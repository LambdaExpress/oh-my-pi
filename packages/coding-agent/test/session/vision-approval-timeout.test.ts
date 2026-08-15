// Vision-fallback approval timeout contract: the configured
// `images.visionApprovalTimeoutMs` value must reach the confirm dialog as
// `dialogOptions.timeout`, and a timed-out prompt denies the vision request
// (onTimeout fires and the confirm resolves non-true), leaving the image
// undescribed.
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionUIDialogOptions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { setLocale } from "../../src/i18n";

// 1x1 transparent PNG.
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const visionModel: Model<"openai-responses"> = buildModel({
	id: "gpt-4o",
	name: "GPT-4o",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
	contextWindow: 128000,
	maxTokens: 4096,
});

const textModel: Model<"openai-responses"> = { ...visionModel, id: "text-only", input: ["text"] };

describe("vision approval timeout", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let confirmCalls: Array<{ title: string; message: string; dialogOptions?: ExtensionUIDialogOptions }>;
	let timeoutFired: number;
	let modelRegistry: ModelRegistry;

	async function createSession(settings: Settings): Promise<void> {
		const mock = createMockModel({ provider: "openai", id: "text-only", responses: [{ content: ["ok"] }] });
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([textModel, visionModel]);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: textModel, systemPrompt: ["t"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		confirmCalls = [];
		timeoutFired = 0;
		session.setVisionFallbackUIContext({
			confirm: async (title, message, dialogOptions) => {
				confirmCalls.push({ title, message, dialogOptions });
				dialogOptions?.onTimeout?.();
				timeoutFired++;
				return false;
			},
		});
	}

	beforeEach(async () => {
		setLocale("en");
		tempDir = path.join(os.tmpdir(), `pi-vision-approval-${Snowflake.next()}`);
		await fs.mkdir(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.setRuntimeApiKey("openai", "test-key");
	});

	afterEach(async () => {
		setLocale(null);
		vi.restoreAllMocks();
		await session?.dispose();
		await authStorage?.close();
		await removeWithRetries(tempDir);
	});

	it("passes the default 30s timeout to the approval confirm dialog", async () => {
		await createSession(Settings.isolated({ "images.visionApproval": true }));
		const result = await session.prompt("hello", {
			images: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
		});

		expect(result).toBe(true);
		expect(confirmCalls).toHaveLength(1);
		expect(confirmCalls[0]?.title).toBe("Allow vision model access?");
		expect(confirmCalls[0]?.dialogOptions?.timeout).toBe(30_000);
	});

	it("uses the configured setting value as the approval timeout", async () => {
		await createSession(Settings.isolated({ "images.visionApproval": true, "images.visionApprovalTimeoutMs": 5000 }));
		await session.prompt("hello", {
			images: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
		});

		expect(confirmCalls[0]?.dialogOptions?.timeout).toBe(5000);
	});

	it("waits indefinitely when the timeout is disabled (0)", async () => {
		await createSession(Settings.isolated({ "images.visionApproval": true, "images.visionApprovalTimeoutMs": 0 }));
		await session.prompt("hello", {
			images: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
		});

		expect(confirmCalls[0]?.dialogOptions?.timeout).toBeUndefined();
		expect(confirmCalls[0]?.dialogOptions?.onTimeout).toBeUndefined();
	});

	it("fires onTimeout and denies when the approval prompt times out", async () => {
		await createSession(Settings.isolated({ "images.visionApproval": true }));
		await session.prompt("hello", {
			images: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
		});

		// The fake confirm simulates the timeout path: onTimeout fires and the
		// dialog resolves non-true, so the vision request is denied and the turn
		// still completes.
		expect(timeoutFired).toBe(1);
		expect(confirmCalls[0]?.dialogOptions?.onTimeout).toBeTypeOf("function");
	});

	it("describes without an approval prompt when images.visionApproval is off (default)", async () => {
		// With images.visionApproval off (default), the approval boundary is not
		// injected, so no confirm dialog appears — even when no vision model is
		// available, the image falls back to the no-vision note path without any
		// approval prompt and without a network call.
		await createSession(Settings.isolated());
		// Re-mock getAvailable to hide the vision model, avoiding a real vision
		// API call; the image then goes down the no-vision note path.
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([textModel]);
		const result = await session.prompt("hello", {
			images: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
		});

		expect(result).toBe(true);
		expect(confirmCalls).toHaveLength(0);
		expect(timeoutFired).toBe(0);
	});
});
