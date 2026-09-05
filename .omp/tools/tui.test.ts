import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";

test("captures terminal text and PNG colors when a compiled host imports the external tool", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-tui-compiled-host-"));
	const hostSource = path.join(directory, "host.ts");
	const hostBinary = path.join(directory, process.platform === "win32" ? "host.exe" : "host");
	const childSource = path.join(directory, "child.ts");
	const toolPath = path.resolve(import.meta.dir, "tui.ts");
	const cwd = path.resolve(import.meta.dir, "..", "..");

	await Bun.write(childSource, `console.log("\\x1b[48;2;18;52;86mready\\x1b[0m"); await Bun.sleep(60_000);\n`);
	await Bun.write(
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
	const shot = await tool.execute("compiled-host-test", { op: "shot", name });
	const image = shot.content.find((part) => part.type === "image");
	if (!image) throw new Error("screenshot did not return an image");
	console.log(JSON.stringify(image));
	const saved = shot.content.find((part) => part.type === "text");
	if (saved?.text.startsWith("screenshot saved: ")) {
		await Bun.file(saved.text.slice("screenshot saved: ".length)).delete();
	}
} finally {
	if (started) await tool.execute("compiled-host-test", { op: "stop", name }).catch(() => {});
}
`,
	);

	try {
		const compile = Bun.spawn([process.execPath, "build", "--compile", hostSource, "--outfile", hostBinary], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [compileExit, compileStdout, compileStderr] = await Promise.all([
			compile.exited,
			new Response(compile.stdout).text(),
			new Response(compile.stderr).text(),
		]);
		expect(compileExit, `${compileStdout}${compileStderr}`).toBe(0);

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
		expect(runExit, stderr).toBe(0);
		expect(stdout).toContain("ready");
		const image: { type: string; data: string; mimeType: string } = JSON.parse(stdout.trim().split("\n").at(-1)!);
		expect(image.mimeType).toBe("image/png");
		const decoded = await loadImage(Buffer.from(image.data, "base64"));
		expect([decoded.width, decoded.height]).toEqual([640, 256]);
		const canvas = createCanvas(decoded.width, decoded.height);
		const context = canvas.getContext("2d");
		context.drawImage(decoded, 0, 0);
		expect([...context.getImageData(1, 1, 1, 1).data]).toEqual([18, 52, 86, 255]);
		expect([...context.getImageData(639, 255, 1, 1).data]).toEqual([16, 20, 24, 255]);
	} finally {
		await fs.promises.rm(directory, { recursive: true, force: true });
	}
}, 20_000);
