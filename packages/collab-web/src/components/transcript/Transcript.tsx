import type { AssistantMessage, ImageContent, SessionEntry, TextContent, ToolResultMessage } from "@oh-my-pi/pi-wire";
import { ChevronRight } from "lucide-react";
import { Fragment, memo, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ActiveTool } from "../../lib/client";
import { fmtTokens } from "../../lib/format";
import type { ToolRenderHost } from "../../tool-render";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";
import "./transcript.css";

export interface TranscriptProps {
	entries: readonly SessionEntry[];
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	working: boolean;
	compact?: boolean; // dense variant for the agent drawer
	/** Sub-session drill-down capabilities forwarded to tool renderers. */
	host?: ToolRenderHost;
}

function Row({
	kind,
	speaker,
	title,
	children,
}: {
	kind: "user" | "assistant" | "custom" | "marker";
	speaker: string;
	title?: string;
	children: ReactNode;
}): ReactNode {
	return (
		<div className={`tr-row tr-row--${kind}`} title={title}>
			<span className="tr-speaker">{speaker}</span>
			<div className="tr-body">{children}</div>
		</div>
	);
}

function ThinkingBlock({ text, redacted }: { text: string; redacted?: boolean }): ReactNode {
	const [open, setOpen] = useState(false);
	const contentId = useId();
	return (
		<div className="tr-think">
			<button
				type="button"
				className="tr-think-head"
				aria-expanded={open}
				aria-controls={contentId}
				onClick={() => setOpen(v => !v)}
			>
				<ChevronRight aria-hidden size={12} className={`tr-chev${open ? " tr-chev--open" : ""}`} />
				thinking{redacted ? " · redacted" : ""}
			</button>
			{open && (
				<div id={contentId} className="tr-think-body">
					{redacted ? "(redacted by provider)" : text}
				</div>
			)}
		</div>
	);
}

function StreamStatus({ label }: { label: string }): ReactNode {
	return (
		<div className="tr-stream-status" role="status" aria-live="polite">
			<span className="tr-stream-dot" aria-hidden />
			<span>{label}</span>
		</div>
	);
}

/** Markdown + image thumbnails for user / custom message content. */
function MsgContent({ content }: { content: string | readonly (TextContent | ImageContent)[] }): ReactNode {
	if (typeof content === "string") return <Markdown text={content} />;
	return (
		<>
			{content.map((block, i) => {
				switch (block.type) {
					case "text":
						return <Markdown key={i} text={block.text} />;
					case "image":
						return (
							<img
								key={i}
								className="tr-msg-img"
								src={`data:${block.mimeType};base64,${block.data}`}
								alt="attachment"
							/>
						);
					default:
						return null;
				}
			})}
		</>
	);
}

function AssistantBody({
	message,
	results,
	active,
	pending,
	host,
	mode = "all",
}: {
	message: AssistantMessage;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	/** Still streaming — suppress stop-reason chips on the partial message. */
	pending: boolean;
	host?: ToolRenderHost;
	mode?: "all" | "process" | "answer";
}): ReactNode {
	const blocks = message.content.map((block, i) => {
		if (mode === "answer" && block.type !== "text") return null;
		if (mode === "process" && block.type === "text") return null;
		switch (block.type) {
			case "thinking":
				return <ThinkingBlock key={i} text={block.thinking} />;
			case "redactedThinking":
				return <ThinkingBlock key={i} text="" redacted />;
			case "text":
				return <Markdown key={i} text={block.text} />;
			case "toolCall": {
				const act = active.get(block.id);
				const result = results.get(block.id);
				const args = act?.args ?? block.arguments;
				return (
					<ToolCard
						key={block.id}
						toolCallId={block.id}
						name={block.name}
						intent={block.intent ?? act?.intent}
						args={args}
						result={result}
						host={host}
						running={!result && (act !== undefined || pending)}
						partialResult={act?.partialResult}
					/>
				);
			}
			default:
				return null;
		}
	});
	const stop = message.stopReason;
	const failed = mode !== "process" && !pending && (stop === "error" || stop === "aborted");
	return (
		<>
			{blocks}
			{failed && (
				<div className="tr-stop">
					<span className={`tr-chip ${stop === "error" ? "tr-chip--err" : "tr-chip--warn"}`}>{stop}</span>
					{message.errorMessage !== undefined && message.errorMessage.length > 0 && (
						<span className="tr-stop-msg">{message.errorMessage}</span>
					)}
				</div>
			)}
		</>
	);
}

