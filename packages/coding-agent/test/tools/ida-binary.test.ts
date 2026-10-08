import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgIdaAvailable, cfgIdaInstall } from "@oh-my-pi/pi-coding-agent/ida/install";
import { IdaUnavailableError } from "@oh-my-pi/pi-coding-agent/ida/runtime";
import {
	isExecutableFile,
	isExecutableHeader,
	parseFatSlices,
	selectSlice,
	splitSliceRef,
} from "@oh-my-pi/pi-coding-agent/ida/store";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { type BinaryView, parseBinaryView, resolveBinaryViewPath } from "@oh-my-pi/pi-coding-agent/tools/read-binary";
import { $which } from "@oh-my-pi/pi-utils";

function peHeader(offset = 0x80): Uint8Array {
	const bytes = new Uint8Array(offset + 4);
	bytes.set([0x4d, 0x5a]);
	new DataView(bytes.buffer).setUint32(0x3c, offset, true);
	bytes.set([0x50, 0x45, 0, 0], offset);
	return bytes;
}

describe("isExecutableHeader", () => {
	const cases: Array<[string, number[], boolean]> = [
		["ELF", [0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00], true],
		["8-byte MZ blob", [0x4d, 0x5a, 0xff, 0xfe, 0xc0, 0xc0, 0x90, 0x91], false],
		["Mach-O 32 BE", [0xfe, 0xed, 0xfa, 0xce, 0, 0, 0, 0], true],
		["Mach-O 32 LE", [0xce, 0xfa, 0xed, 0xfe, 0, 0, 0, 0], true],
		["Mach-O 64 BE", [0xfe, 0xed, 0xfa, 0xcf, 0, 0, 0, 0], true],
		["Mach-O 64 LE", [0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0], true],
		["fat Mach-O, nfat_arch=2", [0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x02], true],
		["Java 8 class", [0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34], false],
		["PNG", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], false],
		["shorter than 4 bytes", [0x7f, 0x45, 0x4c], false],
	];
	for (const [name, bytes, expected] of cases) {
		it(`${name} → ${expected}`, () => {
			expect(isExecutableHeader(new Uint8Array(bytes))).toBe(expected);
		});
	}

	it.each([64, 65, 0x80, 0x1000, 0x10000])("识别 e_lfanew=%i 的 PE DOS 头", offset => {
		const bytes = peHeader(offset);
		expect(isExecutableHeader(bytes)).toBe(true);
		expect(isExecutableHeader(bytes.subarray(0, 64))).toBe(true);
		expect(isExecutableHeader(bytes.subarray(0, 63))).toBe(false);
	});

	it("拒绝指向 DOS 头内部的 PE 偏移", () => {
		const bytes = peHeader();
		const view = new DataView(bytes.buffer);
		for (const offset of [0, 63]) {
			view.setUint32(0x3c, offset, true);
			expect(isExecutableHeader(bytes)).toBe(false);
		}
	});
});

