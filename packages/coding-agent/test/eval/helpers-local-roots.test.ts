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
import { resolveEvalUrlRoots } from "../../src/eval/backend";
import { createHelpers, type HelperContext } from "../../src/eval/js/shared/helpers";
import { JAVASCRIPT_PRELUDE_SOURCE } from "../../src/eval/js/shared/prelude";
import { callSessionTool } from "../../src/eval/js/tool-bridge";
import { rejectionOf } from "../helpers/rejection";

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

	it("reads artifact://<id> as its file's full text, with offset/limit selecting lines", async () => {
		using tmp = TempDir.createSync("@eval-helpers-artifact-");
		const artifacts = path.join(tmp.path(), "artifacts");
		const wide = "v".repeat(14_430);
		await Bun.write(path.join(artifacts, "12.eval.log"), `${wide}\nsecond\nthird\n`);
		await Bun.write(path.join(artifacts, "120.bash.log"), "other");
		const helpers = createHelpers(makeCtx(tmp.path(), { artifact: artifacts }));

		expect(helpers.hasRoot("artifact://12")).toBe(true);
		expect(await helpers.read("artifact://12")).toBe(`${wide}\nsecond\nthird\n`);
		expect(await helpers.read("artifact://12", { offset: 2, limit: 1 })).toBe("second");
		// Not in this session's dir: the prelude falls back to the read tool.
		expect(await helpers.read("artifact://7")).toBeUndefined();
	});

	it("leaves artifact selectors to the read tool and refuses artifact writes", async () => {
		using tmp = TempDir.createSync("@eval-helpers-artifact-guard-");
		const artifacts = path.join(tmp.path(), "artifacts");
		const helpers = createHelpers(makeCtx(tmp.path(), { artifact: artifacts }));

		expect(helpers.hasRoot("artifact://12:raw:1-1")).toBe(false);
		expect(await rejectionOf(helpers.writeFile("artifact://12", "x"))).toMatchObject({
			message: expect.stringMatching(/not supported/i),
		});
		expect(await Bun.file(path.join(artifacts, "12")).exists()).toBe(false);
	});

	it("serves artifact:// from the session's artifacts dir, and leaves it to the read tool without one", async () => {
		using tmp = TempDir.createSync("@eval-helpers-session-artifacts-");
		await Bun.write(path.join(tmp.path(), "12.eval.log"), "artifact text");
		const withDir = { cwd: tmp.path(), getArtifactsDir: () => tmp.path() } as unknown as ToolSession;
		const withoutDir = { cwd: tmp.path() } as unknown as ToolSession;

		const helpers = createHelpers(makeCtx(tmp.path(), resolveEvalUrlRoots(withDir)));
		expect(await helpers.read("artifact://12")).toBe("artifact text");
		expect(createHelpers(makeCtx(tmp.path(), resolveEvalUrlRoots(withoutDir))).hasRoot("artifact://12")).toBe(false);
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