interface EntryRowProps {
	entry: SessionEntry;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	host?: ToolRenderHost;
	assistantMode?: "all" | "process" | "answer";
}

/** Re-render only when the entry itself or one of its tool pairings changed. */
function entryRowEqual(prev: EntryRowProps, next: EntryRowProps): boolean {
	if (prev.entry !== next.entry || prev.host !== next.host || prev.assistantMode !== next.assistantMode) return false;
	const e = next.entry;
	if (e.type !== "message" || e.message.role !== "assistant") return true;
	for (const block of e.message.content) {
		if (block.type !== "toolCall") continue;
		if (prev.results.get(block.id) !== next.results.get(block.id)) return false;
		if (prev.active.get(block.id) !== next.active.get(block.id)) return false;
	}
	return true;
}

const EntryRow = memo(function EntryRow({ entry, results, active, host, assistantMode }: EntryRowProps): ReactNode {
	switch (entry.type) {
		case "message": {
			const msg = entry.message;
			switch (msg.role) {
				case "user":
					return (
						<Row kind="user" speaker="host" title={entry.timestamp}>
							<MsgContent content={msg.content} />
						</Row>
					);
				case "assistant":
					return (
						<Row kind="assistant" speaker="agent" title={entry.timestamp}>
							<AssistantBody
								message={msg}
								results={results}
								active={active}
								pending={false}
								host={host}
								mode={assistantMode}
							/>
						</Row>
					);
				default:
					// toolResult entries are consumed via pairing; developer & unknown roles skipped
					return null;
			}
		}
		case "custom_message": {
			if (entry.customType === "collab-prompt") {
				const details = entry.details;
				const from =
					details !== null &&
					typeof details === "object" &&
					typeof (details as Record<string, unknown>).from === "string"
						? ((details as Record<string, unknown>).from as string)
						: "guest";
				return (
					<Row kind="user" speaker={from} title={entry.timestamp}>
						<MsgContent content={entry.content} />
					</Row>
				);
			}
			if (!entry.display) return null;
			return (
				<Row kind="custom" speaker="system" title={entry.timestamp}>
					<div className="tr-custom">
						<span className="tr-marker-label">{entry.customType}</span>
						<MsgContent content={entry.content} />
					</div>
				</Row>
			);
		}
		case "compaction":
			return (
				<div className="tr-divider" title={entry.shortSummary ?? entry.summary}>
					<span className="tr-speaker">system</span>
					<span>context compacted · {fmtTokens(entry.tokensBefore)} tokens</span>
				</div>
			);
		case "branch_summary":
			return (
				<div className="tr-divider" title={entry.summary}>
					<span className="tr-speaker">system</span>
					<span>branch summary</span>
				</div>
			);
		case "model_change":
			return (
				<Row kind="marker" speaker="system" title={entry.timestamp}>
					<span className="tr-marker">model → {entry.model}</span>
				</Row>
			);
		case "thinking_level_change":
			return (
				<Row kind="marker" speaker="system" title={entry.timestamp}>
					<span className="tr-marker">thinking → {entry.thinkingLevel ?? "off"}</span>
				</Row>
			);
		default:
			// unknown entry types from newer hosts — skip tolerantly
			return null;
	}
}, entryRowEqual);

