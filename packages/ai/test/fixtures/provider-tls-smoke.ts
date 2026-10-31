import assert from "node:assert/strict";
import * as tls from "node:tls";
import * as url from "node:url";
import { streamSimple } from "@oh-my-pi/pi-ai";
import type { Context, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { __resetProxyCache } from "@oh-my-pi/pi-ai/utils/proxy";
import { transportFetch } from "@oh-my-pi/pi-ai/utils/transport-fetch";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

// Reuse the repository's localhost CA/key rather than introducing a second test PKI.
const certificateUrl = new URL("../../../coding-agent/test/fixtures/browser-lifecycle-cert.pem", import.meta.url);
const keyUrl = new URL("../../../coding-agent/test/fixtures/browser-lifecycle-key.pem", import.meta.url);
const certificate = await Bun.file(certificateUrl).text();
const defaultCa = tls.getCACertificates("default");
const unrelatedCa = tls.rootCertificates[0];
assert.ok(unrelatedCa, "the runtime must provide its bundled public roots");
const tempDir = TempDir.createSync("@pi-provider-tls-");
const originalAgentDir = getAgentDir();
setAgentDir(tempDir.path());

// This is an isolated loopback-only process: host proxies/debugging and TLS bypasses must not affect it.
for (const name of ["NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "PI_CODEX_WEBSOCKET", "PI_REQ_DEBUG"]) {
	delete Bun.env[name];
}
Bun.env.NO_PROXY = "*";
Bun.env.no_proxy = "*";
__resetProxyCache();

const events = [
	{ type: "response.created", response: { id: "resp_tls" } },
	{
		type: "response.output_item.added",
		item: { type: "message", id: "msg_tls", role: "assistant", status: "in_progress", content: [] },
	},
	{ type: "response.output_text.delta", item_id: "msg_tls", delta: "tls-ok" },
	{
		type: "response.output_item.done",
		item: {
			type: "message",
			id: "msg_tls",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "tls-ok" }],
		},
	},
	{
		type: "response.completed",
		response: { id: "resp_tls", status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
	},
];
let httpRequests = 0;
let websocketRequests = 0;
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	tls: { key: Bun.file(keyUrl), cert: certificate },
	fetch(request, server) {
		if (server.upgrade(request)) return;
		httpRequests++;
		if (new URL(request.url).pathname.endsWith("/responses")) {
			return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
				headers: { "content-type": "text/event-stream" },
			});
		}
		return new Response("tls-ok");
	},
	websocket: {
		message(socket, data) {
			assert.equal(JSON.parse(String(data)).type, "response.create");
			websocketRequests++;
			for (const event of events) socket.send(JSON.stringify(event));
		},
	},
});
const baseUrl = `https://localhost:${server.port}`;
const model: Model<"openai-codex-responses"> = buildModel({
	id: "gpt-5.3-codex-spark",
	name: "Local TLS fixture",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: `${baseUrl}/backend-api`,
	reasoning: true,
	preferWebsockets: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 128_000,
});
const context: Context = { messages: [{ role: "user", content: "local TLS check", timestamp: 1 }] };
const tokenPayload = Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "local-tls" } }),
).toString("base64");
const apiKey = `aaa.${tokenPayload}.bbb`;
const request = transportFetch(model, undefined);

async function rejectCertificate(run: () => Promise<unknown>): Promise<void> {
	await assert.rejects(
		run,
		error => error instanceof Error && /cert|self.signed|hostname|altname/i.test(error.message),
		"an untrusted certificate must fail TLS validation, not a different transport operation",
	);
}

async function responseText(preferWebsockets: boolean): Promise<string> {
	const result = await streamSimple(model, context, {
		apiKey,
		preferWebsockets,
		sessionId: `tls-${preferWebsockets ? "websocket" : "sse"}`,
		providerSessionState: new Map<string, ProviderSessionState>(),
		codexSseMaxAttempts: 1,
		signal: AbortSignal.timeout(5_000),
	}).result();
	assert.equal(result.stopReason, "stop", result.errorMessage ?? "provider response failed");
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("");
}

try {
	await rejectCertificate(() => request(`${baseUrl}/untrusted`, { signal: AbortSignal.timeout(2_000) }));
	assert.equal(httpRequests, 0, "untrusted TLS must never reach the HTTP handler");

	Bun.env.NODE_EXTRA_CA_CERTS = url.fileURLToPath(certificateUrl);
	const sseText = await responseText(false);
	assert.equal(sseText, "tls-ok");
	assert.equal(httpRequests, 1);

	// Inline PEM is also supported by resolveExtraCa, but is not a runtime-native file path.
	Bun.env.NODE_EXTRA_CA_CERTS = certificate.replace(/\n/g, "\\n");
	const websocketText = await responseText(true);
	assert.equal(websocketText, "tls-ok");
	assert.equal(websocketRequests, 1, "the response must traverse WSS, not an SSE fallback");
	assert.equal(httpRequests, 1, "a trusted WSS handshake must not fall back to HTTP");

	// Model a process whose default store already trusts an enterprise/system CA.
	// Adding an unrelated extra CA must not erase that existing trust.
	tls.setDefaultCACertificates([...defaultCa, certificate]);
	Bun.env.NODE_EXTRA_CA_CERTS = unrelatedCa;
	const defaultCaText = await (await request(`${baseUrl}/default-ca`)).text();
	assert.equal(defaultCaText, "tls-ok");

	await rejectCertificate(() => request(`${baseUrl}/curated-ca`, { tls: { ca: [unrelatedCa] } } as RequestInit));
	Bun.env.NODE_EXTRA_CA_CERTS = certificate;
	await rejectCertificate(() => request(`https://127.0.0.1:${server.port}/wrong-host`));

	process.stdout.write(
		`${JSON.stringify({
			untrustedRejected: true,
			sseText,
			websocketText,
			websocketRequests,
			fallbackRequests: 0,
			defaultCaText,
			curatedCaRejected: true,
			hostnameMismatchRejected: true,
		})}\n`,
	);
} finally {
	await server.stop(true);
	tls.setDefaultCACertificates(defaultCa);
	setAgentDir(originalAgentDir);
	await tempDir.remove();
}
