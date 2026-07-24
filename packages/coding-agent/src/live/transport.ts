import { type AuthStorage, isAuthRetryableError, type OAuthAccess, withOAuthAccess } from "@oh-my-pi/pi-ai";
import { getProxyForProvider, wrapFetchForProxy } from "@oh-my-pi/pi-ai/utils/proxy";
import {
	CODEX_BASE_URL,
	CODEX_CLIENT_VERSION,
	getCodexAccountId,
	OPENAI_HEADER_VALUES,
	OPENAI_HEADERS,
} from "@oh-my-pi/pi-catalog/wire/codex";
import type { Browser, HTTPRequest, Page } from "puppeteer-core";
import { launchHeadlessBrowser } from "../tools/browser/launch";
import audioWorkletSource from "./audio-worklet.txt" with { type: "text" };
import browserRuntimeSource from "./browser-runtime.txt" with { type: "text" };
import {
	buildLiveSessionPayload,
	type LiveClientMessage,
	type LiveServerEvent,
	parseLiveServerEvent,
} from "./protocol";

const SIGNALING_URL = `${CODEX_BASE_URL}/codex/realtime/calls?intent=quicksilver&architecture=avas`;
const MAX_ERROR_BODY_LENGTH = 2_048;
const MAX_HOST_AUDIO_SAMPLES = 32_000;
const SIDEBAND_CONNECT_ATTEMPTS = 5;
const SIDEBAND_CONNECT_TIMEOUT_MS = 15_000;
const LIVE_PROVIDER = "openai-codex";
const LIVE_CALL_ID_PATTERN = /^rtc_[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

type Lifecycle = "idle" | "connecting" | "connected" | "closing" | "closed";

type BrowserLiveApi = {
	start(workletSource: string): Promise<string>;
	acceptAnswer(sdp: string): Promise<void>;
	waitForOpen(): Promise<void>;
	send(payload: string): void;
	pushAudio(payload: string): void;
	setMuted(muted: boolean): void;
	close(): Promise<void>;
};

declare global {
	var ompCodexLive: BrowserLiveApi;
}

interface QueuedAudio {
	payload: string;
	sampleCount: number;
}

interface LiveSignalingResult {
	answer: string;
	callId: string;
	access: OAuthAccess;
}

class LiveSignalingError extends Error {
	status: number;
	errorMessage: string;

	constructor(status: number, message: string) {
		super(message);
		this.name = "LiveSignalingError";
		this.status = status;
		this.errorMessage = message;
	}
}

/** Callbacks emitted by the live WebRTC transport. */
export interface LiveTransportCallbacks {
	onEvent(event: LiveServerEvent): void;
	onOutputLevel(level: number): void;
}

/** Configuration required to establish a Codex live call. */
export interface LiveTransportOptions {
	authStorage: AuthStorage;
	sessionId: string;
	instructions: string;
	voice: string;
	callbacks: LiveTransportCallbacks;
	signal?: AbortSignal;
}

/** Extracts the server-assigned `rtc_<uuid>` call ID from a signaling Location header. */
export function parseLiveCallId(location: string | null): string | undefined {
	if (!location) return undefined;
	return location
		.split("?", 1)[0]
		?.split("/")
		.find(segment => LIVE_CALL_ID_PATTERN.test(segment));
}

/** Builds the Frameless Bidi sideband WebSocket URL for an accepted Codex call. */
export function buildLiveSidebandUrl(callId: string): string {
	const url = new URL(`${CODEX_BASE_URL}/codex/${encodeURIComponent(callId)}`);
	url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
	return url.toString();
}

function liveSessionHeaders(access: OAuthAccess, sessionId: string): Record<string, string> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${access.accessToken}`,
		"OpenAI-Alpha": "quicksilver=v2",
		"x-session-id": sessionId,
		[OPENAI_HEADERS.ORIGINATOR]: OPENAI_HEADER_VALUES.ORIGINATOR_CODEX,
		[OPENAI_HEADERS.VERSION]: CODEX_CLIENT_VERSION,
		[OPENAI_HEADERS.SCOPED_SESSION_ID]: sessionId,
		[OPENAI_HEADERS.THREAD_ID]: sessionId,
	};
	const accountId = access.accountId ?? getCodexAccountId(access.accessToken);
	if (accountId) headers[OPENAI_HEADERS.ACCOUNT_ID] = accountId;
	return headers;
}

function boundedErrorBody(body: string, statusText: string): string {
	const normalized = body.trim().replaceAll(/\s+/g, " ");
	if (!normalized) return statusText || "empty response body";
	if (normalized.length <= MAX_ERROR_BODY_LENGTH) return normalized;
	return `${normalized.slice(0, MAX_ERROR_BODY_LENGTH)}…`;
}

function isAuthError(error: unknown): boolean {
	return isAuthRetryableError(error);
}

function abortReason(signal: AbortSignal | undefined): Error {
	if (signal?.reason instanceof Error) return signal.reason;
	return new DOMException("Live connection aborted", "AbortError");
}

function encodePcm(samples: Float32Array): string {
	return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString("base64");
}

/** Headless-Chromium WebRTC transport for a Codex Frameless Bidi live session. */
export class CodexLiveTransport {
	readonly #options: LiveTransportOptions;
	#browser: Browser | undefined;
	#page: Page | undefined;
	#sideband: Bun.WebSocket | undefined;
	#state: Lifecycle = "idle";
	#connectPromise: Promise<void> | undefined;
	#closePromise: Promise<void> | undefined;
	#sendTail: Promise<void> = Promise.resolve();
	#audioQueue: QueuedAudio[] = [];
	#queuedAudioSamples = 0;
	#audioPumpRunning = false;
	#muted = false;
	#unexpectedFailureReported = false;
	readonly #abortListener: () => void;

	constructor(options: LiveTransportOptions) {
		this.#options = options;
		this.#abortListener = () => {
			void this.close();
		};
		if (!options.signal?.aborted) options.signal?.addEventListener("abort", this.#abortListener, { once: true });
	}

	/** Establish the browser peer, perform Codex signaling, and wait for the data channel. */
	connect(): Promise<void> {
		if (this.#state === "connected") return Promise.resolve();
		if (this.#connectPromise) return this.#connectPromise;
		if (this.#state === "closing" || this.#state === "closed")
			return Promise.reject(new Error("Live transport is closed"));
		if (this.#options.signal?.aborted) return Promise.reject(abortReason(this.#options.signal));
		this.#state = "connecting";
		const operation = this.#connect().catch(async error => {
			await this.close();
			throw error;
		});
		this.#connectPromise = operation;
		return operation;
	}

	async #connect(): Promise<void> {
		const browser = await launchHeadlessBrowser({
			headless: true,
			args: ["--autoplay-policy=no-user-gesture-required"],
			ignoreDefaultArgs: ["--mute-audio"],
		});
		this.#browser = browser;
		if (this.#state !== "connecting") throw abortReason(this.#options.signal);
		const page = await browser.newPage();
		this.#page = page;
		await page.setRequestInterception(true);
		const serveBlankPage = (request: HTTPRequest): void => {
			void request
				.respond({ status: 200, contentType: "text/html", body: "<!doctype html><title>Codex Live</title>" })
				.catch(() => {});
		};
		page.on("request", serveBlankPage);
		try {
			await page.goto("http://localhost/", { waitUntil: "domcontentloaded" });
		} finally {
			page.off("request", serveBlankPage);
			await page.setRequestInterception(false);
		}
		await page.exposeFunction("__ompLiveServerEvent", (payload: string) => this.#handleServerEvent(payload));
		await page.exposeFunction("__ompLiveOutputLevel", (level: number) => this.#handleOutputLevel(level));
		await page.exposeFunction("__ompLiveFailure", (message: string) => this.#handleBrowserFailure(message));
		await page.evaluate(source => Function(source)(), browserRuntimeSource);
		const offer = await page.evaluate(source => globalThis.ompCodexLive.start(source), audioWorkletSource);
		if (this.#state !== "connecting") throw abortReason(this.#options.signal);
		const signaling = await this.#signal(offer);
		await page.evaluate(sdp => globalThis.ompCodexLive.acceptAnswer(sdp), signaling.answer);
		await page.evaluate(muted => globalThis.ompCodexLive.setMuted(muted), this.#muted);
		await page.evaluate(() => globalThis.ompCodexLive.waitForOpen());
		if (this.#state !== "connecting") throw abortReason(this.#options.signal);
		await this.#connectSideband(signaling.callId, signaling.access);
		if (this.#state !== "connecting") throw abortReason(this.#options.signal);
		this.#state = "connected";
	}

	async #signal(offer: string): Promise<LiveSignalingResult> {
		return await withOAuthAccess(
			this.#options.authStorage,
			LIVE_PROVIDER,
			access => this.#signalWithAccess(offer, access),
			{
				sessionId: this.#options.sessionId,
				signal: this.#options.signal,
				isAuthError,
				missingAccessMessage: "No Codex OAuth credential is available for a live call.",
			},
		);
	}

	async #signalWithAccess(offer: string, access: OAuthAccess): Promise<LiveSignalingResult> {
		const headers = new Headers({
			...liveSessionHeaders(access, this.#options.sessionId),
			Accept: "application/sdp",
			"Content-Type": "application/json",
		});
		const fetchImpl = wrapFetchForProxy(fetch, LIVE_PROVIDER);
		const response = await fetchImpl(SIGNALING_URL, {
			method: "POST",
			headers,
			body: JSON.stringify({
				sdp: offer,
				session: buildLiveSessionPayload(this.#options.instructions, this.#options.voice),
			}),
			signal: this.#options.signal,
		});
		const responseBody = await response.text();
		if (!response.ok) {
			const detail = boundedErrorBody(responseBody, response.statusText);
			throw new LiveSignalingError(response.status, `Codex live signaling failed (${response.status}): ${detail}`);
		}
		const answer = responseBody.trim();
		if (!answer) throw new LiveSignalingError(response.status, "Codex live signaling returned an empty SDP answer");
		const callId = parseLiveCallId(response.headers.get("location"));
		if (!callId) {
			throw new LiveSignalingError(response.status, "Codex live signaling returned no valid call ID");
		}
		return { answer, callId, access };
	}

	async #connectSideband(callId: string, access: OAuthAccess): Promise<void> {
		let failure = new Error("Codex live sideband connection failed");
		for (let attempt = 0; attempt < SIDEBAND_CONNECT_ATTEMPTS; attempt++) {
			try {
				await this.#openSideband(callId, access);
				return;
			} catch (cause) {
				failure = cause instanceof Error ? cause : new Error(String(cause));
				if (this.#options.signal?.aborted) throw abortReason(this.#options.signal);
				if (attempt + 1 < SIDEBAND_CONNECT_ATTEMPTS) await Bun.sleep(200 * 2 ** attempt);
			}
		}
		throw failure;
	}

	async #openSideband(callId: string, access: OAuthAccess): Promise<void> {
		const url = buildLiveSidebandUrl(callId);
		const options = {
			headers: liveSessionHeaders(access, this.#options.sessionId),
			proxy: getProxyForProvider(LIVE_PROVIDER),
		} satisfies Bun.WebSocketOptions;
		const socket: Bun.WebSocket = Reflect.construct(WebSocket, [url, options]);
		socket.binaryType = "nodebuffer";
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let opened = false;
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;
		const cleanup = (): void => {
			if (timeout) {
				clearTimeout(timeout);
				timeout = undefined;
			}
			this.#options.signal?.removeEventListener("abort", onAbort);
		};
		const rejectConnect = (error: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onAbort = (): void => {
			socket.close(1000, "aborted");
			rejectConnect(abortReason(this.#options.signal));
		};
		socket.onopen = () => {
			if (settled) {
				socket.close(1000, "stale");
				return;
			}
			opened = true;
			settled = true;
			cleanup();
			this.#sideband = socket;
			resolve();
		};
		socket.onmessage = event => {
			if (typeof event.data !== "string") {
				this.#reportFailure("Codex live sideband returned an unexpected binary frame.");
				return;
			}
			this.#handleSidebandEvent(event.data);
		};
		socket.onerror = event => {
			const detail = event instanceof ErrorEvent && event.message ? `: ${event.message}` : "";
			if (!opened) {
				rejectConnect(new Error(`Codex live sideband connection failed${detail}`));
				socket.close(1011, "connection failed");
				return;
			}
			this.#reportFailure(`Codex live sideband failed${detail}`);
		};
		socket.onclose = event => {
			if (!opened) {
				rejectConnect(new Error(`Codex live sideband closed before connecting (${event.code})`));
				return;
			}
			if (this.#sideband !== socket) return;
			this.#sideband = undefined;
			if (this.#state === "connecting" || this.#state === "connected") {
				const detail = event.reason ? `: ${event.reason}` : "";
				this.#reportFailure(`Codex live sideband closed (${event.code})${detail}`);
			}
		};
		if (this.#options.signal?.aborted) {
			onAbort();
		} else {
			this.#options.signal?.addEventListener("abort", onAbort, { once: true });
			timeout = setTimeout(() => {
				socket.close(1000, "connect timeout");
				rejectConnect(new Error("Codex live sideband connection timed out"));
			}, SIDEBAND_CONNECT_TIMEOUT_MS);
			timeout.unref?.();
		}
		await promise;
	}

	#handleSidebandEvent(payload: string): void {
		if (this.#state === "closing" || this.#state === "closed") return;
		const event = parseLiveServerEvent(payload);
		if (!event) return;
		try {
			this.#options.callbacks.onEvent(event);
		} catch {}
	}

	#handleServerEvent(payload: string): void {
		if (this.#state === "closing" || this.#state === "closed") return;
		const event = parseLiveServerEvent(payload);
		if (!event || (this.#sideband?.readyState === WebSocket.OPEN && event.type !== "error")) return;
		try {
			this.#options.callbacks.onEvent(event);
		} catch {}
	}

	#handleOutputLevel(level: number): void {
		if (this.#state !== "connected" || !Number.isFinite(level)) return;
		try {
			this.#options.callbacks.onOutputLevel(Math.min(1, Math.max(0, level)));
		} catch {}
	}

	#handleBrowserFailure(message: string): void {
		this.#reportFailure(message);
	}

	#reportFailure(message: string): void {
		if ((this.#state !== "connecting" && this.#state !== "connected") || this.#unexpectedFailureReported) {
			return;
		}
		this.#unexpectedFailureReported = true;
		try {
			this.#options.callbacks.onEvent({ type: "error", message });
		} catch {}
	}

	/** Serialize one Frameless Bidi control message onto the call's sideband WebSocket. */
	send(message: LiveClientMessage): Promise<void> {
		const operation = this.#sendTail.then(() => {
			if (this.#state !== "connected") throw new Error("Live transport is not connected");
			const sideband = this.#sideband;
			if (!sideband || sideband.readyState !== WebSocket.OPEN) {
				throw new Error("Codex live sideband is not connected");
			}
			sideband.send(JSON.stringify(message));
		});
		this.#sendTail = operation.catch(() => {});
		return operation;
	}

	/** Queue 16 kHz mono Float32 PCM for continuous browser-side resampling and playback. */
	pushAudio(samples: Float32Array): void {
		if (this.#state !== "connected" || this.#muted || samples.length === 0) return;
		const retained =
			samples.length > MAX_HOST_AUDIO_SAMPLES ? samples.subarray(samples.length - MAX_HOST_AUDIO_SAMPLES) : samples;
		const queued = { payload: encodePcm(retained), sampleCount: retained.length };
		this.#audioQueue.push(queued);
		this.#queuedAudioSamples += queued.sampleCount;
		while (this.#queuedAudioSamples > MAX_HOST_AUDIO_SAMPLES && this.#audioQueue.length > 1) {
			const stale = this.#audioQueue.shift();
			if (stale) this.#queuedAudioSamples -= stale.sampleCount;
		}
		if (!this.#audioPumpRunning) void this.#pumpAudio();
	}

	async #pumpAudio(): Promise<void> {
		this.#audioPumpRunning = true;
		try {
			while (this.#state === "connected" && !this.#muted) {
				const queued = this.#audioQueue.shift();
				if (!queued) break;
				this.#queuedAudioSamples -= queued.sampleCount;
				const page = this.#page;
				if (!page) break;
				await page.evaluate(payload => globalThis.ompCodexLive.pushAudio(payload), queued.payload);
			}
		} catch {
			this.#audioQueue.length = 0;
			this.#queuedAudioSamples = 0;
		} finally {
			this.#audioPumpRunning = false;
			if (this.#audioQueue.length > 0 && this.#state === "connected" && !this.#muted) void this.#pumpAudio();
		}
	}

	/** Enable or disable the browser audio source and discard queued input when muted. */
	async setMuted(muted: boolean): Promise<void> {
		this.#muted = muted;
		this.#audioQueue.length = 0;
		this.#queuedAudioSamples = 0;
		const page = this.#page;
		if (!page || this.#state !== "connected") return;
		await page.evaluate(value => globalThis.ompCodexLive.setMuted(value), muted);
	}

	/** Stop audio, WebRTC, the page, and Chromium. Safe to call repeatedly. */
	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#state = "closing";
		const operation = this.#close();
		this.#closePromise = operation;
		return operation;
	}

	async #close(): Promise<void> {
		this.#options.signal?.removeEventListener("abort", this.#abortListener);
		this.#audioQueue.length = 0;
		this.#queuedAudioSamples = 0;
		const sideband = this.#sideband;
		const page = this.#page;
		const browser = this.#browser;
		this.#sideband = undefined;
		this.#page = undefined;
		this.#browser = undefined;
		if (sideband && (sideband.readyState === WebSocket.OPEN || sideband.readyState === WebSocket.CONNECTING)) {
			sideband.close(1000, "done");
		}
		if (page) {
			try {
				await page.evaluate(() => globalThis.ompCodexLive?.close());
			} catch {}
			try {
				await page.close();
			} catch {}
		}
		if (browser) {
			try {
				await browser.close();
			} catch {}
		}
		this.#state = "closed";
	}
}