interface CompletedRun {
	id: string;
	anchor: SessionEntry;
	process: readonly SessionEntry[];
	final: SessionEntry & { type: "message"; message: AssistantMessage };
	after: readonly SessionEntry[];
	finalHasProcess: boolean;
	updates: number;
	tools: number;
}

type TranscriptPart = { kind: "entry"; entry: SessionEntry } | { kind: "run"; run: CompletedRun };

function startsUserRun(entry: SessionEntry): boolean {
	if (entry.type === "custom_message") return entry.customType === "collab-prompt";
	return entry.type === "message" && entry.message.role === "user" && entry.message.synthetic !== true;
}

function assistantEntry(entry: SessionEntry): entry is CompletedRun["final"] {
	return entry.type === "message" && entry.message.role === "assistant";
}

function hasRenderableProcess(entries: readonly SessionEntry[]): boolean {
	return entries.some(entry => {
		if (entry.type === "message") return entry.message.role === "assistant" && entry.message.content.length > 0;
		if (entry.type === "custom_message") return entry.display === true;
		return true;
	});
}

function completedRun(segment: readonly SessionEntry[], isActive: boolean): CompletedRun | null {
	if (isActive || segment.length < 2) return null;
	let finalIndex = -1;
	for (let i = segment.length - 1; i > 0; i--) {
		if (assistantEntry(segment[i]!)) {
			finalIndex = i;
			break;
		}
	}
	if (finalIndex < 1) return null;
	const final = segment[finalIndex]!;
	if (!assistantEntry(final) || final.message.stopReason !== "stop") return null;
	if (!final.message.content.some(block => block.type === "text" && block.text.length > 0)) return null;

	const process = segment.slice(1, finalIndex);
	const finalHasProcess = final.message.content.some(block => block.type !== "text");
	if (!finalHasProcess && !hasRenderableProcess(process)) return null;

	let updates = 0;
	let tools = 0;
	for (const entry of [...process, final]) {
		if (!assistantEntry(entry)) continue;
		if (entry !== final && entry.message.content.some(block => block.type !== "toolCall")) updates++;
		for (const block of entry.message.content) {
			if (block.type === "toolCall") tools++;
		}
	}

	return {
		id: segment[0]!.id,
		anchor: segment[0]!,
		process,
		final,
		after: segment.slice(finalIndex + 1),
		finalHasProcess,
		updates,
		tools,
	};
}

function transcriptParts(entries: readonly SessionEntry[], working: boolean): TranscriptPart[] {
	const parts: TranscriptPart[] = [];
	let index = 0;
	while (index < entries.length) {
		const anchor = entries[index]!;
		if (!startsUserRun(anchor)) {
			parts.push({ kind: "entry", entry: anchor });
			index++;
			continue;
		}
		let end = index + 1;
		while (end < entries.length && !startsUserRun(entries[end]!)) end++;
		const run = completedRun(entries.slice(index, end), working && end === entries.length);
		if (run) parts.push({ kind: "run", run });
		else {
			for (let i = index; i < end; i++) parts.push({ kind: "entry", entry: entries[i]! });
		}
		index = end;
	}
	return parts;
}

