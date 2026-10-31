import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/sdk";
import { ReadTool } from "../../src/tools/read";
import * as scrapers from "../../src/web/scrapers/types";

function createSession(cwd: string): ToolSession {
	let nextArtifact = 0;
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "fetch.enabled": true }),
		getArtifactsDir: () => cwd,
		allocateOutputArtifact: async tool => {
			const id = String(nextArtifact++);
			return { id, path: path.join(cwd, `${id}.${tool}.log`) };
		},
	};
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.flatMap(block => (block.type === "text" ? [block.text ?? ""] : [])).join("\n");
}

function bodyOf(output: string): string {
	const boundary = output.indexOf("\n---\n\n");
	if (boundary === -1) throw new Error("Missing URL output body");
	return output.slice(boundary + "\n---\n\n".length);
}

describe("read JSON URL artifacts", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("preserves the complete large JSON body in the artifact and in tail reads", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-json-url-"));
		const data = {
			tree: Array.from({ length: 9_000 }, (_, index) => ({ path: `directory-${index}/file.ts`, mode: "100644" })),
			end: "last-json-property",
		};
		// Raw tails select the wire body's physical lines. A compact oversized
		// JSON line still obeys the normal inline byte limit.
		const body = JSON.stringify(data, null, 2);
		expect(body.length).toBeGreaterThan(500_000);
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => new Response(body, { headers: { "Content-Type": "application/json" } }),
		});
		try {
			const reader = new ReadTool(createSession(dir));
			const result = await reader.execute("large-json", { path: server.url.href });
			const artifactId = result.details?.meta?.truncation?.artifactId;
			expect(artifactId).toBeDefined();
			const artifact = await Bun.file(path.join(dir, `${artifactId}.read.log`)).text();
			expect(JSON.parse(bodyOf(artifact))).toEqual(data);
			expect(result.details?.notes?.some(note => note.includes("incomplete"))).toBe(false);

			const tail = await reader.execute("json-tail", { path: `${server.url.href}:raw:-5` });
			expect(textOf(tail), JSON.stringify(tail, null, 2)).toContain('"end": "last-json-property"');
			expect(textOf(tail).trimEnd(), JSON.stringify(tail, null, 2)).toEndWith("}");
		} finally {
			await server.stop(true);
			await fs.rm(dir, { force: true, recursive: true });
		}
	});

	it("keeps raw JSON bytes verbatim rather than applying the renderer character cap", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-json-url-"));
		const body = ` \n${JSON.stringify({ payload: "x".repeat(510_000), end: true })}\n\n`;
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => new Response(body, { headers: { "Content-Type": "application/json" } }),
		});
		try {
			const result = await new ReadTool(createSession(dir)).execute("raw-json", { path: `${server.url.href}:raw` });
			const artifactId = result.details?.meta?.truncation?.artifactId;
			const artifact = await Bun.file(path.join(dir, `${artifactId}.read.log`)).text();
			expect(bodyOf(artifact)).toBe(body);
		} finally {
			await server.stop(true);
			await fs.rm(dir, { force: true, recursive: true });
		}
	});

	it("labels an underlying body cap in both the preview and its persisted artifact", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-json-url-"));
		vi.spyOn(scrapers, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			finalUrl: "https://example.com/oversized.json",
			contentType: "application/json",
			content: `{"tree":[\n${'{"path":"partial"},\n'.repeat(500)}`,
			truncated: true,
		});
		try {
			const result = await new ReadTool(createSession(dir)).execute("capped-json", {
				path: "https://example.com/oversized.json",
			});
			const artifactId = result.details?.meta?.truncation?.artifactId;
			const artifact = await Bun.file(path.join(dir, `${artifactId}.read.log`)).text();
			for (const output of [textOf(result), artifact]) {
				expect(output).toContain("content is incomplete");
				expect(output).toContain("50");
				expect(output).toContain("mid-stream");
			}
		} finally {
			await fs.rm(dir, { force: true, recursive: true });
		}
	});
});
