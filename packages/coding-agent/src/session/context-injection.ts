/**
 * Context injection records.
 *
 * The harness pushes content into the model's context on its own: project
 * instruction files (`AGENTS.md` and friends), always-apply rules, rulebook
 * rules, the skill index, and memory payloads. A {@link ContextInjectionItem}
 * inventories one such source — what it was, how big it is, and a bounded
 * preview of the injected body — so the transcript can show the user what went
 * into the context window and when.
 *
 * Records are persisted as `custom` journal entries (per
 * `CustomEntry`'s contract they never enter the LLM context) and replayed as
 * display-only custom messages by `buildSessionContext`, which is what keeps an
 * injection notice on screen across transcript rebuilds.
 */
import { formatBytes, isRecord } from "@oh-my-pi/pi-utils";
import { createCustomMessage, type CustomMessage } from "./messages";

/** Where an injected block came from, used for the notice's per-item styling. */
export type ContextInjectionKind =
	| "context-file"
	| "rule"
	| "rulebook"
	| "skill"
	| "memory"
	| "notes"
	/** Instructions injected alongside the prompt by the harness or a connected server (MCP). */
	| "guidance";

/** One injected source: what it is, how big it is, and a preview of its body. */
export interface ContextInjectionItem {
	kind: ContextInjectionKind;
	/** Display name without decoration: `AGENTS.md`, `ts-set-map`, or an i18n key for a group (`Rulebook`). */
	label: string;
	/** Origin and size, already display-formatted: `~/project/AGENTS.md · 4.2 KB`. */
	detail?: string;
	/** Entry count for group kinds, rendered as a localized unit (`12 rules`). */
	count?: number;
	/** Bounded head of the injected text, shown when the block is expanded. */
	preview?: string;
}

/** Details payload carried by an injection notice message. */
export interface ContextInjectionDetails {
	items: ContextInjectionItem[];
}

const CONTEXT_INJECTION_KINDS = [
	"context-file",
	"rule",
	"rulebook",
	"skill",
	"memory",
	"notes",
	"guidance",
] as const satisfies readonly ContextInjectionKind[];

function isContextInjectionKind(value: unknown): value is ContextInjectionKind {
	return typeof value === "string" && (CONTEXT_INJECTION_KINDS as readonly string[]).includes(value);
}

/** `custom` journal entry type holding one injection record. */
export const CONTEXT_INJECTION_ENTRY_TYPE = "context-injection";
/** Custom message type the transcript renderer keys its injection notice on. */
export const CONTEXT_INJECTION_MESSAGE_TYPE = "context-injection";

/** Items kept per record; the tail is folded into a trailing count. */
export const MAX_CONTEXT_INJECTION_ITEMS = 10;
/** Characters kept per item preview. */
export const MAX_CONTEXT_INJECTION_PREVIEW_CHARS = 600;

/** Clip a preview to the per-item budget, dropping a partial trailing line. */
export function clipInjectionPreview(text: string): string {
	const normalized = text.replace(/\r\n/g, "\n").trim();
	if (normalized.length <= MAX_CONTEXT_INJECTION_PREVIEW_CHARS) return normalized;
	const head = normalized.slice(0, MAX_CONTEXT_INJECTION_PREVIEW_CHARS);
	const lastBreak = head.lastIndexOf("\n");
	return (lastBreak > MAX_CONTEXT_INJECTION_PREVIEW_CHARS / 2 ? head.slice(0, lastBreak) : head).trimEnd();
}

/** Format an injected body's size for an item detail line. */
export function formatInjectionSize(text: string): string {
	return formatBytes(Buffer.byteLength(text, "utf8"));
}

/**
 * Trim, drop unnamed items, and cap the list. Duplicate labels collapse into
 * one item so a re-injected source does not repeat itself in the notice.
 */