describe("二进制文件与视图选择器", () => {
	let testDir: string;
	let session: ToolSession;
	let nativePath: string;

	beforeAll(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "ida-binary-"));
		session = {
			cwd: testDir,
			hasUI: false,
			getSessionFile: () => path.join(testDir, "session.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(testDir, "session"),
			settings: Settings.isolated({ "ida.enabled": false }),
		};
		nativePath = path.join(testDir, "native.dll");
		await Bun.write(nativePath, peHeader(0x5000));
	});

	afterAll(async () => {
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("完整 DOS 头即可识别 PE，不会因较长 DOS stub 漏掉视图路由", async () => {
		expect(await isExecutableFile(nativePath)).toBe(true);
	});

	it("拒绝磁盘上不存在、DOS 头截断或偏移无效的文件", async () => {
		const truncatedPath = path.join(testDir, "truncated.dll");
		await Bun.write(truncatedPath, peHeader(0x1000).subarray(0, 63));
		const invalidPath = path.join(testDir, "invalid.dll");
		const bytes = peHeader(0x4000);
		new DataView(bytes.buffer).setUint32(0x3c, 63, true);
		await Bun.write(invalidPath, bytes);
		expect(await isExecutableFile(truncatedPath)).toBe(false);
		expect(await isExecutableFile(invalidPath)).toBe(false);
		expect(await isExecutableFile(path.join(testDir, "missing.dll"))).toBe(false);
	});

	it("IDA 关闭时也识别有效 PE 的 imports 选择器，并如实报告不可用", async () => {
		const target = await resolveBinaryViewPath(session, `${nativePath}:imports`);
		expect(target).toEqual({ absolutePath: nativePath, view: "imports" });
		await expect(
			new ReadTool(session).execute("binary-imports-disabled", { path: `${nativePath}:imports:1-25` }),
		).rejects.toBeInstanceOf(IdaUnavailableError);
	});

	it("保留托管方法名称中的双冒号和末尾 asm 视图", async () => {
		const managedPath = path.join(testDir, "managed.dll");
		await Bun.write(managedPath, peHeader());
		const view = "VRC.Core.ConfigManager::Initialize:asm";
		expect(await resolveBinaryViewPath(session, `${managedPath}:${view}`)).toEqual({
			absolutePath: managedPath,
			view,
		});
	});

	it("无扩展名的可执行文件也支持视图选择器", async () => {
		const extensionlessPath = path.join(testDir, "native");
		await Bun.write(extensionlessPath, peHeader());
		expect(await resolveBinaryViewPath(session, `${extensionlessPath}:exports`)).toEqual({
			absolutePath: extensionlessPath,
			view: "exports",
		});
	});

	it("完整字面文件或现存 NTFS 流优先于已存在二进制的选择器", async () => {
		const binaryPath = path.join(testDir, "literal.dll");
		await Bun.write(binaryPath, peHeader());
		const literalPath = `${binaryPath}:imports`;
		await Bun.write(literalPath, "literal filename");
		expect(await resolveBinaryViewPath(session, literalPath)).toBeNull();
		const result = await new ReadTool(session).execute("binary-literal", { path: literalPath });
		const text = result.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n");
		expect(text).toContain("literal filename");
	});
});

/** Big-endian fat header; each entry is `[cputype, cpusubtype, offset, size]`. */
function fatHeader(entries: Array<[number, number, number, number]>, { is64 = false } = {}): Uint8Array {
	const entrySize = is64 ? 32 : 20;
	const view = new DataView(new ArrayBuffer(8 + entries.length * entrySize));
	view.setUint32(0, is64 ? 0xcafebabf : 0xcafebabe);
	view.setUint32(4, entries.length);
	entries.forEach(([cpuType, subtype, offset, size], i) => {
		const at = 8 + i * entrySize;
		view.setUint32(at, cpuType);
		view.setUint32(at + 4, subtype);
		if (is64) {
			view.setBigUint64(at + 8, BigInt(offset));
			view.setBigUint64(at + 16, BigInt(size));
		} else {
			view.setUint32(at + 8, offset);
			view.setUint32(at + 12, size);
		}
	});
	return new Uint8Array(view.buffer);
}

describe("universal Mach-O slices", () => {
	// Mirrors macOS 27 /usr/bin/yes: x86_64, arm64e (pointer-auth capability bit set), and an arm64 subtype lipo cannot name.
	const yes = fatHeader([
		[0x01000007, 3, 0x4000, 0x100],
		[0x0100000c, 0x80000002, 0x110000, 0x200],
		[0x0100000c, 0x8000000c, 0x224000, 0x200],
	]);

	it("names slices like lipo, masking capability bits", () => {
		expect(parseFatSlices(yes)?.map(s => s.arch)).toEqual(["x86_64", "arm64e", "arm64.12"]);
	});

	it("reads 64-bit fat_arch offsets", () => {
		const slices = parseFatSlices(fatHeader([[0x0100000c, 0, 0x1_0000_0000, 0x10]], { is64: true }));
		expect(slices).toEqual([{ arch: "arm64", cpuType: 0x0100000c, offset: 0x1_0000_0000, size: 0x10 }]);
	});

	it("rejects a slice table cut short", () => {
		expect(parseFatSlices(yes.subarray(0, yes.length - 1))).toBeNull();
	});

	it("defaults to the host CPU slice rather than the first", () => {
		const slices = parseFatSlices(yes) ?? [];
		const expected = process.arch === "arm64" ? "arm64e" : "x86_64";
		expect(selectSlice(slices).arch).toBe(expected);
	});

	it("lists available slices for an unknown arch", () => {
		expect(() => selectSlice(parseFatSlices(yes) ?? [], "ppc")).toThrow("no ppc slice; available: x86_64, arm64e");
	});

	it("splits a trailing :@arch off a db reference", () => {
		expect(splitSliceRef("bin/yes:@x86_64")).toEqual({ path: "bin/yes", arch: "x86_64" });
		expect(splitSliceRef("bin/yes")).toEqual({ path: "bin/yes" });
		expect(() => splitSliceRef("bin/yes:@")).toThrow("empty slice name");
	});
});

