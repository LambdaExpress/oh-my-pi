import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { collectSubSessions, exportFromFile, type SessionData } from "../src/export/html";

/**
 * Contract: a session at `<dir>/<name>.jsonl` embeds subagent transcripts from
 * `<dir>/<name>/<AgentId>.jsonl` (recursively) under slash-joined keys, with
 * parent links and last-entry leaf ids. Corrupt/empty/backup files are skipped.
 */

function sessionJsonl(id: string, entryIds: string[], previousSessionFiles?: string[]): string {
	const lines = [
		JSON.stringify({
			type: "session",
			version: 3,
			id,
			timestamp: "2026-06-12T00:00:00.000Z",
			cwd: "/tmp",
			previousSessionFiles,
		}),
	];
	let parent: string | null = null;
	for (const entryId of entryIds) {
		lines.push(
			JSON.stringify({
				type: "model_change",
				id: entryId,
				parentId: parent,
				timestamp: "2026-06-12T00:00:01.000Z",
				model: "test/model",
			}),
		);
		parent = entryId;
	}
	return `${lines.join("\n")}\n`;
}

function sshSessionJsonl(id: string, password: string, marker: string): string {
	const timestamp = "2026-07-12T00:00:00.000Z";
	return [
		JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: "/tmp" }),
		JSON.stringify({
			type: "ssh_config_change",
			operation: "upsert",
			name: "prod",
			config: { host: "example.com", password },
			id: `${id}-ssh`,
			parentId: null,
			timestamp,
		}),
		JSON.stringify({
			type: "message",
			id: `${id}-message`,
			parentId: `${id}-ssh`,
			timestamp,
			message: { role: "user", content: [{ type: "text", text: `${marker} ${password}` }] },
		}),
	].join("\n");
}

function decodeSessionData(html: string): SessionData {
	const match = /<script id="session-data" type="application\/json">([^<]+)<\/script>/.exec(html);
	if (!match) throw new Error("export did not contain embedded session data");
	return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
}

describe("collectSubSessions", () => {
	let root: string;
	let mainFile: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-subsessions-"));
		mainFile = path.join(root, "main.jsonl");
		await Bun.write(mainFile, sessionJsonl("main", ["m1"]));
	});

	afterEach(async () => {
		await removeWithRetries(root);
	});

	test("collects nested subagent sessions with parent links and leaf ids", async () => {
		await Bun.write(path.join(root, "main/Alpha.jsonl"), sessionJsonl("alpha", ["a1", "a2"]));
		await Bun.write(path.join(root, "main/Alpha/Child.jsonl"), sessionJsonl("child", ["c1"]));
		await Bun.write(path.join(root, "main/Beta.jsonl"), sessionJsonl("beta", ["b1"]));

		const subs = await collectSubSessions(mainFile);

		expect(Object.keys(subs).sort()).toEqual(["Alpha", "Alpha/Child", "Beta"]);
		expect(subs.Alpha).toMatchObject({ agentId: "Alpha", parent: null, leafId: "a2" });
		expect(subs.Alpha.entries.map(e => e.id)).toEqual(["a1", "a2"]);
		expect(subs.Alpha.header?.id).toBe("alpha");
		expect(subs["Alpha/Child"]).toMatchObject({ agentId: "Child", parent: "Alpha", leafId: "c1" });
		expect(subs.Beta).toMatchObject({ agentId: "Beta", parent: null, leafId: "b1" });
	});

	test("omits internal move history from standalone HTML", async () => {
		const mainPreviousPath = "/Users/private/main.jsonl";
		const subPreviousPath = "/Users/private/Alpha.jsonl";
		await Bun.write(mainFile, sessionJsonl("main", ["m1"], [mainPreviousPath]));
		await Bun.write(path.join(root, "main/Alpha.jsonl"), sessionJsonl("alpha", ["a1"], [subPreviousPath]));
		const outputPath = path.join(root, "export.html");

		await exportFromFile(mainFile, { outputPath });

		const html = await Bun.file(outputPath).text();
		const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
		expect(encoded).toBeDefined();
		const data = JSON.parse(Buffer.from(encoded!, "base64").toString("utf8")) as {
			header: { previousSessionFiles?: string[] };
			subSessions: Record<string, { header: { previousSessionFiles?: string[] } }>;
		};
		expect(data.header.previousSessionFiles).toBeUndefined();
		expect(data.subSessions.Alpha.header.previousSessionFiles).toBeUndefined();
		expect(html).not.toContain(mainPreviousPath);
		expect(html).not.toContain(subPreviousPath);
	});

	test("skips corrupt, empty, backup, and non-jsonl files", async () => {
		await Bun.write(path.join(root, "main/Good.jsonl"), sessionJsonl("good", ["g1"]));
		await Bun.write(path.join(root, "main/corrupt.jsonl"), "{not json\n");
		await Bun.write(path.join(root, "main/empty.jsonl"), "");
		await Bun.write(path.join(root, "main/Good.jsonl.123.bak"), sessionJsonl("bak", ["x1"]));
		await Bun.write(path.join(root, "main/notes.md"), "# notes\n");

		const subs = await collectSubSessions(mainFile);

		expect(Object.keys(subs)).toEqual(["Good"]);
	});

	test("returns empty record when no subagent dir exists", async () => {
		expect(await collectSubSessions(mainFile)).toEqual({});
		expect(await collectSubSessions(path.join(root, "not-a-session"))).toEqual({});
	});

	test("removes main and sub-session SSH state and passwords from HTML exports", async () => {
		const password = "html-session-ssh-password-sentinel";
		await Bun.write(mainFile, sshSessionJsonl("main", password, "main marker"));
		await Bun.write(path.join(root, "main/Alpha.jsonl"), sshSessionJsonl("alpha", password, "sub marker"));
		const outputPath = path.join(root, "export.html");

		await exportFromFile(mainFile, { outputPath });
		const exported = decodeSessionData(await Bun.file(outputPath).text());
		const flat = JSON.stringify(exported);
		expect(flat).not.toContain(password);
		expect(flat).not.toContain("ssh_config_change");
		expect(flat).toContain("main marker");
		expect(flat).toContain("sub marker");
		expect(await Bun.file(mainFile).text()).toContain(password);
		expect(await Bun.file(path.join(root, "main/Alpha.jsonl")).text()).toContain(password);
	});
});
