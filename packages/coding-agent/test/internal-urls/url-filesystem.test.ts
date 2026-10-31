import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type LocalProtocolOptions, resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { InternalUrlFilesystem } from "@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem";
import * as fileTransfer from "@oh-my-pi/pi-coding-agent/ssh/file-transfer";
import { executeShell, ShellFsFileType, ShellFsOp } from "@oh-my-pi/pi-natives";

const READ = { read: true, write: false, append: false, truncate: false, create: false, createNew: false };
const CREATE = { read: false, write: true, append: false, truncate: true, create: true, createNew: false };

let tempDir: string;
let localOptions: LocalProtocolOptions;
let localRoot: string;

function shellFs(tier: "read" | "write" | "exec" = "exec"): InternalUrlFilesystem {
	return new InternalUrlFilesystem({ context: { localProtocolOptions: localOptions }, tier });
}

/**
 * Create `link` holding the literal `target`, as the native shell's `ln -s` does.
 * Node's `fs.symlink` rewrites `/` to `\` in the target on Windows, mangling a URL.
 */
async function nativeSymlink(target: string, link: string): Promise<void> {
	const result = await executeShell({
		command: `ln -s '${target}' '${path.basename(link)}'`,
		cwd: path.dirname(link),
	});
	if (result.exitCode !== 0) throw new Error(`ln -s ${target} ${link} exited ${result.exitCode}`);
}

beforeEach(async () => {
	tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "url-fs-")));
	localOptions = { getArtifactsDir: () => tempDir, getSessionId: () => "session" };
	localRoot = resolveLocalRoot(localOptions);
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(tempDir, { recursive: true, force: true });
});

describe("InternalUrlFilesystem local://", () => {
	it("creates write targets in the session root, which exists like a mount point", async () => {
		const response = await shellFs().handle({ op: ShellFsOp.Open, path: "local://out.txt", open: CREATE });

		expect(response).toEqual({ local: path.join(localRoot, "out.txt") });
		expect((await fs.stat(localRoot)).isDirectory()).toBe(true);
	});

	it("addresses entry names that need percent-encoding, as the first segment and below", async () => {
		// `?` and `:` are illegal in Windows file names; the rest still needs encoding.
		const [name, encoded] =
			process.platform === "win32"
				? ["we ird #%41 a@b", "we%20ird%20%23%2541%20a@b"]
				: ["we?ird #%41 a@b:1", "we%3Fird%20%23%2541%20a@b:1"];
		await fs.mkdir(path.join(localRoot, name), { recursive: true });
		await fs.writeFile(path.join(localRoot, name, name), "x");

		await expect(shellFs().handle({ op: ShellFsOp.Metadata, path: `local://${encoded}` })).resolves.toEqual({
			local: path.join(localRoot, name),
		});
		await expect(
			shellFs().handle({ op: ShellFsOp.RemoveFile, path: `local://${encoded}/${encoded}` }),
		).resolves.toEqual({ local: path.join(localRoot, name, name) });
	});

	it("reports a missing file as ENOENT instead of creating it", async () => {
		const response = await shellFs().handle({ op: ShellFsOp.Open, path: "local://missing.txt", open: READ });

		expect(response.error?.code).toBe("ENOENT");
		await expect(fs.stat(path.join(localRoot, "missing.txt"))).rejects.toThrow();
	});

	it("resolves a path authority's parent segments within its shared scheme root", async () => {
		await fs.mkdir(localRoot, { recursive: true });
		await fs.writeFile(path.join(localRoot, "bar"), "sandbox\n");

		await expect(
			shellFs("read").handle({ op: ShellFsOp.Open, path: "local://foo/../bar", open: READ }),
		).resolves.toEqual({ local: path.join(localRoot, "bar") });
	});

	it("keeps a trailing read selector as part of the file name", async () => {
		await fs.mkdir(localRoot, { recursive: true });
		await fs.writeFile(path.join(localRoot, "notes.md"), "whole\n");

		const response = await shellFs().handle({ op: ShellFsOp.Open, path: "local://notes.md:1-2", open: READ });

		expect(response.error?.code).toBe("ENOENT");
	});

	it("follows a symlink whose literal target is a URL while readlink keeps the link itself", async () => {
		await fs.mkdir(localRoot, { recursive: true });
		await fs.writeFile(path.join(localRoot, "source.txt"), "source\n");
		const link = await shellFs().handle({
			op: ShellFsOp.Symlink,
			path: "local://link",
			target: "local://source.txt",
		});
		expect(link).toEqual({ local: path.join(localRoot, "link") });
		// What the native side does with that redirect: the link stores the URL verbatim.
		await nativeSymlink("local://source.txt", path.join(localRoot, "link"));

		await expect(shellFs().handle({ op: ShellFsOp.Open, path: "local://link", open: READ })).resolves.toEqual({
			local: path.join(localRoot, "source.txt"),
		});
		await expect(shellFs().handle({ op: ShellFsOp.ReadLink, path: "local://link" })).resolves.toEqual({
			local: path.join(localRoot, "link"),
		});
		await expect(shellFs().handle({ op: ShellFsOp.Canonicalize, path: "local://link" })).resolves.toEqual({
			path: "local://source.txt",
		});
	});

	it("applies the link target's write policy when writing through a URL symlink", async () => {
		await fs.mkdir(localRoot, { recursive: true });
		await nativeSymlink("omp://README.md", path.join(localRoot, "doc"));

		const response = await shellFs().handle({ op: ShellFsOp.Open, path: "local://doc", open: CREATE });

		expect(response.error?.code).toBe("EROFS");
	});

	it("backs URLs onto host paths, including would-be paths of missing entries, without creating them", async () => {
		await fs.mkdir(path.join(localRoot, "dir"), { recursive: true });

		await expect(shellFs().handle({ op: ShellFsOp.BackingPath, path: "local://dir" })).resolves.toEqual({
			path: path.join(localRoot, "dir"),
		});
		await expect(shellFs().handle({ op: ShellFsOp.BackingPath, path: "local://dir/new/file.txt" })).resolves.toEqual({
			path: path.join(localRoot, "dir", "new", "file.txt"),
		});
		await expect(fs.stat(path.join(localRoot, "dir", "new"))).rejects.toThrow();
		await expect(shellFs().handle({ op: ShellFsOp.BackingPath, path: "omp://" })).resolves.toEqual({});
	});

	it("refuses renames that leave the URL namespace", async () => {
		await fs.mkdir(localRoot, { recursive: true });
		await fs.writeFile(path.join(localRoot, "a.txt"), "a");

		const response = await shellFs().handle({
			op: ShellFsOp.Rename,
			path: "local://a.txt",
			target: path.join(tempDir, "a.txt"),
		});

		expect(response.error?.code).toBe("EXDEV");
	});
});

