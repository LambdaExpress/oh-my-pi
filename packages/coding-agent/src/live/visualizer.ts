import { type Component, matchesKey, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { type ThemeColor, theme } from "../modes/theme/theme";

/** Distinct states of a realtime call connection. */
export type LivePhase = "connecting" | "listening" | "working" | "speaking" | "muted" | "error";

/** A transcribed turn in the realtime call. */
export interface LiveTranscript {
	role: "user" | "assistant";
	text: string;
}

/** Configuration callbacks for user interactions in the visualizer. */
export interface LiveVisualizerOptions {
	onStop(): void;
	onToggleMute(): void;
}

/** A compact, fixed-height terminal component for displaying a realtime call. */
export class LiveVisualizer implements Component {
	readonly wantsKeyRelease = false;

	readonly #options: LiveVisualizerOptions;

	#phase: LivePhase = "connecting";
	#inputLevel = 0;
	#outputLevel = 0;
	#transcript: LiveTranscript | undefined;
	#frame = 0;

	#cache:
		| {
				width: number;
				phase: LivePhase;
				inputLevel: number;
				outputLevel: number;
				transcriptRole: string | undefined;
				transcriptText: string | undefined;
				frame: number;
				lines: readonly string[];
		  }
		| undefined;

	constructor(options: LiveVisualizerOptions) {
		this.#options = options;
	}

	/** Updates the current call phase. */
	setPhase(phase: LivePhase): void {
		if (this.#phase !== phase) {
			this.#phase = phase;
			this.invalidate();
		}
	}

	/** Updates the current input and output volume levels (0..1). */
	setLevels(input: number, output: number): void {
		if (this.#inputLevel !== input || this.#outputLevel !== output) {
			this.#inputLevel = input;
			this.#outputLevel = output;
			this.invalidate();
		}
	}

	/** Updates the latest transcript fragment. */
	setTranscript(transcript: LiveTranscript | undefined): void {
		if (this.#transcript?.role !== transcript?.role || this.#transcript?.text !== transcript?.text) {
			this.#transcript = transcript ? { ...transcript } : undefined;
			this.invalidate();
		}
	}

	/** Updates the animation frame for spinners and waveforms. */
	setFrame(frame: number): void {
		if (this.#frame !== frame) {
			this.#frame = frame;
			this.invalidate();
		}
	}

	/** Processes user keypresses. */
	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.#options.onStop();
		} else if (matchesKey(data, "space")) {
			this.#options.onToggleMute();
		}
	}

	/** Clears the render cache. */
	invalidate(): void {
		this.#cache = undefined;
	}

	/** Renders the visualizer into a fixed array of rows at the given width. */
	render(width: number): readonly string[] {
		if (
			this.#cache &&
			this.#cache.width === width &&
			this.#cache.phase === this.#phase &&
			this.#cache.inputLevel === this.#inputLevel &&
			this.#cache.outputLevel === this.#outputLevel &&
			this.#cache.frame === this.#frame &&
			this.#cache.transcriptRole === this.#transcript?.role &&
			this.#cache.transcriptText === this.#transcript?.text
		) {
			return this.#cache.lines;
		}

		const lines = this.#renderLines(width);

		this.#cache = {
			width,
			phase: this.#phase,
			inputLevel: this.#inputLevel,
			outputLevel: this.#outputLevel,
			frame: this.#frame,
			transcriptRole: this.#transcript?.role,
			transcriptText: this.#transcript?.text,
			lines,
		};

		return lines;
	}

	#renderLines(maxWidth: number): readonly string[] {
		const w = Math.max(2, Math.min(maxWidth, 120));
		const innerW = w - 2;

		const topBorder = theme.fg("border", `┌${"─".repeat(innerW)}${w > 1 ? "┐" : ""}`);

		const maxWaveW = Math.min(40, Math.max(0, w - 4));
		const sideW = Math.max(0, Math.floor((maxWaveW - 3) / 2));

		const inWave = this.#generateWaveform(this.#inputLevel, sideW, true);
		const outWave = this.#generateWaveform(this.#outputLevel, sideW, false);

		const inColor: ThemeColor = this.#phase === "muted" ? "dim" : "success";
		const outColor: ThemeColor = this.#phase === "error" ? "error" : "accent";

		const waveContent = truncateToWidth(
			theme.fg(inColor, inWave) + theme.fg("dim", " │ ") + theme.fg(outColor, outWave),
			innerW,
		);
		const waveLen = visibleWidth(waveContent);

		const wavePadL = Math.floor((innerW - waveLen) / 2);
		const wavePadR = innerW - waveLen - wavePadL;
		const row1 =
			theme.fg("border", "│") +
			" ".repeat(Math.max(0, wavePadL)) +
			waveContent +
			" ".repeat(Math.max(0, wavePadR)) +
			(w > 1 ? theme.fg("border", "│") : "");

		const phaseColors: Record<LivePhase, ThemeColor> = {
			connecting: "dim",
			listening: "success",
			working: "warning",
			speaking: "accent",
			muted: "dim",
			error: "error",
		};

		const spinners = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
		let phaseIcon: string;
		if (this.#phase === "working") {
			phaseIcon = spinners[this.#frame % spinners.length];
		} else {
			const staticIcons: Record<LivePhase, string> = {
				connecting: "○",
				listening: "●",
				working: "○",
				speaking: "»",
				muted: "×",
				error: "!",
			};
			phaseIcon = staticIcons[this.#phase];
		}

		const phaseText = truncateToWidth(` ${phaseIcon} ${this.#phase.toUpperCase()} `, innerW);
		const coloredPhase = theme.fg(phaseColors[this.#phase], phaseText);

		const pLen = visibleWidth(coloredPhase);
		const pPadL = Math.floor((innerW - pLen) / 2);
		const pPadR = innerW - pLen - pPadL;
		const row2 =
			theme.fg("border", "│") +
			" ".repeat(Math.max(0, pPadL)) +
			coloredPhase +
			" ".repeat(Math.max(0, pPadR)) +
			(w > 1 ? theme.fg("border", "│") : "");

		const row3 = theme.fg("border", "│") + " ".repeat(Math.max(0, innerW)) + (w > 1 ? theme.fg("border", "│") : "");

		let transcriptText = "";
		if (this.#transcript) {
			const cleanText = sanitizeText(this.#transcript.text).replace(/[\r\n\t]+/g, " ");
			const roleStr = this.#transcript.role === "user" ? "User: " : "Assistant: ";
			transcriptText = theme.fg("dim", roleStr + cleanText);
		}
		const row4Content = truncateToWidth(`  ${transcriptText}`, Math.max(0, innerW - 2)) || "";
		const r4Pad = Math.max(0, innerW - visibleWidth(row4Content));
		const row4 = theme.fg("border", "│") + row4Content + " ".repeat(r4Pad) + (w > 1 ? theme.fg("border", "│") : "");

		const footerContent = truncateToWidth(" space mute · esc end ", innerW);
		const dashCount = Math.max(0, innerW - visibleWidth(footerContent));
		let bottomBorder: string;
		if (innerW >= visibleWidth(footerContent) + 2) {
			bottomBorder =
				theme.fg("border", "└─") +
				theme.fg("dim", footerContent) +
				theme.fg("border", "─".repeat(dashCount - 2) + (w > 1 ? "┘" : ""));
		} else {
			bottomBorder = theme.fg("border", `└${"─".repeat(Math.max(0, innerW))}${w > 1 ? "┘" : ""}`);
		}

		return [topBorder, row1, row2, row3, row4, bottomBorder];
	}

	#generateWaveform(level: number, width: number, reverse: boolean): string {
		const chars = [" ", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
		let out = "";
		for (let i = 0; i < width; i++) {
			const dist = reverse ? width - 1 - i : i;
			const decay = Math.max(0, 1 - (dist / width) * 1.5);
			const val = level * decay * (0.5 + 0.5 * Math.sin(this.#frame * 0.5 + dist * 0.8));
			const charIdx = Math.max(0, Math.min(chars.length - 1, Math.floor(val * chars.length)));
			out += chars[charIdx];
		}
		return out;
	}
}
