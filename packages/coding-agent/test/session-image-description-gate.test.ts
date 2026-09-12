import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent, Model, OpenAICompat } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	needsImageDescriptionForModel,
	SessionProviderBoundary,
	type SessionProviderBoundaryHost,
} from "@oh-my-pi/pi-coding-agent/session/session-provider-boundary";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// 1x1 transparent PNG.
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const image: ImageContent = { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" };

/**
 * A DeepSeek-family chat-completions model. The catalog's class rule strips image
 * parts for these ids, so `input: ["text", "image"]` produces exactly the mismatch
 * this gate has to survive: declared vision, wire-level drop.
 */
function deepseekFlash(compat?: OpenAICompat): Model<"openai-completions"> {
	return buildModel({
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: "https://api.deepseek.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 384_000,
		...(compat ? { compat } : {}),
	});
}

describe("image description gate", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-description-gate-"));
	});

	afterEach(async () => {
		await removeWithRetries(testDir);
	});

	function boundary(model: Model, settings = Settings.isolated()): SessionProviderBoundary {
		const host = {
			model: () => model,
			settings,
			modelRegistry: {
				getAvailable: () => [],
				getApiKey: async () => "test-key",
				resolver: () => async () => "test-key",
			},
			localProtocolOptions: () => ({ getArtifactsDir: () => testDir, getSessionId: () => "test-session" }),
			agent: { telemetry: undefined },
			sessionId: () => "test-session",
			confirmVisionFallback: async () => false,
		} as unknown as SessionProviderBoundaryHost;
		return new SessionProviderBoundary(host);
	}

	it("describes the image when the endpoint strips what the model declares", async () => {
		const model = deepseekFlash();
		// Fixture check: the model advertises vision while the wire drops images.
		expect(model.input).toEqual(["text", "image"]);
		expect(model.compat.stripImageInput).toBe(true);

		expect(needsImageDescriptionForModel(model, Settings.isolated())).toBe(true);
		expect(await boundary(model).buildImageDescriptionNotice([image])).toBeDefined();
	});

	it("stays out of the way when the transport carries the image", async () => {
		const model = deepseekFlash({ stripImageInput: false });
		expect(model.compat.stripImageInput).toBe(false);

		expect(needsImageDescriptionForModel(model, Settings.isolated())).toBe(false);
		expect(await boundary(model).buildImageDescriptionNotice([image])).toBeUndefined();
	});

	it("keeps describing for text-only models and honors the image settings", async () => {
		const model = buildModel({
			id: "deepseek-v4-pro",
			name: "DeepSeek V4 Pro",
			api: "openai-completions",
			provider: "deepseek",
			baseUrl: "https://api.deepseek.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 384_000,
		});

		expect(needsImageDescriptionForModel(model, Settings.isolated())).toBe(true);
		expect(needsImageDescriptionForModel(model, Settings.isolated({ "images.describeForTextModels": false }))).toBe(
			false,
		);
		expect(needsImageDescriptionForModel(model, Settings.isolated({ "images.blockImages": true }))).toBe(false);
		expect(
			await boundary(model, Settings.isolated({ "images.blockImages": true })).buildImageDescriptionNotice([image]),
		).toBeUndefined();
	});
});
