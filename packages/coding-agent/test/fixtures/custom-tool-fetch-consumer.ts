import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import type { CustomTool, CustomToolContext } from "../../src/extensibility/custom-tools/types";
import { CustomToolAdapter } from "../../src/extensibility/custom-tools/wrapper";
import type { ExtensionContext } from "../../src/extensibility/extensions/types";
import { customToolToDefinition } from "../../src/sdk";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-custom-fetch-"));
const certificatePath = path.join(import.meta.dir, "browser-lifecycle-cert.pem");
const certificate = await Bun.file(certificatePath).text();
const expectedA = Buffer.alloc(6091, 65);
const expectedB = Buffer.alloc(6091, 66);
const requests: string[] = [];
const previousNoProxy = { upper: Bun.env.NO_PROXY, lower: Bun.env.no_proxy };
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	tls: { cert: certificate, key: Bun.file(path.join(import.meta.dir, "browser-lifecycle-key.pem")) },
	fetch(request) {
		const session = request.headers.get("x-test-session") || "default";
		requests.push(session);
		return new Response(session === "b" ? expectedB : expectedA);
	},
});
const endpoint = `https://localhost:${server.port}/attachment`;
const parameters = type({ url: "string", destination: "string" });
let expectedContext: CustomToolContext | undefined;
const tool: CustomTool<typeof parameters, { bytes: number }> = {
	name: "download_fixture",
	label: "Download fixture",
	description: "Consume the invocation's HTTP capability and persist the returned bytes",
	parameters,
	async execute(_id, params, _onUpdate, context) {
		if (expectedContext) {
			assert.equal(context, expectedContext, "the borrowed context must retain its identity");
			assert.equal(context.isIdle(), true, "prototype methods must retain their original receiver");
		}
		assert.ok(context.fetch, "the custom tool must receive its HTTP capability");
		const response = await context.fetch(params.url, { signal: AbortSignal.timeout(3_000) });
		assert.equal(response.status, 200);
		const bytes = new Uint8Array(await response.arrayBuffer());
		await Bun.write(params.destination, bytes);
		return { content: [{ type: "text", text: String(bytes.byteLength) }], details: { bytes: bytes.byteLength } };
	},
};
const extensionContext = {
	model: undefined,
	isIdle: () => true,
	hasPendingMessages: () => false,
	abort: () => {},
} as ExtensionContext;

class ScopedContext {
	#fetch: FetchImpl;
	#session: string;

	constructor(fetchImpl: FetchImpl, session: string) {
		this.#fetch = fetchImpl;
		this.#session = session;
	}

	get fetch(): FetchImpl {
		return this.#fetch;
	}

	isIdle(): boolean {
		return this.#session === "a" || this.#session === "b";
	}
}

try {
	Bun.env.NO_PROXY = "*";
	Bun.env.no_proxy = "*";
	delete Bun.env.NODE_EXTRA_CA_CERTS;
	delete Bun.env.NODE_TLS_REJECT_UNAUTHORIZED;
	const definition = customToolToDefinition(tool);
	const untrustedPath = path.join(tempDir, "untrusted.sql");
	await assert.rejects(
		() =>
			definition.execute(
				"untrusted",
				{ url: endpoint, destination: untrustedPath },
				undefined,
				undefined,
				extensionContext,
			),
		error => error instanceof Error && /cert|self.signed/i.test(error.message),
	);
	assert.deepEqual(requests, []);
	await assert.rejects(() => fs.stat(untrustedPath), { code: "ENOENT" });

	Bun.env.NODE_EXTRA_CA_CERTS = certificatePath;
	const trustedPath = path.join(tempDir, "trusted.sql");
	const trusted = await definition.execute(
		"trusted",
		{ url: endpoint, destination: trustedPath },
		undefined,
		undefined,
		extensionContext,
	);
	assert.deepEqual(trusted.details, { bytes: 6091 });
	const trustedBytes = (await fs.stat(trustedPath)).size;
	assert.deepEqual(await fs.readFile(trustedPath), expectedA);

	// An explicitly supplied fetch owns its own policy. A missing ambient CA path
	// must not cause the adapter to replace or wrap these session capabilities.
	Bun.env.NODE_EXTRA_CA_CERTS = path.join(tempDir, "missing-ca.pem");
	const scopedFetch =
		(session: string): FetchImpl =>
		async (input, init) => {
			const headers = new Headers(init?.headers);
			headers.set("x-test-session", session);
			return globalThis.fetch(input, { ...init, headers, tls: { ca: certificate } } as RequestInit);
		};
	const fetchA = scopedFetch("a");
	const fetchB = scopedFetch("b");
	const contextA = Object.freeze(new ScopedContext(fetchA, "a")) as CustomToolContext;
	const contextB = Object.freeze(new ScopedContext(fetchB, "b")) as CustomToolContext;
	assert.equal(contextA.fetch, fetchA);
	assert.equal(contextB.fetch, fetchB);
	const adapterA = new CustomToolAdapter(tool, () => contextA);
	const adapterB = new CustomToolAdapter(tool, () => contextB);
	const pathA = path.join(tempDir, "a.sql");
	const pathB = path.join(tempDir, "b.sql");
	expectedContext = contextA;
	const promiseA = adapterA.execute("a", { url: endpoint, destination: pathA });
	expectedContext = contextB;
	const promiseB = adapterB.execute("b", { url: endpoint, destination: pathB }, undefined, undefined, contextB);
	expectedContext = undefined;
	const [resultA, resultB] = await Promise.all([promiseA, promiseB]);
	assert.deepEqual(resultA.details, { bytes: 6091 });
	assert.deepEqual(resultB.details, { bytes: 6091 });
	const bytesA = (await fs.stat(pathA)).size;
	const bytesB = (await fs.stat(pathB)).size;
	assert.deepEqual(await fs.readFile(pathA), expectedA);
	assert.deepEqual(await fs.readFile(pathB), expectedB);
	assert.deepEqual(requests.toSorted(), ["a", "b", "default"]);
	assert.ok(Object.isFrozen(contextA));
	assert.ok(Object.isFrozen(contextB));

	process.stdout.write(
		`${JSON.stringify({
			untrustedRejected: true,
			defaultFetchBytes: trustedBytes,
			explicitFetchBytes: [bytesA, bytesB],
			borrowedContextPreserved: true,
			isolatedSessionFiles: true,
		})}\n`,
	);
} finally {
	if (previousNoProxy.upper === undefined) delete Bun.env.NO_PROXY;
	else Bun.env.NO_PROXY = previousNoProxy.upper;
	if (previousNoProxy.lower === undefined) delete Bun.env.no_proxy;
	else Bun.env.no_proxy = previousNoProxy.lower;
	await server.stop(true);
	await fs.rm(tempDir, { recursive: true, force: true });
}
