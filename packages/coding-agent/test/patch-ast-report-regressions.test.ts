import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { ToolChoiceQueue } from "@oh-my-pi/pi-coding-agent/session/tool-choice-queue";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AstEditTool } from "@oh-my-pi/pi-coding-agent/tools/ast-edit";
import { parseCodeStatus } from "@oh-my-pi/pi-natives";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import reports from "./fixtures/patch-ast-reports.json";

let tempDir: string;

function makeSession(queue?: ToolChoiceQueue): ToolSession {
	return {
		cwd: tempDir,
		hasUI: false,
		enableLsp: false,
		settings: Settings.isolated({
			"tools.xdev": false,
			"edit.enforceSeenLines": false,
			"edit.fuzzyMatch": true,
			"edit.autoRepair.enabled": false,
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
		...(queue
			? {
					getToolChoiceQueue: () => queue,
					buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
					steer: () => {},
				}
			: {}),
	} as ToolSession;
}

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-patch-ast-reports-"));
});

afterEach(async () => {
	await removeWithRetries(tempDir);
});

describe("reported apply_patch source boundaries", () => {
	for (const report of reports.patches) {
		test(`report ${report.reportId}: exact source or atomic rejection`, async () => {
			for (const [filename, source] of Object.entries(report.files)) {
				await Bun.write(path.join(tempDir, filename), source);
			}
			const result = await new EditTool(makeSession(), "apply_patch").execute(`report-${report.reportId}`, {
				input: report.input,
			});
			const resultContext = `report ${report.reportId}: ${JSON.stringify(result)}`;
			if ("rejected" in report && report.rejected) {
				expect(result.isError, resultContext).toBe(true);
				const diagnostic = result.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
				expect(diagnostic, resultContext).toContain("CaptionBox.tsx");
				expect(diagnostic, resultContext).toContain("Refusing inexact-line match");
				for (const [filename, source] of Object.entries(report.files)) {
					expect(await Bun.file(path.join(tempDir, filename)).text(), `${resultContext}\nfile ${filename}`).toBe(
						source,
					);
				}
			} else if ("expectedFiles" in report && report.expectedFiles) {
				expect(result.isError, resultContext).not.toBe(true);
				for (const [filename, expected] of Object.entries(report.expectedFiles)) {
					expect(await Bun.file(path.join(tempDir, filename)).text(), `${resultContext}\nfile ${filename}`).toBe(
						expected,
					);
				}
			} else {
				throw new Error(`Missing expected outcome for ${resultContext}`);
			}
		});
	}
});

describe("typed Jest AST rewrite boundaries", () => {
	test("previews and applies both reported expressions without changing an existing grammar recovery node", async () => {
		const filename = path.join(tempDir, "home-store-activities.test.ts");
		await Bun.write(filename, reports.typedJestSource);
		// The reported valid TypeScript construct has a trailing argument comma
		// after requireActual<typeof import(...)>; tree-sitter recovers that comma.
		expect(parseCodeStatus({ code: reports.typedJestSource, path: filename }).parsed).toBe(false);
		const queue = new ToolChoiceQueue();
		const tool = new AstEditTool(makeSession(queue));
		const result = await tool.execute("reported-jest-rewrite", {
			ops: [
				{ pat: "root.settingsStore.setRetryFunc", out: "root.settingsStore.requestReadRetry" },
				{
					pat: "mockRespondArrival.mockResolvedValueOnce(undefined)",
					out: 'mockRespondArrival.mockRejectedValueOnce(new ApiWriteError("network", "Arrival response was not confirmed."))',
				},
			],
			paths: [filename],
		});
		expect(result.details?.totalReplacements).toBe(2);
		expect(result.details?.applied).toBe(false);
		expect(await Bun.file(filename).text()).toBe(reports.typedJestSource);
		expect(queue.hasPendingInvoker).toBe(true);
		await queue.peekPendingInvoker()!({ action: "apply", reason: "apply the two reported expression rewrites" });
		const expected = reports.typedJestSource
			.replace("root.settingsStore.setRetryFunc", "root.settingsStore.requestReadRetry")
			.replace(
				"mockRespondArrival.mockResolvedValueOnce(undefined)",
				'mockRespondArrival.mockRejectedValueOnce(new ApiWriteError("network", "Arrival response was not confirmed."))',
			);
		expect(await Bun.file(filename).text()).toBe(expected);
	});

	test("does not stage a rewrite introducing a new error beside the existing typed Jest recovery node", async () => {
		const filename = path.join(tempDir, "home-store-activities.test.ts");
		await Bun.write(filename, reports.typedJestSource);
		const queue = new ToolChoiceQueue();
		const result = await new AstEditTool(makeSession(queue)).execute("invalid-local-rewrite", {
			ops: [{ pat: "root.settingsStore.setRetryFunc", out: "root.settingsStore.requestReadRetry(" }],
			paths: [filename],
		});
		expect(result.details?.totalReplacements).toBe(0);
		expect(result.details?.parseErrors?.length).toBeGreaterThan(0);
		expect(queue.hasPendingInvoker).toBe(false);
		expect(await Bun.file(filename).text()).toBe(reports.typedJestSource);
	});
});
