import type { Api, Model } from "@oh-my-pi/pi-ai";
import { $env, logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { isLowSignalTitleInput } from "../tiny/text";
import { generateSessionTitle, setSessionTerminalTitle } from "./title-generator";

type TitleSession = {
	sessionId: string;
	model?: Model<Api>;
	modelRegistry: ModelRegistry;
	agent: {
		metadataForProvider(provider: string): Record<string, unknown> | undefined;
	};
};

type TitleSessionManager = {
	getSessionName(): string | undefined;
	setSessionName(name: string, source: "auto"): Promise<boolean>;
	getCwd(): string;
};

type GenerateSessionTitleFn = (
	firstMessage: string,
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
	currentModel?: Model<Api>,
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined,
	customSystemPrompt?: string,
) => Promise<string | null>;

type SetSessionTerminalTitleFn = (sessionName: string | undefined, cwd?: string) => void;

export interface AutoSessionTitleOptions {
	text: string;
	session: TitleSession;
	sessionManager: TitleSessionManager;
	settings: Settings;
	titleSystemPrompt?: string;
	onBeforeGenerate?: () => void;
	onTitleApplied?: () => void;
	generateTitle?: GenerateSessionTitleFn;
	setTerminalTitle?: SetSessionTerminalTitleFn;
}

/**
 * Fire-and-forget auto-title generation for the first meaningful user prompt.
 * Returns true when a generation request was started.
 */
export function startAutoSessionTitleGeneration(options: AutoSessionTitleOptions): boolean {
	const { text, session, sessionManager, settings, titleSystemPrompt } = options;
	if (sessionManager.getSessionName()) return false;
	if ($env.PI_NO_TITLE) return false;
	if (isLowSignalTitleInput(text)) return false;

	options.onBeforeGenerate?.();
	const generateTitle = options.generateTitle ?? generateSessionTitle;
	const setTerminalTitle = options.setTerminalTitle ?? setSessionTerminalTitle;

	generateTitle(
		text,
		session.modelRegistry,
		settings,
		session.sessionId,
		session.model,
		provider => session.agent.metadataForProvider(provider),
		titleSystemPrompt,
	)
		.then(async title => {
			if (!title || sessionManager.getSessionName()) return;
			const applied = await sessionManager.setSessionName(title, "auto");
			if (!applied) return;
			setTerminalTitle(sessionManager.getSessionName() ?? title, sessionManager.getCwd());
			options.onTitleApplied?.();
		})
		.catch(err => {
			logger.warn("title-generator: uncaught auto-title error", {
				sessionId: session.sessionId,
				reason: "uncaught-auto-title-error",
				error: err instanceof Error ? err.message : String(err),
			});
		});

	return true;
}
