import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	CONTEXT_INJECTION_ENTRY_TYPE,
	type ContextInjectionItem,
	contextInjectionItemsFromData,
} from "@oh-my-pi/pi-coding-agent/session/context-injection";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const AGENTS_MD = "# Project rules\nAlways run bun check.\n";

describe("context injection recording", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	let tempDir: TempDir;
	let session: AgentSession | undefined;

	beforeAll(() => {
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		model = bundled;
	});

	afterAll(() => {
		authStorage.close();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		try {
			await tempDir.remove();
		} catch {}
	});

	/** Journaled injection records on the current branch, in append order. */
	function recordedInjections(): ContextInjectionItem[][] {
		const records: ContextInjectionItem[][] = [];
		for (const entry of session!.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === CONTEXT_INJECTION_ENTRY_TYPE) {
				records.push(contextInjectionItemsFromData(entry.data));
			}
		}
		return records;
	}

	async function createSession(contextFiles: ReadonlyArray<{ path: string; content: string }>): Promise<void> {
		tempDir = TempDir.createSync("@pi-context-injection-");
		session = (
			await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
				agentRegistry: new AgentRegistry(),
				authStorage,
				modelRegistry,
				settings: Settings.isolated({
					"async.enabled": false,
					"advisor.enabled": false,
					"compaction.enabled": false,
					"memory.backend": "none",
				}),
				model,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: contextFiles.map(file => ({ ...file, level: "project" as const })),
				workspaceTree: {
					rootPath: tempDir.path(),
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				},
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			})
		).session;
	}

	it("journals the instruction files the prompt build injected", async () => {
		await createSession([{ path: "/project/AGENTS.md", content: AGENTS_MD }]);

		const records = recordedInjections();
		expect(records).toHaveLength(1);
		expect(records[0]!.map(item => `${item.kind}:${item.label}`)).toEqual(["context-file:AGENTS.md"]);
		expect(records[0]![0]!.preview).toBe(AGENTS_MD.trim());
	});

	it("stays silent when a rebuild injects the same set", async () => {
		await createSession([{ path: "/project/AGENTS.md", content: AGENTS_MD }]);
		expect(recordedInjections()).toHaveLength(1);

		await session!.refreshBaseSystemPrompt();

		expect(recordedInjections()).toHaveLength(1);
	});

	it("announces a changed source set to subscribers", async () => {
		await createSession([{ path: "/project/AGENTS.md", content: AGENTS_MD }]);
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));

		session!.recordContextInjection([
			{ kind: "context-file", label: "AGENTS.md", detail: "1 KB · /project/AGENTS.md" },
			{ kind: "skill", label: "Skills", count: 3 },
		]);

		expect(recordedInjections()).toHaveLength(2);
		expect(recordedInjections()[1]!.map(item => item.label)).toEqual(["AGENTS.md", "Skills"]);
		// Subscriber fan-out is gated behind the extension emit: drain microtasks
		// until the event lands instead of sleeping on the wall clock.
		for (let attempt = 0; attempt < 100 && events.length === 0; attempt++) await Promise.resolve();
		expect(events.filter(event => event.type === "context_injected")).toHaveLength(1);
	});
});
