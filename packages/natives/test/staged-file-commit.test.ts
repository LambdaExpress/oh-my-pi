import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { commitStagedFileAtomic } from "../native/index.js";

let testDir: string;

beforeEach(async () => {
	testDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-staged-commit-"));
});

afterEach(async () => {
	await fs.rm(testDir, { recursive: true, force: true });
});

async function writeFixture(name: string, content: string): Promise<string> {
	const fixturePath = path.join(testDir, name);
	await fs.writeFile(fixturePath, content, { mode: 0o600 });
	return fixturePath;
}

describe("commitStagedFileAtomic", () => {
	it("commits to a missing destination without replacement", async () => {
		const stagePath = await writeFixture(".stage", "new bytes");
		const destinationPath = path.join(testDir, "destination");

		commitStagedFileAtomic(stagePath, destinationPath, false);

		expect(await fs.readFile(destinationPath, "utf8")).toBe("new bytes");
		expect(await Bun.file(stagePath).exists()).toBe(false);
	});

	it("preserves both files when no-replace finds a conflict", async () => {
		const stagePath = await writeFixture(".stage", "new bytes");
		const destinationPath = await writeFixture("destination", "old bytes");

		expect(() => commitStagedFileAtomic(stagePath, destinationPath, false)).toThrow();

		expect(await fs.readFile(stagePath, "utf8")).toBe("new bytes");
		expect(await fs.readFile(destinationPath, "utf8")).toBe("old bytes");
	});

	it("atomically replaces a regular file and removes the displaced entry", async () => {
		const stagePath = await writeFixture(".stage", "new bytes");
		const destinationPath = await writeFixture("destination", "old bytes");

		commitStagedFileAtomic(stagePath, destinationPath, true);

		expect(await fs.readFile(destinationPath, "utf8")).toBe("new bytes");
		expect(await Bun.file(stagePath).exists()).toBe(false);
		expect((await fs.readdir(testDir)).filter(name => name.includes("backup"))).toEqual([]);
	});

	it("replaces the final symlink or reparse point instead of following it", async () => {
		const targetPath = await writeFixture("link-target", "linked bytes");
		const destinationPath = path.join(testDir, "destination-link");
		try {
			await fs.symlink(targetPath, destinationPath, "file");
		} catch (error) {
			if (process.platform === "win32" && error instanceof Error && "code" in error && error.code === "EPERM") {
				return;
			}
			throw error;
		}
		const stagePath = await writeFixture(".stage", "new bytes");

		commitStagedFileAtomic(stagePath, destinationPath, true);

		expect((await fs.lstat(destinationPath)).isSymbolicLink()).toBe(false);
		expect(await fs.readFile(destinationPath, "utf8")).toBe("new bytes");
		expect(await fs.readFile(targetPath, "utf8")).toBe("linked bytes");
	});

	it("refuses a directory and preserves the stage and destination", async () => {
		const stagePath = await writeFixture(".stage", "new bytes");
		const destinationPath = path.join(testDir, "destination-directory");
		await fs.mkdir(destinationPath);

		expect(() => commitStagedFileAtomic(stagePath, destinationPath, true)).toThrow(/directory|special/i);

		expect(await fs.readFile(stagePath, "utf8")).toBe("new bytes");
		expect((await fs.lstat(destinationPath)).isDirectory()).toBe(true);
	});

	it.skipIf(process.platform === "win32" || !Bun.which("mkfifo"))(
		"rolls back when the displaced destination is a FIFO",
		async () => {
			const stagePath = await writeFixture(".stage", "new bytes");
			const destinationPath = path.join(testDir, "destination-fifo");
			const child = Bun.spawn(["mkfifo", destinationPath], { stdout: "pipe", stderr: "pipe" });
			if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());

			expect(() => commitStagedFileAtomic(stagePath, destinationPath, true)).toThrow(/directory|special/i);

			expect(await fs.readFile(stagePath, "utf8")).toBe("new bytes");
			expect((await fs.lstat(destinationPath)).isFIFO()).toBe(true);
		},
	);
});
