import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type AutoSessionTitleOptions,
	startAutoSessionTitleGeneration,
} from "@oh-my-pi/pi-coding-agent/utils/auto-session-title";
import { TempDir } from "@oh-my-pi/pi-utils";

type TitleSession = AutoSessionTitleOptions["session"];
type TitleSessionManager = AutoSessionTitleOptions["sessionManager"];
type GenerateTitleFn = NonNullable<AutoSessionTitleOptions["generateTitle"]>;
type GenerateTitleCall = Parameters<GenerateTitleFn>;
type SetTerminalTitleFn = NonNullable<AutoSessionTitleOptions["setTerminalTitle"]>;

const originalPiNoTitle = Bun.env.PI_NO_TITLE;

class FakeSessionManager implements TitleSessionManager {
	#sessionName: string | undefined;
	readonly setSessionNameCalls: Array<{ name: string; source: "auto" }> = [];

	constructor(readonly cwd: string) {}

	getSessionName(): string | undefined {
		return this.#sessionName;
	}

	async setSessionName(name: string, source: "auto"): Promise<boolean> {
		this.setSessionNameCalls.push({ name, source });
		this.#sessionName = name;
		return true;
	}

	getCwd(): string {
		return this.cwd;
	}

	setExternalSessionName(name: string): void {
		this.#sessionName = name;
	}
}

class FakeTitleSession implements TitleSession {
	readonly sessionId = "session-auto-title-test";
	readonly agent = {
		metadataForProvider: (_provider: string): Record<string, unknown> | undefined => undefined,
	};
	model: Model<Api> | undefined;

	constructor(readonly modelRegistry: ModelRegistry) {}
}

interface Harness {
	settings: Settings;
	session: FakeTitleSession;
	sessionManager: FakeSessionManager;
	dispose(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-auto-session-title-test-");
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const settings = Settings.isolated({});
	const session = new FakeTitleSession(modelRegistry);
	const sessionManager = new FakeSessionManager(tempDir.join("project"));
	return {
		settings,
		session,
		sessionManager,
		async dispose() {
			authStorage.close();
			await tempDir.remove();
		},
	};
}

async function settleMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

afterEach(() => {
	vi.restoreAllMocks();
	if (originalPiNoTitle === undefined) {
		delete Bun.env.PI_NO_TITLE;
	} else {
		Bun.env.PI_NO_TITLE = originalPiNoTitle;
	}
});

describe("startAutoSessionTitleGeneration", () => {
	it("generates and applies an automatic title for an unnamed meaningful prompt", async () => {
		delete Bun.env.PI_NO_TITLE;
		const harness = await createHarness();
		try {
			const prompt = "Fix the login parser so OAuth callbacks with query strings keep their state token.";
			const generatedTitle = "Fix OAuth callback parsing";
			const generateCalls: GenerateTitleCall[] = [];
			const terminalTitleCalls: Array<{ name: string | undefined; cwd: string | undefined }> = [];
			let beforeGenerateCalls = 0;
			let titleAppliedCalls = 0;
			const titleApplied = Promise.withResolvers<void>();
			const generateTitle: GenerateTitleFn = async (...args) => {
				generateCalls.push(args);
				return generatedTitle;
			};
			const setTerminalTitle: SetTerminalTitleFn = (name, cwd) => {
				terminalTitleCalls.push({ name, cwd });
			};

			const started = startAutoSessionTitleGeneration({
				text: prompt,
				session: harness.session,
				sessionManager: harness.sessionManager,
				settings: harness.settings,
				onBeforeGenerate: () => {
					beforeGenerateCalls++;
				},
				onTitleApplied: () => {
					titleAppliedCalls++;
					titleApplied.resolve();
				},
				generateTitle,
				setTerminalTitle,
			});

			expect(started).toBe(true);
			await titleApplied.promise;
			expect(generateCalls).toHaveLength(1);
			expect(generateCalls[0]?.[0]).toBe(prompt);
			expect(harness.sessionManager.setSessionNameCalls).toEqual([{ name: generatedTitle, source: "auto" }]);
			expect(harness.sessionManager.getSessionName()).toBe(generatedTitle);
			expect(terminalTitleCalls).toEqual([{ name: generatedTitle, cwd: harness.sessionManager.cwd }]);
			expect(beforeGenerateCalls).toBe(1);
			expect(titleAppliedCalls).toBe(1);
		} finally {
			await harness.dispose();
		}
	});

	it("skips low-signal input without invoking generation or progress", async () => {
		delete Bun.env.PI_NO_TITLE;
		const harness = await createHarness();
		try {
			let generateCalls = 0;
			let beforeGenerateCalls = 0;
			let titleAppliedCalls = 0;
			let terminalTitleCalls = 0;
			const generateTitle: GenerateTitleFn = async () => {
				generateCalls++;
				return "Greeting";
			};
			const setTerminalTitle: SetTerminalTitleFn = () => {
				terminalTitleCalls++;
			};

			const started = startAutoSessionTitleGeneration({
				text: "hi 👋",
				session: harness.session,
				sessionManager: harness.sessionManager,
				settings: harness.settings,
				onBeforeGenerate: () => {
					beforeGenerateCalls++;
				},
				onTitleApplied: () => {
					titleAppliedCalls++;
				},
				generateTitle,
				setTerminalTitle,
			});

			expect(started).toBe(false);
			expect(generateCalls).toBe(0);
			expect(beforeGenerateCalls).toBe(0);
			expect(titleAppliedCalls).toBe(0);
			expect(terminalTitleCalls).toBe(0);
			expect(harness.sessionManager.getSessionName()).toBeUndefined();
			expect(harness.sessionManager.setSessionNameCalls).toEqual([]);
		} finally {
			await harness.dispose();
		}
	});

	it("does not clobber a session title that appears while generation is in flight", async () => {
		delete Bun.env.PI_NO_TITLE;
		const harness = await createHarness();
		try {
			const generated = Promise.withResolvers<string | null>();
			let generateCalls = 0;
			let titleAppliedCalls = 0;
			const terminalTitleCalls: Array<{ name: string | undefined; cwd: string | undefined }> = [];
			const generateTitle: GenerateTitleFn = async () => {
				generateCalls++;
				return generated.promise;
			};
			const setTerminalTitle: SetTerminalTitleFn = (name, cwd) => {
				terminalTitleCalls.push({ name, cwd });
			};

			const started = startAutoSessionTitleGeneration({
				text: "Summarize the build failure and propose the smallest parser fix.",
				session: harness.session,
				sessionManager: harness.sessionManager,
				settings: harness.settings,
				onTitleApplied: () => {
					titleAppliedCalls++;
				},
				generateTitle,
				setTerminalTitle,
			});

			expect(started).toBe(true);
			expect(generateCalls).toBe(1);
			harness.sessionManager.setExternalSessionName("Manual incident triage");
			generated.resolve("Build failure parser fix");
			await settleMicrotasks();

			expect(harness.sessionManager.getSessionName()).toBe("Manual incident triage");
			expect(harness.sessionManager.setSessionNameCalls).toEqual([]);
			expect(terminalTitleCalls).toEqual([]);
			expect(titleAppliedCalls).toBe(0);
		} finally {
			await harness.dispose();
		}
	});
});
