import * as fs from "node:fs/promises";
import { Readable } from "node:stream";
import * as zlib from "node:zlib";
import { encodeArchive } from "@oh-my-pi/pi-utils/ar";
import { crc32 } from "@oh-my-pi/pi-utils/ar/checksums";

const ENCODER = new TextEncoder();

/**
 * Write a real ZIP containing a small JSON and a large zero-filled member.
 * Deflated payloads are generated with bounded buffers; stored payloads use a
 * seek over the zero-filled payload, as in an APK's large nested APK. Neither
 * allocates the large member in process memory.
 */
export async function writeLargeZipFixture(
	filePath: string,
	largeSize: number,
	stored = false,
): Promise<{ largePath: string; jsonPath: string; json: string }> {
	const largePath = stored ? "assets/lspatch/origin.apk" : "flows/logs/device-simulator.log";
	const jsonPath = "evidence/lock-state.json";
	const json = '{"locked":true,"route":"original"}\n';
	const entries: Buffer[] = [];
	let offset = 0;
	const file = await fs.open(filePath, "w");
	try {
		const names = [jsonPath, largePath];
		for (const name of names) {
			const nameBytes = ENCODER.encode(name);
			const localOffset = offset;
			const local = Buffer.alloc(30 + nameBytes.byteLength);
			local.writeUInt32LE(0x04034b50, 0);
			local.writeUInt16LE(20, 4);
			local.writeUInt16LE(0x0800, 6);
			const method = name === largePath && !stored ? 8 : 0;
			local.writeUInt16LE(method, 8);
			local.writeUInt16LE(nameBytes.byteLength, 26);
			local.set(nameBytes, 30);
			await file.write(local, 0, local.byteLength, offset);
			offset += local.byteLength;
			const dataStart = offset;
			let checksum = 0;
			let size: number;
			if (name === jsonPath) {
				const bytes = ENCODER.encode(json);
				size = bytes.byteLength;
				checksum = crc32(bytes);
				await file.write(bytes, 0, bytes.byteLength, offset);
				offset += bytes.byteLength;
			} else {
				size = largeSize;
				const chunk = Buffer.alloc(64 * 1024);
				function* zeros(): Generator<Buffer> {
					for (let remaining = largeSize; remaining > 0; remaining -= chunk.byteLength) {
						const bytes = chunk.subarray(0, Math.min(chunk.byteLength, remaining));
						checksum = crc32(bytes, checksum);
						yield bytes;
					}
				}
				if (stored) {
					for (const _chunk of zeros()) {
						// Compute the checksum without materializing the sparse payload.
					}
					offset += largeSize;
				} else {
					const deflater = Readable.from(zeros()).pipe(zlib.createDeflateRaw());
					for await (const bytes of deflater) {
						const compressed = bytes as Buffer;
						await file.write(compressed, 0, compressed.byteLength, offset);
						offset += compressed.byteLength;
					}
				}
			}
			const compressedSize = offset - dataStart;
			local.writeUInt32LE(checksum, 14);
			local.writeUInt32LE(compressedSize, 18);
			local.writeUInt32LE(size, 22);
			await file.write(local, 0, local.byteLength, localOffset);
			const central = Buffer.alloc(46 + nameBytes.byteLength);
			central.writeUInt32LE(0x02014b50, 0);
			central.writeUInt16LE(20, 4);
			central.writeUInt16LE(20, 6);
			central.writeUInt16LE(0x0800, 8);
			central.writeUInt16LE(method, 10);
			central.writeUInt32LE(checksum, 16);
			central.writeUInt32LE(compressedSize, 20);
			central.writeUInt32LE(size, 24);
			central.writeUInt16LE(nameBytes.byteLength, 28);
			central.writeUInt32LE(localOffset, 42);
			central.set(nameBytes, 46);
			entries.push(central);
		}
		const directory = Buffer.concat(entries);
		const end = Buffer.alloc(22);
		end.writeUInt32LE(0x06054b50, 0);
		end.writeUInt16LE(entries.length, 8);
		end.writeUInt16LE(entries.length, 10);
		end.writeUInt32LE(directory.byteLength, 12);
		end.writeUInt32LE(offset, 16);
		await file.write(directory, 0, directory.byteLength, offset);
		await file.write(end, 0, end.byteLength, offset + directory.byteLength);
	} finally {
		await file.close();
	}
	return { largePath, jsonPath, json };
}

/** A legal namespace-prefixed OOXML workbook with shared, rich, and inline strings. */
export async function makeNamespacedXlsxFixture(): Promise<Uint8Array> {
	const spreadsheetNs = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
	const documentRelsNs = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
	const packageRelsNs = "http://schemas.openxmlformats.org/package/2006/relationships";
	return encodeArchive("zip", [
		[
			"[Content_Types].xml",
			`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
		],
		[
			"_rels/.rels",
			`<Relationships xmlns="${packageRelsNs}"><Relationship Id="book" Type="${documentRelsNs}/officeDocument" Target="/xl/workbook.xml"/></Relationships>`,
		],
		[
			"xl/workbook.xml",
			`<x:workbook xmlns:x="${spreadsheetNs}" xmlns:r="${documentRelsNs}"><x:sheets><x:sheet name="执行记录" sheetId="1" r:id="sheet1"/></x:sheets></x:workbook>`,
		],
		[
			"xl/_rels/workbook.xml.rels",
			`<p:Relationships xmlns:p="${packageRelsNs}"><p:Relationship Id="sheet1" Type="${documentRelsNs}/worksheet" Target="/xl/worksheets/sheet1.xml"/><p:Relationship Id="strings" Type="${documentRelsNs}/sharedStrings" Target="/xl/sharedStrings.xml"/></p:Relationships>`,
		],
		[
			"xl/sharedStrings.xml",
			`<s:sst xmlns:s="${spreadsheetNs}" count="1" uniqueCount="1"><s:si><s:r><s:t>Alice</s:t></s:r><s:r><s:t xml:space="preserve"> &amp; Bob</s:t></s:r></s:si></s:sst>`,
		],
		[
			"xl/worksheets/sheet1.xml",
			`<w:worksheet xmlns:w="${spreadsheetNs}"><w:sheetData><w:row r="1"><w:c r="A1" t="inlineStr"><w:is><w:t>Name</w:t></w:is></w:c><w:c r="B1" t="inlineStr"><w:is><w:t>Code</w:t></w:is></w:c><w:c r="C1" t="inlineStr"><w:is><w:t>Active</w:t></w:is></w:c><w:c r="D1" t="inlineStr"><w:is><w:t>Total</w:t></w:is></w:c><w:c r="E1" t="inlineStr"><w:is><w:t>Notes</w:t></w:is></w:c></w:row><w:row r="2"><w:c r="A2" t="s"><w:v>0</w:v></w:c><w:c r="B2" t="str"><w:v>00042</w:v></w:c><w:c r="C2" t="b"><w:v>1</w:v></w:c><w:c r="D2"><w:f>SUM(1,2)</w:f><w:v>3</w:v></w:c><w:c r="E2" t="inlineStr"><w:is><w:r><w:t xml:space="preserve">pre </w:t></w:r><w:r><w:t>served</w:t></w:r></w:is></w:c></w:row></w:sheetData></w:worksheet>`,
		],
	]);
}