function CompletedRunView({
	run,
	results,
	active,
	host,
}: {
	run: CompletedRun;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	host?: ToolRenderHost;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const processId = useId();
	const details = [
		run.updates > 0 ? `${run.updates} update${run.updates === 1 ? "" : "s"}` : null,
		run.tools > 0 ? `${run.tools} tool${run.tools === 1 ? "" : "s"}` : null,
	]
		.filter((value): value is string => value !== null)
		.join(" · ");

	return (
		<>
			<EntryRow entry={run.anchor} results={results} active={active} host={host} />
			<button
				type="button"
				className="tr-run-toggle"
				aria-expanded={open}
				aria-controls={processId}
				onClick={() => setOpen(value => !value)}
			>
				<ChevronRight aria-hidden size={13} className={`tr-chev${open ? " tr-chev--open" : ""}`} />
				<span>{open ? "Hide process" : "Show process"}</span>
				{details && <span className="tr-run-meta">{details}</span>}
			</button>
			<div
				id={processId}
				className="tr-run-process"
				data-expanded={open ? "true" : "false"}
				aria-hidden={!open}
				inert={!open ? true : undefined}
			>
				<div className="tr-run-process-inner">
					{run.process.map(entry => (
						<EntryRow key={entry.id} entry={entry} results={results} active={active} host={host} />
					))}
					{run.finalHasProcess && (
						<EntryRow entry={run.final} results={results} active={active} host={host} assistantMode="process" />
					)}
				</div>
			</div>
			<EntryRow entry={run.final} results={results} active={active} host={host} assistantMode="answer" />
			{run.after.map(entry => (
				<EntryRow key={entry.id} entry={entry} results={results} active={active} host={host} />
			))}
		</>
	);
}

export function Transcript(props: TranscriptProps): ReactNode {
	const { entries, stream, streamDone, activeTools, working, compact, host } = props;

	const results = useMemo(() => {
		const map = new Map<string, ToolResultMessage>();
		for (const entry of entries) {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				map.set(entry.message.toolCallId, entry.message);
			}
		}
		return map;
	}, [entries]);
	const parts = useMemo(() => transcriptParts(entries, working), [entries, working]);

	const rootRef = useRef<HTMLDivElement | null>(null);
	const lockRef = useRef(true);

	// Follow the tail while bottom-locked; releasing/re-arming happens in onScroll.
	useEffect(() => {
		const el = rootRef.current;
		if (el !== null && lockRef.current) el.scrollTop = el.scrollHeight;
	}, [entries, stream, activeTools, working]);

	// Active tools not already represented as toolCall blocks in committed rows or the stream ghost.
	const renderedToolIds = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const block of entry.message.content) {
			if (block.type === "toolCall") renderedToolIds.add(block.id);
		}
	}
	if (stream !== null) {
		for (const block of stream.content) {
			if (block.type === "toolCall") renderedToolIds.add(block.id);
		}
	}
	const tailTools: ActiveTool[] = [];
	for (const tool of activeTools.values()) {
		if (!renderedToolIds.has(tool.toolCallId)) tailTools.push(tool);
	}

	return (
		<div
			ref={rootRef}
			className={`tr-root${compact === true ? " tr-root--compact" : ""}`}
			onScroll={() => {
				const el = rootRef.current;
				if (el !== null) {
					lockRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 40;
				}
			}}
		>
			{entries.length === 0 && stream === null && !working && <div className="tr-empty">no activity yet</div>}
			{parts.map(part =>
				part.kind === "run" ? (
					<CompletedRunView
						key={`run:${part.run.id}`}
						run={part.run}
						results={results}
						active={activeTools}
						host={host}
					/>
				) : (
					<Fragment key={part.entry.id}>
						<EntryRow entry={part.entry} results={results} active={activeTools} host={host} />
					</Fragment>
				),
			)}
			{stream !== null && (
				<Row kind="assistant" speaker="agent">
					<AssistantBody
						message={stream}
						results={results}
						active={activeTools}
						pending={!streamDone}
						host={host}
					/>
					{!streamDone && <StreamStatus label="responding…" />}
				</Row>
			)}
			{tailTools.length > 0 && (
				<Row kind="assistant" speaker="agent">
					{tailTools.map(tool => (
						<ToolCard
							key={tool.toolCallId}
							toolCallId={tool.toolCallId}
							name={tool.toolName}
							intent={tool.intent}
							args={tool.args}
							running
							partialResult={tool.partialResult}
							host={host}
						/>
					))}
				</Row>
			)}
			{working && stream === null && activeTools.size === 0 && (
				<Row kind="assistant" speaker="agent">
					<StreamStatus label="thinking…" />
				</Row>
			)}
		</div>
	);
}
