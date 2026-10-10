import { describe, expect, it } from "bun:test";
import { $which, TempDir } from "@oh-my-pi/pi-utils";
import { type KernelDisplayOutput, PythonKernel } from "../../../src/eval/py/kernel";
import { PYTHON_PRELUDE } from "../../../src/eval/py/prelude";
const pythonPath =
	Bun.env.PYTHON ??
	(process.platform === "win32" ? ($which("python") ?? $which("python3")) : ($which("python3") ?? $which("python"))) ??
	"python";

async function runPrelude(
	code: string,
	env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const prelude = PYTHON_PRELUDE.replace(
		"from __future__ import annotations",
		"from __future__ import annotations\n__omp_display = lambda *args, **kwargs: None",
	);
	const script = `${prelude}\n${code}`;
	// The full prelude exceeds Windows' ~32k `python -c` command-line limit
	// (ENAMETOOLONG); a script file behaves identically on every platform.
	const dir = await TempDir.create("@omp-py-prelude-");
	try {
		const scriptPath = dir.join("script.py");
		await Bun.write(scriptPath, script);
		const proc = Bun.spawn([pythonPath, scriptPath], {
			cwd: dir.absolute(),
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, ...env },
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		// Python's text-mode stdout emits \r\n on Windows.
		return { stdout: stdout.replaceAll("\r\n", "\n"), stderr: stderr.replaceAll("\r\n", "\n"), exitCode };
	} finally {
		await dir.remove();
	}
}

describe("python prelude", () => {
	it("preserves unsafe integer identities in structured display without changing Python values", async () => {
		using dir = TempDir.createSync("@omp-py-display-");
		const kernel = await PythonKernel.start({ cwd: dir.absolute(), interpreter: pythonPath });
		const outputs: KernelDisplayOutput[] = [];
		let text = "";
		try {
			const result = await kernel.execute(
				[
					"file_id = 137193637465486999",
					"payload = {'fileID': file_id, 'negative': -file_id, 'nested': {'values': [(True, False, 0, 1.5, None)], 'safe': [2**53 - 1, -(2**53 - 1)], 'boundaries': [2**53, 2**53 + 1, -2**53, -(2**53 + 1)]}}",
					"nested = payload['nested']",
					"values = nested['values']",
					"flags = values[0]",
					"print('Exact Python integer:', file_id)",
					"display(payload)",
					"assert payload['nested'] is nested and nested['values'] is values and values[0] is flags",
					"assert type(payload['fileID']) is int and payload['fileID'] == file_id",
					"assert type(payload['negative']) is int and payload['negative'] == -file_id",
					"assert nested['safe'] == [2**53 - 1, -(2**53 - 1)]",
					"assert all(type(value) is int for value in nested['boundaries'])",
					"assert nested['boundaries'] == [2**53, 2**53 + 1, -2**53, -(2**53 + 1)]",
					"assert type(flags) is tuple and flags[0] is True and flags[1] is False",
				].join("\n"),
				{
					timeoutMs: 10_000,
					onChunk: chunk => {
						text += chunk;
					},
					onDisplay: output => {
						outputs.push(output);
					},
				},
			);

			expect(result.status).toBe("ok");
			expect(text).toBe(
				"Exact Python integer: 137193637465486999\n" +
					"{'fileID': 137193637465486999, 'negative': -137193637465486999, 'nested': {'values': [(True, False, 0, 1.5, None)], 'safe': [9007199254740991, -9007199254740991], 'boundaries': [9007199254740992, 9007199254740993, -9007199254740992, -9007199254740993]}}\n",
			);
			expect(outputs).toEqual([
				{
					type: "json",
					data: {
						fileID: "137193637465486999",
						negative: "-137193637465486999",
						nested: {
							values: [[true, false, 0, 1.5, null]],
							safe: [Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER],
							boundaries: ["9007199254740992", "9007199254740993", "-9007199254740992", "-9007199254740993"],
						},
					},
				},
			]);
		} finally {
			await kernel.shutdown();
		}
	});

	it.each([
		{ name: "LF", content: "alpha\n中文\n", local: false },
		{ name: "CRLF", content: "alpha\r\n中文\r\n", local: true },
		{ name: "混合换行", content: "alpha\n中文\r\nbeta\rgamma\n", local: true },
	])("逐字节保留 $name 文本并创建父目录", async ({ content, local }) => {
		using dir = TempDir.createSync("@omp-py-write-");
		const root = dir.join("local");
		const expectedPath = local ? dir.join("local", "nested", "contents.txt") : dir.join("nested", "contents.txt");
		const helperPath = local ? "local://nested/contents.txt" : expectedPath;
		const result = await runPrelude(`write(${JSON.stringify(helperPath)}, ${JSON.stringify(content)})`, {
			PI_EVAL_LOCAL_ROOTS: JSON.stringify({ local: root }),
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(Buffer.from(await Bun.file(expectedPath).arrayBuffer())).toEqual(Buffer.from(content, "utf8"));
	});

	it("writefile 将解析后的 LF 正文按 UTF-8 原样写入", async () => {
		using dir = TempDir.createSync("@omp-py-writefile-");
		const kernel = await PythonKernel.start({ cwd: dir.absolute(), interpreter: pythonPath });
		try {
			const result = await kernel.execute("%%writefile nested/contents.txt\nalpha\n中文", { timeoutMs: 10_000 });
			expect(result.status).toBe("ok");
			expect(Buffer.from(await Bun.file(dir.join("nested", "contents.txt")).arrayBuffer())).toEqual(
				Buffer.from("alpha\n中文", "utf8"),
			);
		} finally {
			await kernel.shutdown();
		}
	});

	it("infers eval tool schemas and replaces definitions by name", async () => {
		const result = await runPrelude(
			[
				"from typing import Annotated, Literal, Optional",
				"@tool",
				"def word_count(text: Annotated[str, 'Text to split'], sep: Literal[' ', ','] = ' ', limit: Optional[int] = None) -> dict:",
				'    """Count words in text."""',
				"    return {'count': len(text.split(sep))}",
				"first = __omp_tools__['word_count'].describe()",
				"@tool(name='word_count', description='Replacement')",
				"def replacement(text: str) -> dict:",
				"    return {'count': 1}",
				"print(json.dumps({'first': first, 'current': __omp_tools__['word_count'].describe(), 'defined': tool.defined()}, sort_keys=True))",
				"print(tool.undefine('word_count'), tool.defined())",
			].join("\n"),
			{},
		);

		expect(result.exitCode).toBe(0);
		const lines = result.stdout.trim().split("\n");
		const value = JSON.parse(lines[0] ?? "{}");
		expect(value.first).toEqual({
			name: "word_count",
			description: "Count words in text.",
			parameters: {
				type: "object",
				properties: {
					text: { type: "string", description: "Text to split" },
					sep: { enum: [" ", ","], default: " " },
					limit: { anyOf: [{ type: "integer" }, { type: "null" }], default: null },
				},
				required: ["text"],
				additionalProperties: false,
			},
		});
		expect(value.current.description).toBe("Replacement");
		expect(value.defined).toEqual(["word_count"]);
		expect(lines[1]).toBe("True []");
	});

	it("appends line selectors to delegated URI paths", async () => {
		const requests: unknown[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				requests.push(await request.json());
				return Response.json({
					ok: true,
					value: { text: "resource contents", details: { resolvedPath: "/tmp/resource.txt" } },
				});
			},
		});

		try {
			const result = await runPrelude(
				[`print(read("artifact://21", 3, 2))`, `print(read("mcp://server/resource", 10, 5))`].join("\n"),
				{
					PI_TOOL_BRIDGE_URL: server.url.toString(),
					PI_TOOL_BRIDGE_TOKEN: "test-token",
					PI_TOOL_BRIDGE_SESSION: "test-session",
				},
			);

			expect(result).toEqual({
				stdout: "resource contents\nresource contents\n",
				stderr: "",
				exitCode: 0,
			});
			expect(requests).toEqual([
				{
					session: "test-session",
					run: null,
					name: "read",
					args: { path: "artifact://21:3-4" },
				},
				{
					session: "test-session",
					run: null,
					name: "read",
					args: { path: "mcp://server/resource:10-14" },
				},
			]);
		} finally {
			server.stop(true);
		}
	});

	it("bypasses discovered proxies for loopback bridge calls", async () => {
		let proxyRequests = 0;
		const bridge = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				const body = (await request.json()) as { name?: string; args?: { path?: string } };
				return Response.json({
					ok: true,
					value: body.args?.path,
				});
			},
		});
		const proxy = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => {
				proxyRequests++;
				return new Response("proxy intercepted", { status: 502 });
			},
		});

		try {
			const proxyUrl = proxy.url.toString();
			// urllib also reads macOS SystemConfiguration; environment injection
			// is the hermetic equivalent for this subprocess test.
			const result = await runPrelude(
				[
					"async def main():",
					'    paths = ["one.ts", "two.ts", "three.ts"]',
					"    results = []",
					"    for path in paths:",
					'        results.append(await tool.read({"path": path}))',
					"    print(results)",
					"asyncio.run(main())",
				].join("\n"),
				{
					PI_TOOL_BRIDGE_URL: bridge.url.toString(),
					PI_TOOL_BRIDGE_TOKEN: "test-token",
					PI_TOOL_BRIDGE_SESSION: "test-session",
					HTTP_PROXY: proxyUrl,
					http_proxy: proxyUrl,
					ALL_PROXY: proxyUrl,
					all_proxy: proxyUrl,
					NO_PROXY: "",
					no_proxy: "",
				},
			);

			expect(result).toEqual({
				stdout: "['one.ts', 'two.ts', 'three.ts']\n",
				stderr: "",
				exitCode: 0,
			});
			expect(proxyRequests).toBe(0);
		} finally {
			bridge.stop(true);
			proxy.stop(true);
		}
	});
});
