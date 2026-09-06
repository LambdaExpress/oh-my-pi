import { expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import createTool, { Screen, type TuiParams } from "./tui";

interface TestSchema {
	describe(): TestSchema;
	optional(): TestSchema;
}

const schema: TestSchema = {
	describe() {
		return schema;
	},
	optional() {
		return schema;
	},
};

function testTool() {
	return createTool({
		cwd: path.resolve(import.meta.dir, "../.."),
		zod: {
			object: () => schema,
			string: () => schema,
			boolean: () => schema,
			number: () => schema,
			array: () => schema,
		},
	});
}

type Execute = (params: TuiParams) => Promise<{
	content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
	details?: Record<string, unknown>;
}>;

async function withChild(
	source: string,
	run: (execute: Execute, shutdown: () => Promise<void>) => Promise<void>,
): Promise<void> {
	const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-tui-lifecycle-"));
	const name = path.basename(directory);
	const file = path.join(directory, "child.ts");
	const tool = testTool();
	const execute: Execute = params => tool.execute("lifecycle-test", { name, file, ...params });
	try {
		await Bun.write(file, source);
		await run(execute, () => tool.onSession({ reason: "shutdown" }));
	} finally {
		await execute({ op: "stop" }).catch(() => {});
		await fs.promises.rm(directory, { recursive: true, force: true });
	}
}

function debugHost(handle: string, setup = ""): string {
	return `
import { createServer } from "node:net";
${setup}
const server = createServer(socket => {
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("error", () => {});
	socket.on("data", chunk => {
		buffer += chunk;
		for (;;) {
			const newline = buffer.indexOf("\\n");
			if (newline < 0) return;
			const request = JSON.parse(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
			const reply = response => {
				if (!socket.destroyed) socket.write(JSON.stringify(response) + "\\n");
			};
			if (request.op === "quit") {
				socket.end('{"ok":true}\\n', () => process.exit(0));
				return;
			}
			${handle}
		}
	});
});
server.listen(process.env.OMP_TUI_DEBUG);
process.stdin.resume();
process.stdin.on("data", data => {
	if (data.includes(3)) process.exit(0);
});
if (process.stdin.isTTY) process.stdin.setRawMode(true);
`;
}

test("start waits for a painted protocol response before text queries can use the session", async () => {
	await withChild(
		debugHost(`
		if (request.op === "text") {
			setTimeout(() => reply({ ok: true, lines: ["painted viewport"], window_top: 0 }), 100);
		}
	`),
		async execute => {
			const started = await execute({ op: "start", timeout: 3 });
			expect(started.content).toContainEqual({
				type: "text",
				text: expect.stringContaining("painted viewport"),
			});
			const text = await execute({ op: "text" });
			expect(text.details?.lines).toEqual(["painted viewport"]);
		},
	);
}, 5_000);

test("a sibling tool shutdown cannot dispose another owner's terminal", async () => {
	await withChild(
		debugHost('if (request.op === "text") reply({ ok: true, lines: ["owner still running"], window_top: 0 });'),
		async execute => {
			await execute({ op: "start", timeout: 3 });
			await testTool().onSession({ reason: "shutdown" });
			const result = await execute({ op: "text" });
			expect(result.content[0]).toMatchObject({
				type: "text",
				text: expect.stringContaining("owner still running"),
			});
		},
	);
}, 5_000);

test("concurrent stop and owner shutdown release the same terminal once", async () => {
	await withChild(
		debugHost('if (request.op === "text") reply({ ok: true, lines: ["ready"], window_top: 0 });'),
		async (execute, shutdown) => {
			await execute({ op: "start", timeout: 3 });
			const [first, second] = await Promise.all([execute({ op: "stop" }), execute({ op: "stop" }), shutdown()]);
			for (const result of [first, second]) {
				expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("(exit 0)") });
			}
			await expect(execute({ op: "screen" })).rejects.toThrow(/no session/);
			await expect(execute({ op: "start" })).rejects.toThrow(/shutting down/);
		},
	);
}, 5_000);

