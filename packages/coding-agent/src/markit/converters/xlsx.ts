// Adapted from markit-ai (MIT). See ../NOTICE.

import { XMLParser } from "@oh-my-pi/pi-utils/xml";
import type { ConversionResult, Converter, StreamInfo } from "../types";
import { ZipPackage } from "@oh-my-pi/pi-utils/ar";

const EXTENSIONS = [".xlsx"];
const MIMETYPES = ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"];

/** A text value, or a `{ "#text" }` node when the element carries attributes. */
type XmlText = string | number | { "#text"?: string | number };
type XmlElement = Record<string, unknown>;

interface RichTextRun extends XmlElement {
	t?: XmlText;
}
interface StringItem extends XmlElement {
	t?: XmlText;
	r?: RichTextRun | RichTextRun[];
}
interface Cell extends XmlElement {
	"@_t"?: string;
	v?: string | number;
	is?: StringItem;
}
interface Row extends XmlElement {
	c?: Cell | Cell[];
}
interface Sheet extends XmlElement {
	"@_name": string;
	"@_r:id": string;
}
interface Relationship {
	"@_Id": string;
	"@_Target": string;
}

export class XlsxConverter implements Converter {
	name = "xlsx";

	accepts(streamInfo: StreamInfo): boolean {
		if (streamInfo.extension && EXTENSIONS.includes(streamInfo.extension)) return true;
		if (streamInfo.mimetype && MIMETYPES.some(m => streamInfo.mimetype?.startsWith(m))) return true;
		return false;
	}

	async convert(input: Buffer, _streamInfo: StreamInfo): Promise<ConversionResult> {
		const zip = await ZipPackage.open(input);
		const parser = new XMLParser({
			ignoreAttributes: false,
			attributeNamePrefix: "@_",
			textNodeName: "#text",
			parseTagValue: false,
			trimValues: false,
			processEntities: { maxTotalExpansions: 1_000_000 },
		});
		// Parse shared strings
		const ssXml = await zip.readText("xl/sharedStrings.xml");
		const ss = ssXml ? xmlChild<XmlElement>(parser.parse(ssXml), "sst") : undefined;
		const shared = toArray(xmlChild<StringItem | StringItem[]>(ss, "si"));
		// Parse workbook for sheet names
		const wbXml = await zip.readText("xl/workbook.xml");
		if (!wbXml) throw new Error("Invalid XLSX: missing workbook.xml");
		const wb = xmlChild<XmlElement>(parser.parse(wbXml), "workbook");
		if (!wb) throw new Error("Invalid XLSX: missing workbook element");
		const sheets = toArray(xmlChild<Sheet | Sheet[]>(xmlChild<XmlElement>(wb, "sheets"), "sheet"));
		if (sheets.length === 0) throw new Error("Invalid XLSX: workbook contains no sheets");
		// Parse workbook rels to map rIds to sheet files
		const relsXml = await zip.readText("xl/_rels/workbook.xml.rels");
		const rels = relsXml ? xmlChild<XmlElement>(parser.parse(relsXml), "Relationships") : undefined;
		const relList = toArray(xmlChild<Relationship | Relationship[]>(rels, "Relationship"));
		const relMap = new Map<string, string>();
		for (const r of relList) {
			relMap.set(r["@_Id"], r["@_Target"]);
		}
		const sections: string[] = [];
		for (const sheet of sheets) {
			const sheetName = sheet["@_name"];
			const rId = xmlChild<string>(sheet, "id", true);
			const target = rId ? relMap.get(rId) : undefined;
			if (!target) throw new Error(`Invalid XLSX: missing worksheet relationship for '${sheetName}'`);
			const sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
			const sheetXml = await zip.readText(sheetPath);
			if (!sheetXml) throw new Error(`Invalid XLSX: missing worksheet '${sheetPath}'`);
			const worksheet = xmlChild<XmlElement>(parser.parse(sheetXml), "worksheet");
			if (!worksheet) throw new Error(`Invalid XLSX: missing worksheet element in '${sheetPath}'`);
			sections.push(`## ${sheetName}`);
			const rows = toArray(xmlChild<Row | Row[]>(xmlChild<XmlElement>(worksheet, "sheetData"), "row"));
			if (rows.length === 0) continue;
			// Extract all rows as string arrays
			const tableRows: string[][] = [];
			for (const row of rows) {
				const cells = toArray(xmlChild<Cell | Cell[]>(row, "c"));
				const values: string[] = [];
				for (const cell of cells) {
					values.push(this.getCellValue(cell, shared));
				}
				tableRows.push(values);
			}
			if (tableRows.length === 0) continue;
			// Normalize column count
			let maxCols = 0;
			for (const row of tableRows) {
				if (row.length > maxCols) maxCols = row.length;
			}
			for (const row of tableRows) {
				while (row.length < maxCols) row.push("");
			}
			const [header, ...body] = tableRows;
			const lines: string[] = [];
			lines.push(`| ${header.join(" | ")} |`);
			lines.push(`| ${header.map(() => "---").join(" | ")} |`);
			for (const row of body) {
				lines.push(`| ${row.join(" | ")} |`);
			}
			sections.push(lines.join("\n"));
		}
		return { markdown: sections.join("\n\n") };
	}

	getCellValue(cell: Cell, shared: StringItem[]): string {
		const value = xmlChild<string | number>(cell, "v");
		// Shared string
		if (cell["@_t"] === "s") {
			return this.getSharedString(shared, Number(value));
		}
		// Inline string
		if (cell["@_t"] === "inlineStr") {
			return stringItemValue(xmlChild<StringItem>(cell, "is"));
		}
		// Boolean
		if (cell["@_t"] === "b") {
			return value === 1 || value === "1" ? "TRUE" : "FALSE";
		}
		// Number or formula result
		if (value != null) return String(value);
		return "";
	}

	getSharedString(shared: StringItem[], idx: number): string {
		return stringItemValue(shared[idx]);
	}
}

/**
 * OOXML namespace prefixes are arbitrary. Inspect parsed local names rather
 * than assuming the default namespace or rewriting the XML text (which could
 * corrupt cell contents). Attribute lookups keep element and attribute keys
 * separate, including relationship ids using a nonstandard prefix.
 */
function xmlChild<T>(node: unknown, name: string, attribute = false): T | undefined {
	if (node === null || typeof node !== "object") return undefined;
	const element = node as XmlElement;
	const exact = attribute ? `@_${name}` : name;
	if (Object.hasOwn(element, exact)) return element[exact] as T;
	for (const key in element) {
		if (key.startsWith("@_") !== attribute) continue;
		const colon = key.indexOf(":");
		if (colon > 0 && key.slice(colon + 1) === name) return element[key] as T;
	}
	return undefined;
}

function stringItemValue(item: StringItem | undefined): string {
	const text = xmlChild<XmlText>(item, "t");
	if (text != null) return textValue(text);
	return toArray(xmlChild<RichTextRun | RichTextRun[]>(item, "r"))
		.map(run => textValue(xmlChild<XmlText>(run, "t")))
		.join("");
}

function textValue(t: XmlText | undefined): string {
	if (t == null) return "";
	if (typeof t === "object") return String(t["#text"] ?? "");
	return String(t);
}

function toArray<T>(val: T | T[] | undefined): T[] {
	if (!val) return [];
	return Array.isArray(val) ? val : [val];
}
