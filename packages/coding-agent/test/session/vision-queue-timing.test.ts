import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Api } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Container } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const PROVIDER = "vision-queue-test";
const SOURCE_ID = "vision-queue-timing.test";
const REPRO_API = "vision-queue-timing-test" as Api;

function messageLabel(message: AgentMessage): string {
	if (message.role === "custom") return message.customType;
	if (message.role !== "user" || typeof message.content === "string") return message.role;
	return message.content.find(part => part.type === "text")?.text ?? message.role;
}

function renderPendingMessages(session: AgentSession): string {
	const pendingMessagesContainer = new Container();
	const ctx = {
		session,
		viewSession: session,
		pendingMessagesContainer,
		compactionQueuedMessages: [],
		keybindings: { getDisplayString: () => "Alt+Up" },
		ui: { requestComponentRender: () => {} },
	} as unknown as InteractiveModeContext;
	new UiHelpers(ctx).updatePendingMessagesDisplay();
	return Bun.stripANSI(pendingMessagesContainer.render(120).join("\n"));
}

describe("vision-backed queued message timing", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;
	let session: AgentSession;
	let running: Promise<boolean> | undefined;
	let releaseVision: PromiseWithResolvers<void> | undefined;

	beforeEach(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("dark theme missing");
		setThemeInstance(theme);
		tempDir = TempDir.createSync("@pi-vision-queue-timing-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		releaseVision?.resolve();
		session?.clearQueue();
		await session?.abort();
		await running?.catch(() => undefined);
		await session?.dispose();
		registry?.clearSourceRegistrations(SOURCE_ID);
		authStorage?.close();
		tempDir?.removeSync();
	});

	async function createRunningSession() {
		const activeStarted = Promise.withResolvers<void>();
		const visionStarted = Promise.withResolvers<void>();
		const visionStreamSettled = Promise.withResolvers<void>();
		releaseVision = Promise.withResolvers<void>();
		const mainMock = createMockModel({
			provider: PROVIDER,
			id: "text",
			handler: async (_context, options) => {
				activeStarted.resolve();
				const aborted = Promise.withResolvers<void>();
				if (options?.signal?.aborted) {
					aborted.resolve();
				} else {
					options?.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
				}
				await aborted.promise;
				return { content: ["working"] };
			},
		});
		const visionMock = createMockModel({
			provider: PROVIDER,
			id: "vision",
			handler: async (_context, options) => {
				visionStarted.resolve();
				const outcome = Promise.withResolvers<"released" | "aborted">();
				void releaseVision!.promise.then(() => outcome.resolve("released"));
				if (options?.signal?.aborted) {
					outcome.resolve("aborted");
				} else {
					options?.signal?.addEventListener("abort", () => outcome.resolve("aborted"), { once: true });
				}
				if ((await outcome.promise) === "aborted") {
					return { content: [], stopReason: "aborted", errorMessage: "vision request aborted" };
				}
				return { content: ["image description"] };
			},
		});
		authStorage.setRuntimeApiKey(PROVIDER, "test-key");
		registry.registerProvider(
			PROVIDER,
			{
				baseUrl: "mock://vision-queue-test",
				api: REPRO_API,
				apiKey: "test-key",
				streamSimple: (model, context, options) => {
					const mock = model.id === "vision" ? visionMock : mainMock;
					const stream = mock.stream(mock, context, options);
					if (model.id === "vision") {
						void stream.result().then(
							() => visionStreamSettled.resolve(),
							() => visionStreamSettled.resolve(),
						);
					}
					return stream;
				},
				models: [
					{
						id: "text",
						name: "Text",
						reasoning: false,
						input: ["text"],
						cost: ZERO_COST,
						contextWindow: 100_000,
						maxTokens: 4096,
					},
					{
						id: "vision",
						name: "Vision",
						reasoning: false,
						input: ["text", "image"],
						cost: ZERO_COST,
						contextWindow: 100_000,
						maxTokens: 4096,
					},
				],
			},
			SOURCE_ID,
		);
		const textModel = registry.getAvailable().find(model => model.provider === PROVIDER && model.id === "text");
		if (!textModel) throw new Error("text model missing");
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("vision", `${PROVIDER}/vision`);
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: textModel, systemPrompt: ["Test"], tools: [] },
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry: registry,
		});
		session.setVisionFallbackUIContext({ confirm: async () => true });
		running = session.prompt("keep working");
		await activeStarted.promise;
		expect(session.isStreaming).toBe(true);
		return { visionStarted, visionStreamSettled };
	}

	it("shows the approved image message immediately and delivers its companion atomically in order", async () => {
		const { visionStarted } = await createRunningSession();
		const batchDelivered = Promise.withResolvers<void>();
		const deliveredBatches: AgentMessage[][] = [];
		const originalSteerBatch = session.agent.steerBatch.bind(session.agent);
		session.agent.steerBatch = messages => {
			deliveredBatches.push([...messages]);
			originalSteerBatch(messages);
			if (deliveredBatches.length === 2) batchDelivered.resolve();
		};
		let enqueueSettled = false;
		const enqueue = session
			.steer("queued image", [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }])
			.then(() => {
				enqueueSettled = true;
			});
		await visionStarted.promise;
		await Promise.resolve();

		expect(enqueueSettled).toBe(true);
		expect(session.getQueuedMessages()).toEqual({ steering: ["queued image"], followUp: [] });
		expect(session.queuedUserMessageCount).toBe(1);
		expect(session.queuedMessageCount).toBe(1);
		expect(session.hasRunnableQueuedMessages).toBe(false);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(renderPendingMessages(session)).toContain("1. queued image");

		await session.steer("queued after image");
		expect(session.getQueuedMessages().steering).toEqual(["queued image", "queued after image"]);
		expect(session.agent.hasQueuedMessages()).toBe(false);

		releaseVision!.resolve();
		await enqueue;
		await batchDelivered.promise;

		expect(deliveredBatches.map(batch => batch.map(messageLabel))).toEqual([
			["image-attachment-description", "queued image"],
			["queued after image"],
		]);
		expect(session.getQueuedMessages().steering).toEqual(["queued image", "queued after image"]);
	});

	it("does not requeue an approved image message after the user restores it", async () => {
		const { visionStarted, visionStreamSettled } = await createRunningSession();
		const enqueue = session.steer("restore me", [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }]);
		await visionStarted.promise;
		await enqueue;

		const restored = session.clearQueue();
		expect(restored.steering).toHaveLength(1);
		expect(restored.steering[0]?.text).toBe("restore me");
		expect(restored.steering[0]?.images).toHaveLength(1);
		expect(restored.steering[0]?.images?.[0]?.type).toBe("image");
		expect(session.queuedMessageCount).toBe(0);

		releaseVision!.resolve();
		await visionStreamSettled.promise;
		await session.abort();
		await running?.catch(() => undefined);

		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
	});
});
