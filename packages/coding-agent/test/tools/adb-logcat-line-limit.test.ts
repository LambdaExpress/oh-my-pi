import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AdbCommandOptions,
	type AdbCommandResult,
	type AdbSubprocess,
	executeAdb,
} from "../../src/adb/adb-executor";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { AdbTool } from "../../src/tools/adb";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

function session(extra: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: os.tmpdir(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({
			"tools.maxTimeout": 30,
			"tools.artifactSpillThreshold": 1024,
			"tools.artifactTailBytes": 1024,
		}),
		...extra,
	} as ToolSession;
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.flatMap(part => (part.type === "text" ? [part.text ?? ""] : [])).join("\n");
}

function harness(chunks: readonly string[], extra: Partial<ToolSession> = {}, emitChunks = true) {
	const calls: Array<{ args: readonly string[]; options: AdbCommandOptions }> = [];
	const tool = new AdbTool(session(extra), {
		executeAdb: async (args, options = {}) => {
			calls.push({ args, options });
			if (emitChunks) for (const chunk of chunks) options.onChunk?.(chunk);
			return { output: chunks.join(""), exitCode: 0, cancelled: false } as AdbCommandResult;
		},
		emulatorManager: {
			status: async () => ({ serial: "emulator-5554", state: "device" as const }),
		} as never,
	});
	return { tool, calls };
}

describe("finite logcat physical line limit", () => {
	it.each([
		{ chunks: [""], lines: 1, expected: "(no output)" },
		{ chunks: ["only"], lines: 1, expected: "only" },
		{ chunks: ["only\n"], lines: 1, expected: "only\n" },
		{ chunks: ["old\nnew\n"], lines: 1, expected: "new\n" },
		{ chunks: ["old\nnew"], lines: 1, expected: "new" },
		{ chunks: ["old\r\nnew\r\n"], lines: 1, expected: "new\n" },
		{ chunks: ["old\r", "\nnew\r", "\n"], lines: 1, expected: "new\n" },
		{ chunks: ["old\n\n"], lines: 1, expected: "\n" },
		{ chunks: ["old\nn", "ew", "\n"], lines: 1, expected: "new\n" },
		{ chunks: ["old\nn", "ew"], lines: 1, expected: "new" },
		{ chunks: ["one\n", "two\n"], lines: 2, expected: "one\ntwo\n" },
		{
			chunks: ["--------- beginning of main\nrecord\n  stack\n--------- beginning of crash\nnew\n"],
			lines: 3,
			expected: "  stack\n--------- beginning of crash\nnew\n",
		},
	])("caps $chunks to $lines recent physical lines", async ({ chunks, lines, expected }) => {
		const { tool } = harness(chunks);
		expect(text(await tool.execute("finite", { op: "logcat", lines }))).toBe(expected);
	});

	it("also bounds executors returning output without chunk callbacks", async () => {
		const { tool } = harness(["old\nnew\n"], {}, false);
		expect(text(await tool.execute("no-chunks", { op: "logcat", lines: 1 }))).toBe("new\n");
	});

	it("keeps only the latest 10000 lines despite multiline records and preserves the native filter", async () => {
		const raw = Array.from({ length: 10909 }, (_, index) => `ReactNativeJS: line ${index}\n`).join("");
		const { tool, calls } = harness([raw.slice(0, 113), raw.slice(113)]);
		const result = text(await tool.execute("limit", { op: "logcat", lines: 10000, filter: "ReactNativeJS:I" }));
		expect(result).toBe(raw.split("\n").slice(909).join("\n"));
		expect(result.match(/\n/g)).toHaveLength(10000);
		expect(calls[0]?.args).toEqual(["-s", "emulator-5554", "logcat", "-d", "-t", "10000", "ReactNativeJS:I"]);
	});

	it("does not cap follow output or turn -T into a finite -t dump", async () => {
		const { tool, calls } = harness(["first\n", "second\nthird\n"]);
		const updates: string[] = [];
		const result = await tool.execute("follow", { op: "logcat", lines: 1, follow: true }, undefined, update => {
			updates.push(text(update));
		});
		expect(text(result)).toBe("first\nsecond\nthird\n");
		expect(calls[0]?.args).toEqual(["-s", "emulator-5554", "logcat", "-T", "1"]);
		expect(updates.at(-1)).toContain("third");
	});

	it("fake-adb subprocess smoke bounds the real executor artifact after filtering and multiline formatting", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "adb-logcat-lines-"));
		directories.push(directory);
		const artifactPath = path.join(directory, "logcat.txt");
		const count = 10000;
		const program = `
			const args = JSON.parse(process.env.OMP_FAKE_ADB_ARGS);
			if (args[0] === "devices") console.log("List of devices attached\\nemulator-5554\\tdevice model:Fake");
			else if (args.includes("emu")) console.log("Fake_AVD\\nOK");
			else if (args.includes("logcat")) {
				if (args.at(-1) !== "ReactNativeJS:I") process.exit(4);
				process.stdout.write("--------- beginning of main\\n");
				for (let i = 0; i < 10000; i++) {
					process.stdout.write("line " + i + "\\n");
					if (i < 909) process.stdout.write("  continuation " + i + "\\n");
				}
			} else process.exit(5);
		`;
		const tool = new AdbTool(
			session({
				settings: Settings.isolated({
					"tools.maxTimeout": 30,
					"tools.artifactSpillThreshold": 1,
					"tools.artifactTailBytes": 1,
				}),
				allocateOutputArtifact: async () => ({ path: artifactPath, id: "adb-logcat-smoke" }),
			}),
			{
				resolveExecutable: () => process.execPath,
				executeAdb: (args, options = {}) =>
					executeAdb(args, {
						...options,
						spillThreshold: 128,
						tailBytes: 64,
						headBytes: 64,
						dependencies: {
							resolveExecutable: () => process.execPath,
							spawn: (argv, spawnOptions) =>
								Bun.spawn([argv[0]!, "-e", program], {
									...spawnOptions,
									env: { ...spawnOptions.env, OMP_FAKE_ADB_ARGS: JSON.stringify(argv.slice(1)) },
								}) as AdbSubprocess,
						},
					}),
			},
		);
		const result = await tool.execute("smoke", { op: "logcat", lines: count, filter: "ReactNativeJS:I" });
		const saved = await fs.readFile(artifactPath, "utf8");
		const rawLines = ["--------- beginning of main"];
		for (let index = 0; index < count; index++) {
			rawLines.push(`line ${index}`);
			if (index < 909) rawLines.push(`  continuation ${index}`);
		}
		expect(saved).toBe(`${rawLines.slice(-count).join("\n")}\n`);
		expect(saved.match(/\n/g)).toHaveLength(count);
		expect(result.details?.meta?.truncation?.artifactId).toBe("adb-logcat-smoke");
	});
});
