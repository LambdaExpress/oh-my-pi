import type { Component } from "../tui";
import { Text } from "../components/text";
import type { Theme, ThemeColor } from "../theme/theme";
import { renderStatusLine } from "../render/status-line";
import { framedToolCard } from "../render/tool-card";
import {
	formatExpandHint,
	formatStatusIcon,
	PREVIEW_LIMITS,
	replaceTabs,
	sanitizeDisplayWarning,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../render/render-utils";
import { t } from "../i18n";
import type { RenderResultOptions, ToolActivityContext, ToolActivitySummary, ToolRenderer } from "./renderer";

/** Display fields captured from a debugger session. */
export interface DebugSessionSnapshot {
	id: string;
	adapter: string;
	status: string;
	cwd: string;
	program?: string;
	stopReason?: string;
	frameName?: string;
	instructionPointerReference?: string;
	source?: { path?: string };
	line?: number;
	column?: number;
	needsConfigurationDone: boolean;
	exitCode?: number;
}

/** Debug execution metadata consumed by the transcript. */
export interface DebugToolDetails {
	action: string;
	success: boolean;
	snapshot?: DebugSessionSnapshot;
}

/** Debug arguments used to describe a pending request. */
export interface DebugRenderArgs {
	action?: string;
	program?: string;
	file?: string;
	line?: number;
	function?: string;
	expression?: string;
	command?: string;
	memory_reference?: string;
	instruction_reference?: string;
	data_id?: string;
	name?: string;
}

/** Formats a debugger stop location as a source path and coordinates. */
export function formatLocation(snapshot: DebugSessionSnapshot | undefined): string | null {
	if (!snapshot?.source?.path || snapshot.line === undefined) {
		return null;
	}
	return `${snapshot.source.path}:${snapshot.line}${snapshot.column !== undefined ? `:${snapshot.column}` : ""}`;
}

/** Formats the debugger session snapshot for model and terminal output. */
export function formatSessionSnapshot(snapshot: DebugSessionSnapshot): string[] {
	const lines = [
		`Session ${snapshot.id}`,
		`Adapter: ${snapshot.adapter}`,
		`Status: ${snapshot.status}`,
		`CWD: ${snapshot.cwd}`,
	];
	if (snapshot.program) lines.push(`Program: ${snapshot.program}`);
	if (snapshot.stopReason) lines.push(`Stop reason: ${snapshot.stopReason}`);
	if (snapshot.frameName) lines.push(`Frame: ${snapshot.frameName}`);
	if (snapshot.instructionPointerReference) {
		lines.push(`Instruction pointer: ${snapshot.instructionPointerReference}`);
	}
	const location = formatLocation(snapshot);
	if (location) lines.push(`Location: ${location}`);
	if (snapshot.needsConfigurationDone) {
		lines.push("Configuration: pending configurationDone; set breakpoints, then continue.");
	}
	if (snapshot.exitCode !== undefined) lines.push(`Exit code: ${snapshot.exitCode}`);
	return lines;
}

function summarizeDebugCall(args: DebugRenderArgs): string {
	const action = args.action ? args.action.replaceAll("_", " ") : "request";
	if (args.program) {
		return `${action} ${truncateToWidth(args.program, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.file && args.line !== undefined) {
		return `${action} ${truncateToWidth(`${args.file}:${args.line}`, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.function) {
		return `${action} ${truncateToWidth(args.function, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.expression) {
		return `${action} ${truncateToWidth(args.expression, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.command) {
		return `${action} ${truncateToWidth(args.command, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.memory_reference) {
		return `${action} ${truncateToWidth(args.memory_reference, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.instruction_reference) {
		return `${action} ${truncateToWidth(args.instruction_reference, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.data_id) {
		return `${action} ${truncateToWidth(args.data_id, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.name) {
		return `${action} ${truncateToWidth(args.name, TRUNCATE_LENGTHS.TITLE)}`;
	}
	return action;
}

const DEBUG_ACCENT_FIELDS: Record<string, true> = {
	CWD: true,
	"Data ID": true,
	Execution: true,
	Frame: true,
	Function: true,
	"Instruction pointer": true,
	Location: true,
	Program: true,
	"Session ID": true,
	Variable: true,
	"Variables ref": true,
};

const DEBUG_MUTED_FIELDS: Record<string, true> = {
	"Access types": true,
	"Bytes written": true,
	Configuration: true,
	"Exit code": true,
	Offset: true,
	Persistent: true,
	"Stop reason": true,
	"Stop snapshot": true,
	"Trigger deadline": true,
	Type: true,
	"Unreadable bytes": true,
};

function debugStatusColor(status: string): ThemeColor {
	switch (status.trim().toLowerCase()) {
		case "running":
			return "accent";
		case "stopped":
			return "warning";
		case "terminated":
			return "success";
		case "error":
		case "failed":
		case "missing":
			return "error";
		default:
			return "toolOutput";
	}
}

function styleDebugLines(lines: readonly string[], theme: Theme, isError = false): string[] {
	const styled: string[] = [];
	let outputContinuationColor: ThemeColor | undefined;
	let inNextActions = false;

	for (const line of lines) {
		if (line.length === 0) {
			styled.push(line);
			outputContinuationColor = undefined;
			continue;
		}
		if (isError) {
			styled.push(theme.fg("error", line));
			continue;
		}

		const categoryLine = /^\[([^\]]+)\](?: (.*))?$/.exec(line);
		if (categoryLine) {
			const category = categoryLine[1].toLowerCase();
			let labelColor: ThemeColor = "dim";
			outputContinuationColor = "toolOutput";
			if (category === "stderr") {
				labelColor = "error";
				outputContinuationColor = "error";
			} else if (category === "telemetry") {
				labelColor = "muted";
				outputContinuationColor = "muted";
			} else if (category === "important") {
				labelColor = "warning";
				outputContinuationColor = "warning";
			}
			const label = `[${categoryLine[1]}]`;
			styled.push(
				categoryLine[2] === undefined
					? theme.fg(labelColor, label)
					: `${theme.fg(labelColor, label)} ${theme.fg(outputContinuationColor, categoryLine[2])}`,
			);
			inNextActions = false;
			continue;
		}
		if (outputContinuationColor && line.startsWith("  ")) {
			const indentColor = outputContinuationColor === "toolOutput" ? "dim" : outputContinuationColor;
			styled.push(`${theme.fg(indentColor, line.slice(0, 2))}${theme.fg(outputContinuationColor, line.slice(2))}`);
			continue;
		}
		outputContinuationColor = undefined;

		if (line === "Next:") {
			styled.push(theme.fg("dim", line));
			inNextActions = true;
			continue;
		}
		if (inNextActions) {
			const nextAction = /^(.+?: )(\{.*)$/.exec(line);
			if (nextAction) {
				styled.push(`${theme.fg("dim", nextAction[1])}${theme.fg("toolOutput", nextAction[2])}`);
				continue;
			}
			inNextActions = false;
		}

		const session = /^(Session )(.+)$/.exec(line);
		if (session) {
			styled.push(`${theme.fg("dim", session[1])}${theme.fg("accent", session[2])}`);
			continue;
		}

		const field = /^([A-Za-z][A-Za-z ]*): (.*)$/.exec(line);
		if (field) {
			const label = field[1];
			const value = field[2];
			const prefix = theme.fg("dim", `${label}: `);
			if (label === "Trigger") {
				const trigger = /^(.*?)( \()([^()]*)\)$/.exec(value);
				styled.push(
					value === "none"
						? `${prefix}${theme.fg("muted", value)}`
						: trigger
							? `${prefix}${theme.fg("accent", trigger[1])}${theme.fg("dim", trigger[2])}${theme.fg(
									debugStatusColor(trigger[3]),
									trigger[3],
								)}${theme.fg("dim", ")")}`
							: `${prefix}${theme.fg("accent", value)}`,
				);
				continue;
			}

			let valueColor: ThemeColor = "toolOutput";
			if (DEBUG_ACCENT_FIELDS[label] === true) {
				valueColor = "accent";
			} else if (label === "Status" || label === "Winner") {
				valueColor = debugStatusColor(value);
			} else if (/error/i.test(label)) {
				valueColor = "error";
			} else if (DEBUG_MUTED_FIELDS[label] === true) {
				valueColor = "muted";
			}
			styled.push(`${prefix}${theme.fg(valueColor, value)}`);
			continue;
		}

		if (/^[^\s].*:$/.test(line)) {
			styled.push(theme.fg("dim", line));
			continue;
		}
		const treeLine = /^(\s*(?:[-*] |[│├└─]+\s*))(.*)$/u.exec(line);
		if (treeLine) {
			styled.push(`${theme.fg("dim", treeLine[1])}${theme.fg("toolOutput", treeLine[2])}`);
			continue;
		}

		styled.push(theme.fg("toolOutput", line));
	}

	return styled;
}

/** Renders debugger calls and captured execution snapshots. */
export const debugToolRenderer = {
	animatedPartialResult: true,
	/** Folded row: the debugger action plus its target, same text as the call header. */
	activitySummary(args: unknown, context: ToolActivityContext): ToolActivitySummary {
		const detail = summarizeDebugCall((args ?? {}) as DebugRenderArgs);
		return { label: t("Debug"), detail: context.theme.fg("muted", sanitizeDisplayWarning(detail)) };
	},
	renderCall(args: DebugRenderArgs, _options: RenderResultOptions, theme: Theme): Component {
		const text = renderStatusLine(
			{ icon: "pending", title: t("Debug"), description: summarizeDebugCall(args) },
			theme,
		);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: DebugToolDetails; isError?: boolean },
		options: RenderResultOptions,
		theme: Theme,
		args?: DebugRenderArgs,
	): Component {
		return framedToolCard(theme, () => {
			const action = (args?.action ?? result.details?.action ?? "debug").replaceAll("_", " ");
			const success = !options.isPartial && !result.isError;
			const statusIcon = success
				? theme.styledSymbol("tool.debug", "accent")
				: formatStatusIcon(options.isPartial ? "running" : "error", theme, options.spinnerFrame);
			const header = `${statusIcon} ${t("Debug")} ${action}`;
			const summaryLines = result.details?.snapshot
				? styleDebugLines(
						formatSessionSnapshot(result.details.snapshot).map(line => replaceTabs(line)),
						theme,
					)
				: [];
			const text = result.content.find(block => block.type === "text")?.text ?? t("No output");
			const rawLines = replaceTabs(text).split("\n");
			const previewLimit = options.expanded ? rawLines.length : PREVIEW_LIMITS.COLLAPSED_LINES;
			const displayedLines = styleDebugLines(
				rawLines.slice(0, previewLimit).map(line => truncateToWidth(line, TRUNCATE_LENGTHS.LINE)),
				theme,
				result.isError,
			);
			const remaining = rawLines.length - displayedLines.length;
			if (remaining > 0) {
				displayedLines.push(
					theme.fg(
						"muted",
						`${t("… {count} more lines", { count: remaining })} ${formatExpandHint(theme, options.expanded, true)}`,
					),
				);
			}
			return {
				header,
				phase: options.isPartial ? "partial" : result.isError ? "error" : "success",
				sections: [
					...(summaryLines.length > 0
						? [{ label: theme.fg("toolTitle", t("Session")), content: summaryLines }]
						: []),
					{ label: theme.fg("toolTitle", t("Output")), content: displayedLines },
				],
				applyBg: false,
			};
		});
	},
	mergeCallAndResult: true,
	inline: true,
} satisfies ToolRenderer<DebugRenderArgs, DebugToolDetails>;
