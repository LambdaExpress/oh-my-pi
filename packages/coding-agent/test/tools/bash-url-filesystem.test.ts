import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { stripWindowsExtendedLengthPathPrefix } from "@oh-my-pi/pi-utils";

let tempDir: string;
let localRoot: string;
let session: ToolSession;

beforeEach(async () => {
	tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bash-url-fs-")));
	const localProtocolOptions = { getArtifactsDir: () => tempDir, getSessionId: () => "bash-url-fs" };
	localRoot = resolveLocalRoot(localProtocolOptions);
	session = {
		cwd: tempDir,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		localProtocolOptions,
		settings: Settings.isolated({
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
		}),
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
});

afterEach(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
});

async function run(command: string, cwd?: string): Promise<{ text: string; isError: boolean | undefined }> {
	const result = await new BashTool(session).execute("call", { command, ...(cwd ? { cwd } : {}) });
	return { text: result.content.find(c => c.type === "text")?.text ?? "", isError: result.isError };
}

describe("bash internal URLs through the shell filesystem", () => {
	it("creates, reads, and removes the same session scratch directory", async () => {
		expect((await run("mkdir -p local://phone-logs")).isError).toBeUndefined();
		const read = await new ReadTool(session).execute("read-scratch", { path: "local://phone-logs" });
		expect(stripWindowsExtendedLengthPathPrefix(read.details?.resolvedPath ?? "")).toBe(
			path.join(localRoot, "phone-logs"),
		);
		expect((await fs.stat(path.join(localRoot, "phone-logs"))).isDirectory()).toBe(true);

		expect((await run("rmdir local://phone-logs")).isError).toBeUndefined();
		await expect(fs.stat(path.join(localRoot, "phone-logs"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("removes variable-composed URL parents without removing the scratch mount", async () => {
		const { isError } = await run('mkdir -p local://work/a/b && scheme=local && rmdir -p "$scheme://work/a/b"');

		expect(isError).toBeUndefined();
		await expect(fs.stat(path.join(localRoot, "work"))).rejects.toMatchObject({ code: "ENOENT" });
		expect((await fs.stat(localRoot)).isDirectory()).toBe(true);
		expect((await fs.stat(tempDir)).isDirectory()).toBe(true);
	});

	it("preserves nonempty URL directories while still removing later empty operands", async () => {
		const { isError } = await run(
			"mkdir -p local://full local://empty && printf kept > local://full/kept && rmdir local://full local://empty",
		);

		expect(isError).toBe(true);
		expect(await fs.readFile(path.join(localRoot, "full", "kept"), "utf8")).toBe("kept");
		await expect(fs.stat(path.join(localRoot, "empty"))).rejects.toMatchObject({ code: "ENOENT" });
		expect((await run("rmdir --ignore-fail-on-non-empty local://full")).isError).toBeUndefined();
		expect(await fs.readFile(path.join(localRoot, "full", "kept"), "utf8")).toBe("kept");
	});

	it("does not reinterpret URL parents or unknown schemes as host directories", async () => {
		const outside = path.join(tempDir, "outside");
		await fs.mkdir(outside);

		expect((await run("rmdir -p local://../outside")).isError).toBe(true);
		expect((await run("rmdir unsupported://outside")).isError).toBe(true);
		expect((await fs.stat(outside)).isDirectory()).toBe(true);
	});

	it("refuses to remove a directory reached through a scratch symlink escaping its root", async () => {
		const outside = path.join(tempDir, "outside");
		const target = path.join(outside, "empty");
		await fs.mkdir(target, { recursive: true });
		await fs.mkdir(localRoot, { recursive: true });
		await fs.symlink(outside, path.join(localRoot, "escape"), process.platform === "win32" ? "junction" : "dir");

		expect((await run("rmdir local://escape/empty")).isError).toBe(true);
		expect((await fs.stat(target)).isDirectory()).toBe(true);
	});

	it("resolves variable-composed URLs and redirections at access time, leaving literal text alone", async () => {
		const { text, isError } = await run(
			`scheme=local; printf 'hi\\n' > "$scheme://out.txt"; printf 'more\\n' >> local://out.txt; cat local://out.txt; echo 'local://out.txt'`,
		);

		expect(isError).toBeUndefined();
		expect(text).toContain("hi\nmore\n");
		expect(text).toContain("local://out.txt");
		expect(await fs.readFile(path.join(localRoot, "out.txt"), "utf-8")).toBe("hi\nmore\n");
	});

	it("follows URL symlinks and resolves backed URLs to their physical path", async () => {
		const { text, isError } = await run(
			"printf 'body\\n' > local://source.txt && ln -s local://source.txt local://link && cat local://link && readlink local://link && realpath local://link",
		);

		const physical = await fs.realpath(path.join(localRoot, "source.txt"));
		expect(isError).toBeUndefined();
		const [body, linkTarget, canonicalTarget] = text.split("\n");
		expect(body).toBe("body");
		expect(stripWindowsExtendedLengthPathPrefix(linkTarget!)).toBe(physical);
		expect(stripWindowsExtendedLengthPathPrefix(canonicalTarget!)).toBe(physical);
		expect(await fs.readlink(path.join(localRoot, "link"))).toBe("local://source.txt");
	});

	it("runs in a URL working directory with relative paths inside it", async () => {
		await fs.mkdir(path.join(localRoot, "work"), { recursive: true });
		await fs.writeFile(path.join(localRoot, "work", "in.txt"), "inside\n");

		const { text, isError } = await run("cat in.txt; printf 'rel\\n' > rel.txt; ls", "local://work");

		expect(isError).toBeUndefined();
		expect(text).toContain("inside");
		expect(text).toContain("rel.txt");
		expect(await fs.readFile(path.join(localRoot, "work", "rel.txt"), "utf-8")).toBe("rel\n");
	});

	it("fails a redirection into a read-only scheme", async () => {
		const { isError } = await run("printf 'x' > omp://README.md");

		expect(isError).toBe(true);
	});
});
