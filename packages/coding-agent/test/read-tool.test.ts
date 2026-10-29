import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deflateSync } from "node:zlib";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { registerArtifactsDir } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { TempDir } from "@oh-my-pi/pi-utils/temp";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

function createSession(cwd: string, sourcePath: string): ToolSession {
	const image: ImageContent = { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" };
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "images.autoResize": false }),
		getImageAttachments: () => [{ label: "Image #1", uri: "attachment://1", image, sourcePath }],
	};
}

describe("read attachment URLs", () => {
	let testDir: string;
	let imagePath: string;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "read-attachment-"));
		imagePath = path.join(testDir, "original.png");
		fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
	});

	afterEach(() => {
		removeSyncWithRetries(testDir);
	});

	it("decodes attachment URLs through the underlying image file path", async () => {
		const tool = new ReadTool(createSession(testDir, imagePath));
		const attachmentResult = await tool.execute("read-attachment", { path: "attachment://1" });
		const fileResult = await tool.execute("read-file", { path: imagePath });

		expect(attachmentResult.content).toEqual(fileResult.content);
		expect(attachmentResult.content).toContainEqual({
			type: "image",
			data: TINY_PNG_BASE64,
			mimeType: "image/png",
		});
	});

	it("reports unknown attachment URLs with the available URIs", async () => {
		const tool = new ReadTool(createSession(testDir, imagePath));

		await expect(tool.execute("read-missing-attachment", { path: "attachment://2" })).rejects.toThrow(
			"Could not resolve image attachment 'attachment://2'. Available attachment URIs: attachment://1.",
		);
	});
});

describe("read repetition tracking", () => {
	function pixelPng(red: number, green: number, blue: number): Buffer {
		const template = Buffer.from(TINY_PNG_BASE64, "base64");
		const pixels = deflateSync(Buffer.from([0, red, green, blue, 255]), { level: 0 });
		const chunk = Buffer.alloc(pixels.length + 12);
		chunk.writeUInt32BE(pixels.length);
		chunk.write("IDAT", 4);
		pixels.copy(chunk, 8);
		chunk.writeUInt32BE(Bun.hash.crc32(chunk.subarray(4, -4)), chunk.length - 4);
		return Buffer.concat([template.subarray(0, 33), chunk, template.subarray(-12)]);
	}

	it("resets repetition when image bytes change beneath identical metadata", async () => {
		using tmp = TempDir.createSync("@read-image-repetition-");
		const imagePath = path.join(tmp.path(), "pixel.png");
		const tool = new ReadTool(createSession(tmp.path(), imagePath));
		let baselineText: TextContent[] = [];
		for (const [index, pixels] of [pixelPng(255, 0, 0), pixelPng(0, 255, 0), pixelPng(0, 0, 255)].entries()) {
			fs.writeFileSync(imagePath, pixels);
			const result = await tool.execute(`read-overwritten-image-${index}`, { path: imagePath });
			const text = result.content.filter(block => block.type === "text");
			if (index === 0) baselineText = text;
			expect(text).toEqual(baselineText);
			expect(result.content).toContainEqual({
				type: "image",
				data: pixels.toString("base64"),
				mimeType: "image/png",
			});
		}

		const second = await tool.execute("read-unchanged-image-second", { path: imagePath });
		expect(second.content.filter(block => block.type === "text")).toEqual(baselineText);
		const third = await tool.execute("read-unchanged-image-third", { path: imagePath });
		expect(third.content.filter(block => block.type === "text")).not.toEqual(baselineText);

		fs.writeFileSync(imagePath, pixelPng(255, 0, 0));
		const changed = await tool.execute("read-image-after-hint", { path: imagePath });
		expect(changed.content.filter(block => block.type === "text")).toEqual(baselineText);
	});

	it("keeps raw text verbatim across repeated reads and overwrites", async () => {
		using tmp = TempDir.createSync("@read-text-repetition-");
		const filePath = path.join(tmp.path(), "notes.txt");
		fs.writeFileSync(filePath, "original text\n");
		const tool = new ReadTool(createSession(tmp.path(), ""));
		const read = (id: string) => tool.execute(id, { path: `${filePath}:raw` });
		const first = await read("read-text-first");
		expect(first.content).toEqual([{ type: "text", text: "original text\n" }]);
		expect((await read("read-text-second")).content).toEqual(first.content);
		const third = await read("read-text-third");
		expect(third.content).toEqual(first.content);

		fs.writeFileSync(filePath, "replacement text\n");
		expect((await read("read-text-changed")).content).toEqual([{ type: "text", text: "replacement text\n" }]);
		expect((await read("read-text-changed-second")).content).toEqual([{ type: "text", text: "replacement text\n" }]);
	});

	it("still hints on repeated non-raw reads and resets after an overwrite", async () => {
		using tmp = TempDir.createSync("@read-text-repetition-");
		const filePath = path.join(tmp.path(), "notes.txt");
		fs.writeFileSync(filePath, "original text\n");
		const tool = new ReadTool(createSession(tmp.path(), ""));
		const first = await tool.execute("read-numbered-first", { path: filePath });
		expect((await tool.execute("read-numbered-second", { path: filePath })).content).toEqual(first.content);
		expect((await tool.execute("read-numbered-third", { path: filePath })).content).not.toEqual(first.content);

		fs.writeFileSync(filePath, "replacement text\n");
		const changed = await tool.execute("read-numbered-changed", { path: filePath });
		expect((await tool.execute("read-numbered-changed-second", { path: filePath })).content).toEqual(changed.content);
	});
});

