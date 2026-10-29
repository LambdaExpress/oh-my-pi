import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { fetchReadUrl, materializeReadUrlToFile } from "@oh-my-pi/pi-coding-agent/tools/fetch";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { loadPage } from "@oh-my-pi/pi-coding-agent/web/scrapers/types";
import * as scraperUtils from "@oh-my-pi/pi-coding-agent/web/scrapers/utils";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const PDF_BYTES = Buffer.from("%PDF-1.7\nfixture bytes for the conversion boundary\n%%EOF");

function makeSession(cwd: string): ToolSession {
	let nextArtifact = 0;
	const artifactsDir = path.join(cwd, "artifacts");
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => null,
		getArtifactsDir: () => artifactsDir,
		allocateOutputArtifact: async tool => {
			const id = String(nextArtifact++);
			return { id, path: path.join(artifactsDir, `${id}.${tool}.log`) };
		},
		settings: Settings.isolated({ "fetch.enabled": true }),
	};
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

describe("remote PDF response snapshots", () => {
	let testDir: string;
	const servers: Bun.Server<undefined>[] = [];

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "fetch-pdf-snapshot-"));
	});

	afterEach(async () => {
		for (const server of servers) server.stop(true);
		servers.length = 0;
		vi.restoreAllMocks();
		await removeWithRetries(testDir);
	});

	function serve(handler: (request: Request) => Response | Promise<Response>): string {
		const server = Bun.serve({ port: 0, fetch: handler });
		servers.push(server);
		return `http://127.0.0.1:${server.port}`;
	}

	it("uses one response for full reads, concurrent ranges and search materialization", async () => {
		let requests = 0;
		const base = serve(() =>
			++requests === 1
				? new Response(PDF_BYTES, { headers: { "content-type": "application/pdf" } })
				: new Response("temporarily unavailable", { status: 503 }),
		);
		const body = Array.from({ length: 5500 }, (_, i) => `PDF body line ${i + 1}`).join("\n");
		const convert = vi.spyOn(scraperUtils, "convertWithMarkit").mockResolvedValue({ ok: true, content: body });
		const binaryRefetch = vi.spyOn(scraperUtils, "fetchBinary");
		const session = makeSession(testDir);
		const tool = new ReadTool(session);
		const url = `${base}/book.pdf`;

		const full = await tool.execute("pdf-full", { path: url });
		const [firstRange, secondRange, materialized] = await Promise.all([
			tool.execute("pdf-range-a", { path: `${url}:4878-4915` }),
			tool.execute("pdf-range-b", { path: `${url}:5048-5070` }),
			materializeReadUrlToFile(session, { path: url }),
		]);

		expect(full.details?.method).toBe("markit");
		expect(textOf(firstRange)).toContain("PDF body line 4900");
		expect(textOf(secondRange)).toContain("PDF body line 5055");
		expect(textOf(firstRange)).not.toContain("beyond end");
		expect(await Bun.file(materialized.path).text()).toBe(body);
		expect(requests).toBe(1);
		expect(convert).toHaveBeenCalledTimes(1);
		expect(convert.mock.calls[0]?.[0]).toEqual(PDF_BYTES);
		expect(binaryRefetch).not.toHaveBeenCalled();
	});

	it("shares an in-flight response without one reader aborting another reader", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let requests = 0;
		const base = serve(async () => {
			requests++;
			entered.resolve();
			await release.promise;
			return new Response(PDF_BYTES, { headers: { "content-type": "application/pdf" } });
		});
		const convert = vi
			.spyOn(scraperUtils, "convertWithMarkit")
			.mockResolvedValue({ ok: true, content: "Shared PDF text" });
		const session = makeSession(testDir);
		const controller = new AbortController();
		const first = fetchReadUrl(session, { path: `${base}/parallel.pdf`, raw: true }, controller.signal);
		const second = fetchReadUrl(session, { path: `${base}/parallel.pdf`, raw: true });
		const firstOutcome = first.then(
			() => undefined,
			error => error,
		);

		await entered.promise;
		controller.abort();
		expect(await firstOutcome).toBeInstanceOf(ToolAbortError);
		release.resolve();
		expect((await second).content).toBe("Shared PDF text");
		expect(requests).toBe(1);
		expect(convert).toHaveBeenCalledTimes(1);
	});

	it("reports HTTP failure instead of treating failure metadata as eight PDF lines", async () => {
		let unavailable = true;
		const base = serve(() =>
			unavailable
				? new Response("temporarily unavailable", { status: 503, headers: { "content-type": "text/html" } })
				: new Response(PDF_BYTES, { headers: { "content-type": "application/pdf" } }),
		);
		vi.spyOn(scraperUtils, "convertWithMarkit").mockResolvedValue({ ok: true, content: "Recovered PDF text" });
		const session = makeSession(testDir);
		const tool = new ReadTool(session);
		const result = tool.execute("pdf-http-failure", { path: `${base}/book.pdf:4878-4915` });
		await expect(result).rejects.toThrow("HTTP 503");

		unavailable = false;
		expect((await fetchReadUrl(session, { path: `${base}/book.pdf` })).content).toBe("Recovered PDF text");
	});

	it("reports a failed extensionless download before applying its line range", async () => {
		const base = serve(
			() =>
				new Response("temporarily unavailable", {
					status: 503,
					headers: { "content-type": "text/html" },
				}),
		);
		const tool = new ReadTool(makeSession(testDir));

		await expect(tool.execute("pdf-unknown-failure", { path: `${base}/download?id=42:4878-4915` })).rejects.toThrow(
			"HTTP 503",
		);
	});

	it("rejects a successful HTML error response at a PDF URL and allows a later valid response", async () => {
		let valid = false;
		const base = serve(() =>
			valid
				? new Response(PDF_BYTES, { headers: { "content-type": "application/pdf" } })
				: new Response("<html><body>upstream unavailable</body></html>", {
						headers: { "content-type": "text/html" },
					}),
		);
		const convert = vi
			.spyOn(scraperUtils, "convertWithMarkit")
			.mockResolvedValue({ ok: true, content: "Valid PDF text" });
		const session = makeSession(testDir);
		const tool = new ReadTool(session);

		await expect(tool.execute("pdf-html-failure", { path: `${base}/book.pdf:5000-5010` })).rejects.toThrow(
			"PDF header",
		);
		expect(convert).not.toHaveBeenCalled();
		valid = true;
		expect((await fetchReadUrl(session, { path: `${base}/book.pdf` })).content).toBe("Valid PDF text");
	});

	it("does not cache extraction errors or replace a successful snapshot with later failures", async () => {
		let requests = 0;
		const base = serve(() => {
			requests++;
			return new Response(PDF_BYTES, { headers: { "content-type": "application/pdf" } });
		});
		const convert = vi
			.spyOn(scraperUtils, "convertWithMarkit")
			.mockResolvedValueOnce({ ok: false, content: "", error: "Encrypted PDF requires a password" })
			.mockResolvedValueOnce({ ok: true, content: "Recovered PDF text" })
			.mockResolvedValue({ ok: false, content: "", error: "later extraction failure" });
		const session = makeSession(testDir);
		const url = `${base}/encrypted.pdf`;

		await expect(fetchReadUrl(session, { path: url })).rejects.toThrow("Encrypted PDF requires a password");
		expect((await fetchReadUrl(session, { path: url })).content).toBe("Recovered PDF text");
		expect((await fetchReadUrl(session, { path: url })).content).toBe("Recovered PDF text");
		expect(requests).toBe(2);
		expect(convert).toHaveBeenCalledTimes(2);
	});

	it("accepts real short extracted text instead of discarding it by a length heuristic", async () => {
		const base = serve(() => new Response(PDF_BYTES, { headers: { "content-type": "application/pdf" } }));
		vi.spyOn(scraperUtils, "convertWithMarkit").mockResolvedValue({ ok: true, content: "Hi." });

		expect((await fetchReadUrl(makeSession(testDir), { path: `${base}/short.pdf` })).content).toBe("Hi.");
	});

	it("keeps an empty extraction failure diagnostic", async () => {
		const base = serve(() => new Response(PDF_BYTES, { headers: { "content-type": "application/pdf" } }));
		vi.spyOn(scraperUtils, "convertWithMarkit").mockResolvedValue({ ok: true, content: " \n\t" });

		await expect(fetchReadUrl(makeSession(testDir), { path: `${base}/empty.pdf` })).rejects.toThrow(
			"no usable output",
		);
	});

	it("recognizes PDF MIME at an extensionless URL and retains a session-local snapshot", async () => {
		let requests = 0;
		const base = serve(() => {
			requests++;
			return new Response(PDF_BYTES, { headers: { "content-type": "application/pdf" } });
		});
		vi.spyOn(scraperUtils, "convertWithMarkit").mockResolvedValue({ ok: true, content: "Extensionless PDF text" });
		const session = makeSession(testDir);
		const url = `${base}/download?id=42`;

		expect((await fetchReadUrl(session, { path: url, raw: true })).content).toBe("Extensionless PDF text");
		expect((await fetchReadUrl(session, { path: url, raw: true })).content).toBe("Extensionless PDF text");
		expect(requests).toBe(1);
		await fetchReadUrl(makeSession(testDir), { path: url, raw: true });
		expect(requests).toBe(2);
	});

	it("reports a PDF response without content instead of indexing its metadata", async () => {
		const base = serve(() => new Response(null, { status: 204 }));
		const tool = new ReadTool(makeSession(testDir));

		await expect(tool.execute("pdf-no-content", { path: `${base}/empty.pdf:5000-5010` })).rejects.toThrow(
			"HTTP 204 No Content",
		);
	});

	it("does not expose capped binary bytes as a successful PDF response", async () => {
		const base = serve(() => new Response(PDF_BYTES, { headers: { "content-type": "application/pdf" } }));
		const response = await loadPage(`${base}/capped.pdf`, {
			maxBytes: 8,
			binaryBodyForContentType: mime => mime === "application/pdf",
		});

		expect(response.ok).toBe(false);
		expect(response.error).toBe("Response body exceeds 8 bytes");
		expect(response.binary).toBeUndefined();
	});

	it("evicts old PDF snapshots instead of retaining unbounded session content", async () => {
		let requests = 0;
		const base = serve(() => {
			requests++;
			return new Response(PDF_BYTES, { headers: { "content-type": "application/pdf" } });
		});
		vi.spyOn(scraperUtils, "convertWithMarkit").mockResolvedValue({ ok: true, content: "Bounded PDF snapshot" });
		const session = makeSession(testDir);

		for (let index = 0; index < 17; index++) {
			await fetchReadUrl(session, { path: `${base}/book-${index}.pdf`, raw: true });
		}
		await fetchReadUrl(session, { path: `${base}/book-16.pdf`, raw: true });
		expect(requests).toBe(17);
		await fetchReadUrl(session, { path: `${base}/book-0.pdf`, raw: true });
		expect(requests).toBe(18);
	});
});