test("queued PTY output after stop cannot reach disposed or replacement terminals", async () => {
	type DataCallback = (terminal: unknown, chunk: Uint8Array) => void;
	const callbacks: DataCallback[] = [];
	const spawn = new Proxy(Bun.spawn, {
		apply(original, receiver, args) {
			const options = (Array.isArray(args[0]) ? args[1] : args[0]) as {
				terminal?: { data?: DataCallback };
			};
			if (options?.terminal?.data) callbacks.push(options.terminal.data);
			return Reflect.apply(original, receiver, args);
		},
	});
	const spy = vi.spyOn(Bun, "spawn").mockImplementation(spawn);
	try {
		await withChild(
			debugHost(
				'if (request.op === "text") reply({ ok: true, lines: ["ready"], window_top: 0 });',
				'process.stdout.write("fresh terminal\\r\\n");',
			),
			async execute => {
				await execute({ op: "start", timeout: 3 });
				const lateOutput = callbacks.at(-1)!;
				await execute({ op: "stop" });
				lateOutput(undefined, Buffer.from("OLD SESSION OUTPUT\r\n\x1b[6n"));
				await execute({ op: "start", timeout: 3 });
				lateOutput(undefined, Buffer.from("OLD SESSION OUTPUT\r\n"));
				const result = await execute({ op: "screen" });
				expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("fresh terminal") });
				expect(result.content[0]).toMatchObject({
					type: "text",
					text: expect.not.stringContaining("OLD SESSION OUTPUT"),
				});
			},
		);
	} finally {
		spy.mockRestore();
	}
}, 8_000);

test("start reconnects when the startup debug server is replaced before its first response", async () => {
	await withChild(
		debugHost(
			`
		if (request.op === "text") {
			if (restarting) {
				restarting = false;
				socket.destroy();
				server.close(() => setTimeout(() => server.listen(process.env.OMP_TUI_DEBUG), 50));
			} else {
				reply({ ok: true, lines: ["restarted viewport"], window_top: 0 });
			}
		}
	`,
			"let restarting = true;",
		),
		async execute => {
			const started = await execute({ op: "start", timeout: 3 });
			expect(started.content[0]).toMatchObject({
				type: "text",
				text: expect.stringContaining("restarted viewport"),
			});
			const text = await execute({ op: "text" });
			expect(text.details?.lines).toEqual(["restarted viewport"]);
		},
	);
}, 5_000);

test("startup does not retry a malformed protocol response as a server restart", async () => {
	await withChild(
		debugHost(`
		if (request.op === "text") socket.write("not JSON\\n");
	`),
		async execute => {
			await expect(execute({ op: "start", timeout: 3 })).rejects.toThrow("bad response line");
			await expect(execute({ op: "info" })).rejects.toThrow("has no debug socket");
		},
	);
}, 5_000);

test("startup reports process exit instead of retrying its closed socket until the deadline", async () => {
	await withChild(
		debugHost(`
		if (request.op === "text") process.exit(7);
	`),
		async execute => {
			await expect(execute({ op: "start", timeout: 15 })).rejects.toThrow("exit 7");
		},
	);
}, 5_000);

test("start bounds protocol readiness by its deadline instead of reporting an unpainted viewport", async () => {
	await withChild(
		debugHost(`
		if (request.op === "text") reply({ ok: false, error: "no frame painted yet" });
	`),
		async execute => {
			await expect(execute({ op: "start", timeout: 0.5 })).rejects.toThrow("debug protocol readiness failed");
			const screen = await execute({ op: "screen" });
			expect(screen.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("screen 100x30") });
		},
	);
}, 5_000);

test("start includes the initial protocol response in its timeout", async () => {
	await withChild(
		debugHost(`
		if (request.op === "text") {
			setTimeout(() => reply({ ok: true, lines: ["late viewport"], window_top: 0 }), 800);
		}
	`),
		async execute => {
			await expect(execute({ op: "start", timeout: 0.5 })).rejects.toThrow("debug protocol readiness failed");
			await expect(execute({ op: "info" })).rejects.toThrow("has no debug socket");
		},
	);
}, 5_000);

test("quiet quit keys acknowledge a real TUI shutdown instead of timing out", async () => {
	const tuiPath = path.resolve(import.meta.dir, "../../packages/tui/src/index.ts");
	await withChild(
		`
		import { ProcessTerminal, Text, TUI } from ${JSON.stringify(tuiPath)};
		const tui = new TUI(new ProcessTerminal());
		tui.addChild(new Text("ready to quit"));
		tui.addInputListener(data => {
			if (data === "q") tui.stop();
			return { consume: true };
		});
		tui.start();
	`,
		async execute => {
			await execute({ op: "start", timeout: 3 });
			const quit = await execute({ op: "keys", keys: "q", quiet: true });
			expect(quit.details).toEqual({ ok: true, injected: 1 });
			const stopped = await execute({ op: "stop" });
			expect(stopped.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("(exit 0)") });
		},
	);
}, 5_000);

