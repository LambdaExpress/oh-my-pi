import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test(
	"loads the screen emulator when a compiled host imports the external tool",
	async () => {
		const directory = mkdtempSync(join(tmpdir(), "omp-tui-compiled-host-"));
		const hostSource = join(directory, "host.ts");
		const hostBinary = join(directory, process.platform === "win32" ? "host.exe" : "host");
		const childSource = join(directory, "child.ts");
		const toolPath = resolve(import.meta.dir, "tui.ts");
		const cwd = resolve(import.meta.dir, "..", "..");

		writeFileSync(childSource, `console.log("ready"); await Bun.sleep(60_000);\n`);
		writeFileSync(
			hostSource,
			`
export {};
const [toolPath, cwd, childPath] = process.argv.slice(2);
if (!toolPath || !cwd || !childPath) throw new Error("missing host arguments");
// Runtime-selected import reproduces how a compiled OMP executable loads a custom tool.
const { default: createTool } = await import(toolPath);
const schema = {
	describe() { return schema; },
	optional() { return schema; },
};
const tool = createTool({
	cwd,
	zod: {
		object() { return schema; },
		string() { return schema; },
		boolean() { return schema; },
		number() { return schema; },
		array() { return schema; },
	},
});
const name = "compiled-host";
let started = false;
try {
	const result = await tool.execute("compiled-host-test", {
		op: "start",
		name,
		file: childPath,
		rows: 8,
		cols: 40,
		timeout: 0.25,
	});
	started = true;
	const text = result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\\n");
	console.log(text);
	if (!text.includes("ready")) throw new Error("terminal output did not contain ready");
} finally {
	if (started) await tool.execute("compiled-host-test", { op: "stop", name }).catch(() => {});
}
`,
		);

		try {
			const compile = Bun.spawn(
				[process.execPath, "build", "--compile", hostSource, "--outfile", hostBinary],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const [compileExit, compileStdout, compileStderr] = await Promise.all([
				compile.exited,
				new Response(compile.stdout).text(),
				new Response(compile.stderr).text(),
			]);
			expect(`${compileStdout}${compileStderr}`).not.toContain("error:");
			expect(compileExit).toBe(0);

			const run = Bun.spawn([hostBinary, toolPath, cwd, childSource], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [runExit, stdout, stderr] = await Promise.all([
				run.exited,
				new Response(run.stdout).text(),
				new Response(run.stderr).text(),
			]);
			expect(stderr).toBe("");
			expect(runExit).toBe(0);
			expect(stdout).toContain("ready");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
	20_000,
);
