import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ShellFsOp } from "@oh-my-pi/pi-natives";
import { Settings } from "../../src/config/settings";
import { InternalUrlRouter } from "../../src/internal-urls/router";
import { InternalUrlFilesystem } from "../../src/internal-urls/url-filesystem";
import * as fileTransfer from "../../src/ssh/file-transfer";
import type { ToolSession } from "../../src/tools";
import { GlobTool } from "../../src/tools/glob";
import { GrepTool } from "../../src/tools/grep";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

describe("SSH directory search through the native filesystem", () => {
	let root: string;
	let tool: GrepTool;
	let globTool: GlobTool;
	let readSpy: Mock<typeof fileTransfer.readRemoteFile>;
	let listSpy: Mock<typeof fileTransfer.listRemoteDir>;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "grep-ssh-directory-"));
		InternalUrlRouter.resetForTests();
		const localPath = (remote: string) => path.join(root, ...remote.split("/").filter(Boolean));
		vi.spyOn(fileTransfer, "statRemotePath").mockImplementation(async (_target, remote) => {
			try {
				const stat = await fs.stat(localPath(remote));
				return stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
				throw error;
			}
		});
		readSpy = vi.spyOn(fileTransfer, "readRemoteFile").mockImplementation(async (_target, remote, options) => {
			const bytes = await fs.readFile(localPath(remote));
			return { bytes: bytes.subarray(0, options.maxBytes), truncated: bytes.length > options.maxBytes };
		});
		listSpy = vi.spyOn(fileTransfer, "listRemoteDir").mockImplementation(async (_target, remote) => {
			const entries = await fs.readdir(localPath(remote), { withFileTypes: true });
			return entries.map(entry => ({ name: entry.name, isDirectory: entry.isDirectory() }));
		});
		const session: ToolSession = {
			cwd: root,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getSessionSshHosts: async () => [
				{
					name: "fixture",
					host: "192.0.2.1",
					password: "fixture-password-sentinel",
					_source: {
						provider: "ssh-session",
						providerName: "Session SSH",
						path: "session://fixture",
						level: "session",
					},
				},
			],
			settings: Settings.isolated({ "grep.contextBefore": 0, "grep.contextAfter": 0 }),
		};
		tool = new GrepTool(session);
		globTool = new GlobTool(session);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		InternalUrlRouter.resetForTests();
		await fs.rm(root, { recursive: true, force: true });
	});

	async function put(remote: string, content: string): Promise<void> {
		const destination = path.join(root, ...remote.split("/").filter(Boolean));
		await fs.mkdir(path.dirname(destination), { recursive: true });
		await fs.writeFile(destination, content);
	}

	it("globs remote and local roots together at read tier using the session alias", async () => {
		await put("/repo/evidence/C1V1-backend.json", '{"source":"remote"}\n');
		await put("/repo/evidence/C1V2-other.json", "{}\n");
		await put("/repo/evidence/sub/C1V3-backend.json", "{}\n");
		await put("/local/local.json", '{"source":"local"}\n');
		const result = await globTool.execute("mixed-glob", {
			path: "ssh://fixture/repo/evidence/C1V*backend*.json;local/*.json",
			hidden: true,
			gitignore: false,
			limit: 50,
		});
		expect(new Set(result.details?.files)).toEqual(
			new Set(["ssh://fixture/repo/evidence/C1V1-backend.json", "local/local.json"]),
		);
		expect(listSpy.mock.calls.some(call => call[0].password === "fixture-password-sentinel")).toBe(true);
		expect(listSpy.mock.calls.every(call => !call[1].includes(";"))).toBe(true);
		expect(textOf(result)).not.toContain("fixture-password-sentinel");
	});

	it("applies remote glob recursion, hidden, gitignore, and limits without an exec command", async () => {
		await fs.mkdir(path.join(root, "repo", ".git"), { recursive: true });
		await put("/repo/.gitignore", "ignored/\n");
		await put("/repo/ignored/package.json", "{}\n");
		await put("/repo/.hidden/package.json", "{}\n");
		await put("/repo/visible/package.json", "{}\n");
		const respected = await globTool.execute("respect-policy", {
			path: "ssh://fixture/repo/**/package.json",
			hidden: false,
			gitignore: true,
			limit: 100,
		});
		expect(respected.details?.files).toEqual(["ssh://fixture/repo/visible/package.json"]);
		const all = await globTool.execute("include-all", {
			path: "ssh://fixture/repo/**/package.json",
			hidden: true,
			gitignore: false,
			limit: 2,
		});
		expect(all.details?.files).toHaveLength(2);
		expect(all.details?.truncated).toBe(true);
	});

	it("recursively searches a single remote directory, not its rendered listing", async () => {
		await put("/repo/web/js/video.js", "const frame_rate = 24;\n");
		await put("/repo/web/needle-in-name.txt", "unrelated text\n");
		const result = await tool.execute("single", {
			pattern: "frame_rate",
			path: "ssh://fixture/repo/web",
			gitignore: false,
		});
		expect(textOf(result)).toContain("const frame_rate = 24;");
		expect(textOf(result)).toContain("js/video.js");
		expect(textOf(result)).not.toContain("fixture-password-sentinel");
		expect(listSpy).toHaveBeenCalled();
		expect(readSpy.mock.calls.every(call => !call[1].endsWith("/web") && !call[1].endsWith("/js"))).toBe(true);
		expect(readSpy.mock.calls.some(call => call[0].password === "fixture-password-sentinel")).toBe(true);
		const namesOnly = await tool.execute("listing", { pattern: "needle-in-name", path: "ssh://fixture/repo/web" });
		expect(namesOnly.details?.matchCount).toBe(0);
	});

	it("searches the explicit remote root and keeps root globs non-recursive", async () => {
		await put("/top.py", "needle root\n");
		await put("/sub/deep.py", "needle nested\n");
		const recursive = await tool.execute("remote-root", {
			pattern: "needle",
			path: "ssh://fixture/",
			gitignore: false,
		});
		expect(recursive.details?.matchCount).toBe(2);
		const shallow = await tool.execute("remote-root-glob", {
			pattern: "needle",
			path: "ssh://fixture/*.py",
			gitignore: false,
		});
		expect(shallow.details?.matchCount).toBe(1);
		expect(textOf(shallow)).toContain("needle root");
		expect(textOf(shallow)).not.toContain("needle nested");
		const globbed = await globTool.execute("remote-root-find", {
			path: "ssh://fixture/*.py",
			gitignore: false,
		});
		expect(globbed.details?.files).toEqual(["ssh://fixture/top.py"]);
	});

	it("rejects malformed requested roots instead of treating them as optional ancestor probes", async () => {
		for (const remote of ["ssh://fixture", "ssh://.git", "ssh:///repo"]) {
			await expect(tool.execute("invalid-root", { pattern: "needle", path: remote })).rejects.toThrow();
		}
		expect(readSpy).not.toHaveBeenCalled();
		expect(listSpy).not.toHaveBeenCalled();
	});

	it("searches semicolon-separated remote directories and reports missing entries", async () => {
		await put("/repo/core/video.py", "ffprobe = 'native'\n");
		await put("/repo/clipbin/sub/codec.py", "ffmpeg = 'native'\n");
		const result = await tool.execute("multiple", {
			pattern: "ffprobe|ffmpeg|imageio_ffmpeg|shutil.which",
			path: "ssh://fixture/repo/core;ssh://fixture/repo/clipbin;ssh://fixture/repo/not-cloned",
			case: false,
			gitignore: true,
			skip: 0,
		});
		const text = textOf(result);
		expect(text).toContain("ffprobe = 'native'");
		expect(text).toContain("ffmpeg = 'native'");
		expect(result.details?.missingPaths).toEqual(["ssh://fixture/repo/not-cloned"]);
		expect([...readSpy.mock.calls, ...listSpy.mock.calls].some(call => call[1].includes(";"))).toBe(false);
	});

	it("classifies a not-yet-created directory again on a later call", async () => {
		await expect(
			tool.execute("not-created", {
				pattern: "needle",
				path: "ssh://fixture/repo/cloning/",
			}),
		).rejects.toThrow();
		await fs.mkdir(path.join(root, "repo", "cloning"), { recursive: true });
		const result = await tool.execute("created", { pattern: "needle", path: "ssh://fixture/repo/cloning/" });
		expect(result.details?.matchCount).toBe(0);
		expect(readSpy).not.toHaveBeenCalled();
	});

	it("surfaces a root directory listing transport error", async () => {
		await fs.mkdir(path.join(root, "repo"), { recursive: true });
		listSpy.mockRejectedValue(new Error("remote directory listing failed: connection reset"));
		await expect(
			tool.execute("list-failed", {
				pattern: "needle",
				path: "ssh://fixture/repo",
				gitignore: false,
			}),
		).rejects.toThrow(/remote directory listing failed: connection reset/);
	});

	it("preserves gitignore and case handling for remote directory walks", async () => {
		await fs.mkdir(path.join(root, "repo", ".git"), { recursive: true });
		await put("/repo/.gitignore", "ignored/\n");
		await put("/repo/ignored/secret.py", "NeEdLe ignored\n");
		await put("/repo/src/visible.py", "NeEdLe visible\n");
		const sensitive = await tool.execute("sensitive", { pattern: "needle", path: "ssh://fixture/repo", case: true });
		expect(sensitive.details?.matchCount).toBe(0);
		const respected = await tool.execute("respected", {
			pattern: "needle",
			path: "ssh://fixture/repo",
			case: false,
			gitignore: true,
		});
		expect(textOf(respected)).toContain("NeEdLe visible");
		expect(textOf(respected)).not.toContain("NeEdLe ignored");
		const ignored = await tool.execute("ignored", {
			pattern: "needle",
			path: "ssh://fixture/repo",
			case: false,
			gitignore: false,
		});
		expect(textOf(ignored)).toContain("NeEdLe ignored");
	});

	it("loads ancestor ignore rules without expanding the searched remote directory", async () => {
		await fs.mkdir(path.join(root, "repo", ".git"), { recursive: true });
		await put("/repo/.gitignore", "web/ignored/\n");
		await put("/repo/web/ignored/hidden.py", "needle ignored\n");
		await put("/repo/web/src/visible.py", "needle visible\n");
		await put("/repo/elsewhere.py", "needle outside\n");

		const result = await tool.execute("ancestor-ignore", {
			pattern: "needle",
			path: "ssh://fixture/repo/web",
			gitignore: true,
		});
		expect(result.details?.matchCount).toBe(1);
		expect(textOf(result)).toContain("needle visible");
		expect(textOf(result)).not.toContain("needle ignored");
		expect(textOf(result)).not.toContain("needle outside");
	});

	it("pages remote files by skip without widening the requested root", async () => {
		for (let index = 0; index < 25; index++) {
			await put(`/repo/web/f${String(index).padStart(2, "0")}.py`, `needle ${index}\n`);
		}
		await put("/unrequested/elsewhere.py", "needle outside\n");
		const first = await tool.execute("first", { pattern: "needle", path: "ssh://fixture/repo/web" });
		const second = await tool.execute("second", { pattern: "needle", path: "ssh://fixture/repo/web", skip: 20 });
		expect(first.details?.files).toHaveLength(20);
		expect(second.details?.files).toHaveLength(5);
		expect(textOf(second)).toContain("needle 24");
		expect([...readSpy.mock.calls, ...listSpy.mock.calls].every(call => !call[1].startsWith("/unrequested"))).toBe(
			true,
		);
	});

	it("matches the reported decorator regex with Rust and PCRE on a remote file", async () => {
		const lines = Array.from({ length: 350 }, () => "# filler");
		lines[149] = '        @routes.get("/userdata")';
		lines[213] = '        @routes.get("/v2/userdata")';
		lines[333] = '        @routes.get("/userdata/{file}")';
		await put("/repo/app/user_manager.py", `${lines.join("\n")}\n`);
		for (const pattern of ["@routes.get.*userdata", "@routes\\.get(?=.*userdata)"]) {
			const result = await tool.execute("decorators", {
				pattern,
				path: "ssh://fixture/repo/app/user_manager.py",
				case: true,
			});
			const text = textOf(result);
			for (const line of [lines[149], lines[213], lines[333]]) expect(text).toContain(line);
			expect(result.details?.matchCount).toBe(3);
		}
	});

	it("searches a replaced static Xcode log with alternation, escapes, and absolute line ranges", async () => {
		const remote = "/repo/maestro/output.log";
		await put(remote, "warning: previous build\n");
		await tool.execute("previous-build", { pattern: "warning:", path: `ssh://fixture${remote}` });

		const lines = Array.from({ length: 478 }, (_, index) => `${index} ${"compile input ".repeat(11)}`);
		lines[0] = "The following build commands failed:";
		lines[90] = "embedded.mobileprovision";
		lines[165] = "Warning: provisioning diagnostic";
		lines[200] = 'Signing Identity: "Apple Development"';
		lines[201] = "Provisioning Profile: development";
		lines[477] = "error: Build input file cannot be found: 'MaestroDriverLib/Info.plist'";
		await put(remote, `${lines.join("\n")}\n`);

		const combined = await tool.execute("combined", {
			pattern: "error:|[Ff]ailed|[Ww]arning|mobileprovision|Signing Identity|Provisioning Profile",
			path: `ssh://fixture${remote}`,
			case: true,
			gitignore: true,
			skip: null,
		});
		expect(combined.details?.matchCount).toBe(6);
		for (const index of [0, 90, 165, 200, 201, 477]) expect(textOf(combined)).toContain(lines[index]!);
		expect(textOf(combined)).not.toContain("previous build");

		const narrow = await tool.execute("narrow", { pattern: "error:", path: `ssh://fixture${remote}` });
		expect(narrow.details?.matchCount).toBe(1);
		expect(textOf(narrow)).toContain(lines[477]!);
		const ranged = await tool.execute("ranged", {
			pattern: "failed|mobileprovision|error:",
			path: `ssh://fixture${remote}:470-478`,
		});
		expect(ranged.details?.matchCount).toBe(1);
		expect(textOf(ranged)).toContain(lines[477]!);
		expect(textOf(ranged)).not.toContain(lines[0]!);
		const escaped = await tool.execute("escaped", {
			pattern: String.raw`embedded\.mobileprovision|MaestroDriverLib/Info\.plist`,
			path: `ssh://fixture${remote}`,
		});
		expect(escaped.details?.matchCount).toBe(2);
		expect(textOf(escaped)).toContain(lines[90]!);
		expect(textOf(escaped)).toContain(lines[477]!);
	});

	const failingRemotePath = "/repo/unknown-unavailable-not found.log";
	const failingRemoteUrl = "ssh://fixture/repo/unknown-unavailable-not%20found.log";
	for (const [scope, remote] of [
		["file", failingRemoteUrl],
		["directory", "ssh://fixture/repo"],
		["canonical directory", "ssh://fixture/repo/./"],
		["multiple directories", "ssh://fixture/peer;ssh://fixture/repo"],
	] as const) {
		for (const failure of ["transport", "truncation"] as const) {
			it(`surfaces a remote ${failure} during native open in a ${scope} scope`, async () => {
				await put(failingRemotePath, "error: actual build failure\n");
				await put("/peer/kept.log", "unrelated\n");
				let failureInjected = false;
				const originalFilesystem = InternalUrlFilesystem.prototype.shellFilesystem;
				vi.spyOn(InternalUrlFilesystem.prototype, "shellFilesystem").mockImplementation(
					function (this: InternalUrlFilesystem) {
						const filesystem = originalFilesystem.call(this);
						const handler = filesystem.handler;
						filesystem.handler = async (error, request) => {
							// Native grep retains authored dot segments; the VFS resolves
							// their resource identity before the transfer boundary.
							if (
								request.op === ShellFsOp.Open &&
								request.path !== undefined &&
								new URL(request.path).href === failingRemoteUrl
							) {
								failureInjected = true;
								if (failure === "transport")
									readSpy.mockRejectedValueOnce(
										new Error(`SSH connection reset by peer while reading ${failingRemotePath}`),
									);
								else {
									readSpy.mockResolvedValueOnce({
										bytes: new TextEncoder().encode("incomplete prefix"),
										truncated: true,
									});
								}
							}
							return handler(error, request);
						};
						return filesystem;
					},
				);

				await expect(
					tool.execute(`native-open-${failure}`, {
						pattern: "failed|mobileprovision|error:",
						path: remote,
					}),
				).rejects.toThrow(failure === "transport" ? /SSH connection reset by peer/ : /exceeds the 1 MiB limit/);
				expect(failureInjected).toBe(true);
			});
		}
	}

	it("keeps remote glob filters scoped beneath their explicit directory", async () => {
		await put("/repo/web/top.py", "needle top\n");
		await put("/repo/web/sub/deep.py", "needle deep\n");
		await put("/repo/web/not-python.txt", "needle text\n");
		const result = await tool.execute("glob", { pattern: "needle", path: "ssh://fixture/repo/web/*.py" });
		expect(textOf(result)).toContain("needle top");
		expect(textOf(result)).not.toContain("needle deep");
		expect(textOf(result)).not.toContain("needle text");
	});
});