describe("parseBinaryView", () => {
	const cases: Array<[string, BinaryView]> = [
		["", { kind: "overview" }],
		["imports", { kind: "imports" }],
		["main:asm", { kind: "asm", target: "main" }],
		["xrefs:0x401000", { kind: "xrefs", target: "0x401000" }],
		["sub_1000", { kind: "pseudocode", target: "sub_1000" }],
	];
	for (const [view, expected] of cases) {
		it(`${JSON.stringify(view)} → ${expected.kind}`, () => {
			expect(parseBinaryView(view)).toEqual(expected);
		});
	}

	it("rejects xrefs without a target", () => {
		expect(() => parseBinaryView("xrefs:")).toThrow("xrefs needs a target");
	});
});

describe("IDA availability", () => {
	let withIdalib: string;
	let withoutIdalib: string;

	beforeAll(async () => {
		withIdalib = await fs.mkdtemp(path.join(os.tmpdir(), "ida-install-"));
		withoutIdalib = await fs.mkdtemp(path.join(os.tmpdir(), "ida-empty-"));
		for (const lib of ["libidalib.dylib", "libidalib.so", "idalib.dll"]) {
			await Bun.write(path.join(withIdalib, lib), "");
		}
	});

	afterAll(async () => {
		await fs.rm(withIdalib, { recursive: true, force: true });
		await fs.rm(withoutIdalib, { recursive: true, force: true });
	});

	it("exposes IDA when the configured install ships idalib", () => {
		const settings = Settings.isolated({ "ida.installDir": withIdalib });
		expect(cfgIdaInstall.get(settings)).toBe(withIdalib);
		expect(cfgIdaAvailable.get(settings)).toBe(true);
	});

	it("hides IDA when the configured install lacks idalib, without falling back", () => {
		expect(cfgIdaAvailable.get(Settings.isolated({ "ida.installDir": withoutIdalib }))).toBe(false);
	});

	it("hides IDA when disabled even with a valid install", () => {
		expect(cfgIdaAvailable.get(Settings.isolated({ "ida.enabled": false, "ida.installDir": withIdalib }))).toBe(
			false,
		);
	});
});

const pythonPath =
	Bun.env.PYTHON ??
	(process.platform === "win32" ? ($which("python") ?? $which("python3")) : ($which("python3") ?? $which("python")));

