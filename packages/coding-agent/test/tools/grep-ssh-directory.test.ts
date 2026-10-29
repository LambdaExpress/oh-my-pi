import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { InternalUrlRouter } from "../../src/internal-urls/router";
import * as fileTransfer from "../../src/ssh/file-transfer";
import type { ToolSession } from "../../src/tools";
import { GrepTool } from "../../src/tools/grep";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

describe("SSH directory grep through the native filesystem", () => {
	let root: string;
	let tool: GrepTool;
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
		expect(textOf(namesOnly)).toContain("No matches found");
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
		expect(text).toContain("Skipped missing paths:");
		expect(text).toContain("not-cloned");
		expect([...readSpy.mock.calls, ...listSpy.mock.calls].some(call => call[1].includes(";"))).toBe(false);
	});

	it("classifies a not-yet-created directory again on a later call", async () => {
		await expect(
			tool.execute("not-created", {
				pattern: "needle",
				path: "ssh://fixture/repo/cloning/",
			}),
		).rejects.toThrow(/not found|not yet available/i);
		await fs.mkdir(path.join(root, "repo", "cloning"), { recursive: true });
		const result = await tool.execute("created", { pattern: "needle", path: "ssh://fixture/repo/cloning/" });
		expect(textOf(result)).toContain("No matches found");
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
		expect(textOf(sensitive)).toContain("No matches found");
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
