import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { registerArtifactsDir } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

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
		const report = `${lines.join("\r\n")}\r\n`;
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
		expect(leadingRaw.details?.totalLines).toBe(221);
		expect(leadingRaw.content).toEqual(trailingRaw.content);
		expect(leadingRaw.content[0]).toEqual(
			expect.objectContaining({ type: "text", text: expect.stringContaining(expected) }),
		);
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
