import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as vm from "node:vm";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { createHelpers, type HelperContext } from "../../src/eval/js/shared/helpers";
import { JAVASCRIPT_PRELUDE_SOURCE } from "../../src/eval/js/shared/prelude";
import { callSessionTool } from "../../src/eval/js/tool-bridge";

/**
 * The eval helpers (`read`/`write`) must substitute injected on-disk
 * roots for internal-URL schemes. Without it, `write("local://x.md")` hits a
 * stdlib `path.resolve` that collapses `local://` to `local:/`, creating a junk
 * `local:` directory under the cwd instead of landing where `read local://x.md`
 * resolves. These lock the substitution contract and its guards.
 */
function makeCtx(cwd: string, roots: Record<string, string>): HelperContext {
	return {
		cwd: () => cwd,
		env: new Map(),
		localRoots: () => roots,
		emitStatus: () => {},
	};
}

describe("eval js helpers internal-url resolution", () => {
	it.each([
		{ name: "LF", content: "alpha\n中文\n" },
		{ name: "CRLF", content: "alpha\r\n中文\r\n" },
		{ name: "混合换行", content: "alpha\n中文\r\nbeta\rgamma\n" },
	])("逐字节保留 local:// 文件的 $name 文本", async ({ content }) => {
		using tmp = TempDir.createSync("@eval-helpers-newlines-");
		const root = path.join(tmp.path(), "local");
		const helpers = createHelpers(makeCtx(tmp.path(), { local: root }));
		await helpers.writeFile("local://nested/contents.txt", content);

		expect(Buffer.from(await Bun.file(path.join(root, "nested", "contents.txt")).arrayBuffer())).toEqual(
			Buffer.from(content, "utf8"),
		);
	});

	it("writes and reads local:// under the injected root", async () => {
		using tmp = TempDir.createSync("@eval-helpers-local-");
		const root = path.join(tmp.path(), "local");
		const helpers = createHelpers(makeCtx(tmp.path(), { local: root }));

		await helpers.writeFile("local://notes/merge-map.md", "hello");
		expect(await Bun.file(path.join(root, "notes", "merge-map.md")).text()).toBe("hello");
		expect(await helpers.read("local://notes/merge-map.md")).toBe("hello");

		// Regression: no literal `local:` directory created under the cwd.
		expect(await Bun.file(path.join(tmp.path(), "local:")).exists()).toBe(false);
		expect(await Bun.file(path.join(tmp.path(), "local:", "notes", "merge-map.md")).exists()).toBe(false);
	});

	it("rejects traversal and schemes without an injected root", async () => {
		using tmp = TempDir.createSync("@eval-helpers-guard-");
		const helpers = createHelpers(makeCtx(tmp.path(), { local: path.join(tmp.path(), "local") }));

		await expect(helpers.writeFile("local://../escape.md", "x")).rejects.toThrow(/traversal|escapes/i);
		await expect(helpers.writeFile("memory://x.md", "x")).rejects.toThrow(/not supported/i);
		await expect(helpers.read("https://example.com/page")).rejects.toThrow(/not supported/i);
		await expect(helpers.writeFile("xd://lsp", "{}")).rejects.toThrow(/top-level write tool directly/i);
	});

	it("leaves plain relative and absolute paths resolving against the cwd", async () => {
		using tmp = TempDir.createSync("@eval-helpers-plain-");
		const helpers = createHelpers(makeCtx(tmp.path(), {}));

		await helpers.writeFile("foo/bar.txt", "bar");
		expect(await helpers.read("foo/bar.txt")).toBe("bar");
	});
});

describe("eval read() artifact recovery", () => {
	it("follows the first delegated read footer to verbatim bounded artifact content", async () => {
		using tmp = TempDir.createSync("@eval-read-artifact-recovery-");
		const manager = SessionManager.create(tmp.path(), path.join(tmp.path(), "sessions"));
		const settings = Settings.isolated();
		const context = { sessionManager: manager, settings } as unknown as AgentToolContext;
		const session: ToolSession = {
			cwd: tmp.path(),
			hasUI: false,
			getSessionFile: () => manager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => manager.getArtifactsDir(),
			getToolContext: () => context,
			sessionManager: manager,
			settings,
		};
		const tool = wrapToolWithMetaNotice(new ReadTool(session)) as AgentTool;
		session.getToolByName = name => (name === "read" ? tool : undefined);
		const sandbox = vm.createContext({
			__omp_helpers__: createHelpers(makeCtx(tmp.path(), { local: path.join(tmp.path(), "local") })),
			__omp_call_tool__: (name: string, args: unknown) => callSessionTool(name, args, { session }),
		});
		vm.runInContext(JAVASCRIPT_PRELUDE_SOURCE, sandbox);
		const content = `\ufeff${"α".repeat(28_000)}\r\nsecond\r\n`;
		const filePath = path.join(tmp.path(), "template.txt");
		await Bun.write(filePath, content);

		try {
			const initial: string = await vm.runInContext(
				`read(${JSON.stringify(`${pathToFileURL(filePath).href}:raw`)})`,
				sandbox,
			);
			const selector = initial.match(/\bartifact:\/\/\d+:raw:\d+-\d+/u)?.[0];
			if (!selector) throw new Error("The eval read helper did not expose the bounded artifact selector");
			expect(await vm.runInContext(`read(${JSON.stringify(selector)})`, sandbox)).toBe(content);
		} finally {
			await manager.close();
		}
	});
});