for (const exit of [0, 7]) {
	test(`quiet input distinguishes an immediate process exit ${exit} from an acknowledgement`, async () => {
		const tuiPath = path.resolve(import.meta.dir, "../../packages/tui/src/index.ts");
		await withChild(
			`
			import { ProcessTerminal, Text, TUI } from ${JSON.stringify(tuiPath)};
			const tui = new TUI(new ProcessTerminal());
			tui.addChild(new Text("ready to quit immediately"));
			tui.addInputListener(data => {
				if (data === "q") {
					tui.stop();
					process.exit(${exit});
				}
				return { consume: true };
			});
			tui.start();
		`,
			async execute => {
				await execute({ op: "start", timeout: 3 });
				if (exit === 0) {
					const quit = await execute({ op: "keys", keys: "q", quiet: true });
					expect(quit.details).toEqual({ ok: true, exit: 0, acknowledged: false });
					expect(quit.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("exit 0") });
					await expect(execute({ op: "keys", keys: "q", quiet: true })).rejects.toThrow("already exited");
				} else {
					await expect(execute({ op: "keys", keys: "q", quiet: true })).rejects.toThrow("exit 7");
				}
				const stopped = await execute({ op: "stop" });
				expect(stopped.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(`(exit ${exit})`) });
			},
		);
	}, 5_000);
}

test("a closed debug connection rejects every pending request without waiting for request timeouts", async () => {
	await withChild(
		debugHost(`
		if (request.op === "text") reply({ ok: true, lines: ["ready"], window_top: 0 });
		if (request.op === "values") socket.destroy();
	`),
		async execute => {
			await execute({ op: "start", timeout: 3 });
			const results = await Promise.allSettled([execute({ op: "info" }), execute({ op: "values" })]);
			for (const result of results) {
				expect(result.status).toBe("rejected");
				if (result.status === "rejected") expect(String(result.reason)).toContain("debug socket closed");
			}
		},
	);
}, 5_000);

test("a timed-out request invalidates the connection so a late response cannot answer another request", async () => {
	await withChild(
		debugHost(`
		if (request.op === "text") reply({ ok: true, lines: ["ready"], window_top: 0 });
		if (request.op === "info") {
			setTimeout(() => reply({ ok: true, pid: 123 }), 10_200);
		}
		if (request.op === "values") {
			setTimeout(() => reply({ ok: true, values: { actual: true } }), 400);
		}
	`),
		async execute => {
			await execute({ op: "start", timeout: 3 });
			await expect(execute({ op: "info" })).rejects.toThrow("debug request timed out");
			// The late info response arrives before the values response. It must
			// never resolve a newly submitted values request as if it were its own.
			await expect(execute({ op: "values" })).rejects.toThrow("has no debug socket");
		},
	);
}, 18_000);

test.skipIf(process.platform !== "win32")(
	"Windows screenshots distinguish CJK, box drawing and actual TUI icons from missing-glyph boxes",
	async () => {
		const pairs = [
			["欢", "迎"],
			["╭", "┐"],
			["⎋", "⎇"],
			["⠋", "⠙"],
			["👻", "📁"],
		];
		if (GlobalFonts.families.some(({ family }) => /nerd font|\bNF[MP]?$/i.test(family))) {
			pairs.push(["\uf00c", "\uf071"], ["\u{f12b7}", "\u{f02a0}"]);
		}
		const glyphs = pairs.flat();
		const screen = await Screen.create(4, glyphs.length + 1);
		try {
			screen.feed(Buffer.from(`\x1b[?25l${glyphs.join("\r\n")}`));
			const image = await loadImage(await screen.png());
			const canvas = createCanvas(image.width, image.height);
			const context = canvas.getContext("2d");
			context.drawImage(image, 0, 0);
			const masks = glyphs.map((_, index) => Buffer.from(context.getImageData(0, index * 32, 64, 32).data));
			for (let index = 0; index < pairs.length; index++) {
				expect(masks[index * 2].equals(masks[index * 2 + 1]), `missing glyphs: ${pairs[index].join(" / ")}`).toBe(
					false,
				);
			}
		} finally {
			screen.dispose();
		}
	},
);

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
