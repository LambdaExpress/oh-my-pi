import { describe, expect, it } from "bun:test";
import { XlsxConverter } from "@oh-my-pi/pi-coding-agent/markit/converters/xlsx";
import { encodeArchive } from "@oh-my-pi/pi-utils/ar";
import { makeNamespacedXlsxFixture } from "./helpers/archive-documents";

describe("XLSX workbook conversion", () => {
	it("reads namespace-prefixed workbook, relationships, strings, and cells without losing text", async () => {
		const converter = new XlsxConverter();
		const result = await converter.convert(Buffer.from(await makeNamespacedXlsxFixture()), { extension: ".xlsx" });

		expect(result.markdown).toContain("## 执行记录");
		expect(result.markdown).toContain("| Name | Code | Active | Total | Notes |");
		expect(result.markdown).toContain("| Alice & Bob | 00042 | TRUE | 3 | pre served |");
	});

	it("retains the sheet name for a valid empty worksheet", async () => {
		const bytes = await encodeArchive("zip", [
			[
				"xl/workbook.xml",
				'<x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:sheets><x:sheet name="Empty" sheetId="1" r:id="sheet1"/></x:sheets></x:workbook>',
			],
			[
				"xl/_rels/workbook.xml.rels",
				'<Relationships><Relationship Id="sheet1" Target="worksheets/sheet1.xml"/></Relationships>',
			],
			[
				"xl/worksheets/sheet1.xml",
				'<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData/></x:worksheet>',
			],
		]);
		const result = await new XlsxConverter().convert(Buffer.from(bytes), { extension: ".xlsx" });
		expect(result.markdown).toBe("## Empty");
	});

	it("reports an unresolved worksheet instead of returning an empty conversion", async () => {
		const bytes = await encodeArchive("zip", [
			[
				"xl/workbook.xml",
				'<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Missing" sheetId="1" r:id="missing"/></sheets></workbook>',
			],
			["xl/_rels/workbook.xml.rels", "<Relationships/>"],
		]);
		await expect(new XlsxConverter().convert(Buffer.from(bytes), { extension: ".xlsx" })).rejects.toThrow(
			/worksheet|relationship/i,
		);
	});
});