describe("读取代理报告字段的行选择器", () => {
	let testDir: string;
	let outputId: string;
	let unregister: () => void;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "read-agent-field-"));
		outputId = path.basename(testDir);
		unregister = registerArtifactsDir(testDir);
	});

	afterEach(() => {
		unregister();
		removeSyncWithRetries(testDir);
	});

	function reportLines(count: number): string[] {
		return Array.from({ length: count }, (_, i) => `报告第 ${i + 1} 行`);
	}

	it("按 70–155 行切片 JSON 输出内的文本字段且保留未选择字段", async () => {
		const lines = reportLines(240);
		const report = lines.join("\n");
		fs.writeFileSync(path.join(testDir, `${outputId}.md`), JSON.stringify({ report }));
		const session = createSession(testDir, "");
		const tool = new ReadTool(session);
		const selected = await tool.execute("read-report-range", { path: `agent://${outputId}/report:70-155` });

		expect(selected.details?.displayContent).toEqual({
			text: lines.slice(69, 155).join("\n"),
			startLine: 70,
			lineNumbers: Array.from({ length: 86 }, (_, i) => i + 70),
		});
		expect(selected.details?.totalLines).toBe(240);
		expect(selected.content).not.toContainEqual(
			expect.objectContaining({ text: expect.stringMatching(/^\[[^\n]+#[0-9A-F]{4}\]/) }),
		);
		expect(session.editStore).toBeUndefined();
		const unselected = await tool.execute("read-full-report", { path: `agent://${outputId}/report` });
		expect(unselected.content).toEqual([{ type: "text", text: report }]);
	});

	it("对 sidecar 报告字段支持两种 raw 顺序并保留 CRLF", async () => {
		const lines = reportLines(220);
		const report = `\uFEFF${lines.join("\r\n")}\r\n`;
		fs.writeFileSync(path.join(testDir, `${outputId}.md`), "报告预览");
		fs.writeFileSync(path.join(testDir, `${outputId}.json`), JSON.stringify({ report }));
		const tool = new ReadTool(createSession(testDir, ""));
		const expected = report.split("\n").slice(0, 200).join("\n");
		const leadingRaw = await tool.execute("read-report-leading-raw", {
			path: `agent://${outputId}/report:raw:1-200`,
		});
		const trailingRaw = await tool.execute("read-report-trailing-raw", {
			path: `agent://${outputId}/report:1-200:raw`,
		});

		expect(leadingRaw.details?.displayContent?.text).toBe(expected);
		expect(leadingRaw.details?.displayContent?.startLine).toBe(1);
		expect(leadingRaw.details?.totalLines).toBe(220);
		expect(leadingRaw.content).toEqual(trailingRaw.content);
		expect(leadingRaw.content[0]).toEqual(
			expect.objectContaining({ type: "text", text: expect.stringContaining(expected) }),
		);
		const finalLines = await tool.execute("read-report-final-lines", {
			path: `agent://${outputId}/report:raw:219-220`,
		});
		expect(finalLines.content).toEqual([{ type: "text", text: `${lines.slice(-2).join("\r\n")}\r\n` }]);
		expect(finalLines.details?.displayContent?.lineNumbers).toEqual([219, 220]);
		expect(finalLines.details?.totalLines).toBe(220);
		const whole = await tool.execute("read-report-bounded-eof", {
			path: `agent://${outputId}/report:raw:1-225`,
		});
		expect(whole.content).toEqual([{ type: "text", text: report }]);
		expect(whole.details?.displayContent?.lineNumbers).toEqual(Array.from({ length: 220 }, (_, i) => i + 1));
		const beyond = await tool.execute("read-report-beyond", { path: `agent://${outputId}/report:raw:221` });
		expect(beyond.details?.totalLines).toBe(220);
		expect(beyond.details?.displayContent).toBeUndefined();
	});

	it("对嵌套报告字段按 1–210 行切片且支持混合尾范围", async () => {
		const lines = reportLines(240);
		fs.writeFileSync(
			path.join(testDir, `${outputId}.md`),
			JSON.stringify({ reports: [{ data: { report: lines.join("\n") } }] }),
		);
		const tool = new ReadTool(createSession(testDir, ""));
		const target = `agent://${outputId}/reports/0/data/report`;
		const prefix = await tool.execute("read-nested-report", { path: `${target}:1-210` });

		expect(prefix.details?.displayContent?.text).toBe(lines.slice(0, 210).join("\n"));
		expect(prefix.details?.displayContent?.lineNumbers).toEqual(Array.from({ length: 210 }, (_, i) => i + 1));
		const mixed = await tool.execute("read-nested-report-tail", { path: `${target}:1-2,-2` });
		expect(mixed.details?.displayContent?.text).toBe([...lines.slice(0, 2), "…", ...lines.slice(-2)].join("\n"));
		expect(mixed.details?.displayContent?.lineNumbers).toEqual([1, 2, null, 239, 240]);
	});

	it.each(["\n", "\r\n"])(
		"preserves the raw EOF terminator at the physical-line output boundary for %j",
		async ending => {
			const report = `x${ending}`.repeat(DEFAULT_MAX_LINES);
			const longerReport = `${report}last${ending}`;
			fs.writeFileSync(path.join(testDir, `${outputId}.md`), JSON.stringify({ report, longerReport }));
			const tool = new ReadTool(createSession(testDir, ""));
			const result = await tool.execute("read-report-line-boundary", {
				path: `agent://${outputId}/report:raw:1-${DEFAULT_MAX_LINES}`,
			});

			expect(result.content).toEqual([{ type: "text", text: report }]);
			expect(result.details?.totalLines).toBe(DEFAULT_MAX_LINES);
			expect(result.details?.truncation).toBeUndefined();
			expect(result.details?.displayContent?.lineNumbers?.at(-1)).toBe(DEFAULT_MAX_LINES);

			const limited = await tool.execute("read-report-over-line-boundary", {
				path: `agent://${outputId}/longerReport:raw:1-${DEFAULT_MAX_LINES + 1}`,
			});
			expect(limited.details?.displayContent?.text).toBe(report.slice(0, -1));
			expect(limited.details?.displayContent?.lineNumbers?.at(-1)).toBe(DEFAULT_MAX_LINES);
			expect(limited.details?.totalLines).toBe(DEFAULT_MAX_LINES + 1);
			expect(limited.details?.truncation?.outputLines).toBe(DEFAULT_MAX_LINES);
			expect(limited.details?.truncation?.totalLines).toBe(DEFAULT_MAX_LINES + 1);
		},
	);

	it("仍原样返回非文本字段并拒绝对其应用行范围", async () => {
		const value = { complete: true, items: ["一", "二"] };
		fs.writeFileSync(path.join(testDir, `${outputId}.md`), JSON.stringify({ value, empty: null }));
		const tool = new ReadTool(createSession(testDir, ""));
		const target = `agent://${outputId}/value`;
		const expected = [{ type: "text" as const, text: JSON.stringify(value, null, 2) }];

		expect((await tool.execute("read-json-value", { path: target })).content).toEqual(expected);
		expect((await tool.execute("read-raw-json-value", { path: `${target}:raw` })).content).toEqual(expected);
		await expect(tool.execute("read-json-value-range", { path: `${target}:1-2` })).rejects.toBeInstanceOf(ToolError);
		await expect(
			tool.execute("read-null-value-tail", { path: `agent://${outputId}/empty:raw:-2` }),
		).rejects.toBeInstanceOf(ToolError);
	});
});

describe("read artifact spill recovery", () => {
	it("recovers a 53.8 KiB output from the first footer even when one line exceeds the spill budget", async () => {
		using tmp = TempDir.createSync("@read-artifact-recovery-");
		const manager = SessionManager.create(tmp.path(), path.join(tmp.path(), "sessions"));
		const session = createSession(tmp.path(), "");
		session.sessionManager = manager;
		session.getArtifactsDir = () => manager.getArtifactsDir();
		const tool = wrapToolWithMetaNotice(new ReadTool(session));
		const context = { sessionManager: manager, settings: session.settings } as unknown as AgentToolContext;
		const prefix = '\ufeff<section data-image="';
		const suffix = '">\r\n第二行\r\n</section>\r\n';
		const content = prefix + "x".repeat(55_091 - Buffer.byteLength(prefix + suffix, "utf8")) + suffix;
		const filePath = path.join(tmp.path(), "template.html");
		fs.writeFileSync(filePath, content);

		try {
			const initial = await tool.execute(
				"read-large-template",
				{ path: `${filePath}:raw` },
				undefined,
				undefined,
				context,
			);
			const initialText = initial.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
			const selector = initialText.match(/\bartifact:\/\/\d+:raw:\d+-\d+/u)?.[0];
			if (!selector) throw new Error("The first spill footer did not provide a bounded raw artifact selector");

			const recovered = await tool.execute(
				"read-template-artifact-page",
				{ path: selector },
				undefined,
				undefined,
				context,
			);
			expect(recovered.content).toEqual([{ type: "text", text: content }]);
			expect(recovered.details?.meta?.pagedSource).toBe(true);
			expect(recovered.details?.meta?.truncation).toBeUndefined();
		} finally {
			await manager.close();
		}
	});

	it("keeps the unbounded raw byte boundary and recovers the refused artifact through its bounded selector", async () => {
		using tmp = TempDir.createSync("@read-artifact-raw-boundary-");
		const manager = SessionManager.create(tmp.path(), path.join(tmp.path(), "sessions"));
		const session = createSession(tmp.path(), "");
		session.sessionManager = manager;
		session.getArtifactsDir = () => manager.getArtifactsDir();
		const tool = new ReadTool(session);
		const atLimit = "x".repeat(DEFAULT_MAX_BYTES);
		const aboveLimit = `${atLimit}y`;

		try {
			const acceptedId = await manager.saveArtifact(atLimit, "read");
			const refusedId = await manager.saveArtifact(aboveLimit, "read");
			const accepted = await tool.execute("read-at-raw-limit", { path: `artifact://${acceptedId}:raw` });
			expect(accepted.content).toEqual([{ type: "text", text: atLimit }]);

			const refused = await tool.execute("read-above-raw-limit", { path: `artifact://${refusedId}:raw` });
			expect(refused.details?.displayContent).toBeUndefined();
			const refusedText = refused.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
			const selector = refusedText.match(/\bartifact:\/\/\d+:raw:\d+-\d+/u)?.[0];
			if (!selector) throw new Error("The raw guard did not provide a bounded artifact selector");
			const recovered = await tool.execute("read-refused-artifact-page", { path: selector });
			expect(recovered.content).toEqual([{ type: "text", text: aboveLimit }]);
		} finally {
			await manager.close();
		}
	});
});