export function normalizeContextInjectionItems(items: readonly ContextInjectionItem[]): ContextInjectionItem[] {
	const seen = new Set<string>();
	const normalized: ContextInjectionItem[] = [];
	for (const item of items) {
		const label = item.label.trim();
		if (label.length === 0) continue;
		const key = `${item.kind}\u0000${label}\u0000${item.detail ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const preview = item.preview ? clipInjectionPreview(item.preview) : undefined;
		normalized.push({
			kind: item.kind,
			label,
			...(item.detail ? { detail: item.detail } : {}),
			...(item.count !== undefined ? { count: item.count } : {}),
			...(preview ? { preview } : {}),
		});
		if (normalized.length >= MAX_CONTEXT_INJECTION_ITEMS) break;
	}
	return normalized;
}

/**
 * Stable identity of an injection set. Recorded injections whose signature is
 * unchanged are the same context push a rebuild produced again, so the session
 * journals and surfaces it once.
 */
export function contextInjectionSignature(items: readonly ContextInjectionItem[]): string {
	return items.map(item => `${item.kind}:${item.label}:${item.detail ?? ""}:${item.count ?? ""}`).join("\u0001");
}

/** One-line list of injected sources, e.g. `AGENTS.md · skills · memory`. */
export function summarizeContextInjections(items: readonly ContextInjectionItem[], maxLabels = 4): string {
	const labels = items.slice(0, maxLabels).map(item => item.label);
	const rest = items.length - maxLabels;
	return rest > 0 ? `${labels.join(" · ")} · ${rest} more` : labels.join(" · ");
}

/**
 * The MCP block of the injection inventory: one item per connected server, so
 * the notice reports which servers are live — and a mid-session `/mcp enable`
 * or `disable` changes the set — instead of only the servers that happen to
 * ship instructions. An item's detail and preview describe the tool list the
 * server contributes; its own instructions win the preview when it has them.
 */
export function mcpInjectionItems(
	serverTools: ReadonlyMap<string, readonly string[]> = new Map(),
	serverInstructions?: ReadonlyMap<string, string>,
): ContextInjectionItem[] {
	const items: ContextInjectionItem[] = [];
	for (const [serverName, toolNames] of serverTools) {
		const instructions = serverInstructions?.get(serverName);
		const tools = toolNames.length === 1 ? "1 tool" : `${toolNames.length} tools`;
		const preview = instructions ?? toolNames.join("\n");
		items.push({
			kind: "guidance",
			label: `MCP ${serverName}`,
			detail: instructions ? `${tools} · ${formatInjectionSize(instructions)} · server instructions` : tools,
			...(preview ? { preview } : {}),
		});
	}
	return items;
}

/**
 * Display-only message replayed from a persisted {@link ContextInjectionDetails}
 * record. `display` stays true so the transcript renders the notice; the
 * message is synthesized by `buildSessionContext`'s transcript walk, so it
 * never reaches the provider.
 */
export function createContextInjectionMessage(
	items: readonly ContextInjectionItem[],
	timestamp: number | string,
): CustomMessage<ContextInjectionDetails> {
	const normalized = normalizeContextInjectionItems(items);
	return createCustomMessage(
		CONTEXT_INJECTION_MESSAGE_TYPE,
		summarizeContextInjections(normalized),
		true,
		{ items: normalized } satisfies ContextInjectionDetails,
		new Date(timestamp).toISOString(),
	) as CustomMessage<ContextInjectionDetails>;
}

/**
 * Read the items out of a persisted injection payload (journal `custom` entry
 * data or a notice message's `details`), skipping malformed entries so a
 * hand-edited or older record cannot break the transcript.
 */
export function contextInjectionItemsFromData(data: unknown): ContextInjectionItem[] {
	if (!isRecord(data) || !Array.isArray(data.items)) return [];
	const items: ContextInjectionItem[] = [];
	for (const raw of data.items) {
		if (!isRecord(raw) || !isContextInjectionKind(raw.kind) || typeof raw.label !== "string") continue;
		const item: ContextInjectionItem = { kind: raw.kind, label: raw.label };
		if (typeof raw.detail === "string") item.detail = raw.detail;
		if (typeof raw.count === "number") item.count = raw.count;
		if (typeof raw.preview === "string") item.preview = raw.preview;
		items.push(item);
	}
	return normalizeContextInjectionItems(items);
}

/** Read the items out of an injection notice message. */
export function contextInjectionItemsFromMessage(message: { details?: unknown }): ContextInjectionItem[] {
	return contextInjectionItemsFromData(message.details);
}