describe("InternalUrlFilesystem cancellation", () => {
	it("refuses new work after the run is cancelled but still serves the shell's cleanup", async () => {
		const controller = new AbortController();
		const filesystem = new InternalUrlFilesystem({
			context: { localProtocolOptions: localOptions, signal: controller.signal },
			tier: "exec",
		});
		await fs.mkdir(localRoot, { recursive: true });
		controller.abort();

		const work = await filesystem.handle({ op: ShellFsOp.Open, path: "local://t.tmp", open: CREATE });
		const cleanup = await filesystem.handle({ op: ShellFsOp.RemoveFile, path: "local://t.tmp", cleanup: true });

		expect(work.error?.code).toBe("ECANCELED");
		expect(cleanup).toEqual({ local: path.join(localRoot, "t.tmp") });
	});
});

describe("InternalUrlFilesystem policy", () => {
	it("refuses shell writes to handler-written schemes", async () => {
		const response = await shellFs().handle({ op: ShellFsOp.Open, path: "agent://Worker", open: CREATE });

		expect(response.error?.code).toBe("EROFS");
	});

	it("refuses schemes whose read tier exceeds the command's approval tier", async () => {
		const router = InternalUrlRouter.instance();
		let resolved = false;
		router.register({
			scheme: "exec-only-fixture",
			spec: { backing: "remote", selectors: "none", immutable: true, readTier: "exec" },
			async resolve() {
				resolved = true;
				throw new Error("Unapproved resolver must not run");
			},
		});
		try {
			const response = await shellFs("write").handle({
				op: ShellFsOp.Metadata,
				path: "exec-only-fixture://host/file",
			});
			expect(response.error?.code).toBe("EACCES");
			expect(resolved).toBe(false);
		} finally {
			router.unregister("exec-only-fixture");
		}
	});
});