describe.skipIf(!pythonPath)("IDA worker response protocol", () => {
	async function runWorker(mode: string, requests: object[] = []): Promise<unknown[]> {
		if (!pythonPath) throw new Error("Python is unavailable");
		const child = Bun.spawn(
			[
				pythonPath,
				"-u",
				path.resolve(import.meta.dir, "../fixtures/ida-worker-protocol.py"),
				path.resolve(import.meta.dir, "../../src/ida/worker.py"),
				mode,
			],
			{
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" },
				timeout: 10_000,
			},
		);
		child.stdin.write(requests.map(request => `${JSON.stringify(request)}\n`).join(""));
		await child.stdin.end();
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(stdout.endsWith("\n")).toBe(true);
		return Bun.JSONL.parse(stdout);
	}

	it("returns complete consecutive success and error frames without pthread_sigmask despite late SIGINT", async () => {
		const frames = await runWorker("requests", [
			{ id: 1, method: "exec", params: { code: "print('你好\\nsecond line'); total = 6 * 7; total" } },
			{ id: 2, method: "view", params: { kind: "overview" } },
			{ id: 3, method: "exec", params: { code: "total + 1" } },
			{ id: 4, method: "close", params: { save: false } },
		]);
		expect(frames).toEqual([
			{ id: 1, ok: true, result: { output: "你好\nsecond line\n", value: "42", error: null }, dirty: false },
			{ id: 2, ok: false, error: { type: "RuntimeError", message: "no IDA database open" } },
			{ id: 3, ok: true, result: { output: "", value: "43", error: null }, dirty: false },
			{ id: 4, ok: true, result: { closed: true, saved: false } },
		]);
	});

	it.each(["pseudocode-native", "pseudocode-managed-supported"])(
		"以正确 SDK 绑定生成伪代码并清除颜色标签：%s",
		async mode => {
			const name = mode === "pseudocode-native" ? "read_value" : "Example::Read";
			expect(await runWorker(mode)).toEqual([
				{
					text: `// ${name} @ 0x1000-0x1003\nint read_value(void)\n{\n    return 1;\n}`,
					sigint_restored: true,
				},
			]);
		},
	);

	it.each(["pseudocode-managed", "pseudocode-badarch"])("托管处理器不受支持时保留 IL 与可操作说明：%s", async mode => {
		const [result] = (await runWorker(mode)) as Array<{ text: string; sigint_restored: boolean }>;
		expect(result?.sigint_restored).toBe(true);
		expect(result?.text).toContain("cli");
		expect(result?.text).toContain("ILSpy");
		expect(result?.text.endsWith("0x1000  ldc.i4.1\n0x1001  stloc.0\n0x1002  ret")).toBe(true);
		expect(result?.text).not.toContain("TypeError");
		expect(result?.text).not.toContain("hexrays_failure_t");
	});

	it("原生反编译失败时保留 SDK 原因、错误地址及反汇编", async () => {
		const [result] = (await runWorker("pseudocode-failure")) as Array<{ text: string; sigint_restored: boolean }>;
		expect(result?.sigint_restored).toBe(true);
		const failureLine = result?.text.split("\n").find(line => line.includes("cannot convert to microcode"));
		expect(failureLine).toContain("0x1001");
		expect(result?.text.endsWith("0x1000  mov eax, 1\n0x1001  nop\n0x1002  ret")).toBe(true);
	});

	it("原生处理器缺少反编译器时显示反汇编而非绑定错误", async () => {
		const [result] = (await runWorker("pseudocode-unavailable")) as Array<{ text: string; sigint_restored: boolean }>;
		expect(result?.sigint_restored).toBe(true);
		expect(result?.text).toContain("metapc");
		expect(result?.text.endsWith("0x1000  mov eax, 1\n0x1001  nop\n0x1002  ret")).toBe(true);
		expect(result?.text).not.toContain("hexrays_failure_t");
	});

	it.each(["pseudocode-interrupt", "pseudocode-canceled"])("中断不能降级为成功的反汇编：%s", async mode => {
		expect(await runWorker(mode)).toEqual([{ interrupted: true, sigint_restored: true }]);
	});

	it("restores the previous SIGINT handler after successful output and a broken protocol pipe", async () => {
		expect(await runWorker("restore")).toEqual([
			{ after_success: 1, after_failure: 2, failure: "protocol pipe closed" },
		]);
	});

	it.skipIf(process.platform === "win32")(
		"defers POSIX SIGINT until a complete flushed frame and preserves prior masks",
		async () => {
			expect(await runWorker("posix")).toEqual([
				{
					delivered: [
						{ frame: { id: 1 }, flushed: true },
						{ frame: { id: 2 }, flushed: true },
					],
					preserved_unrelated: true,
					preserved_blocked: true,
					deferred_preblocked: true,
				},
			]);
		},
	);
});
