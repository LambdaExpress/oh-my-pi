import { logger } from "@oh-my-pi/pi-utils";
import { LiveSessionController } from "../../live/controller";
import { LiveVisualizer } from "../../live/visualizer";
import { vocalizer } from "../../tts/vocalizer";
import type { CustomEditor } from "../components/custom-editor";
import type { InteractiveModeContext } from "../types";

const ANIMATION_INTERVAL_MS = 80;

function errorFrom(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

/** Owns the editor-replacing visualizer and realtime session lifecycle for `/live`. */
export class LiveCommandController {
	readonly #ctx: InteractiveModeContext;

	#session: LiveSessionController | undefined;
	#settling: Promise<void> | undefined;
	#visualizer: LiveVisualizer | undefined;
	#detachedEditor: CustomEditor | undefined;
	#animationInterval: NodeJS.Timeout | undefined;
	#previousShowHardwareCursor: boolean | undefined;
	#previousUseTerminalCursor: boolean | undefined;
	#resumeVocalizer: (() => void) | undefined;

	constructor(ctx: InteractiveModeContext) {
		this.#ctx = ctx;
	}

	/** Whether a live session is connected, connecting, or closing. */
	get active(): boolean {
		return this.#session !== undefined || this.#settling !== undefined;
	}

	/** Start live mode, or stop the currently active session. */
	async handleCommand(): Promise<void> {
		if (this.#session) {
			await this.stop();
			return;
		}
		if (this.#settling) await this.#settling;
		await this.#start();
	}

	/** Stop the active live session and restore the editor. */
	async stop(): Promise<void> {
		const session = this.#session;
		if (!session) {
			if (this.#settling) await this.#settling;
			return;
		}
		try {
			await session.stop();
		} catch (cause) {
			this.#finish(session, errorFrom(cause));
		} finally {
			this.#finish(session);
		}
	}

	/** Release UI resources during synchronous InteractiveMode teardown. */
	dispose(): void {
		const session = this.#session;
		if (session) {
			this.#finish(session);
			void session.stop().catch(cause => {
				logger.debug("Live session teardown failed", { error: errorFrom(cause).message });
			});
		} else {
			this.#restoreEditor();
		}
	}

	async #start(): Promise<void> {
		const visualizer = new LiveVisualizer({
			onStop: () => {
				void this.stop().catch(cause => this.#ctx.showError(errorFrom(cause).message));
			},
			onToggleMute: () => this.#session?.toggleMute(),
		});
		this.#mountVisualizer(visualizer);

		let session: LiveSessionController;
		session = new LiveSessionController({
			session: this.#ctx.session,
			extractAssistantText: message => this.#ctx.extractAssistantText(message),
			callbacks: {
				onPhase: phase => {
					if (this.#visualizer !== visualizer) return;
					visualizer.setPhase(phase);
					this.#ctx.ui.requestComponentRender(visualizer);
				},
				onLevels: (input, output) => {
					if (this.#visualizer !== visualizer) return;
					visualizer.setLevels(input, output);
					this.#ctx.ui.requestComponentRender(visualizer);
				},
				onTranscript: transcript => {
					if (this.#visualizer !== visualizer) return;
					visualizer.setTranscript(transcript);
					this.#ctx.ui.requestComponentRender(visualizer);
				},
				onTerminal: error => this.#finish(session, error),
			},
		});
		this.#session = session;

		try {
			await session.start();
		} catch (cause) {
			if (this.#session === session) {
				await session.stop();
				this.#finish(session, errorFrom(cause));
			}
		}
	}

	#mountVisualizer(visualizer: LiveVisualizer): void {
		this.#visualizer = visualizer;
		this.#detachedEditor = this.#ctx.editor;
		this.#previousShowHardwareCursor = this.#ctx.ui.getShowHardwareCursor();
		this.#previousUseTerminalCursor = this.#ctx.editor.getUseTerminalCursor();
		this.#ctx.ui.setShowHardwareCursor(false);
		this.#ctx.editor.setUseTerminalCursor(false);
		this.#ctx.editorContainer.clear();
		this.#ctx.editorContainer.addChild(visualizer);
		this.#ctx.ui.setFocus(visualizer);
		this.#resumeVocalizer = vocalizer.suspend();
		let frame = 0;
		this.#animationInterval = setInterval(() => {
			if (this.#visualizer !== visualizer) return;
			frame += 1;
			visualizer.setFrame(frame);
			this.#ctx.ui.requestComponentRender(visualizer);
		}, ANIMATION_INTERVAL_MS);
		this.#ctx.ui.requestRender();
	}

	#finish(session: LiveSessionController, error?: Error): void {
		if (this.#session !== session) return;
		this.#session = undefined;
		this.#restoreEditor();
		if (error) this.#ctx.showError(error.message);
		const settling = session.stop().catch(cause => {
			logger.debug("Live session cleanup failed", { error: errorFrom(cause).message });
		});
		this.#settling = settling;
		void settling.finally(() => {
			if (this.#settling === settling) this.#settling = undefined;
		});
	}

	#restoreEditor(): void {
		if (this.#animationInterval) {
			clearInterval(this.#animationInterval);
			this.#animationInterval = undefined;
		}
		this.#resumeVocalizer?.();
		this.#resumeVocalizer = undefined;
		const editor = this.#detachedEditor;
		this.#detachedEditor = undefined;
		this.#visualizer = undefined;
		if (!editor) return;
		this.#ctx.editorContainer.clear();
		this.#ctx.editorContainer.addChild(editor);
		if (this.#previousShowHardwareCursor !== undefined) {
			this.#ctx.ui.setShowHardwareCursor(this.#previousShowHardwareCursor);
		}
		if (this.#previousUseTerminalCursor !== undefined) {
			editor.setUseTerminalCursor(this.#previousUseTerminalCursor);
		}
		this.#previousShowHardwareCursor = undefined;
		this.#previousUseTerminalCursor = undefined;
		this.#ctx.ui.setFocus(editor);
		this.#ctx.ui.requestRender();
	}
}
