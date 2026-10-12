import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

describe("ArtifactManager concurrent allocation", () => {
	const dirs: string[] = [];

	function freshDir(): string {
		const dir = path.join(os.tmpdir(), `omp-artifacts-${crypto.randomUUID()}`, "session");
		dirs.push(path.dirname(dir));
		return dir;
	}

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			removeSyncWithRetries(dir);
		}
	});

	// Directory scans yield before seeding #nextId. A later scan must not move
	// the counter backwards after a concurrent caller already consumed an ID.
	// Same toolType => file overwrite; the first ID resolves to B's bytes.
	it("hands concurrent same-toolType savers distinct ids that each resolve to their own content", async () => {
		const mgr = new ArtifactManager(freshDir());
		const [idA, idB] = await Promise.all([mgr.save("CONTENT-A", "bash"), mgr.save("CONTENT-B", "bash")]);

		expect(idA).not.toBe(idB);

		const pathA = await mgr.getPath(idA);
		const pathB = await mgr.getPath(idB);
		expect(pathA).not.toBeNull();
		expect(pathB).not.toBeNull();
		expect(await Bun.file(pathA as string).text()).toBe("CONTENT-A");
		expect(await Bun.file(pathB as string).text()).toBe("CONTENT-B");
	});

	// Different toolTypes turn a duplicate id into two coexisting files
	// (`{id}.bash.log` + `{id}.async.log`); getPath's startsWith(`${id}.`) then
	// resolves ambiguously in unspecified readdir order. Distinct ids keep each
	// artifact:// pointing at the content its caller wrote.
	it("hands concurrent different-toolType savers distinct ids that each resolve to their own content", async () => {
		const mgr = new ArtifactManager(freshDir());
		const [idA, idB] = await Promise.all([mgr.save("BASH-BYTES", "bash"), mgr.save("ASYNC-BYTES", "async")]);

		expect(idA).not.toBe(idB);

		const pathA = await mgr.getPath(idA);
		const pathB = await mgr.getPath(idB);
		expect(await Bun.file(pathA as string).text()).toBe("BASH-BYTES");
		expect(await Bun.file(pathB as string).text()).toBe("ASYNC-BYTES");
	});

	// The race also re-opens on a fresh manager over a directory that already
	// holds artifacts (e.g. after a `#artifactManager = null` reset): the scan
	// seeds from maxId, and concurrent callers must still get ids past it.
	it("does not reuse ids when racing init over a pre-populated directory", async () => {
		const dir = freshDir();
		const seed = new ArtifactManager(dir);
		await seed.save("OLD", "bash");

		const mgr = new ArtifactManager(dir);
		const [idA, idB] = await Promise.all([mgr.save("NEW-A", "bash"), mgr.save("NEW-B", "bash")]);

		expect(idA).not.toBe(idB);
		expect(await Bun.file((await mgr.getPath(idA)) as string).text()).toBe("NEW-A");
		expect(await Bun.file((await mgr.getPath(idB)) as string).text()).toBe("NEW-B");
	});

	it("does not reuse outstanding path reservations when later scans find no published files", async () => {
		const mgr = new ArtifactManager(freshDir());
		const reservations = await Promise.all(Array.from({ length: 16 }, () => mgr.allocatePath("eval")));
		const contents = Array.from({ length: 16 }, (_, index) => `concurrent-output-${index}`);
		const ids = await Promise.all(
			contents.map((content, index) => mgr.save(content, index % 2 === 0 ? "read" : "bash")),
		);

		const allIds = [...reservations.map(reservation => reservation.id), ...ids];
		expect(new Set(allIds).size).toBe(allIds.length);
		for (const [index, id] of ids.entries()) {
			expect(await Bun.file((await mgr.getPath(id))!).text()).toBe(contents[index]);
		}
	});
});