describe("InternalUrlFilesystem host authorities", () => {
	it("preserves an explicit remote root and clamps parent traversal below its host", async () => {
		const stat = vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("directory");
		const filesystem = new InternalUrlFilesystem({ context: { sshHosts: [] }, tier: "read" });

		for (const [url, remote] of [
			["ssh://fixture/", "/"],
			["ssh://fixture/../../etc", "/etc"],
			["ssh://fixture/a/../../../", "/"],
		] as const) {
			const response = await filesystem.handle({ op: ShellFsOp.Metadata, path: url });
			expect(response.metadata?.fileType).toBe(ShellFsFileType.Dir);
			expect(stat.mock.calls.at(-1)?.[0]).toMatchObject({ name: "fixture", host: "fixture" });
			expect(stat.mock.calls.at(-1)?.[1]).toBe(remote);
		}
	});

	it("does not repair missing hosts or missing absolute paths into valid remote reads", async () => {
		const stat = vi.spyOn(fileTransfer, "statRemotePath");
		const filesystem = new InternalUrlFilesystem({ context: { sshHosts: [] }, tier: "read" });

		for (const url of [
			"ssh://fixture",
			"ssh:///etc/hosts",
			"ssh://fixture/etc/unknown%ZZ",
			"ssh://fixture:0/etc/unknown",
			"ssh://fixture/etc/unknown?draft",
		]) {
			const response = await filesystem.handle({ op: ShellFsOp.Metadata, path: url });
			expect(response.error?.code).toBe("EINVAL");
		}
		expect(stat).not.toHaveBeenCalled();
	});

	it("keeps user/port authorities and encoded path segments distinct during parent normalization", async () => {
		const stat = vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("directory");
		const filesystem = new InternalUrlFilesystem({ context: { sshHosts: [] }, tier: "read" });
		const response = await filesystem.handle({
			op: ShellFsOp.Metadata,
			path: "ssh://reader@fixture:2222/../tmp/space%20%23%25",
		});

		expect(response.metadata?.fileType).toBe(ShellFsFileType.Dir);
		expect(stat.mock.calls[0]?.[0]).toMatchObject({ host: "fixture", username: "reader", port: 2222 });
		expect(stat.mock.calls[0]?.[1]).toBe("/tmp/space #%");
	});

	it("keeps transfer failures as EIO even when the diagnostic or filename looks missing", async () => {
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("file");
		const error = new Error("SSH connection reset reading /unknown/unavailable/not found.log");
		vi.spyOn(fileTransfer, "readRemoteFile").mockRejectedValue(error);
		const response = await new InternalUrlFilesystem({ context: { sshHosts: [] }, tier: "read" }).handle({
			op: ShellFsOp.Open,
			path: "ssh://fixture/unknown/unavailable/not%20found.log",
			open: READ,
		});

		expect(response.error).toEqual({ code: "EIO", message: error.message });
	});

	it("keeps directory transfer failures distinct from an absent optional probe", async () => {
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("directory");
		const error = new Error("SSH connection reset listing /unknown/unavailable/not found");
		vi.spyOn(fileTransfer, "listRemoteDir").mockRejectedValue(error);
		const response = await new InternalUrlFilesystem({ context: { sshHosts: [] }, tier: "read" }).handle({
			op: ShellFsOp.ReadDir,
			path: "ssh://fixture/unknown/unavailable/not%20found",
		});

		expect(response.error).toEqual({ code: "EIO", message: error.message });
	});

	it("preserves structured filesystem errors and marks only a real remote miss as ENOENT", async () => {
		const stat = vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("missing");
		const read = vi.spyOn(fileTransfer, "readRemoteFile");
		const filesystem = new InternalUrlFilesystem({ context: { sshHosts: [] }, tier: "read" });
		const request = { op: ShellFsOp.Open, path: "ssh://fixture/missing", open: READ };
		expect((await filesystem.handle(request)).error?.code).toBe("ENOENT");
		expect(read).not.toHaveBeenCalled();

		stat.mockRejectedValue(Object.assign(new Error("Structured refusal"), { code: "EACCES" }));
		expect((await filesystem.handle(request)).error?.code).toBe("EACCES");
	});
});

describe("InternalUrlFilesystem rendered resources", () => {
	it("serves omp:// as a read-only tree whose files hold the rendered bytes", async () => {
		const filesystem = shellFs();
		const listing = await filesystem.handle({ op: ShellFsOp.ReadDir, path: "omp://" });
		const entry = listing.entries?.find(item => item.fileType === ShellFsFileType.File);
		if (!entry) throw new Error("omp:// listed no documents");
		const url = `omp://${entry.name}`;

		const opened = await filesystem.handle({ op: ShellFsOp.Open, path: url, open: READ });
		const handle = opened.handle;
		if (handle === undefined) throw new Error(`open ${url} returned no handle`);
		const metadata = await filesystem.handle({ op: ShellFsOp.FileMetadata, handle });
		const read = await filesystem.handle({ op: ShellFsOp.Read, handle, offset: 0n, length: 1 << 20 });
		const rendered = await filesystem.handle({ op: ShellFsOp.Open, path: url, open: CREATE });
		await filesystem.handle({ op: ShellFsOp.Close, handle });

		expect(metadata.metadata).toEqual({
			fileType: ShellFsFileType.File,
			size: read.data?.length ?? -1,
			mode: 0o444,
		});
		expect(read.data?.length).toBeGreaterThan(0);
		expect(rendered.error?.code).toBe("EROFS");
	});
});
