import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Effort } from "@oh-my-pi/pi-ai";
import {
	type Component,
	Container,
	extractPrintableText,
	fuzzyRank,
	getKeybindings,
	getSettingItemFilterText,
	type ImageBudget,
	Input,
	matchesKey,
	replaceTabs,
	routeSelectListMouse,
	routeSgrMouseInput,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	type SgrMouseEvent,
	Spacer,
	type Tab,
	TabBar,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import type { ShapeTarget } from "@oh-my-pi/snapcompact";
import {
	getDefault,
	getType,
	normalizeProviderMaxInFlightRequests,
	type SettingPath,
	settings,
	validateProviderMaxInFlightRequests,
} from "../../config/settings";
import type {
	SettingTab,
	StatusLinePreset,
	StatusLineSegmentId,
	StatusLineSeparatorStyle,
} from "../../config/settings-schema";
import { SETTING_TABS, TAB_METADATA, type SubmenuOption } from "../../config/settings-schema";
import { setLocale, t } from "../../i18n";
import { getCurrentThemeName, getSelectListTheme, getSettingsListTheme, theme } from "../../modes/theme/theme";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "../../thinking";
import { getTabBarTheme } from "../shared";
import { bottomBorder, divider, row, topBorder } from "./overlay-box";
import { handleInputOrEscape, PluginSettingsComponent } from "./plugin-settings";
import { getSettingDef, getSettingsForTab, type SettingDef } from "./settings-defs";
import { SnapcompactShapePreview } from "./snapcompact-shape-preview";
import { getPreset } from "./status-line/presets";

/**
 * A submenu component for selecting from a list of options.
 */
/**
 * Submenu component for free-text string settings.
 * Mirrors the ConfigInputSubmenu pattern from plugin-settings.ts.
 */
class TextInputSubmenu extends Container {
	#input: Input;
	#error: Text;

	constructor(
		label: string,
		description: string,
		currentValue: string,
		secret: boolean,
		private readonly onSubmit: (value: string) => void,
		private readonly onCancel: () => void,
	) {
		super();

		this.addChild(new Text(theme.bold(theme.fg("accent", label)), 0, 0));
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}
		this.addChild(new Spacer(1));

		this.#input = new Input();
		this.#input.mask = secret;
		if (currentValue) {
			this.#input.setValue(currentValue);
		}
		this.#error = new Text("", 0, 0);
		this.#input.onSubmit = value => {
			try {
				this.onSubmit(value); // empty string clears the setting
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.#error.setText(theme.fg("error", truncateToWidth(replaceTabs(message).replace(/[\r\n]+/g, " "), 100)));
			}
		};
		this.addChild(this.#input);
		this.addChild(new Spacer(1));
		this.addChild(this.#error);
		this.addChild(new Text(theme.fg("dim", t("  Enter to save · Esc to cancel · Clear field to unset")), 0, 0));
	}

	handleInput(data: string): void {
		handleInputOrEscape(data, this.#input, this.onCancel);
	}
}

class SelectSubmenu extends Container {
	#selectList: SelectList;
	#previewText: Text | null = null;
	#previewUpdateRequestId: number = 0;
	#selectListLineOffset = 0;

	constructor(
		title: string,
		description: string,
		options: ReadonlyArray<SelectItem>,
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
		onSelectionChange?: (value: string) => void | Promise<void>,
		private readonly getPreview?: () => string,
		footer?: Component,
	) {
		super();

		// Title
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));

		// Description
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}

		// Preview (if provided)
		if (getPreview) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", t("Preview:")), 0, 0));
			this.#previewText = new Text(getPreview(), 0, 0);
			this.addChild(this.#previewText);
		}

		// Spacer
		this.addChild(new Spacer(1));

		// Select list
		this.#selectList = new SelectList(options, Math.min(options.length, 10), getSelectListTheme());

		// Pre-select current value
		const currentIndex = options.findIndex(o => o.value === currentValue);
		if (currentIndex !== -1) {
			this.#selectList.setSelectedIndex(currentIndex);
		}

		this.#selectList.onSelect = item => {
			onSelect(item.value);
		};

		this.#selectList.onCancel = onCancel;

		if (onSelectionChange) {
			this.#selectList.onSelectionChange = item => {
				const requestId = ++this.#previewUpdateRequestId;
				const result = onSelectionChange(item.value);
				if (result && typeof (result as Promise<void>).then === "function") {
					void (result as Promise<void>).finally(() => {
						if (requestId === this.#previewUpdateRequestId) {
							this.#updatePreview();
						}
					});
					return;
				}
				if (requestId === this.#previewUpdateRequestId) {
					this.#updatePreview();
				}
			};
		}

		this.addChild(this.#selectList);

		// Hint
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", t("  Enter to select · Esc to go back")), 0, 0));

		// Footer (e.g. the snapcompact shape preview) below the interactive rows,
		// so the list never shifts while browsing.
		if (footer) {
			this.addChild(new Spacer(1));
			this.addChild(footer);
		}
	}

	#updatePreview(): void {
		if (this.#previewText && this.getPreview) {
			this.#previewText.setText(this.getPreview());
		}
	}

	/**
	 * Concatenate children like Container.render, recording where the select
	 * list lands so routed mouse events can be hit-tested against it.
	 */
	override render(width: number): readonly string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			const childLines = child.render(Math.max(1, width));
			if (child === this.#selectList) {
				this.#selectListLineOffset = lines.length;
			}
			lines.push(...childLines);
		}
		return lines;
	}

	/** Mouse routed from the host: wheel steps, hover lights, click confirms. */
	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		routeSelectListMouse(this.#selectList, event, line - this.#selectListLineOffset);
	}

	handleInput(data: string): void {
		this.#selectList.handleInput(data);
	}
}

/**
 * Submenu for array-of-enum settings: every option is a toggle row. Enter or
 * Space flips membership; ordered lists render 1-based positions and reorder
 * the highlighted member with ←/→. Changes apply live; Esc goes back.
 */
class MultiSelectSubmenu extends Container {
	#selectList!: SelectList;
	#value: string[];
	#cursor = 0;
	#selectListLineOffset = 0;

	constructor(
		private readonly title: string,
		private readonly description: string,
		private readonly options: ReadonlyArray<SelectItem>,
		initial: readonly string[],
		private readonly ordered: boolean,
		private readonly onApply: (value: string[]) => void,
		private readonly onClose: () => void,
	) {
		super();
		// Drop stale ids (renamed/removed providers) so positions stay contiguous.
		this.#value = initial.filter(id => options.some(option => option.value === id));
		this.#rebuild();
	}

	#rebuild(): void {
		this.clear();
		this.addChild(new Text(theme.bold(theme.fg("accent", this.title)), 0, 0));
		if (this.description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", this.description), 0, 0));
		}
		this.addChild(new Spacer(1));

		const items = this.options.map((option): SelectItem => {
			const position = this.#value.indexOf(option.value);
			const mark =
				position === -1
					? theme.fg("dim", this.ordered ? " · " : " ○ ")
					: this.ordered
						? theme.fg("accent", `${String(position + 1).padStart(2)}.`)
						: theme.fg("accent", " ● ");
			return { value: option.value, label: `${mark} ${option.label}`, description: option.description };
		});
		this.#selectList = new SelectList(items, Math.min(items.length, 12), getSelectListTheme());
		this.#selectList.setSelectedIndex(this.#cursor);
		this.#selectList.onSelect = item => this.#toggle(item.value);
		this.#selectList.onSelectionChange = item => {
			this.#cursor = this.options.findIndex(option => option.value === item.value);
		};
		this.#selectList.onCancel = this.onClose;
		this.addChild(this.#selectList);

		this.addChild(new Spacer(1));
		const hint = this.ordered
			? t("  Enter/Space to toggle · ←/→ move · 1-9 place at position · Esc to go back")
			: t("  Enter/Space to toggle · Esc to go back");
		this.addChild(new Text(theme.fg("dim", hint), 0, 0));
	}

	#apply(next: string[]): void {
		this.#value = next;
		this.onApply([...next]);
		this.#rebuild();
	}

	#toggle(id: string): void {
		const next = this.#value.includes(id) ? this.#value.filter(v => v !== id) : [...this.#value, id];
		this.#apply(next);
	}

	#move(id: string, delta: -1 | 1): void {
		const from = this.#value.indexOf(id);
		if (from === -1) return;
		const to = from + delta;
		if (to < 0 || to >= this.#value.length) return;
		const next = [...this.#value];
		next[from] = next[to]!;
		next[to] = id;
		this.#apply(next);
	}

	/** Splice the option into the 1-based `position` of the selection (adding it if unselected). */
	#placeAt(id: string, position: number): void {
		const next = this.#value.filter(v => v !== id);
		next.splice(Math.min(position - 1, next.length), 0, id);
		this.#apply(next);
	}

	/** Concatenate children, recording the select list's line offset for mouse routing. */
	override render(width: number): readonly string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			const childLines = child.render(Math.max(1, width));
			if (child === this.#selectList) {
				this.#selectListLineOffset = lines.length;
			}
			lines.push(...childLines);
		}
		return lines;
	}

	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		routeSelectListMouse(this.#selectList, event, line - this.#selectListLineOffset);
	}

	handleInput(data: string): void {
		const current = this.options[this.#cursor]?.value;
		if (data === " " && current !== undefined) {
			this.#toggle(current);
			return;
		}
		if (this.ordered && current !== undefined && (data === "\x1b[D" || data === "\x1b[C")) {
			this.#move(current, data === "\x1b[D" ? -1 : 1);
			return;
		}
		if (this.ordered && current !== undefined && data.length === 1 && data >= "1" && data <= "9") {
			this.#placeAt(current, Number(data));
			return;
		}
		this.#selectList.handleInput(data);
	}
}

class ProviderLimitsSubmenu extends Container {
	#selectList: SelectList | undefined;

	constructor(
		private readonly providers: readonly string[],
		private readonly onChange: (value: Record<string, number>) => void,
		private readonly onCancel: () => void,
		private readonly requestRender?: () => void,
	) {
		super();
		this.#showProviderList();
	}

	#providerIds(): string[] {
		const limits = normalizeProviderMaxInFlightRequests(settings.get("providers.maxInFlightRequests"));
		return [...new Set([...this.providers, ...Object.keys(limits)])].sort((a, b) => a.localeCompare(b));
	}

	#showProviderList(): void {
		this.clear();
		this.addChild(new Text(theme.bold(theme.fg("accent", t("Max In-Flight Requests"))), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					t("Select a provider, enter a positive number to cap concurrent LLM requests, or clear it for unlimited."),
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));

		const limits = normalizeProviderMaxInFlightRequests(settings.get("providers.maxInFlightRequests"));
		const providerItems = this.#providerIds().map((provider): SelectItem => {
			const limit = limits[provider];
			return {
				value: provider,
				label: provider,
				description: limit === undefined ? t("Unlimited") : t("Limit: {limit}", { limit }),
			};
		});
		const clearItem: SelectItem[] =
			Object.keys(limits).length === 0
				? []
				: [{ value: "__clear_all", label: t("Clear all limits"), description: t("Make every provider unlimited") }];
		const items = [...providerItems, ...clearItem];
		this.#selectList = new SelectList(items, Math.min(Math.max(items.length, 1), 12), getSelectListTheme());
		this.#selectList.onSelect = item => {
			if (item.value === "__clear_all") {
				settings.set("providers.maxInFlightRequests", {});
				this.onChange({});
				this.#showProviderList();
				this.requestRender?.();
				return;
			}
			this.#showProviderEditor(item.value);
		};
		this.#selectList.onCancel = this.onCancel;
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", t("  Enter to edit provider · Esc to go back")), 0, 0));
	}

	#showProviderEditor(provider: string): void {
		const limits = normalizeProviderMaxInFlightRequests(settings.get("providers.maxInFlightRequests"));
		this.clear();
		this.#selectList = undefined;
		this.addChild(
			new TextInputSubmenu(
				t("Max In-Flight Requests: {provider}", { provider }),
				t("Enter a positive number. Decimals round down. Clear the field to make this provider unlimited."),
				limits[provider]?.toString() ?? "",
				false,
				value => {
					const next = { ...limits };
					const trimmed = value.trim();
					if (trimmed === "") {
						delete next[provider];
					} else {
						const limit = Number(trimmed);
						if (!Number.isFinite(limit) || limit <= 0) throw new Error(t("Limit must be a positive number."));
						next[provider] = Math.max(1, Math.floor(limit));
					}
					const normalized = validateProviderMaxInFlightRequests(next);
					settings.set("providers.maxInFlightRequests", normalized);
					this.onChange(normalized);
					this.#showProviderList();
					this.requestRender?.();
				},
				() => {
					this.#showProviderList();
					this.requestRender?.();
				},
			),
		);
	}

	handleInput(data: string): void {
		if (this.#selectList) {
			this.#selectList.handleInput(data);
			return;
		}
		this.children[0]?.handleInput?.(data);
	}
}

let cachedSidebarWidth: number | undefined;
/**
 * Split-sidebar width derived from every group name in the schema (not just
 * the visible tab), so the divider column never moves when switching tabs or
 * when condition-gated groups appear.
 */
function settingsSidebarWidth(): number {
	if (cachedSidebarWidth === undefined) {
		let nameWidth = 0;
		for (const tab of SETTING_TABS) {
			for (const def of getSettingsForTab(tab)) {
				if (def.group) nameWidth = Math.max(nameWidth, visibleWidth(def.group));
			}
		}
		cachedSidebarWidth = Math.min(22, nameWidth) + 4;
	}
	return cachedSidebarWidth;
}

function translatedLabel(path: SettingPath, fallback: string): string {
	switch (path) {
		case "advisor.enabled": return t("Enable Advisor");
		case "advisor.immuneTurns": return t("Advisor Immune Turns");
		case "advisor.subagents": return t("Advisor for Subagents");
		case "advisor.syncBacklog": return t("Advisor Sync Backlog");
		case "ask.enabled": return t("Ask");
		case "ask.notify": return t("Ask Notification");
		case "ask.timeout": return t("Ask Timeout");
		case "astEdit.enabled": return t("AST Edit");
		case "astGrep.enabled": return t("AST Grep");
		case "async.enabled": return t("Async Execution");
		case "async.pollWaitDuration": return t("Max Poll Time");
		case "autoResume": return t("Auto Resume");
		case "autocompleteMaxVisible": return t("Autocomplete Items");
		case "autolearn.autoContinue": return t("Auto-run capture at stop");
		case "autolearn.enabled": return t("Auto-Learn (experimental)");
		case "bash.autoBackground.enabled": return t("Bash Auto-Background");
		case "bash.direnv": return t("direnv Auto-Load");
		case "bash.direnvLoadTimeoutMs": return t("direnv Load Timeout (ms)");
		case "bash.enabled": return t("Bash");
		case "bash.patterns": return t("Bash Approval Patterns");
		case "bashInterceptor.enabled": return t("Bash Interceptor");
		case "branchSummary.enabled": return t("Branch Summaries");
		case "browser.cdpUrl": return t("Browser CDP URL");
		case "browser.cmux": return t("cmux Browser");
		case "browser.enabled": return t("Browser");
		case "browser.headless": return t("Headless Browser");
		case "browser.relay": return t("Browser Relay");
		case "browser.relayUrl": return t("Browser Relay URL");
		case "browser.screenshotDir": return t("Screenshot Directory");
		case "checkpoint.enabled": return t("Checkpoint/Rewind");
		case "codexResets.autoRedeem": return t("Codex Auto-Redeem Saved Resets");
		case "codexResets.keepCredits": return t("Codex Auto-Redeem Reserve");
		case "codexResets.minBlockedMinutes": return t("Codex Auto-Redeem Min Block");
		case "codexResets.salvageHorizonHours": return t("Codex Reset Salvage Horizon");
		case "collab.displayName": return t("Display Name");
		case "collab.relayUrl": return t("Relay URL");
		case "collab.webUrl": return t("Web UI URL");
		case "colorBlindMode": return t("Color-Blind Mode");
		case "commands.enableClaudeProject": return t("Claude Project Commands");
		case "commands.enableClaudeUser": return t("Claude User Commands");
		case "commands.enableOpencodeProject": return t("OpenCode Project Commands");
		case "commands.enableOpencodeUser": return t("OpenCode User Commands");
		case "compaction.dropUseless": return t("Elide Uneventful Results");
		case "compaction.enabled": return t("Auto-Compact");
		case "compaction.handoffSaveToDisk": return t("Save Handoff Docs");
		case "compaction.idleEnabled": return t("Idle Compaction");
		case "compaction.idleThresholdTokens": return t("Idle Compaction Threshold");
		case "compaction.idleTimeoutSeconds": return t("Idle Compaction Delay");
		case "compaction.midTurnEnabled": return t("Mid-Turn Compaction");
		case "compaction.remoteEnabled": return t("Remote Compaction");
		case "compaction.remoteStreamingV2Enabled": return t("Remote Compaction V2");
		case "compaction.strategy": return t("Compaction Strategy");
		case "compaction.supersedeReads": return t("Supersede Stale Reads");
		case "compaction.thresholdPercent": return t("Compaction Threshold");
		case "compaction.thresholdTokens": return t("Compaction Token Limit");
		case "completion.notify": return t("Completion Notification");
		case "computer.display": return t("Computer Display");
		case "computer.enabled": return t("Computer");
		case "computer.maxHeight": return t("Computer Screenshot Height");
		case "computer.maxWidth": return t("Computer Screenshot Width");
		case "contextPromotion.enabled": return t("Auto-Promote Context");
		case "debug.enabled": return t("Debug");
		case "defaultThinkingLevel": return t("Thinking Level");
		case "dev.autoqa": return t("Auto QA");
		case "dev.autoqaPush.endpoint": return t("Auto QA Push Endpoint");
		case "display.cacheMissMarker": return t("Cache Miss Marker");
		case "display.collapseCompacted": return t("Collapse Compacted History");
		case "display.collapseCompletedRuns": return t("Collapse Completed Runs");
		case "display.hideToolActivity": return t("Hide Tool Activity");
		case "display.language": return t("Language");
		case "display.shimmer": return t("Shimmer");
		case "display.showTokenUsage": return t("Show Token Usage");
		case "display.smoothStreaming": return t("Smooth Streaming");
		case "doubleEscapeAction": return t("Double-Escape Action");
		case "edit.blockAutoGenerated": return t("Block Auto-Generated Files");
		case "edit.enforceSeenLines": return t("Enforce Seen-Line Guard");
		case "edit.fuzzyMatch": return t("Fuzzy Match");
		case "edit.fuzzyThreshold": return t("Fuzzy Match Threshold");
		case "edit.mode": return t("Edit Mode");
		case "edit.streamingAbort": return t("Abort on Failed Preview");
		case "emojiAutocomplete": return t("Emoji Autocomplete");
		case "error.notify": return t("Error Notification");
		case "eval.jl": return t("Julia Eval Backend");
		case "eval.js": return t("JavaScript Eval Backend");
		case "eval.py": return t("Python Eval Backend");
		case "eval.rb": return t("Ruby Eval Backend");
		case "exa.enableResearcher": return t("Exa Researcher");
		case "exa.enableSearch": return t("Exa Search");
		case "exa.enableWebsets": return t("Exa Websets");
		case "exa.searchDelayMs": return t("Exa Search Delay");
		case "features.unexpectedStopDetection": return t("Detect unexpected stops");
		case "fetch.enabled": return t("Read URLs");
		case "followUpMode": return t("Follow-Up Mode");
		case "generate_image.enabled": return t("Generate Image");
		case "git.enabled": return t("Enable Git Integration");
		case "github.cache.enabled": return t("GitHub View Cache");
		case "github.cache.hardTtlSec": return t("GitHub Cache Hard TTL");
		case "github.cache.softTtlSec": return t("GitHub Cache Soft TTL");
		case "github.enabled": return t("GitHub CLI");
		case "glob.enabled": return t("Glob");
		case "goal.continuationModes": return t("Goal Continuation Modes");
		case "goal.enabled": return t("Goal Mode");
		case "goal.statusInFooter": return t("Goal Status in Footer");
		case "grep.contextAfter": return t("Grep Context After");
		case "grep.contextBefore": return t("Grep Context Before");
		case "grep.enabled": return t("Grep");
		case "hideThinkingBlock": return t("Hide Thinking Blocks");
		case "hindsight.apiToken": return t("Hindsight API Token");
		case "hindsight.apiUrl": return t("Hindsight API URL");
		case "hindsight.autoRecall": return t("Hindsight Auto Recall");
		case "hindsight.autoRetain": return t("Hindsight Auto Retain");
		case "hindsight.bankId": return t("Hindsight Bank ID");
		case "hindsight.mentalModelAutoSeed": return t("Hindsight Mental Model Auto-Seed");
		case "hindsight.mentalModelsEnabled": return t("Hindsight Mental Models");
		case "hindsight.retainMode": return t("Hindsight Retain Mode");
		case "hindsight.scoping": return t("Hindsight Scoping");
		case "images.autoResize": return t("Auto-Resize Images");
		case "images.blockImages": return t("Block Images");
		case "images.describeForTextModels": return t("Describe Images for Text Models");
		case "images.visionApprovalTimeoutMs": return t("Vision Approval Timeout");
		case "includeModelInPrompt": return t("Include Model in Prompt");
		case "includeWorkspaceTree": return t("Include Workspace Tree");
		case "inlineToolDescriptors": return t("Inline Tool Descriptors");
		case "inspect_image.mode": return t("Inspect Image");
		case "inspect_image.timeoutMs": return t("Inspect Image Timeout");
		case "interruptMode": return t("Interrupt Mode");
		case "irc.timeoutMs": return t("IRC Timeout");
		case "julia.interpreter": return t("Julia Interpreter");
		case "launch.enabled": return t("Launch");
		case "live.voice": return t("Live Voice");
		case "loop.mode": return t("Loop Mode");
		case "lsp.diagnosticsDeduplicate": return t("Deduplicate Diagnostics");
		case "lsp.diagnosticsOnEdit": return t("Diagnostics on Edit");
		case "lsp.diagnosticsOnWrite": return t("Diagnostics on Write");
		case "lsp.enabled": return t("LSP");
		case "lsp.formatOnWrite": return t("Format on Write");
		case "lsp.lazy": return t("Lazy LSP Startup");
		case "lsp.shared": return t("Shared Language Servers");
		case "magicKeywords.enabled": return t("Magic Keywords");
		case "magicKeywords.orchestrate": return t("Orchestrate Keyword");
		case "magicKeywords.ultrathink": return t("Ultrathink Keyword");
		case "magicKeywords.workflow": return t("Workflow Keyword");
		case "marketplace.autoUpdate": return t("Marketplace Auto-Update");
		case "mcp.enableProjectConfig": return t("MCP Project Config");
		case "mcp.notificationDebounceMs": return t("MCP Notification Debounce");
		case "mcp.notifications": return t("MCP Update Injection");
		case "mcp.renderMarkdownResults": return t("MCP Markdown Results");
		case "memory.backend": return t("Memory Backend");
		case "minP": return t("Min P");
		case "mnemopi.autoRecall": return t("Mnemopi Auto Recall");
		case "mnemopi.autoRetain": return t("Mnemopi Auto Retain");
		case "mnemopi.bank": return t("Mnemopi Bank");
		case "mnemopi.dbPath": return t("Mnemopi DB Path");
		case "mnemopi.embeddingApiKey": return t("Mnemopi Embedding API Key");
		case "mnemopi.embeddingApiUrl": return t("Mnemopi Embedding API URL");
		case "mnemopi.embeddingModel": return t("Mnemopi Embedding Model");
		case "mnemopi.embeddingVariant": return t("Embedding variant");
		case "mnemopi.enhancedRecall": return t("Mnemopi Enhanced Recall");
		case "mnemopi.llmApiKey": return t("Mnemopi LLM API Key");
		case "mnemopi.llmBaseUrl": return t("Mnemopi LLM Base URL");
		case "mnemopi.llmMode": return t("Mnemopi LLM Mode");
		case "mnemopi.llmModel": return t("Mnemopi LLM Model");
		case "mnemopi.noEmbeddings": return t("Mnemopi Disable Embeddings");
		case "mnemopi.polyphonicRecall": return t("Mnemopi Polyphonic Recall");
		case "mnemopi.proactiveLinking": return t("Mnemopi Proactive Linking");
		case "mnemopi.scoping": return t("Mnemopi Scoping");
		case "model.loopGuard.checkAssistantContent": return t("Loop Guard Scan Prose");
		case "model.loopGuard.enabled": return t("Loop Guard");
		case "model.loopGuard.toolCallReminder": return t("Loop Guard Tool-Call Reminder");
		case "model.toolCallLoopGuard.enabled": return t("Tool-Call Loop Guard");
		case "model.toolCallLoopGuard.exemptTools": return t("Tool-Call Loop Exempt Tools");
		case "model.toolCallLoopGuard.threshold": return t("Tool-Call Loop Threshold");
		case "modelRoleStorage": return t("Model Role Storage");
		case "omitThinking": return t("Omit Thinking summaries");
		case "paste.largeMenuThreshold": return t("Large Paste Menu");
		case "personality": return t("Personality");
		case "plan.defaultOnStartup": return t("Start in Plan Mode");
		case "plan.enabled": return t("Plan Mode");
		case "power.sleepPrevention": return t("Sleep Prevention");
		case "presencePenalty": return t("Presence Penalty");
		case "prewalk.enabled": return t("Enable Prewalk");
		case "proseOnlyThinking": return t("Prose Only Thinking");
		case "provider.appendOnlyContext": return t("Append-Only Context");
		case "providers.anthropic.serverSideFallback": return t("Anthropic Server-Side Fallback (Fable 5)");
		case "providers.antigravityEndpoint": return t("Antigravity Endpoint Mode");
		case "providers.autoThinkingMaxEffort": return t("Auto Thinking Ceiling");
		case "providers.autoThinkingModel": return t("Auto Thinking Model");
		case "providers.fetch": return t("Fetch Provider");
		case "providers.fireworksTier": return t("Fireworks Tier");
		case "providers.imageOrder": return t("Image Provider Order");
		case "providers.kimiApiFormat": return t("Kimi API Format");
		case "providers.maxInFlightRequests": return t("Max In-Flight Requests");
		case "providers.memoryModel": return t("Memory Model");
		case "providers.ollama-cloud.maxConcurrency": return t("Ollama Cloud Max Concurrency");
		case "providers.openaiWebsockets": return t("OpenAI WebSockets");
		case "providers.openrouterVariant": return t("OpenRouter Routing");
		case "providers.streamFirstEventTimeoutSeconds": return t("Stream First Event Timeout");
		case "providers.streamIdleTimeoutSeconds": return t("Stream Idle Timeout");
		case "providers.tinyModel": return t("Tiny Model");
		case "providers.tinyModelDevice": return t("Tiny Model Device");
		case "providers.tinyModelDtype": return t("Tiny Model Precision");
		case "providers.tts": return t("Text-to-Speech Provider");
		case "providers.unexpectedStopModel": return t("Unexpected Stop Model");
		case "providers.webSearchExclude": return t("Excluded Web Search Providers");
		case "providers.webSearchGeminiModel": return t("Gemini web_search model");
		case "providers.webSearchOrder": return t("Web Search Provider Order");
		case "providers.webSearchTimeoutSeconds": return t("Web Search Timeout");
		case "pwsh.enabled": return t("PowerShell");
		case "python.interpreter": return t("Python Interpreter");
		case "python.kernelMode": return t("Python Kernel Mode");
		case "read.defaultLimit": return t("Default Read Limit");
		case "read.renderMarkdown": return t("Markdown Previews");
		case "read.summarize.enabled": return t("Read Summaries");
		case "read.summarize.minBodyLines": return t("Read Summary Body Lines");
		case "read.summarize.minCommentLines": return t("Read Summary Comment Lines");
		case "read.summarize.minTotalLines": return t("Read Summary Minimum File Length");
		case "read.summarize.prose": return t("Prose Summaries");
		case "read.summarize.unfoldLimit": return t("Read Summary Unfold Ceiling");
		case "read.summarize.unfoldUntil": return t("Read Summary Unfold Target");
		case "read.toolResultPreview": return t("Inline Read Previews");
		case "readLineNumbers": return t("Line Numbers");
		case "recap.enabled": return t("Idle Recap");
		case "recap.idleSeconds": return t("Idle Recap Delay");
		case "repetitionPenalty": return t("Repetition Penalty");
		case "retry.fallbackChains": return t("Retry Fallback Chains");
		case "retry.fallbackRevertPolicy": return t("Fallback Revert Policy");
		case "retry.maxDelayMs": return t("Max Retry Delay");
		case "retry.maxRetries": return t("Retry Attempts");
		case "retry.modelFallback": return t("Retry Model Fallback");
		case "retry.usageAwareFallback": return t("Usage-Aware Fallback");
		case "retry.usageReservePct": return t("Reserve Margin");
		case "retry.usageReservePolicy": return t("Reserve Policy");
		case "ruby.interpreter": return t("Ruby Interpreter");
		case "searxng.endpoint": return t("SearXNG Endpoint");
		case "secrets.enabled": return t("Hide Secrets");
		case "security.enabled": return t("Security");
		case "share.redactSecrets": return t("Share Secret Redaction");
		case "share.serverUrl": return t("Share Server");
		case "share.store": return t("Share Store");
		case "shellMinimizer.enabled": return t("Shell Minimizer");
		case "shellMinimizer.sourceOutlineLevel": return t("Shell Minimizer Source Outline");
		case "showHardwareCursor": return t("Show Hardware Cursor");
		case "skills.enableSkillCommands": return t("Skill Commands");
		case "snapcompact.shape": return t("Snapcompact Shape");
		case "snapcompact.systemPrompt": return t("Snapcompact System Prompt");
		case "snapcompact.toolResults": return t("Snapcompact Tool Results");
		case "speech.enabled": return t("Speech Vocalization");
		case "speech.enhanced": return t("Enhanced Speech Rewriting");
		case "speech.mode": return t("Speech Vocalization Mode");
		case "speech.voice": return t("Speech Vocalization Voice");
		case "speechgen.enabled": return t("Speech Generation");
		case "startup.changelogMode": return t("Startup Changelog");
		case "startup.checkUpdate": return t("Check for Updates");
		case "startup.quiet": return t("Quiet Startup");
		case "startup.setupWizard": return t("Setup Wizard");
		case "startup.showSplash": return t("Show Startup Splash");
		case "statusLine.compactThinkingLevel": return t("Compact Thinking Level");
		case "statusLine.preset": return t("Status Line Preset");
		case "statusLine.separator": return t("Status Line Separator");
		case "statusLine.sessionAccent": return t("Session Accent");
		case "statusLine.showHookStatus": return t("Show Hook Status");
		case "statusLine.transparent": return t("Transparent Status Line");
		case "steeringMode": return t("Steering Mode");
		case "stt.enabled": return t("Speech-to-Text");
		case "stt.modelName": return t("Speech Model");
		case "stt.submitTrigger": return t("Speech-to-Text Submit Trigger");
		case "symbolPreset": return t("Symbol Preset");
		case "task.agentIdleTtlMs": return t("Agent Idle TTL");
		case "task.batch": return t("Batch Task Calls");
		case "task.eager": return t("Prefer Task Delegation");
		case "task.enableEffort": return t("Per-Task Effort");
		case "task.enableLsp": return t("LSP in Subagents");
		case "task.isolation.apply": return t("Apply Isolated Changes");
		case "task.isolation.commits": return t("Isolation Commit Style");
		case "task.isolation.merge": return t("Isolation Merge Strategy");
		case "task.isolation.mode": return t("Isolation Mode");
		case "task.maxConcurrency": return t("Max Concurrent Tasks");
		case "task.maxEffort": return t("Maximum Per-Spawn Effort");
		case "task.maxRecursionDepth": return t("Max Task Recursion");
		case "task.maxRuntimeMs": return t("Max Subagent Runtime");
		case "task.prewalk": return t("Generic Task Prewalk");
		case "task.showResolvedModelBadge": return t("Show Resolved Model Badge");
		case "task.softRequestBudget": return t("Soft Subagent Request Budget");
		case "task.softRequestBudgetNotice": return t("Soft Request Budget Notice");
		case "tasks.todoClearDelay": return t("Todo Auto-Clear Delay");
		case "temperature": return t("Temperature");
		case "terminal.showImages": return t("Show Inline Images");
		case "terminal.showProgress": return t("Native Terminal Progress");
		case "textVerbosity": return t("Text Verbosity");
		case "theme.dark": return t("Dark Theme");
		case "theme.light": return t("Light Theme");
		case "tier.advisor": return t("Service Tier — Advisor");
		case "tier.anthropic": return t("Service Tier — Anthropic");
		case "tier.google": return t("Service Tier — Google");
		case "tier.openai": return t("Service Tier — OpenAI");
		case "tier.subagent": return t("Service Tier — Subagent");
		case "title.refreshOnReplan": return t("Refresh Title on Replan");
		case "todo.eager": return t("Create Todos Automatically");
		case "todo.enabled": return t("Todos");
		case "todo.reminders": return t("Todo Reminders");
		case "todo.remindersMax": return t("Todo Reminder Limit");
		case "tools.abortOnFabricatedResult": return t("Abort On Fabricated Tool Result");
		case "tools.approval": return t("Tool Approval Policies");
		case "tools.approvalMode": return t("Tool Approval");
		case "tools.artifactHeadBytes": return t("Artifact Head Size (KB)");
		case "tools.artifactSpillThreshold": return t("Artifact Spill Threshold (KB)");
		case "tools.artifactTailBytes": return t("Artifact Tail Size (KB)");
		case "tools.artifactTailLines": return t("Artifact Tail Lines");
		case "tools.format": return t("Tool Calling Mode");
		case "tools.intentTracing": return t("Intent Tracing");
		case "tools.maxTimeout": return t("Max Tool Timeout");
		case "tools.outputMaxColumns": return t("Output Column Cap");
		case "tools.xdev": return t("xd:// Tools");
		case "tools.xdevDocs": return t("xd:// Prompt Docs");
		case "tools.xdevInlineDevices": return t("xd:// Inline Devices");
		case "topK": return t("Top K");
		case "topP": return t("Top P");
		case "treeFilterMode": return t("Session Tree Filter");
		case "tts.localModel": return t("Local TTS Model");
		case "tts.localVoice": return t("Local TTS Voice");
		case "ttsr.builtinRules": return t("Built-in Rules");
		case "ttsr.contextMode": return t("TTSR Context Mode");
		case "ttsr.disabledRules": return t("Disabled Rules");
		case "ttsr.enabled": return t("TTSR");
		case "ttsr.interruptMode": return t("TTSR Interrupt Mode");
		case "ttsr.repeatGap": return t("TTSR Repeat Gap");
		case "ttsr.repeatMode": return t("TTSR Repeat Mode");
		case "tui.codexResetFireworks": return t("Codex Reset Fireworks");
		case "tui.hyperlinks": return t("Terminal Hyperlinks");
		case "tui.imeSafeCursor": return t("IME-Safe Prompt Layout");
		case "tui.renderMermaid": return t("Render Mermaid Diagrams");
		case "tui.scrollbackRebuild": return t("Rewrite Scrollback");
		case "tui.textSizing": return t("Large Headings (Kitty)");
		case "tui.tight": return t("Tight Layout");
		case "tui.titleState": return t("Terminal Title Run State");
		case "vault.enabled": return t("Obsidian Vault");
		case "web_search.enabled": return t("Web Search");
		case "workspace.additionalDirectories": return t("Additional Workspace Dirs");
		case "worktree.base": return t("Worktree Base Directory");
		default:
			return fallback;
	}
}

function translatedDescription(path: SettingPath, fallback: string): string {
	switch (path) {
		case "advisor.enabled": return t("Pair a second model (assigned to the 'advisor' role) that passively reviews each turn and injects notes.");
		case "advisor.immuneTurns": return t("After an advisor concern or blocker interrupts, route further concerns/blockers non-interruptingly for this many primary turns.");
		case "advisor.subagents": return t("Also enable the advisor on spawned task/eval subagents.");
		case "advisor.syncBacklog": return t("Pause the main agent for up to 30 seconds if the advisor falls behind by this many turns. Off disables catch-up delays.");
		case "ask.enabled": return t("Enable the ask tool for interactive user questions");
		case "ask.notify": return t("Notify when the ask tool is waiting for input");
		case "ask.timeout": return t("Auto-select the recommended ask option after this many seconds (0 disables)");
		case "astEdit.enabled": return t("Enable the ast_edit tool for structural AST rewrites");
		case "astGrep.enabled": return t("Enable the ast_grep tool for structural AST search");
		case "async.enabled": return t("Enable async bash commands, background tasks, and SSH file transfers");
		case "async.pollWaitDuration": return t("How long a `hub` wait watches background jobs before returning the current state. A fixed value waits that exact duration every time. `smart` adapts: it starts at 5s and lengthens with each back-to-back wait (up to 5m), then resets to 5s after about a minute without waiting.");
		case "autoResume": return t("Automatically resume the most recent session in the current directory");
		case "autocompleteMaxVisible": return t("Max visible items in autocomplete dropdown (3-20)");
		case "autolearn.autoContinue": return t("When on, auto-run one private capture turn at stop (uses extra tokens). When off, only standing auto-learn guidance remains.");
		case "autolearn.enabled": return t("After the agent stops, nudge it to capture lessons to memory and create/enhance isolated managed skills");
		case "bash.autoBackground.enabled": return t("Automatically background long-running bash commands and deliver the result later");
		case "bash.direnv": return t("Auto-load a repo's direnv/devenv `.envrc` into the bash session so devenv tools and env vars are present without manual `direnv exec`. Honors direnv's allow list: an `.envrc` you haven't `direnv allow`ed is never executed");
		case "bash.direnvLoadTimeoutMs": return t("Max wait for the first `direnv export` (a cold devenv shell can be slow); on timeout the session runs without the direnv env");
		case "bash.enabled": return t("Enable the bash tool for shell command execution");
		case "bash.patterns": return t("Ordered bash command approval rules. Each item has match and approval fields; only '*' wildcards are supported.");
		case "bashInterceptor.enabled": return t("Block shell commands that have dedicated tools");
		case "branchSummary.enabled": return t("Prompt to summarize when leaving a branch");
		case "browser.cdpUrl": return t("Default HTTP CDP discovery endpoint (for example http://127.0.0.1:9222) to attach to instead of launching a browser. Explicit app.cdp_url or app.path on the tool call take precedence.");
		case "browser.cmux": return t("Use cmux WKWebView surfaces for browser automation when a cmux socket is available. Set PI_BROWSER_CMUX=0 or PI_BROWSER_CMUX=1 to override.");
		case "browser.enabled": return t("Enable the browser tool for scripted Chromium automation (puppeteer)");
		case "browser.headless": return t("Launch browser in headless mode (disable to show browser UI)");
		case "browser.relay": return t("Drive your own Chrome tabs through the omp browser relay. Install the extension once (`omp browser-relay install`); the relay server auto-starts when the browser tool needs it. Takes precedence over Browser CDP URL; set PI_BROWSER_RELAY=0 or PI_BROWSER_RELAY=1 to override.");
		case "browser.relayUrl": return t("omp browser relay endpoint (default http://127.0.0.1:9224).");
		case "browser.screenshotDir": return t("Directory to save screenshots. If unset, screenshots go to a temp file. Supports ~. Examples: ~/Downloads, ~/Desktop, /sdcard/Download (Android)");
		case "checkpoint.enabled": return t("Enable the checkpoint and rewind tools for context checkpointing");
		case "codexResets.autoRedeem": return t("Spend saved Codex rate-limit resets automatically: restore an account blocked by an exhausted 5h or weekly window when a turn is stuck and no other account can take over, and salvage credits that are about to expire. unset asks before the first spend, yes spends without prompting, and no disables both checks.");
		case "codexResets.keepCredits": return t("Never auto-spend below this many saved resets (0 = the last credit may be spent automatically). Credits about to expire are exempt — a reserved credit that expires preserves nothing.");
		case "codexResets.minBlockedMinutes": return t("Only auto-redeem when the natural unblock — the latest reset among the exhausted 5h/weekly windows — is at least this many minutes away (don't spend a scarce credit to save a short wait). Raise it (e.g. 360) to ignore 5h-only blocks.");
		case "codexResets.salvageHorizonHours": return t("Spend a saved Codex reset automatically when it would otherwise expire within this many hours and either chat window (5h or weekly) has meaningful usage to restore (0 disables expiry salvage).");
		case "collab.displayName": return t("Name shown to other collab participants (default: OS username)");
		case "collab.relayUrl": return t("Relay used by /collab (wss://host[:port])");
		case "collab.webUrl": return t("Browser UI used by /collab links; empty derives from collab.relayUrl; explicit http:// is localhost-only");
		case "colorBlindMode": return t("Use blue instead of green for diff additions");
		case "commands.enableClaudeProject": return t("Load commands from .claude/commands/");
		case "commands.enableClaudeUser": return t("Load commands from ~/.claude/commands/");
		case "commands.enableOpencodeProject": return t("Load commands from .opencode/commands/");
		case "commands.enableOpencodeUser": return t("Load commands from ~/.config/opencode/commands/");
		case "compaction.dropUseless": return t("Prune tool results flagged contextually useless (no matches, timed-out waits) once consumed (cache-aware)");
		case "compaction.enabled": return t("Automatically compact context when it gets too large");
		case "compaction.handoffSaveToDisk": return t("Save generated handoff documents to markdown files for the auto-handoff flow");
		case "compaction.idleEnabled": return t("Compact context while idle when token count exceeds threshold");
		case "compaction.idleThresholdTokens": return t("Token count above which idle compaction triggers");
		case "compaction.idleTimeoutSeconds": return t("Seconds to wait while idle before compacting");
		case "compaction.midTurnEnabled": return t("Check thresholds at safe mid-turn tool-loop boundaries before the next provider request");
		case "compaction.remoteEnabled": return t("Use remote compaction endpoints when available instead of local summarization");
		case "compaction.remoteStreamingV2Enabled": return t("Use Responses streaming compaction for compatible remote compaction models");
		case "compaction.strategy": return t("Choose in-place context-full maintenance, auto-handoff, surgical shake (drop heavy content), snapcompact (archive history as dense images), or disable auto maintenance (off)");
		case "compaction.supersedeReads": return t("Prune older read results when the same file is read again (cache-aware, runs every turn)");
		case "compaction.thresholdPercent": return t("Percent threshold for context maintenance; set to Default to use legacy reserve-based behavior");
		case "compaction.thresholdTokens": return t("Fixed token limit for context maintenance; overrides percentage if set");
		case "completion.notify": return t("Notify when the agent finishes a turn");
		case "computer.display": return t("Composite all displays or select a native display id");
		case "computer.enabled": return t("Enable the scriptable host-desktop control tool (screenshots, input, accessibility)");
		case "computer.maxHeight": return t("Maximum composite screenshot height in pixels");
		case "computer.maxWidth": return t("Maximum composite screenshot width in pixels");
		case "contextPromotion.enabled": return t("Promote to a larger-context model on context overflow instead of compacting");
		case "debug.enabled": return t("Enable the debug tool for DAP-based debugging");
		case "defaultThinkingLevel": return t("Reasoning depth for thinking-capable models");
		case "dev.autoqa": return t("Local reproducible tool issue reporting to D:\\project\\oh-my-pi\\issues through xd://report_issue. On by default; reports are never pushed remotely");
		case "dev.autoqaPush.endpoint": return t("Full URL receiving Auto QA JSON reports (default https://qa.omp.sh/v1/grievances)");
		case "display.cacheMissMarker": return t("Show a divider above an assistant turn whose request lost (missed) the prompt cache");
		case "display.collapseCompacted": return t("Collapse pre-compaction history behind the summary divider on the live transcript; disable to keep the full transcript inline with dividers at each compaction point");
		case "display.collapseCompletedRuns": return t("After a request completes normally, show only its initial user request and final assistant answer");
		case "display.hideToolActivity": return t("Hide model-initiated tool calls and results from the transcript");
		case "display.language": return t("Language for user-facing interface text (English fallback for untranslated strings)");
		case "display.shimmer": return t("Animation style for working/loading messages");
		case "display.showTokenUsage": return t("Show per-turn token usage on assistant messages");
		case "display.smoothStreaming": return t("Reveal assistant text and streamed tool input smoothly while chunks arrive");
		case "doubleEscapeAction": return t("Action when pressing Escape twice with empty editor");
		case "edit.blockAutoGenerated": return t("Prevent editing of files that appear to be auto-generated (protoc, sqlc, swagger, etc.)");
		case "edit.enforceSeenLines": return t("Reject edits anchored on lines a prior read/search never displayed in full");
		case "edit.fuzzyMatch": return t("Accept high-confidence fuzzy matches for whitespace differences");
		case "edit.fuzzyThreshold": return t("Similarity threshold (0-1) for accepting fuzzy matches");
		case "edit.mode": return t("Select the edit tool variant (replace, patch, hashline, or apply_patch)");
		case "edit.streamingAbort": return t("Abort streaming edit tool calls when patch preview fails");
		case "emojiAutocomplete": return t("Suggest emojis from `:name:` shortcodes and expand text emoticons like `:D` or `:-)`");
		case "error.notify": return t("Notify when the agent stops with an error");
		case "eval.jl": return t("Allow the eval tool to dispatch Julia cells to the persistent Julia kernel");
		case "eval.js": return t("Allow the eval tool to dispatch JavaScript cells to the in-process runtime");
		case "eval.py": return t("Allow the eval tool to dispatch Python cells to the IPython kernel");
		case "eval.rb": return t("Allow the eval tool to dispatch Ruby cells to the persistent Ruby kernel");
		case "exa.enableResearcher": return t("Enable the Exa researcher tool for AI-powered deep research");
		case "exa.enableSearch": return t("Enable Exa basic search, deep search, code search, and crawl tools");
		case "exa.enableWebsets": return t("Enable Exa webset management and enrichment tools");
		case "exa.searchDelayMs": return t("Minimum delay between Exa web search requests in milliseconds; set 0 to disable pacing");
		case "features.unexpectedStopDetection": return t("Use a small model to detect when the assistant says it will continue but stops without tool calls; automatically prompt it to continue.");
		case "fetch.enabled": return t("Allow the read tool to fetch and process URLs");
		case "followUpMode": return t("How to drain follow-up messages after a turn completes");
		case "generate_image.enabled": return t("Enable the generate_image tool (text-to-image generation and editing). Exposed as an xd:// device when tools.xdev is on.");
		case "git.enabled": return t("Show git branch, status, and PR information in the TUI and watch repository metadata.");
		case "github.cache.enabled": return t("Cache rendered issue/PR view output in ~/.omp/cache/github-cache.db so repeated reads are free");
		case "github.cache.hardTtlSec": return t("Past the soft TTL the cached row is returned and refreshed in the background; past the hard TTL it is dropped (seconds; default 7 days)");
		case "github.cache.softTtlSec": return t("Within this window, cached issue/PR view rows are returned directly (seconds; default 5 minutes)");
		case "github.enabled": return t("Enable the github tool (op-based dispatch for repository, issue, pull request, diff, search, checkout, push, and Actions watch workflows)");
		case "glob.enabled": return t("Enable the glob tool for glob-based file lookup");
		case "goal.continuationModes": return t("Run modes where active goals may auto-continue between turns");
		case "goal.enabled": return t("Enable per-session goal mode and the hidden goal tool");
		case "goal.statusInFooter": return t("Show token budget alongside the goal indicator in the status line");
		case "grep.contextAfter": return t("Lines of context after each grep match");
		case "grep.contextBefore": return t("Lines of context before each grep match");
		case "grep.enabled": return t("Enable the grep tool for regex content search");
		case "hideThinkingBlock": return t("Hide thinking blocks in assistant responses");
		case "hindsight.apiToken": return t("Bearer token for authenticated Hindsight servers");
		case "hindsight.apiUrl": return t("Hindsight server URL (Cloud or self-hosted)");
		case "hindsight.autoRecall": return t("Recall memories on the first turn of each session");
		case "hindsight.autoRetain": return t("Retain transcript every N turns and at session boundaries");
		case "hindsight.bankId": return t("Memory bank identifier (default: project name)");
		case "hindsight.mentalModelAutoSeed": return t("At session start, create any built-in mental models (project-conventions, project-decisions, user-preferences) that do not yet exist on the bank.");
		case "hindsight.mentalModelsEnabled": return t("Read curated reflect summaries (mental models) into developer instructions at boot. Loads existing models on the bank — does not write. Pair with hindsight.mentalModelAutoSeed to also auto-create the built-in seed set.");
		case "hindsight.retainMode": return t("full-session = upsert one document per session, last-turn = chunked");
		case "hindsight.scoping": return t("global = one shared bank; per-project = isolated bank per cwd; per-project-tagged = shared bank with project tags so global + project memories merge on recall");
		case "images.autoResize": return t("Resize large images to 2000x2000 max for better model compatibility");
		case "images.blockImages": return t("Prevent images from being sent to LLM providers");
		case "images.describeForTextModels": return t("When an image is attached to a model without vision support, ask for approval before a vision-capable model describes it; denied images are only saved under local://");
		case "images.visionApprovalTimeoutMs": return t("Timeout for the vision-model approval prompt, in milliseconds. When the prompt times out, the request is automatically denied and the image is only saved under local://. Set to 0 to wait indefinitely.");
		case "includeModelInPrompt": return t("Surface the active model identifier in the system prompt so the agent knows which model it is");
		case "includeWorkspaceTree": return t("Render the workspace directory tree in the system prompt. WARNING: This can bust prompt caching across sessions when files are modified.");
		case "inlineToolDescriptors": return t("Render full tool descriptors in the system prompt and strip top-level/nested descriptions from provider tool schemas so descriptor text is sent once. Auto enables this for Gemini models and disables it otherwise");
		case "inspect_image.mode": return t("Controls the inspect_image tool, which delegates image understanding to a vision-capable model. 'auto' exposes it only when the active model lacks native image input; 'on' always exposes it; 'off' never does.");
		case "inspect_image.timeoutMs": return t("Per-request timeout for the inspect_image vision-model call, in milliseconds. A stalled provider fails fast with a timeout error instead of blocking until manual abort. Set to 0 to disable the timeout.");
		case "interruptMode": return t("When steering messages interrupt tool execution");
		case "irc.timeoutMs": return t("Default timeout for hub message waits (and send await:true) in milliseconds; 0 disables the timeout");
		case "julia.interpreter": return t("Optional path to an exact Julia executable. When set, automatic Julia runtime discovery is skipped.");
		case "launch.enabled": return t("Enable the launch tool for supervising shared long-running project processes");
		case "live.voice": return t("Voice used by Codex-backed realtime voice sessions");
		case "loop.mode": return t("What happens between /loop iterations before re-submitting the prompt");
		case "lsp.diagnosticsDeduplicate": return t("Suppress post-edit LSP diagnostics already shown for a file; only surface new or changed ones");
		case "lsp.diagnosticsOnEdit": return t("Return LSP diagnostics after editing code files");
		case "lsp.diagnosticsOnWrite": return t("Return LSP diagnostics after writing code files");
		case "lsp.enabled": return t("Enable the lsp tool for code intelligence (definitions, references, diagnostics, rename)");
		case "lsp.formatOnWrite": return t("Automatically format code files using LSP after writing");
		case "lsp.lazy": return t("Start language servers on first use (lsp tool or editing a matching file type) instead of at session startup");
		case "lsp.shared": return t("Share one language server per project across omp instances via the daemon broker (falls back to private servers when unavailable)");
		case "magicKeywords.enabled": return t("Enable hidden notices for standalone ultrathink, orchestrate, and workflowz keywords");
		case "magicKeywords.orchestrate": return t("Let standalone orchestrate append its hidden multi-agent orchestration notice");
		case "magicKeywords.ultrathink": return t("Let standalone ultrathink request maximum automatic thinking and append its hidden notice");
		case "magicKeywords.workflow": return t("Let standalone workflowz append its hidden eval workflow notice");
		case "marketplace.autoUpdate": return t("Check for plugin updates on startup");
		case "mcp.enableProjectConfig": return t("Load .mcp.json/mcp.json from project root");
		case "mcp.notificationDebounceMs": return t("Debounce window in milliseconds for MCP resource updates before injecting them into the conversation");
		case "mcp.notifications": return t("Inject MCP resource updates into the agent conversation");
		case "mcp.renderMarkdownResults": return t("Render non-JSON MCP text results as Markdown in the transcript");
		case "memory.backend": return t("Off, local summary pipeline, Mnemopi SQLite, or Hindsight remote memory");
		case "minP": return t("Minimum probability threshold (0-1, -1 = provider default)");
		case "mnemopi.autoRecall": return t("Recall local memories into the first turn of each session");
		case "mnemopi.autoRetain": return t("Retain completed conversation turns into local Mnemopi memory");
		case "mnemopi.bank": return t("Optional shared bank base name. Per-project modes derive project-local banks from it.");
		case "mnemopi.dbPath": return t("Optional SQLite DB path. Defaults to the agent memories directory.");
		case "mnemopi.embeddingApiKey": return t("Optional embedding API key passed to Mnemopi");
		case "mnemopi.embeddingApiUrl": return t("Optional OpenAI-compatible embedding endpoint passed to Mnemopi");
		case "mnemopi.embeddingModel": return t("Advanced: explicit embedding model id that overrides the variant. Leave empty to use mnemopi.embeddingVariant.");
		case "mnemopi.embeddingVariant": return t("Local embedding model family. en = stronger English model; multilingual = cross-language model. Changing this rebuilds existing memory embeddings on next start.");
		case "mnemopi.enhancedRecall": return t("Enable the tiered query result cache for repeated and similar recall queries");
		case "mnemopi.llmApiKey": return t("Optional LLM API key for Mnemopi remote mode");
		case "mnemopi.llmBaseUrl": return t("Optional OpenAI-compatible LLM endpoint for Mnemopi remote mode");
		case "mnemopi.llmMode": return t("Use no LLM, the online tiny model (the TINY role from /models, else @smol), or a remote OpenAI-compatible endpoint");
		case "mnemopi.llmModel": return t("Optional LLM model name for Mnemopi remote mode");
		case "mnemopi.noEmbeddings": return t("Force deterministic FTS-only recall instead of vector embeddings");
		case "mnemopi.polyphonicRecall": return t("Enable 4-voice recall (vector, graph, fact, temporal) fused with reciprocal rank fusion");
		case "mnemopi.proactiveLinking": return t("Ingest new memories into the episodic graph as they are stored, linking them to related entities and memories");
		case "mnemopi.scoping": return t("global = one shared bank; per-project = isolated bank per cwd; per-project-tagged = project-local writes plus global recall visibility");
		case "model.loopGuard.checkAssistantContent": return t("Apply loop guard to assistant prose messages in addition to thinking logs");
		case "model.loopGuard.enabled": return t("Enable automatic stream loop detection for model reasoning and prose");
		case "model.loopGuard.toolCallReminder": return t("When a Gemini reasoning stream emits many consecutive planning headers without calling a tool, interrupt it and inject a reminder to issue a tool call (requires Loop Guard)");
		case "model.toolCallLoopGuard.enabled": return t("Detect consecutive identical tool calls across turns and inject a corrective steer");
		case "model.toolCallLoopGuard.exemptTools": return t("Tool names that may repeat consecutively without triggering the cross-turn loop guard");
		case "model.toolCallLoopGuard.threshold": return t("Consecutive identical tool calls required before the corrective steer is injected");
		case "modelRoleStorage": return t("Where model selector role assignments are saved");
		case "omitThinking": return t("Instruct upstream providers to completely omit thinking summaries from responses (where supported)");
		case "paste.largeMenuThreshold": return t("When a paste reaches this many lines, offer a menu to wrap it in a code block, wrap it in XML tags, or save it to a file. 0 disables the menu (large pastes still collapse to a [Paste] marker).");
		case "personality": return t("Communication style rendered into the system prompt's personality block");
		case "plan.defaultOnStartup": return t("Automatically enter plan mode at the start of every new session");
		case "plan.enabled": return t("Enable plan mode for read-only exploration and planning before execution");
		case "power.sleepPrevention": return t("Prevent macOS sleep during active sessions. Each level is cumulative — it adds the flags of all lower levels.");
		case "presencePenalty": return t("Penalty for introducing already-present tokens (-1 = provider default)");
		case "prewalk.enabled": return t("Start on the active model, then switch to a fast/cheap model (default the 'smol' role) at the first edit/write after the plan nudge's todo list exists — the strong model plans, commits the todos, and starts the implementation before handing off. Overridable per session with --prewalk / --no-prewalk.");
		case "proseOnlyThinking": return t("Omit code blocks from thinking summaries and replace them with an ellipsis");
		case "provider.appendOnlyContext": return t("Cache system prompt + tool specs and keep an append-only message log so provider prefix caches (DeepSeek, Xiaomi/SGLang, Anthropic) hit at maximum rate. Auto enables for known prefix-cache providers.");
		case "providers.anthropic.serverSideFallback": return t("When a Claude Fable 5 / Mythos 5 request is blocked by Anthropic's safety classifier, retry it on Claude Opus 4.8 server-side (Anthropic `server-side-fallback-2026-06-01` beta). Opt-in — leaving this off preserves the pre-fallback behavior for every request.");
		case "providers.antigravityEndpoint": return t("Endpoint routing strategy for google-antigravity providers (chat, search, image, discovery)");
		case "providers.autoThinkingMaxEffort": return t("Highest effort the `auto` classifier may resolve. `xhigh` keeps the classifier one tier below the top, so only an explicit `ultrathink` reaches `max`; `max` lets a turn the classifier judges exceptional bill the top tier on models that expose it.");
		case "providers.autoThinkingModel": return t("Difficulty classifier for the `auto` thinking level: online (the TINY role from /models, else smol) by default, or a local on-device model");
		case "providers.fetch": return t("Reader backend priority for the fetch/read URL tool");
		case "providers.imageOrder": return t("Prioritized providers for image generation; unlisted providers follow the active session provider and the built-in order");
		case "providers.kimiApiFormat": return t("API format for Kimi Code provider (auto follows live model metadata)");
		case "providers.memoryModel": return t("Mnemopi LLM for fact extraction + consolidation: online (the TINY role from /models, else smol/remote) by default, or a local on-device model");
		case "providers.ollama-cloud.maxConcurrency": return t("Maximum concurrent Ollama Cloud subagent runs per process; 0 disables the provider-specific limit");
		case "providers.openaiWebsockets": return t("Websocket policy for OpenAI Codex models (auto uses model defaults, on forces, off disables)");
		case "providers.openrouterVariant": return t("Default routing-variant suffix appended to OpenRouter model IDs (overridden when the selector already names a variant)");
		case "providers.streamFirstEventTimeoutSeconds": return t("Seconds to wait for the first model stream event; -1 uses provider/env defaults, 0 disables the watchdog");
		case "providers.streamIdleTimeoutSeconds": return t("Seconds a model stream may stay silent between events; -1 uses provider/env defaults, 0 disables the watchdog");
		case "providers.tinyModel": return t("Session-title model: online (the TINY role from /models, else @smol) by default, or a local on-device model");
		case "providers.tinyModelDevice": return t("ONNX execution provider for local tiny models (titles + memory). Default uses CPU-only inference. The PI_TINY_DEVICE env var overrides this.");
		case "providers.tinyModelDtype": return t("ONNX quantization/precision for local tiny models. Default uses each model's shipped dtype (q4); lower precision is faster, higher is more faithful. The PI_TINY_DTYPE env var overrides this.");
		case "providers.tts": return t("Backend for the tts tool: local on-device neural TTS (Kokoro-82M) or xAI Grok Voice");
		case "providers.unexpectedStopModel": return t("Classifier for unexpected-stop detection: online (the TINY role from /models, else smol) by default, or a local on-device model.");
		case "providers.webSearchExclude": return t("Providers that web_search should never use, even as fallbacks");
		case "providers.webSearchGeminiModel": return t("Model ID for Gemini Google Search grounding. Defaults to gemini-2.5-flash.");
		case "providers.webSearchOrder": return t("Prioritized providers for the web_search tool; unlisted providers retain their default order afterward");
		case "pwsh.enabled": return t("Enable the pwsh tool for direct PowerShell script execution");
		case "python.interpreter": return t("Optional path to an exact Python executable. When set, automatic Python runtime discovery is skipped.");
		case "python.kernelMode": return t("Keep the IPython kernel alive across eval calls or start fresh each time");
		case "read.defaultLimit": return t("Default number of lines returned when agent calls read without a limit");
		case "read.renderMarkdown": return t("Render Markdown read results as formatted terminal Markdown previews instead of raw source");
		case "read.summarize.enabled": return t("Return structural code summaries when read is called without an explicit selector");
		case "read.summarize.minBodyLines": return t("Minimum multiline body or literal length before read summaries collapse it");
		case "read.summarize.minCommentLines": return t("Minimum multiline block comment length before read summaries collapse it");
		case "read.summarize.minTotalLines": return t("Files with fewer total lines are read verbatim instead of structurally summarized");
		case "read.summarize.prose": return t("Return structural summaries for Markdown and plain text reads");
		case "read.summarize.unfoldLimit": return t("Hard ceiling on summary size while BFS-unfolding. An unfold whose revealed lines would exceed this is skipped (that span stays folded) and unfolding continues with the remaining spans.");
		case "read.summarize.unfoldUntil": return t("BFS-unfold elidable spans until the summary is at least this many visible lines. 0 keeps only the outermost elisions.");
		case "read.toolResultPreview": return t("Render read tool results inline in the transcript instead of summary rows");
		case "readLineNumbers": return t("Prepend line numbers to read tool output by default");
		case "recap.enabled": return t("Generate a brief LLM recap of where things stand after the terminal has been idle");
		case "recap.idleSeconds": return t("Seconds to wait while idle before showing the recap");
		case "repetitionPenalty": return t("Penalty for repeated tokens (-1 = provider default)");
		case "retry.fallbackRevertPolicy": return t("When to return to the primary model after a fallback");
		case "retry.maxDelayMs": return t("Maximum wait between retries, in ms. When the provider asks us to wait longer than this and no credential or model fallback succeeds, the request fails fast instead of sleeping (e.g. 3-hour Anthropic rate-limit windows).");
		case "retry.maxRetries": return t("Maximum retry attempts on API errors");
		case "retry.modelFallback": return t("Allow retry recovery to switch to configured fallback models");
		case "retry.usageAwareFallback": return t("Use reliable coding-plan quota reports to prefer same-provider accounts, then configured fallback models, before a hard usage limit. Ordinary configured API keys are excluded.");
		case "retry.usageReservePct": return t("Treat a coding-plan model as near its limit below this remaining percentage. Unknown or unmapped usage keeps the primary model.");
		case "retry.usageReservePolicy": return t("What to do when every same-provider coding-plan account is inside the reserve margin.");
		case "ruby.interpreter": return t("Optional path to an exact Ruby executable. When set, automatic Ruby runtime discovery is skipped.");
		case "searxng.endpoint": return t("Base URL of a self-hosted SearXNG instance used for web search");
		case "secrets.enabled": return t("Obfuscate configured secrets and redact credential-shaped tokens before sending to AI providers");
		case "security.enabled": return t("Enable OMP-native security scan planning, execution, and the read-only security:// resource namespace");
		case "share.redactSecrets": return t("Run the secret obfuscator over /share snapshots before upload (uses the secrets.* config)");
		case "share.serverUrl": return t("Share viewer/upload base used by /share (encrypted blob upload + viewer; links are <base>/<id>#<key>)");
		case "share.store": return t("Where /share uploads the encrypted session blob");
		case "shellMinimizer.enabled": return t("Compress verbose shell output (git, npm, cargo, etc.) before returning it to the agent");
		case "shellMinimizer.sourceOutlineLevel": return t("Source outline mode for cat/read of source files: default or aggressive");
		case "showHardwareCursor": return t("Show terminal cursor for IME support");
		case "skills.enableSkillCommands": return t("Register skills as /skill:name commands");
		case "snapcompact.shape": return t("Frame shape snapcompact prints text with (compaction archive and inline imaging). Auto picks a shape tuned for the current model.");
		case "snapcompact.systemPrompt": return t("Experimental: render selected system prompt text as dense PNG image(s) and attach to the first user message (vision models only). Saves tokens; loses prompt caching for imaged text.");
		case "snapcompact.toolResults": return t("Experimental: render large historical tool results as dense PNG image(s) instead of text (vision models only). Saves tokens on accumulated read/search output.");
		case "speech.enabled": return t("Speak the assistant's output aloud through the speakers as it streams");
		case "speech.enhanced": return t("Rewrite assistant output into natural spoken prose with the tiny/smol model before synthesis (describes code, drops links and markdown). Falls back to mechanical cleanup on failure");
		case "speech.mode": return t("What to speak: all = assistant messages + thinking; assistant = messages only; yield = only the final message at turn end");
		case "speech.voice": return t("Kokoro voice used when speaking the assistant's output aloud");
		case "speechgen.enabled": return t("Enable the tts tool for on-device (Kokoro) or xAI Grok Voice speech-file synthesis");
		case "startup.changelogMode": return t("Choose whether update notes start as a summary, full details, or stay hidden");
		case "startup.checkUpdate": return t("Check for omp updates on startup");
		case "startup.quiet": return t("Skip welcome screen and startup status messages");
		case "startup.setupWizard": return t("Show newly added onboarding steps once per setup version");
		case "startup.showSplash": return t("Show the full animated setup splash on normal interactive startup without rerunning setup. Quiet Startup still suppresses it.");
		case "statusLine.compactThinkingLevel": return t("Show the thinking level as a single icon on the model name instead of a separate ` · <level>` suffix.");
		case "statusLine.preset": return t("Pre-built status line configurations");
		case "statusLine.separator": return t("Style of separators between segments");
		case "statusLine.sessionAccent": return t("Use the session name color for the editor border and status line gap");
		case "statusLine.showHookStatus": return t("Display hook status messages below the status line");
		case "statusLine.transparent": return t("Use the terminal's default background for the status line instead of the theme's `statusLineBg`. Powerline end caps are dropped because they need a contrasting fill to bridge into the surrounding terminal.");
		case "steeringMode": return t("How to process queued messages while agent is working");
		case "stt.enabled": return t("Enable speech-to-text input via microphone");
		case "stt.modelName": return t("Local on-device speech model. Parakeet TDT v3 (sherpa-onnx) is the SoTA default; Whisper base/small/large-v3-turbo tiers (transformers.js) trade size for multilingual coverage. Downloaded on first use.");
		case "stt.submitTrigger": return t("Choose when speech dictation automatically submits: Never, Release (2+ words), Release with complete sentence, or When I Say Submit.");
		case "symbolPreset": return t("Glyph set for icons and symbols (Unicode, Nerd Font, or ASCII)");
		case "task.agentIdleTtlMs": return t("How long an idle subagent stays live in memory before being parked to disk (ms). Parked agents are revived automatically when messaged or resumed. 0 keeps idle agents live until exit.");
		case "task.batch": return t("Switch the task tool to its batch shape: one call carries { context, tasks[] } — one subagent per item, with an optional per-item agent (defaulting to the session spawn-policy agent), per-item isolation, and a required shared context prepended to every assignment. With async.enabled=true, each spawn runs as an independent background agent with the normal idle/parked lifecycle; otherwise the call blocks for merged results. Disable to restore the flat single-spawn schema.");
		case "task.eager": return t("How strongly to push delegating work to subagents");
		case "task.enableEffort": return t("Expose the optional effort parameter on task spawns, allowing callers to override each subagent's thinking level");
		case "task.enableLsp": return t("Allow subagents spawned via the task tool to use the lsp tool. Off by default to keep subagents cheap; enable when LSP-aware delegation is worth the extra tokens.");
		case "task.isolation.apply": return t("Automatically apply successful isolated task changes to the parent checkout; disable to retain patch or branch artifacts");
		case "task.isolation.commits": return t("Commit message style for nested repo changes (generic or AI-generated)");
		case "task.isolation.merge": return t("How isolated task changes are integrated (patch apply or branch merge)");
		case "task.maxConcurrency": return t("Maximum number of subagents running concurrently");
		case "task.maxEffort": return t("Maximum reasoning effort allowed for the task tool's per-spawn effort hint. Lower values prevent callers from escalating subagents above this ceiling; the default preserves the model's full range.");
		case "task.maxRecursionDepth": return t("How many levels deep subagents can spawn their own subagents");
		case "task.maxRuntimeMs": return t("Hard wall-clock limit per subagent (ms). 0 disables it. Defense-in-depth against provider-side stream hangs that escape the inference-layer watchdog; triggers a normal subagent abort with a 'timed out' reason.");
		case "task.prewalk": return t("Arm prewalk for the bundled generic `task` subagent: it starts on its resolved model, plans and begins the implementation, then hands off to the 'smol' role at its first edit/write. Per-agent overrides (task.agentPrewalk, toggled with P in /agents) and user agent `prewalk` frontmatter apply regardless of this toggle.");
		case "task.showResolvedModelBadge": return t("Display the actual model ID used by each subagent in the task widget status line");
		case "task.softRequestBudget": return t("Soft per-subagent request budget (assistant requests per run). Crossing it injects a wrap-up steering notice (see task.softRequestBudgetNotice); at 1.5x the budget the run is force-stopped and the agent must yield its partial findings. 0 disables the guard. Bundled scout/sonic agents cap out at a lower built-in budget, so a value below that cap still applies to them.");
		case "task.softRequestBudgetNotice": return t("Inject one steering notice when a subagent crosses its soft request budget, asking it to wrap up before the 1.5x forced-yield stop.");
		case "tasks.todoClearDelay": return t("Delay before completed or abandoned todos are removed from the todo widget");
		case "temperature": return t("Sampling temperature (0 = deterministic, 1 = creative, -1 = provider default)");
		case "terminal.showImages": return t("Render images inline in the terminal");
		case "terminal.showProgress": return t("Emit OSC 9;4 indeterminate progress while the agent or context maintenance is running");
		case "textVerbosity": return t("OpenAI Responses and Codex response verbosity (low, medium, or high)");
		case "theme.dark": return t("Theme used when the terminal has a dark background");
		case "theme.light": return t("Theme used when the terminal has a light background");
		case "tier.advisor": return t("Service Tier for the advisor model. None = standard processing; Inherit = match the main agent's live per-family tiers; pick a value to apply it to the advisor model's family.");
		case "tier.google": return t("Processing tier for Gemini (Google AI Studio + Vertex) requests, and Google-family models routed via OpenRouter (none = omit). Sent as the top-level `serviceTier` field.");
		case "tier.openai": return t("Processing tier for OpenAI / OpenAI-Codex requests, and OpenAI-family models routed via OpenRouter (none = omit). Sent as `service_tier`.");
		case "tier.subagent": return t("Service Tier for spawned task/eval subagents. Inherit = match the main agent's live per-family tiers (tracks /fast); pick a value to apply it to whichever family the subagent's model belongs to.");
		case "title.refreshOnReplan": return t("Refresh generated session titles after todo init replans unless the title was set by the user");
		case "todo.eager": return t("How strongly to push automatic todo-list creation after the first message");
		case "todo.enabled": return t("Enable the todo tool for task tracking");
		case "todo.reminders": return t("Remind the agent to complete todos before stopping");
		case "todo.remindersMax": return t("Maximum number of todo reminders before giving up");
		case "tools.abortOnFabricatedResult": return t("With in-band tool calls, stop the model immediately when it starts hallucinating a tool result mid-turn. Disable to let the model finish generating and discard the fabricated continuation instead.");
		case "tools.approval": return t("Per-tool approval policies. Set to 'allow' to auto-approve, 'prompt' to require confirmation, or 'deny' to block. Overrides are honored in every approval mode.");
		case "tools.approvalMode": return t("Default approval behavior for tool calls. 'Always ask' auto-approves read-only tools only. 'Write' auto-approves read and workspace-write tools. 'Yolo' auto-approves all tiers; user policy may still prompt or block.");
		case "tools.artifactHeadBytes": return t("Amount of head content kept inline alongside the tail when output spills to artifact (middle elision). 0 disables — keep tail only.");
		case "tools.artifactSpillThreshold": return t("Tool output above this size is saved as an artifact; tail is kept inline");
		case "tools.artifactTailBytes": return t("Amount of tail content kept inline when output spills to artifact");
		case "tools.artifactTailLines": return t("Maximum lines of tail content kept inline when output spills to artifact");
		case "tools.format": return t("Controls how tools are exposed to the model. Auto uses provider-native tool calls unless the selected model is marked as not supporting them, then falls back to the GLM owned dialect. Native forces provider-native tools; the other values force the named owned dialect. Applies on session start.");
		case "tools.intentTracing": return t("Ask the agent to describe the intent of each tool call before executing it");
		case "tools.maxTimeout": return t("Maximum timeout in seconds the agent can set for any tool (0 = no limit)");
		case "tools.outputMaxColumns": return t("Per-line byte cap for streaming tool outputs (bash, python, js eval) and `read`. Lines wider than this are ellipsis-truncated; remaining bytes up to the next newline are dropped. 0 disables.");
		case "tools.xdev": return t("Mount rarely-used (discoverable) tools under xd:// device URLs driven via read/write instead of shipping their schemas on every request. Sessions without a granted write tool skip mounting and expose every tool top-level. Disable to expose every enabled tool top-level.");
		case "tools.xdevDocs": return t("Choose which mounted-device docs and schemas are inlined in the system prompt. Built-ins keeps core tools inline while MCP and extension tools stay on-demand.");
		case "tools.xdevInlineDevices": return t("When xd:// Prompt Docs is Built-ins Only, inline dynamic devices whose names match these glob patterns (for example mcp__context_mode_*). Catalog Only ignores this setting.");
		case "topK": return t("Sample from top-K tokens (-1 = provider default)");
		case "topP": return t("Nucleus sampling cutoff (0-1, -1 = provider default)");
		case "treeFilterMode": return t("Default filter mode when opening the session tree");
		case "tts.localModel": return t("On-device neural TTS model (Kokoro-82M) used by the local TTS backend");
		case "tts.localVoice": return t("Kokoro voice used by the local TTS backend (American/British, female/male)");
		case "ttsr.builtinRules": return t("Load the default rules shipped with the agent (override individually with ttsr.disabledRules)");
		case "ttsr.contextMode": return t("What to do with partial output when TTSR triggers");
		case "ttsr.disabledRules": return t("Rule names to ignore entirely (applies to bundled defaults and your own rules)");
		case "ttsr.enabled": return t("Interrupt the agent mid-stream when output matches rule patterns (Time-Traveling Stream Rules)");
		case "ttsr.interruptMode": return t("When to interrupt mid-stream vs inject warning after completion");
		case "ttsr.repeatGap": return t("Messages before a rule can trigger again");
		case "ttsr.repeatMode": return t("How rules can repeat: once per session or after a message gap");
		case "tui.codexResetFireworks": return t("Celebrate unscheduled Codex weekly usage resets and newly banked saved resets with a top-third fireworks overlay that remains until Escape");
		case "tui.hyperlinks": return t("Wrap paths and URLs in OSC 8 hyperlinks for terminal-native click-to-open (auto: detect support; off: never; always: unconditional)");
		case "tui.imeSafeCursor": return t("Move the prompt's bottom border to a separate row so macOS IME preedit cannot displace it");
		case "tui.renderMermaid": return t("Render Mermaid fenced code blocks as ASCII diagrams");
		case "tui.scrollbackRebuild": return t("Erase and replay terminal scrollback when a block's final form replaces its live preview. When off (default), stale preview copies remain in history and the final content is appended below.");
		case "tui.textSizing": return t("Render Markdown H1 headings at 2x scale using Kitty's OSC 66 text-sizing protocol. Only takes effect on Kitty terminals; ignored everywhere else. Off by default.");
		case "tui.tight": return t("Remove the 1-character horizontal padding from the left and right of the terminal output");
		case "tui.titleState": return t("Show the agent run state in the terminal title's separator — an animated spinner while working (a static ':' on Windows), '>' when it's your turn, '!' when the agent is waiting on you");
		case "vault.enabled": return t("Enable the vault:// internal URL for reading and editing Obsidian vault content via the Obsidian CLI. When disabled, vault:// resolution is refused and the vault:// entry is omitted from the system prompt.");
		case "web_search.enabled": return t("Enable the web_search tool for live web results");
		case "workspace.additionalDirectories": return t("Extra workspace directories added to every session as additional roots (multi-root workspace). Managed live via /add-dir and /remove-dir. Paths resolve relative to cwd; absolute paths recommended. The agent is told these roots exist and can read/grep/glob them.");
		case "worktree.base": return t("Base directory for agent-managed worktrees — task-isolation copies, `github` PR checkouts, and `omp worktree` cleanup all live here. Unset uses ~/.omp/wt. Must be an absolute or ~-relative path; relative paths are ignored. The OMP_WORKTREE_DIR env var overrides this.");
		default:
			return fallback;
	}
}

function translatedOptions(path: SettingPath, options: ReadonlyArray<SubmenuOption>): ReadonlyArray<SubmenuOption> {
	switch (path) {
		case "advisor.immuneTurns":
			return [
				{ value: "0", label: t("0 turns"), description: t("Allow every concern/blocker to interrupt.") },
				{ value: "1", label: t("1 turn") },
				{ value: "2", label: t("2 turns") },
				{ value: "3", label: t("3 turns"), description: t("Default.") },
				{ value: "4", label: t("4 turns") },
				{ value: "5", label: t("5 turns") },
			];
		case "ask.timeout":
			return [
				{ value: "0", label: t("Disabled") },
				{ value: "15", label: t("15 seconds") },
				{ value: "30", label: t("30 seconds") },
				{ value: "60", label: t("60 seconds") },
				{ value: "120", label: t("120 seconds") },
			];
		case "async.pollWaitDuration":
			return [
				{ value: "5s", label: t("5 seconds") },
				{ value: "10s", label: t("10 seconds") },
				{ value: "30s", label: t("30 seconds") },
				{ value: "1m", label: t("1 minute") },
				{ value: "5m", label: t("5 minutes") },
				{ value: "smart", label: t("Smart"), description: t("Default — adaptive 5s→5m, resets when you stop polling") },
			];
		case "autocompleteMaxVisible":
			return [
				{ value: "3", label: t("3 items") },
				{ value: "5", label: t("5 items") },
				{ value: "7", label: t("7 items") },
				{ value: "10", label: t("10 items") },
				{ value: "15", label: t("15 items") },
				{ value: "20", label: t("20 items") },
			];
		case "codexResets.autoRedeem":
			return [
				{ value: "unset", label: t("Unset"), description: t("Check eligibility, then ask before spending the first saved reset.") },
				{ value: "yes", label: t("Yes"), description: t("Spend eligible saved resets without prompting.") },
				{ value: "no", label: t("No"), description: t("Do not run the saved-reset auto-redeem check.") },
			];
		case "compaction.idleThresholdTokens":
			return [
				{ value: "100000", label: t("100K tokens") },
				{ value: "200000", label: t("200K tokens") },
				{ value: "300000", label: t("300K tokens") },
				{ value: "400000", label: t("400K tokens") },
				{ value: "500000", label: t("500K tokens") },
				{ value: "600000", label: t("600K tokens") },
				{ value: "700000", label: t("700K tokens") },
				{ value: "800000", label: t("800K tokens") },
				{ value: "900000", label: t("900K tokens") },
			];
		case "compaction.idleTimeoutSeconds":
			return [
				{ value: "60", label: t("1 minute") },
				{ value: "120", label: t("2 minutes") },
				{ value: "300", label: t("5 minutes") },
				{ value: "600", label: t("10 minutes") },
				{ value: "1800", label: t("30 minutes") },
				{ value: "3600", label: t("1 hour") },
			];
		case "compaction.strategy":
			return [
				{ value: "context-full", label: t("Context-full"), description: t("Summarize in-place and keep the current session") },
				{ value: "handoff", label: t("Handoff"), description: t("Generate handoff and continue in a new session") },
				{ value: "shake", label: t("Shake"), description: t("Drop heavy content (tool results + large blocks) in place; recover via artifact") },
				{ value: "snapcompact", label: t("Snapcompact"), description: t("Archive history onto dense bitmap images the model reads back; no LLM call") },
				{ value: "off", label: t("Off"), description: t("Disable automatic context maintenance (same behavior as Auto-compact off)") },
			];
		case "compaction.thresholdPercent":
			return [
				{ value: "default", label: t("Default"), description: t("Legacy reserve-based threshold") },
				{ value: "10", label: t("10%"), description: t("Extremely early maintenance") },
				{ value: "20", label: t("20%"), description: t("Very early maintenance") },
				{ value: "30", label: t("30%"), description: t("Early maintenance") },
				{ value: "40", label: t("40%"), description: t("Moderately early maintenance") },
				{ value: "50", label: t("50%"), description: t("Halfway point") },
				{ value: "60", label: t("60%"), description: t("Moderate context usage") },
				{ value: "70", label: t("70%"), description: t("Balanced") },
				{ value: "75", label: t("75%"), description: t("Slightly aggressive") },
				{ value: "80", label: t("80%"), description: t("Typical threshold") },
				{ value: "85", label: t("85%"), description: t("Aggressive context usage") },
				{ value: "90", label: t("90%"), description: t("Very aggressive") },
				{ value: "95", label: t("95%"), description: t("Near context limit") },
			];
		case "compaction.thresholdTokens":
			return [
				{ value: "default", label: t("Default"), description: t("Use percentage-based threshold") },
				{ value: "25000", label: t("25K tokens"), description: t("Quarter of a 200K window") },
				{ value: "50000", label: t("50K tokens"), description: t("Half of a 200K window") },
				{ value: "100000", label: t("100K tokens"), description: t("Half of a 200K window") },
				{ value: "150000", label: t("150K tokens"), description: t("Three-quarters of a 200K window") },
				{ value: "200000", label: t("200K tokens"), description: t("Full standard context window") },
				{ value: "300000", label: t("300K tokens"), description: t("Large context window") },
				{ value: "500000", label: t("500K tokens"), description: t("Very large context window") },
			];
		case "display.language":
			return [
				{ value: "auto", label: t("Auto (follow system)"), description: t("Automatically match the system language") },
				{ value: "en", label: t("English"), description: t("English") },
				{ value: "zh-CN", label: t("简体中文"), description: t("Simplified Chinese") },
			];
		case "display.shimmer":
			return [
				{ value: "classic", label: t("Classic"), description: t("Soft cosine wave sweeping across the text") },
				{ value: "kitt", label: t("KITT Scanner"), description: t("Knight Rider 1982 red light bouncing left-right") },
				{ value: "disabled", label: t("Disabled"), description: t("No animation; static muted text") },
			];
		case "edit.fuzzyThreshold":
			return [
				{ value: "0.85", label: "0.85", description: t("Lenient") },
				{ value: "0.90", label: "0.90", description: t("Moderate") },
				{ value: "0.95", label: "0.95", description: t("Default") },
				{ value: "0.98", label: "0.98", description: t("Strict") },
			];
		case "grep.contextAfter":
			return [
				{ value: "0", label: t("0 lines") },
				{ value: "1", label: t("1 line") },
				{ value: "2", label: t("2 lines") },
				{ value: "3", label: t("3 lines") },
				{ value: "5", label: t("5 lines") },
				{ value: "10", label: t("10 lines") },
			];
		case "grep.contextBefore":
			return [
				{ value: "0", label: t("0 lines") },
				{ value: "1", label: t("1 line") },
				{ value: "2", label: t("2 lines") },
				{ value: "3", label: t("3 lines") },
				{ value: "5", label: t("5 lines") },
			];
		case "hindsight.retainMode":
			return [
				{ value: "full-session", label: t("Full session"), description: t("Upsert one document per session (recommended)") },
				{ value: "last-turn", label: t("Last turn"), description: t("Chunked retention sliced by turn boundaries") },
			];
		case "hindsight.scoping":
			return [
				{ value: "global", label: t("Global"), description: t("One shared bank — every project sees the same memories") },
				{ value: "per-project", label: t("Per project"), description: t("Isolated bank per cwd basename — projects cannot see each other's memories") },
				{ value: "per-project-tagged", label: t("Per project (tagged)"), description: t("Shared bank, retains tagged with project:<cwd>. Recall surfaces project + untagged global memories together") },
			];
		case "images.visionApprovalTimeoutMs":
			return [
				{ value: "0", label: t("Disabled") },
				{ value: "30000", label: t("30 seconds") },
				{ value: "60000", label: t("1 minute") },
				{ value: "120000", label: t("2 minutes") },
				{ value: "300000", label: t("5 minutes") },
			];
		case "inlineToolDescriptors":
			return [
				{ value: "auto", label: t("Auto"), description: t("Inline descriptors for Gemini models; keep them in tool schemas otherwise") },
				{ value: "on", label: t("On"), description: t("Always inline descriptors in the system prompt") },
				{ value: "off", label: t("Off"), description: t("Keep descriptors in provider tool schemas only") },
			];
		case "inspect_image.mode":
			return [
				{ value: "auto", label: t("Auto (only for models without vision)") },
				{ value: "on", label: t("On") },
				{ value: "off", label: t("Off") },
			];
		case "inspect_image.timeoutMs":
			return [
				{ value: "0", label: t("Disabled") },
				{ value: "60000", label: t("1 minute") },
				{ value: "120000", label: t("2 minutes") },
				{ value: "180000", label: t("3 minutes") },
				{ value: "300000", label: t("5 minutes") },
			];
		case "irc.timeoutMs":
			return [
				{ value: "0", label: t("Disabled") },
				{ value: "30000", label: t("30 seconds") },
				{ value: "60000", label: t("1 minute") },
				{ value: "120000", label: t("2 minutes") },
				{ value: "300000", label: t("5 minutes") },
			];
		case "loop.mode":
			return [
				{ value: "prompt", label: t("Prompt"), description: t("Re-submit the prompt as a follow-up message (current behavior)") },
				{ value: "compact", label: t("Compact"), description: t("Compact the session context, then re-submit the prompt") },
				{ value: "reset", label: t("Reset"), description: t("Start a new session, then re-submit the prompt") },
			];
		case "marketplace.autoUpdate":
			return [
				{ value: "off", label: t("Off"), description: t("Don't check for plugin updates") },
				{ value: "notify", label: t("Notify"), description: t("Check on startup and notify when updates are available") },
				{ value: "auto", label: t("Auto"), description: t("Check on startup and auto-install updates") },
			];
		case "memory.backend":
			return [
				{ value: "off", label: t("Off"), description: t("No memory subsystem runs") },
				{ value: "local", label: t("Local"), description: t("Local rollout summarisation pipeline (memory_summary.md)") },
				{ value: "hindsight", label: t("Hindsight"), description: t("Vectorize Hindsight remote memory service") },
				{ value: "mnemopi", label: t("Mnemopi"), description: t("Local SQLite recall/retain backend with optional embeddings") },
			];
		case "minP":
			return [
				{ value: "-1", label: t("Default"), description: t("Use provider default") },
				{ value: "0.01", label: "0.01", description: t("Very permissive") },
				{ value: "0.05", label: "0.05", description: t("Balanced") },
				{ value: "0.1", label: "0.1", description: t("Strict") },
			];
		case "mnemopi.embeddingVariant":
			return [
				{ value: "en", label: t("English (bge-base-en-v1.5)"), description: t("BAAI/bge-base-en-v1.5 (768d), English-only") },
				{ value: "multilingual", label: t("Multilingual (multilingual-e5-large)"), description: t("intfloat/multilingual-e5-large (1024d), cross-language recall") },
			];
		case "mnemopi.llmMode":
			return [
				{ value: "none", label: t("None"), description: t("Disable Mnemopi LLM-backed extraction") },
				{ value: "smol", label: t("Online (tiny)"), description: t("Use the online tiny model (the TINY role from /models, else @smol)") },
				{ value: "remote", label: t("Remote"), description: t("Use the Mnemopi remote LLM settings below") },
			];
		case "mnemopi.scoping":
			return [
				{ value: "global", label: t("Global"), description: t("One shared Mnemopi bank for every project") },
				{ value: "per-project", label: t("Per project"), description: t("Project-local Mnemopi bank per cwd basename") },
				{ value: "per-project-tagged", label: t("Per project (tagged)"), description: t("Write to a project-local bank but merge project + shared recall results") },
			];
		case "modelRoleStorage":
			return [
				{ value: "global", label: t("Global"), description: t("Save role models in the active profile config (current behavior)") },
				{ value: "project", label: t("Per-project"), description: t("Save project role models in .omp/config.yml; missing project roles use global defaults") },
			];
		case "paste.largeMenuThreshold":
			return [
				{ value: "0", label: t("Off") },
				{ value: "100", label: t("100 lines") },
				{ value: "250", label: t("250 lines") },
				{ value: "500", label: t("500 lines") },
				{ value: "1000", label: t("1000 lines") },
			];
		case "personality":
			return [
				{ value: "default", label: t("Default"), description: t("Terse, evidence-first engineer; dense, action-oriented replies") },
				{ value: "friendly", label: t("Friendly"), description: t("Warm, encouraging collaborator focused on momentum and morale") },
				{ value: "pragmatic", label: t("Pragmatic"), description: t("Direct, efficient engineer focused on clarity and rigor") },
				{ value: "none", label: t("None"), description: t("Omit the personality block entirely") },
			];
		case "power.sleepPrevention":
			return [
				{ value: "off", label: t("Off"), description: t("Do not prevent any sleep") },
				{ value: "idle", label: t("Prevent Idle Sleep"), description: t("Keep the system awake while a session is open (caffeinate -i)") },
				{ value: "display", label: t("Prevent Display Sleep"), description: t("Also keep the display from idle-sleeping (caffeinate -i -d)") },
				{ value: "system", label: t("Prevent System Sleep"), description: t("Also block all system sleep on AC and declare the user active (caffeinate -i -d -s -u)") },
			];
		case "presencePenalty":
			return [
				{ value: "-1", label: t("Default"), description: t("Use provider default") },
				{ value: "0", label: "0", description: t("No penalty") },
				{ value: "0.5", label: "0.5", description: t("Mild novelty") },
				{ value: "1", label: "1", description: t("Encourage novelty") },
				{ value: "2", label: "2", description: t("Strong novelty") },
			];
		case "provider.appendOnlyContext":
			return [
				{ value: "auto", label: t("Auto"), description: t("Enable for known prefix-cache providers (recommended)") },
				{ value: "on", label: t("On"), description: t("Always enable append-only context") },
				{ value: "off", label: t("Off"), description: t("Disable append-only context") },
			];
		case "providers.antigravityEndpoint":
			return [
				{ value: "auto", label: t("Auto"), description: t("Try production endpoint, fail over to sandbox on 5xx/429") },
				{ value: "production", label: t("Production Only"), description: t("Force production endpoint only") },
				{ value: "sandbox", label: t("Sandbox Only"), description: t("Force sandbox endpoint only") },
			];
		case "providers.autoThinkingMaxEffort":
			return [
				{ value: "xhigh", label: t("xhigh"), description: t("Classifier stops at xhigh (default)") },
				{ value: "max", label: t("max"), description: t("Classifier may resolve max where the model supports it") },
			];
		case "providers.fetch":
			return [
				{ value: "auto", label: t("Auto"), description: t("Priority: native > trafilatura > lynx > parallel > jina") },
				{ value: "native", label: t("Native"), description: t("In-process HTML→Markdown converter (always available)") },
				{ value: "trafilatura", label: t("Trafilatura"), description: t("Auto-installs via uv/pip") },
				{ value: "lynx", label: t("Lynx"), description: t("Requires lynx system package") },
				{ value: "parallel", label: t("Parallel"), description: t("Requires PARALLEL_API_KEY") },
				{ value: "jina", label: t("Jina"), description: t("Uses r.jina.ai reader (JINA_API_KEY optional)") },
			];
		case "providers.fireworksTier":
			return [
				{ value: "standard", label: t("Standard"), description: t("Default serving path (no service_tier)") },
				{ value: "priority", label: t("Priority"), description: t("Priority serving path: higher reliability, premium per-token pricing") },
			];
		case "providers.kimiApiFormat":
			return [
				{ value: "auto", label: t("Auto"), description: t("Use the model's server-declared protocol") },
				{ value: "openai", label: t("OpenAI"), description: t("api.kimi.com") },
				{ value: "anthropic", label: t("Anthropic"), description: t("api.moonshot.ai") },
			];
		case "providers.openaiWebsockets":
			return [
				{ value: "auto", label: t("Auto"), description: t("Use model/provider default websocket behavior") },
				{ value: "off", label: t("Off"), description: t("Disable websockets for OpenAI Codex models") },
				{ value: "on", label: t("On"), description: t("Force websockets for OpenAI Codex models") },
			];
		case "providers.openrouterVariant":
			return [
				{ value: "default", label: t("Default"), description: t("No suffix; use OpenRouter's default routing") },
				{ value: "nitro", label: t(":nitro"), description: t("Prioritize throughput / lowest latency") },
				{ value: "floor", label: t(":floor"), description: t("Prioritize cheapest available provider") },
				{ value: "online", label: t(":online"), description: t("Enable OpenRouter's web-search plugin") },
				{ value: "exacto", label: t(":exacto"), description: t("Cherry-picked high-quality providers (only defined for select models)") },
			];
		case "providers.streamFirstEventTimeoutSeconds":
			return [
				{ value: "-1", label: t("Auto"), description: t("Use provider defaults and PI_* timeout env vars") },
				{ value: "0", label: t("Off"), description: t("Disable first-event timeout") },
				{ value: "300", label: t("5 minutes") },
				{ value: "600", label: t("10 minutes") },
				{ value: "1800", label: t("30 minutes") },
			];
		case "providers.streamIdleTimeoutSeconds":
			return [
				{ value: "-1", label: t("Auto"), description: t("Use provider defaults and PI_* timeout env vars") },
				{ value: "0", label: t("Off"), description: t("Disable idle timeout") },
				{ value: "300", label: t("5 minutes") },
				{ value: "600", label: t("10 minutes") },
				{ value: "1800", label: t("30 minutes") },
			];
		case "providers.tts":
			return [
				{ value: "auto", label: t("Auto"), description: t("Prefer local on-device TTS; route .mp3 output to xAI when credentials exist") },
				{ value: "local", label: t("Local"), description: t("On-device neural TTS (Kokoro-82M); output is WAV/PCM16") },
				{ value: "xai", label: t("xAI Grok Voice"), description: t("Requires xAI Grok OAuth or XAI_API_KEY; MP3 or WAV") },
			];
		case "providers.webSearchTimeoutSeconds":
			return [
				{ value: "30", label: t("30 seconds") },
				{ value: "60", label: t("1 minute") },
				{ value: "120", label: t("2 minutes") },
				{ value: "180", label: t("3 minutes") },
				{ value: "300", label: t("5 minutes") },
			];
		case "read.defaultLimit":
			return [
				{ value: "200", label: t("200 lines") },
				{ value: "300", label: t("300 lines") },
				{ value: "500", label: t("500 lines") },
				{ value: "1000", label: t("1000 lines") },
				{ value: "5000", label: t("5000 lines") },
			];
		case "recap.idleSeconds":
			return [
				{ value: "60", label: t("1 minute") },
				{ value: "120", label: t("2 minutes") },
				{ value: "240", label: t("4 minutes") },
				{ value: "300", label: t("5 minutes") },
				{ value: "600", label: t("10 minutes") },
			];
		case "repetitionPenalty":
			return [
				{ value: "-1", label: t("Default"), description: t("Use provider default") },
				{ value: "0.8", label: "0.8", description: t("Allow repetition") },
				{ value: "1", label: "1", description: t("No penalty") },
				{ value: "1.1", label: "1.1", description: t("Mild penalty") },
				{ value: "1.2", label: "1.2", description: t("Balanced") },
				{ value: "1.5", label: "1.5", description: t("Strong penalty") },
			];
		case "retry.fallbackRevertPolicy":
			return [
				{ value: "cooldown-expiry", label: t("Cooldown expiry"), description: t("Return to the primary model after its suppression window ends") },
				{ value: "never", label: t("Never"), description: t("Stay on the fallback model until manually changed") },
			];
		case "retry.maxRetries":
			return [
				{ value: "1", label: t("1 retry") },
				{ value: "2", label: t("2 retries") },
				{ value: "3", label: t("3 retries") },
				{ value: "5", label: t("5 retries") },
				{ value: "10", label: t("10 retries") },
			];
		case "retry.usageReservePct":
			return [
				{ value: "5", label: t("5%"), description: t("Act only when nearly exhausted") },
				{ value: "10", label: t("10%"), description: t("Balanced safety margin") },
				{ value: "15", label: t("15%"), description: t("Conservative") },
				{ value: "20", label: t("20%"), description: t("Early protection") },
				{ value: "25", label: t("25%"), description: t("Very conservative") },
			];
		case "retry.usageReservePolicy":
			return [
				{ value: "confirm", label: t("Confirm interactively"), description: t("Keep interactive sessions on the primary until confirmed; background agents auto-fallback") },
				{ value: "auto", label: t("Auto-fallback"), description: t("Always select the next eligible configured fallback") },
				{ value: "fail-closed", label: t("Fail closed"), description: t("Do not spend reserve quota or select a fallback") },
			];
		case "share.store":
			return [
				{ value: "blob", label: t("Encrypted Blob"), description: t("Upload to the share server (no GitHub account needed; avoids gist API rate limits)") },
				{ value: "gist", label: t("GitHub Gist"), description: t("Push to a secret gist (needs authenticated gh), falling back to the share server") },
			];
		case "snapcompact.shape":
			return [
				{ value: "auto", label: t("Auto"), description: t("Picks a shape tuned for the current model, falling back to its provider family.") },
				{ value: "8x8r-bw", label: t("8x8 repeated, black"), description: t("unscii square cell, black ink, every line printed twice with the copy on a pale highlight band.") },
				{ value: "8x8r-sent", label: t("8x8 repeated, sentence hues"), description: t("Repeated grid with ink cycling six hues at sentence boundaries.") },
				{ value: "8x8u-bw", label: t("8x8, black"), description: t("Plain unscii square cell, single-printed lines, black ink.") },
				{ value: "8x8u-sent", label: t("8x8, sentence hues"), description: t("Plain unscii square cell with sentence-hue ink.") },
				{ value: "6x6u-bw", label: t("6x6 dense, black"), description: t("unscii squeezed to 6x6 — densest readable cell, fewest frames — in black ink.") },
				{ value: "6x6u-sent", label: t("6x6 dense, sentence hues"), description: t("Densest cell with sentence-hue ink.") },
				{ value: "5x8-bw", label: t("5x8 legacy, black"), description: t("Original X.org 5x8 glyphs on the 2576px frame, black ink.") },
				{ value: "5x8-sent", label: t("5x8 legacy, sentence hues"), description: t("The original snapcompact shape (pre-shape-table sessions rendered this).") },
				{ value: "6x12-dim", label: t("6x12, dimmed stopwords"), description: t("X.org 6x12 glyphs, black ink, function words dimmed gray.") },
				{ value: "8x13-bw", label: t("8x13, black"), description: t("X.org 8x13 glyphs, black ink.") },
				{ value: "8on16-bw", label: t("8x13 on 16px pitch, black"), description: t("8x13 glyphs on an 8x16 cell (extra leading), black ink.") },
				{ value: "8on22-bw", label: t("8x13 on 22px pitch (leading), black"), description: t("8x13 glyphs on an 8x22 cell — extra line spacing so rows don't crowd. Default for OpenAI/Google.") },
				{ value: "11on16-bw", label: t("8x13 on 11px advance (tracking), black"), description: t("8x13 glyphs on an 11x16 cell — extra letter spacing so characters don't merge. Default for Anthropic.") },
				{ value: "silver16-bw", label: t("Silver 16, CJK"), description: t("Embedded Silver TrueType font on a 16px grid for CJK and other non-Latin text.") },
				{ value: "doc-8on16-bw", label: t("Doc 8on16, black"), description: t("Two word-wrapped newspaper columns of 8x13 glyphs on a 16px pitch, black ink.") },
				{ value: "doc-8on16-sent", label: t("Doc 8on16, sentence hues"), description: t("Two-column doc layout with sentence-hue ink.") },
				{ value: "doc-8on16-sent-dim", label: t("Doc 8on16, sentence hues + dimmed stopwords"), description: t("Two-column doc layout, sentence-hue ink, function words dimmed gray.") },
			];
		case "snapcompact.systemPrompt":
			return [
				{ value: "none", label: t("None"), description: t("Keep the system prompt as text.") },
				{ value: "agents-md", label: t("AGENTS.md"), description: t("Only move loaded context-file instructions to images, when that saves tokens.") },
				{ value: "all", label: t("All"), description: t("Move the full system prompt to images, when that saves tokens.") },
			];
		case "speech.mode":
			return [
				{ value: "all", label: t("All (messages + thinking)") },
				{ value: "assistant", label: t("Assistant messages") },
				{ value: "yield", label: t("Final message only") },
			];
		case "startup.changelogMode":
			return [
				{ value: "summary", label: t("Summary"), description: t("Show release and change counts with a /changelog hint") },
				{ value: "expanded", label: t("Expanded"), description: t("Show the recent release notes in full") },
				{ value: "hidden", label: t("Hidden"), description: t("Do not show release notes on startup") },
			];
		case "statusLine.preset":
			return [
				{ value: "default", label: t("Default"), description: t("Model, path, git, context, tokens, cost") },
				{ value: "minimal", label: t("Minimal"), description: t("Path and git only") },
				{ value: "compact", label: t("Compact"), description: t("Model, git, cost, context") },
				{ value: "full", label: t("Full"), description: t("All segments including time") },
				{ value: "nerd", label: t("Nerd"), description: t("Maximum info with Nerd Font icons") },
				{ value: "ascii", label: t("ASCII"), description: t("No special characters") },
				{ value: "custom", label: t("Custom"), description: t("User-defined segments") },
			];
		case "statusLine.separator":
			return [
				{ value: "powerline", label: t("Powerline"), description: t("Solid arrows (Nerd Font)") },
				{ value: "powerline-thin", label: t("Thin chevron"), description: t("Thin arrows (Nerd Font)") },
				{ value: "slash", label: t("Slash"), description: t("Forward slashes") },
				{ value: "pipe", label: t("Pipe"), description: t("Vertical pipes") },
				{ value: "block", label: t("Block"), description: t("Solid blocks") },
				{ value: "none", label: t("None"), description: t("Space only") },
				{ value: "ascii", label: t("ASCII"), description: t("Greater-than signs") },
			];
		case "symbolPreset":
			return [
				{ value: "unicode", label: t("Unicode"), description: t("Standard symbols (default)") },
				{ value: "nerd", label: t("Nerd Font"), description: t("Requires Nerd Font") },
				{ value: "ascii", label: t("ASCII"), description: t("Maximum compatibility") },
			];
		case "task.eager":
			return [
				{ value: "default", label: t("Default"), description: t("Model decides when to delegate") },
				{ value: "preferred", label: t("Preferred"), description: t("Adds delegation guidance to the system prompt") },
				{ value: "always", label: t("Always"), description: t("Prompt guidance plus a first-turn delegation reminder") },
			];
		case "task.isolation.commits":
			return [
				{ value: "generic", label: t("Generic"), description: t("Static commit message") },
				{ value: "ai", label: t("AI"), description: t("AI-generated commit message from diff") },
			];
		case "task.isolation.merge":
			return [
				{ value: "patch", label: t("Patch"), description: t("Combine diffs and git apply") },
				{ value: "branch", label: t("Branch"), description: t("Commit per task, merge with --no-ff") },
			];
		case "task.isolation.mode":
			return [
				{ value: "none", label: t("None"), description: t("No isolation") },
				{ value: "auto", label: t("Auto"), description: t("Let the PAL pick the best available backend") },
				{ value: "apfs", label: t("APFS"), description: t("macOS clonefile reflink (APFS)") },
				{ value: "btrfs", label: t("btrfs"), description: t("btrfs subvolume snapshot") },
				{ value: "zfs", label: t("ZFS"), description: t("ZFS snapshot + clone") },
				{ value: "reflink", label: t("Reflink"), description: t("Linux FICLONE per-file reflink") },
				{ value: "overlayfs", label: t("Overlayfs"), description: t("Linux kernel overlay (or fuse-overlayfs fallback)") },
				{ value: "projfs", label: t("ProjFS"), description: t("Windows Projected File System") },
				{ value: "block-clone", label: t("Block clone"), description: t("Windows FSCTL_DUPLICATE_EXTENTS_TO_FILE (NTFS/ReFS)") },
				{ value: "rcopy", label: t("Recursive copy"), description: t("git worktree if available, otherwise recursive copy") },
			];
		case "task.maxConcurrency":
			return [
				{ value: "0", label: t("Unlimited") },
				{ value: "1", label: t("1 task") },
				{ value: "2", label: t("2 tasks") },
				{ value: "4", label: t("4 tasks") },
				{ value: "8", label: t("8 tasks") },
				{ value: "16", label: t("16 tasks") },
				{ value: "32", label: t("32 tasks") },
				{ value: "64", label: t("64 tasks") },
			];
		case "task.maxRecursionDepth":
			return [
				{ value: "-1", label: t("Unlimited") },
				{ value: "0", label: t("None") },
				{ value: "1", label: t("Single") },
				{ value: "2", label: t("Double") },
				{ value: "3", label: t("Triple") },
			];
		case "task.maxRuntimeMs":
			return [
				{ value: "0", label: t("Unlimited"), description: t("Default") },
				{ value: "300000", label: t("5 minutes") },
				{ value: "900000", label: t("15 minutes") },
				{ value: "1800000", label: t("30 minutes") },
				{ value: "3600000", label: t("1 hour") },
			];
		case "task.softRequestBudget":
			return [
				{ value: "0", label: t("Disabled") },
				{ value: "90", label: t("90 requests") },
				{ value: "150", label: t("150 requests") },
				{ value: "200", label: t("200 requests"), description: t("Default") },
			];
		case "tasks.todoClearDelay":
			return [
				{ value: "0", label: t("Instant") },
				{ value: "60", label: t("1 minute"), description: t("Default") },
				{ value: "300", label: t("5 minutes") },
				{ value: "900", label: t("15 minutes") },
				{ value: "1800", label: t("30 minutes") },
				{ value: "3600", label: t("1 hour") },
				{ value: "-1", label: t("Never") },
			];
		case "temperature":
			return [
				{ value: "-1", label: t("Default"), description: t("Use provider default") },
				{ value: "0", label: "0", description: t("Deterministic") },
				{ value: "0.2", label: "0.2", description: t("Focused") },
				{ value: "0.5", label: "0.5", description: t("Balanced") },
				{ value: "0.7", label: "0.7", description: t("Creative") },
				{ value: "1", label: "1", description: t("Maximum variety") },
			];
		case "textVerbosity":
			return [
				{ value: "low", label: t("Low"), description: t("Prefer concise responses") },
				{ value: "medium", label: t("Medium"), description: t("Balance brevity and detail (default)") },
				{ value: "high", label: t("High"), description: t("Prefer detailed responses") },
			];
		case "todo.eager":
			return [
				{ value: "default", label: t("Default"), description: t("Model decides; no automatic todo list") },
				{ value: "preferred", label: t("Preferred"), description: t("Suggests a todo list on the first message (reminder, not forced)") },
				{ value: "always", label: t("Always"), description: t("Forces a comprehensive todo list on the first message") },
			];
		case "todo.remindersMax":
			return [
				{ value: "1", label: t("1 reminder") },
				{ value: "2", label: t("2 reminders") },
				{ value: "3", label: t("3 reminders") },
				{ value: "5", label: t("5 reminders") },
			];
		case "tools.approvalMode":
			return [
				{ value: "always-ask", label: t("Always ask"), description: t("Auto-approve read-only tools; require confirmation for write and exec tools.") },
				{ value: "write", label: t("Write"), description: t("Auto-approve read-only and write tools; require confirmation for exec tools such as bash, eval, browser, and task.") },
				{ value: "yolo", label: t("Yolo"), description: t("Auto-approve read, write, and exec tools. User policy can still require confirmation or block calls.") },
			];
		case "tools.artifactHeadBytes":
			return [
				{ value: "0", label: t("0 KB"), description: t("Disabled; tail-only truncation") },
				{ value: "1", label: t("1 KB"), description: t("~250 tokens") },
				{ value: "2.5", label: t("2.5 KB"), description: t("~625 tokens") },
				{ value: "5", label: t("5 KB"), description: t("~1.25K tokens") },
				{ value: "10", label: t("10 KB"), description: t("~2.5K tokens") },
				{ value: "20", label: t("20 KB"), description: t("Default; ~5K tokens") },
				{ value: "50", label: t("50 KB"), description: t("~12.5K tokens") },
				{ value: "100", label: t("100 KB"), description: t("~25K tokens") },
				{ value: "200", label: t("200 KB"), description: t("~50K tokens") },
			];
		case "tools.artifactSpillThreshold":
			return [
				{ value: "1", label: t("1 KB"), description: t("~250 tokens") },
				{ value: "2.5", label: t("2.5 KB"), description: t("~625 tokens") },
				{ value: "5", label: t("5 KB"), description: t("~1.25K tokens") },
				{ value: "10", label: t("10 KB"), description: t("~2.5K tokens") },
				{ value: "20", label: t("20 KB"), description: t("~5K tokens") },
				{ value: "30", label: t("30 KB"), description: t("~7.5K tokens") },
				{ value: "50", label: t("50 KB"), description: t("Default; ~12.5K tokens") },
				{ value: "75", label: t("75 KB"), description: t("~19K tokens") },
				{ value: "100", label: t("100 KB"), description: t("~25K tokens") },
				{ value: "200", label: t("200 KB"), description: t("~50K tokens") },
				{ value: "500", label: t("500 KB"), description: t("~125K tokens") },
				{ value: "1000", label: t("1 MB"), description: t("~250K tokens") },
			];
		case "tools.artifactTailBytes":
			return [
				{ value: "1", label: t("1 KB"), description: t("~250 tokens") },
				{ value: "2.5", label: t("2.5 KB"), description: t("~625 tokens") },
				{ value: "5", label: t("5 KB"), description: t("~1.25K tokens") },
				{ value: "10", label: t("10 KB"), description: t("~2.5K tokens") },
				{ value: "20", label: t("20 KB"), description: t("Default; ~5K tokens") },
				{ value: "50", label: t("50 KB"), description: t("~12.5K tokens") },
				{ value: "100", label: t("100 KB"), description: t("~25K tokens") },
				{ value: "200", label: t("200 KB"), description: t("~50K tokens") },
			];
		case "tools.artifactTailLines":
			return [
				{ value: "50", label: t("50 lines"), description: t("~250 tokens") },
				{ value: "100", label: t("100 lines"), description: t("~500 tokens") },
				{ value: "250", label: t("250 lines"), description: t("~1.25K tokens") },
				{ value: "500", label: t("500 lines"), description: t("Default; ~2.5K tokens") },
				{ value: "1000", label: t("1000 lines"), description: t("~5K tokens") },
				{ value: "2000", label: t("2000 lines"), description: t("~10K tokens") },
				{ value: "5000", label: t("5000 lines"), description: t("~25K tokens") },
			];
		case "tools.format":
			return [
				{ value: "auto", label: t("Auto"), description: t("Use native tool calls unless the model is known not to support them.") },
				{ value: "native", label: t("Native"), description: t("Use provider-native tool calls.") },
				{ value: "glm", label: t("GLM"), description: t("Use GLM-style in-band tool calls.") },
				{ value: "hermes", label: t("Hermes"), description: t("Use Hermes-style in-band tool calls.") },
				{ value: "kimi", label: t("Kimi"), description: t("Use Kimi-style in-band tool calls.") },
				{ value: "xml", label: t("XML"), description: t("Use generic XML in-band tool calls.") },
				{ value: "anthropic", label: t("Anthropic"), description: t("Use Anthropic-style in-band tool calls.") },
				{ value: "deepseek", label: t("DeepSeek"), description: t("Use DeepSeek-style in-band tool calls.") },
				{ value: "harmony", label: t("Harmony"), description: t("Use Harmony-style in-band tool calls.") },
				{ value: "qwen3", label: t("Qwen3"), description: t("Use the Qwen3 owned dialect.") },
				{ value: "gemini", label: t("Gemini"), description: t("Use the Gemini owned dialect.") },
				{ value: "gemma", label: t("Gemma"), description: t("Use the Gemma owned dialect.") },
				{ value: "minimax", label: t("MiniMax"), description: t("Use the MiniMax owned dialect.") },
			];
		case "tools.maxTimeout":
			return [
				{ value: "0", label: t("No limit") },
				{ value: "30", label: t("30 seconds") },
				{ value: "60", label: t("60 seconds") },
				{ value: "120", label: t("120 seconds") },
				{ value: "300", label: t("5 minutes") },
				{ value: "600", label: t("10 minutes") },
			];
		case "tools.outputMaxColumns":
			return [
				{ value: "0", label: t("Off"), description: t("No per-line cap") },
				{ value: "256", label: "256", description: t("Tight") },
				{ value: "512", label: "512" },
				{ value: "768", label: "768", description: t("Default") },
				{ value: "1024", label: "1024" },
				{ value: "2048", label: "2048" },
				{ value: "4096", label: "4096", description: t("Loose") },
			];
		case "tools.xdevDocs":
			return [
				{ value: "inline", label: t("All Devices"), description: t("Inline docs and schemas for every mounted device.") },
				{ value: "builtins", label: t("Built-ins Only"), description: t("Inline built-in docs; fetch MCP and extension docs on demand.") },
				{ value: "catalog", label: t("Catalog Only"), description: t("List every device; fetch all docs on demand.") },
			];
		case "topK":
			return [
				{ value: "-1", label: t("Default"), description: t("Use provider default") },
				{ value: "1", label: "1", description: t("Greedy top token") },
				{ value: "20", label: "20", description: t("Focused") },
				{ value: "40", label: "40", description: t("Balanced") },
				{ value: "100", label: "100", description: t("Broad") },
			];
		case "topP":
			return [
				{ value: "-1", label: t("Default"), description: t("Use provider default") },
				{ value: "0.1", label: "0.1", description: t("Very focused") },
				{ value: "0.3", label: "0.3", description: t("Focused") },
				{ value: "0.5", label: "0.5", description: t("Balanced") },
				{ value: "0.9", label: "0.9", description: t("Broad") },
				{ value: "1", label: "1", description: t("No nucleus filtering") },
			];
		case "ttsr.interruptMode":
			return [
				{ value: "always", label: t("always"), description: t("Interrupt on prose and tool streams") },
				{ value: "prose-only", label: t("prose-only"), description: t("Interrupt only on reply/thinking matches") },
				{ value: "tool-only", label: t("tool-only"), description: t("Interrupt only on tool-call argument matches") },
				{ value: "never", label: t("never"), description: t("Never interrupt; inject warning after completion") },
			];
		case "ttsr.repeatGap":
			return [
				{ value: "5", label: t("5 messages") },
				{ value: "10", label: t("10 messages") },
				{ value: "15", label: t("15 messages") },
				{ value: "20", label: t("20 messages") },
				{ value: "30", label: t("30 messages") },
			];
		default:
			return options;
	}
}

/**
 * Translate a settings-tab display label (TAB_METADATA literals = i18n keys).
 * Called at render time so the Language switch applies to the tab bar
 * immediately.
 */
function tabLabel(tab: SettingTab | "plugins"): string {
	switch (tab) {
		case "appearance": return t("Appearance");
		case "model": return t("Model");
		case "interaction": return t("Interaction");
		case "context": return t("Context");
		case "memory": return t("Memory");
		case "files": return t("Files");
		case "shell": return t("Shell");
		case "tools": return t("Tools");
		case "tasks": return t("Tasks");
		case "providers": return t("Providers");
		case "plugins":
			return t("Plugins");
	}
}

/** Translate a settings section heading (TAB_GROUPS literal = i18n key). */
function groupLabel(group: string): string {
	switch (group) {
		case "Advisor": return t("Advisor");
		case "Agent": return t("Agent");
		case "Approvals": return t("Approvals");
		case "Auto-Learn": return t("Auto-Learn");
		case "Available Tools": return t("Available Tools");
		case "Bash": return t("Bash");
		case "Collab": return t("Collab");
		case "Commands & Skills": return t("Commands & Skills");
		case "Compaction": return t("Compaction");
		case "Computer": return t("Computer");
		case "Developer": return t("Developer");
		case "Discovery & MCP": return t("Discovery & MCP");
		case "Display": return t("Display");
		case "Editing": return t("Editing");
		case "Eval & Runtimes": return t("Eval & Runtimes");
		case "Execution": return t("Execution");
		case "Experimental": return t("Experimental");
		case "Fireworks": return t("Fireworks");
		case "General": return t("General");
		case "Git": return t("Git");
		case "GitHub": return t("GitHub");
		case "Grep & Browser": return t("Grep & Browser");
		case "Hindsight": return t("Hindsight");
		case "Images": return t("Images");
		case "Input": return t("Input");
		case "Isolation": return t("Isolation");
		case "LSP": return t("LSP");
		case "Magic Keywords": return t("Magic Keywords");
		case "Mnemopi": return t("Mnemopi");
		case "Modes": return t("Modes");
		case "Notifications": return t("Notifications");
		case "Output Limits": return t("Output Limits");
		case "Power (macOS)": return t("Power (macOS)");
		case "Prewalk": return t("Prewalk");
		case "Privacy": return t("Privacy");
		case "Prompt": return t("Prompt");
		case "Protocol": return t("Protocol");
		case "Read Summaries": return t("Read Summaries");
		case "Reading": return t("Reading");
		case "Retry & Fallback": return t("Retry & Fallback");
		case "Rules (TTSR)": return t("Rules (TTSR)");
		case "Sampling": return t("Sampling");
		case "Services": return t("Services");
		case "Speech": return t("Speech");
		case "Startup & Updates": return t("Startup & Updates");
		case "Status Line": return t("Status Line");
		case "Subagents": return t("Subagents");
		case "Theme": return t("Theme");
		case "Thinking": return t("Thinking");
		case "Timeouts": return t("Timeouts");
		case "Tiny Model": return t("Tiny Model");
		case "Todos": return t("Todos");
		case "Vision": return t("Vision");
		default:
			return group;
	}
}

function getSettingsTabs(): Tab[] {
	return [
		...SETTING_TABS.map(id => {
			const meta = TAB_METADATA[id];
			const icon = theme.symbol(meta.icon as Parameters<typeof theme.symbol>[0]);
			return { id, label: `${icon} ${tabLabel(id)}`, short: icon };
		}),
		{ id: "plugins", label: `${theme.icon.package} ${t("Plugins")}`, short: theme.icon.package },
	];
}

/**
 * Dynamic context for settings that need runtime data.
 * Some settings (like thinking level) are managed by the session, not Settings.
 */
export interface SettingsRuntimeContext {
	/** Available thinking levels (from session) */
	availableThinkingLevels: Effort[];
	/** Current thinking level (from session) */
	thinkingLevel: ThinkingLevel | undefined;
	/** Available themes */
	availableThemes: string[];
	/** Provider/source ids shown in /model. */
	providers: string[];
	/** Working directory for plugins tab */
	cwd: string;
	/** Active model (api + id); resolves what the snapcompact `auto` shape maps to. */
	model?: ShapeTarget;
	/** Shared TUI image budget (graphics ids + transmit-once) for image previews. */
	imageBudget?: ImageBudget;
	/** Schedules a re-render after async preview work completes. */
	requestRender?: () => void;
}

/** Status line settings subset for preview */
export interface StatusLinePreviewSettings {
	preset?: StatusLinePreset;
	leftSegments?: StatusLineSegmentId[];
	rightSegments?: StatusLineSegmentId[];
	separator?: StatusLineSeparatorStyle;
	sessionAccent?: boolean;
	transparent?: boolean;
	compactThinkingLevel?: boolean;
}

export interface SettingsCallbacks {
	/** Called when any setting value changes */
	onChange: (path: SettingPath, newValue: unknown) => void;
	/** Called for theme preview while browsing */
	onThemePreview?: (theme: string) => void | Promise<void>;
	/** Called for status line preview while configuring */
	onStatusLinePreview?: (settings: StatusLinePreviewSettings) => void;
	/** Get current rendered status line for inline preview */
	getStatusLinePreview?: () => string;
	/** Called when plugins change */
	onPluginsChanged?: () => void | Promise<void>;
	/** Called when settings panel is closed */
	onCancel: () => void;
}

/**
 * Main tabbed settings selector component.
 * Uses declarative settings definitions from settings-defs.ts.
 */
export class SettingsSelectorComponent implements Component {
	#tabBar: TabBar;
	#currentList: SettingsList | null = null;
	#searchList: SettingsList | null = null;
	#pluginComponent: PluginSettingsComponent | null = null;
	#currentTabId: SettingTab | "plugins" = "appearance";
	#preSearchTabId: SettingTab | "plugins" = "appearance";
	#searchQuery = "";
	/** Single-line editor backing the search banner (cursor, word ops, paste). */
	#searchInput = new Input();
	#searchMatchCount = 0;
	/** First matching item id per tab id, for Tab-key jumps while searching. */
	#searchFirstMatch = new Map<string, string>();
	#textInputActive = false;
	#hasSectionJump = false;
	// Frame geometry from the last render, for mouse hit-testing (the
	// fullscreen overlay paints from screen row 0, so mouse rows map 1:1).
	#tabRowStart = 0;
	#tabRowCount = 0;
	#contentRowStart = 0;
	#contentRowCount = 0;

	constructor(
		private readonly context: SettingsRuntimeContext,
		private readonly callbacks: SettingsCallbacks,
	) {
		// No label prefix (the frame title already says Settings) and no
		// "(tab to cycle)" hint (folded into the footer hint line).
		this.#tabBar = new TabBar("", getSettingsTabs(), getTabBarTheme());
		this.#tabBar.showHint = false;
		this.#tabBar.onTabChange = () => {
			const tabId = this.#tabBar.getActiveTab().id as SettingTab | "plugins";
			if (this.#searchList) {
				// While searching, tabs act as jump targets into the result list.
				const firstId = this.#searchFirstMatch.get(tabId);
				if (firstId) this.#searchList.selectItem(firstId);
				return;
			}
			this.#switchToTab(tabId);
		};

		// Initialize with first tab
		this.#switchToTab("appearance");
	}

	invalidate(): void {
		this.#tabBar.invalidate();
		this.#currentList?.invalidate();
		this.#searchList?.invalidate();
		this.#pluginComponent?.invalidate();
	}

	/** Swap the active content (per-tab list, search list, or plugins). */
	#setContent(build: () => void): void {
		this.#currentList = null;
		this.#searchList = null;
		this.#pluginComponent = null;
		build();
	}

	#switchToTab(tabId: SettingTab | "plugins"): void {
		this.#currentTabId = tabId;
		this.#setContent(() => {
			if (tabId === "plugins") {
				this.#showPluginsTab();
			} else {
				this.#showSettingsTab(tabId);
			}
		});
	}

	#footerHintText(): string {
		if (this.#searchList) {
			return t("Enter to change · Tab to jump tabs · Esc to exit search");
		}
		if (this.#currentTabId === "plugins") {
			return t("Tab to switch tabs · Esc to close");
		}
		if (this.#currentList?.sectionFocused) {
			return t("↑/↓ to jump sections · Tab/Enter to settings · ←/→ to switch tabs · Esc to close");
		}
		const nav = this.#hasSectionJump ? t("Tab to jump sections · ←/→ to switch tabs") : t("Tab to switch tabs");
		return t("Enter/Space to change · {nav} · Type to search · Esc to close", { nav });
	}

	/** Single-line search banner: accent icon, editable query with live cursor, right-aligned match count. */
	#renderSearchBanner(width: number): string {
		const icon = theme.symbol("icon.search");
		const countText = this.#searchMatchCount === 1 ? t("1 match") : t("{count} matches", { count: this.#searchMatchCount });
		const rightWidth = visibleWidth(countText) + 1; // trailing margin
		const prefix = ` ${theme.fg("accent", icon)} `;
		// The input pads itself to exactly this width and keeps the cursor in view.
		const inputWidth = Math.max(4, width - visibleWidth(prefix) - rightWidth - 1);
		const inputLine = this.#searchInput.render(inputWidth)[0] ?? "";
		const count = theme.fg(this.#searchMatchCount > 0 ? "dim" : "warning", countText);
		return truncateToWidth(`${prefix}${theme.bold(inputLine)} ${count} `, width);
	}

	/**
	 * Fullscreen frame: title border, tab row, divider, optional search banner,
	 * the active content sized to fill the terminal, the appearance preview,
	 * then a footer hint pinned above the bottom border.
	 */
	render(width: number): readonly string[] {
		const height = Math.max(14, process.stdout.rows || 40);
		const innerWidth = Math.max(1, width - 4);

		const tabLines = this.#tabBar.render(innerWidth);
		const searching = this.#searchList !== null;
		const showPreview = !searching && this.#currentTabId === "appearance";
		const previewLines = showPreview ? ["", theme.fg("muted", t("Preview:")), this.#getStatusPreviewString()] : [];

		// Fixed chrome: top border, tabs, divider, [search row], divider, hint, bottom border.
		const fixedRows = 1 + tabLines.length + 1 + (searching ? 1 : 0) + 1 + 1 + 1;
		const contentRows = Math.max(7, height - fixedRows - previewLines.length);

		const list = this.#searchList ?? this.#currentList;
		let contentLines: readonly string[];
		if (list) {
			// SettingsList pads itself to viewport + blank + 3 description rows.
			list.setMaxVisible(contentRows - 4);
			contentLines = list.render(innerWidth);
		} else if (this.#pluginComponent) {
			contentLines = this.#pluginComponent.render(innerWidth);
		} else {
			contentLines = [];
		}

		const out: string[] = [];
		out.push(topBorder(width, t("Settings")));
		this.#tabRowStart = out.length;
		this.#tabRowCount = tabLines.length;
		for (const line of tabLines) {
			out.push(row(line, width));
		}
		out.push(divider(width));
		if (searching) {
			out.push(row(this.#renderSearchBanner(innerWidth), width));
		}
		this.#contentRowStart = out.length;
		this.#contentRowCount = contentRows;
		for (let i = 0; i < contentRows; i++) {
			out.push(row(contentLines[i] ?? "", width));
		}
		for (const line of previewLines) {
			out.push(row(line, width));
		}
		out.push(divider(width));
		out.push(row(theme.fg("dim", this.#footerHintText()), width));
		out.push(bottomBorder(width));
		return out;
	}

	/**
	 * Route an SGR mouse report against the frame geometry of the last render.
	 * Wheel scrolls the focused list, motion drives the hover highlights (tabs
	 * and rows), and a left click activates: tabs switch (or jump, while
	 * searching), a row click selects, and a click on the already-selected row
	 * activates it (toggle / open submenu).
	 */
	#handleMouse(data: string): boolean {
		return routeSgrMouseInput(data, event => this.#routeMouseEvent(event));
	}

	#routeMouseEvent(event: SgrMouseEvent): boolean {
		const list = this.#searchList ?? this.#currentList;
		// row() insets content by the border column plus a space.
		const contentColInset = 2;
		const innerCol = event.col - contentColInset;
		const contentLine = event.row - this.#contentRowStart;

		// An open submenu owns the pointer: wheel, hover, and clicks route into
		// it (text-input submenus ignore routed events).
		if (list?.hasOpenSubmenu()) {
			list.routeSubmenuMouse(event, contentLine, innerCol);
			return true;
		}

		const tabLine = event.row - this.#tabRowStart;
		const overTabs = tabLine >= 0 && tabLine < this.#tabRowCount;
		const overContent = contentLine >= 0 && contentLine < this.#contentRowCount;

		if (event.wheel !== null) {
			if (overContent) {
				list?.handleWheelAt(event.wheel, contentLine, innerCol);
			}
			return true;
		}

		if (event.motion) {
			const hovered = overTabs ? this.#tabBar.tabAt(tabLine, innerCol) : undefined;
			this.#tabBar.setHoverTab(hovered && !hovered.muted ? hovered.id : null);
			// hoverTest: never light up pane rows while the pointer is on the
			// sidebar — only rows the pointer is actually on.
			list?.setHoverItem(overContent ? (list.hoverTest(contentLine, innerCol) ?? null) : null);
			return true;
		}
		if (!event.leftClick) return true;

		if (overTabs) {
			const tab = this.#tabBar.tabAt(tabLine, innerCol);
			if (tab) this.#tabBar.selectTab(tab.id);
			return true;
		}
		if (overContent && list) {
			const id = list.hitTest(contentLine, innerCol);
			if (id !== undefined) {
				const wasSelected = list.getSelectedItem()?.id === id;
				list.selectItem(id);
				// Click-again activates: toggle booleans, open submenus.
				if (wasSelected) list.handleInput("\n");
			}
		}
		return true;
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Global search (type-to-search across every tab)
	// ═══════════════════════════════════════════════════════════════════════

	/** Swap the tab content for the global search result list. */
	#startSearch(initialQuery: string): void {
		this.#preSearchTabId = this.#currentTabId;
		this.#searchInput = new Input();
		this.#searchInput.prompt = "";
		this.#searchInput.setValue(initialQuery);
		const list = new SettingsList(
			[],
			10,
			getSettingsListTheme(),
			(id, newValue) => this.#onSearchSettingChange(id as SettingPath, newValue),
			() => this.callbacks.onCancel(),
			{
				layout: "flat",
				typeToSearch: false,
				emptyText: t("No matching settings"),
				hint: "",
			},
		);
		// Keep the footer tab highlight on the tab owning the selected result.
		list.onSelectionChange = item => this.#syncTabBarToSelection(item);
		this.#setContent(() => {
			this.#searchList = list;
		});
		this.#setSearchQuery(initialQuery);
	}

	/**
	 * Recompute matches across every settings tab. Results render as one flat
	 * list with a heading row per tab; the footer tab bar reorders to show
	 * matching tabs (with counts) first and the rest muted at the end.
	 */
	#setSearchQuery(query: string): void {
		if (!this.#searchList) return;
		if (query.length === 0) {
			this.#endSearch(false);
			return;
		}
		this.#searchQuery = query;

		const counts = new Map<SettingTab, number>();
		const items: SettingItem[] = [];
		const tabResults: { tab: SettingTab; matched: SettingItem[]; bestScore: number; order: number }[] = [];
		this.#searchFirstMatch.clear();
		let total = 0;
		for (const tab of SETTING_TABS) {
			const candidates: SettingItem[] = [];
			for (const def of getSettingsForTab(tab)) {
				const item = this.#defToItem(def);
				if (item) candidates.push(item);
			}
			const ranked = fuzzyRank(candidates, query, getSettingItemFilterText);
			const matched = ranked.map(result => result.item);
			counts.set(tab, matched.length);
			if (matched.length === 0) continue;
			total += matched.length;
			tabResults.push({
				tab,
				matched,
				bestScore: ranked[0]?.score ?? 0,
				order: SETTING_TABS.indexOf(tab),
			});
		}

		tabResults.sort((a, b) => a.bestScore - b.bestScore || a.order - b.order);
		for (const result of tabResults) {
			const meta = TAB_METADATA[result.tab];
			items.push({
				id: `__tab:${result.tab}`,
				label: `${theme.symbol(meta.icon as Parameters<typeof theme.symbol>[0])} ${tabLabel(result.tab)}`,
				currentValue: "",
				heading: true,
			});
			this.#searchFirstMatch.set(result.tab, result.matched[0]?.id ?? "");
			items.push(...result.matched);
		}

		this.#searchList.setItems(items);
		this.#searchMatchCount = total;
		this.#tabBar.setTabs(
			this.#buildSearchTabs(
				counts,
				tabResults.map(result => result.tab),
			),
		);
		this.#syncTabBarToSelection(this.#searchList.getSelectedItem());
	}

	/**
	 * Leave search mode. With `jumpToSelection`, land on the tab containing
	 * the selected result and keep it selected there — search doubles as
	 * navigation. Otherwise restore the pre-search tab.
	 */
	#endSearch(jumpToSelection: boolean): void {
		if (!this.#searchList) return;
		const selected = jumpToSelection ? this.#searchList.getSelectedItem() : undefined;
		const selectedDef = selected ? getSettingDef(selected.id as SettingPath) : undefined;
		const targetTab: SettingTab | "plugins" = selectedDef?.tab ?? this.#preSearchTabId;

		this.#searchQuery = "";
		this.#searchFirstMatch.clear();
		this.#searchMatchCount = 0;
		this.#tabBar.setTabs(getSettingsTabs(), targetTab);
		this.#switchToTab(targetTab);
		if (selectedDef) {
			this.#currentList?.selectItem(selectedDef.path);
		}
	}

	/** Matching tabs first (counts attached), ordered by best result score; the rest stay muted at the end. */
	#buildSearchTabs(counts: Map<SettingTab, number>, matchedTabOrder: readonly SettingTab[]): Tab[] {
		const matched: Tab[] = [];
		const empty: Tab[] = [];
		const matchedIds = new Set<SettingTab>(matchedTabOrder);
		for (const id of matchedTabOrder) {
			const meta = TAB_METADATA[id];
			const icon = theme.symbol(meta.icon as Parameters<typeof theme.symbol>[0]);
			const count = counts.get(id) ?? 0;
			if (count > 0) {
				matched.push({ id, label: `${icon} ${tabLabel(id)} (${count})`, short: `${icon} ${count}` });
			}
		}
		for (const id of SETTING_TABS) {
			if (matchedIds.has(id)) continue;
			const meta = TAB_METADATA[id];
			const icon = theme.symbol(meta.icon as Parameters<typeof theme.symbol>[0]);
			empty.push({ id, label: `${icon} ${tabLabel(id)}`, short: icon, muted: true });
		}
		// Plugins hosts its own UI; it is not part of the schema-backed search.
		empty.push({ id: "plugins", label: `${theme.icon.package} ${t("Plugins")}`, short: theme.icon.package, muted: true });
		return [...matched, ...empty];
	}

	#syncTabBarToSelection(item: SettingItem | undefined): void {
		if (!this.#searchList || !item) return;
		const def = getSettingDef(item.id as SettingPath);
		if (def) this.#tabBar.setActiveById(def.tab);
	}

	/** Value-change dispatch for the search result list (any tab's setting). */
	#onSearchSettingChange(path: SettingPath, newValue: string): void {
		const def = getSettingDef(path);
		if (!def) return;
		if (def.type === "boolean") {
			const boolValue = newValue === "true";
			settings.set(path, boolValue as never);
			this.callbacks.onChange(path, boolValue);
		} else if (def.type === "enum") {
			settings.set(path, newValue as never);
			this.callbacks.onChange(path, newValue);
		}
		// Submenu/text types already persisted inside their own done callbacks.
		if (def.tab === "appearance") {
			this.#triggerStatusLinePreview();
		}
		// Values feed the searchable text and condition gates may have flipped:
		// recompute results in place (selection is preserved by item id).
		this.#setSearchQuery(this.#searchQuery);
	}

	/**
	 * Convert a setting definition to a SettingItem for the UI.
	 */
	#defToItem(def: SettingDef): SettingItem | null {
		// Check condition: applies to every variant — booleans, enums, submenus, text inputs.
		if (def.condition && !def.condition()) {
			return null;
		}

		const currentValue = this.#getCurrentValue(def);
		const changed = this.#isChanged(def, currentValue);

		switch (def.type) {
			case "boolean":
				return {
					id: def.path,
					label: translatedLabel(def.path, def.label),
					description: translatedDescription(def.path, def.description),
					currentValue: currentValue ? "true" : "false",
					values: ["true", "false"],
					changed,
				};

			case "enum":
				return {
					id: def.path,
					label: translatedLabel(def.path, def.label),
					description: translatedDescription(def.path, def.description),
					currentValue: String(currentValue ?? ""),
					values: [...def.values],
					changed,
				};

			case "submenu":
				return {
					id: def.path,
					label: translatedLabel(def.path, def.label),
					description: translatedDescription(def.path, def.description),
					currentValue: this.#getSubmenuCurrentValue(def.path, currentValue),
					submenu: (cv, done) => this.#createSubmenu(def, cv, done),
					changed,
				};

			case "text":
				return {
					id: def.path,
					label: translatedLabel(def.path, def.label),
					description: translatedDescription(def.path, def.description),
					currentValue: this.#formatTextInputValue(def, currentValue),
					submenu: (cv, done) => this.#createTextInput(def, cv, done),
					changed,
				};

			case "providerLimits":
				return {
					id: def.path,
					label: translatedLabel(def.path, def.label),
					description: translatedDescription(def.path, def.description),
					currentValue: this.#formatProviderLimitsValue(currentValue),
					submenu: (_cv, done) => this.#createProviderLimitsInput(done),
					changed,
				};

			case "multiselect":
				return {
					id: def.path,
					label: translatedLabel(def.path, def.label),
					description: translatedDescription(def.path, def.description),
					currentValue: this.#formatMultiSelectValue(def, currentValue),
					submenu: (_cv, done) => this.#createMultiSelect(def, done),
					changed,
				};
		}
	}

	/**
	 * Get the current value for a setting.
	 */
	#getCurrentValue(def: SettingDef): unknown {
		return settings.get(def.path);
	}

	#isChanged(def: SettingDef, currentValue: unknown): boolean {
		const defaultValue: unknown = getDefault(def.path);
		if (Array.isArray(currentValue) && Array.isArray(defaultValue)) {
			return (
				currentValue.length !== defaultValue.length ||
				currentValue.some((entry, index) => entry !== defaultValue[index])
			);
		}
		return !Object.is(currentValue, defaultValue);
	}

	#getSubmenuCurrentValue(path: SettingPath, value: unknown): string {
		const rawValue = String(value ?? "");
		if (path === "compaction.thresholdPercent" && (rawValue === "-1" || rawValue === "")) {
			return "default";
		}
		if (path === "compaction.thresholdTokens" && (rawValue === "-1" || rawValue === "")) {
			return "default";
		}
		return rawValue;
	}

	/**
	 * Create a submenu for a submenu-type setting.
	 */
	#createSubmenu(
		def: SettingDef & { type: "submenu" },
		currentValue: string,
		done: (value?: string) => void,
	): Container {
		let options = translatedOptions(def.path, def.options);

		// Special case: inject runtime options for thinking level
		if (def.path === "defaultThinkingLevel") {
			// Prepend `auto`; the rest are the model's runtime-supported efforts.
			const levels: ConfiguredThinkingLevel[] = [AUTO_THINKING, ...this.context.availableThinkingLevels];
			options = levels.map(level => {
				const baseOpt = options.find(o => o.value === level);
				return baseOpt || { value: level, label: level };
			});
		} else if (def.path === "theme.dark" || def.path === "theme.light") {
			options = this.context.availableThemes.map(t => ({ value: t, label: t }));
		}

		// Preview handlers
		let onPreview: ((value: string) => void | Promise<void>) | undefined;
		let onPreviewCancel: (() => void) | undefined;
		let footer: Component | undefined;

		const activeThemeBeforePreview = getCurrentThemeName() ?? currentValue;
		if (def.path === "theme.dark" || def.path === "theme.light") {
			onPreview = value => {
				return this.callbacks.onThemePreview?.(value);
			};
			onPreviewCancel = () => {
				this.callbacks.onThemePreview?.(activeThemeBeforePreview);
			};
		} else if (def.path === "statusLine.preset") {
			onPreview = value => {
				const presetDef = getPreset(
					value as "default" | "minimal" | "compact" | "full" | "nerd" | "ascii" | "custom",
				);
				this.callbacks.onStatusLinePreview?.({
					preset: value as StatusLinePreset,
					leftSegments: presetDef.leftSegments,
					rightSegments: presetDef.rightSegments,
					separator: presetDef.separator,
				});
			};
			onPreviewCancel = () => {
				const currentPreset = settings.get("statusLine.preset");
				const presetDef = getPreset(currentPreset);
				this.callbacks.onStatusLinePreview?.({
					preset: currentPreset,
					leftSegments: presetDef.leftSegments,
					rightSegments: presetDef.rightSegments,
					separator: presetDef.separator,
				});
			};
		} else if (def.path === "statusLine.separator") {
			onPreview = value => {
				this.callbacks.onStatusLinePreview?.({ separator: value as StatusLineSeparatorStyle });
			};
			onPreviewCancel = () => {
				const separator = settings.get("statusLine.separator");
				this.callbacks.onStatusLinePreview?.({ separator });
			};
		} else if (def.path === "snapcompact.shape") {
			const shapePreview = new SnapcompactShapePreview(currentValue, {
				model: this.context.model,
				imageBudget: this.context.imageBudget,
				requestRender: this.context.requestRender,
			});
			onPreview = value => shapePreview.setValue(value);
			footer = shapePreview;
		}

		// Provide status line preview for theme selection
		const isThemeSetting = def.path === "theme.dark" || def.path === "theme.light";
		const getPreview = isThemeSetting ? this.callbacks.getStatusLinePreview : undefined;

		return new SelectSubmenu(
			translatedLabel(def.path, def.label),
			translatedDescription(def.path, def.description),
			options,
			currentValue,
			value => {
				this.#setSettingValue(def.path, value);
				this.callbacks.onChange(def.path, value);
				done(value);
			},
			() => {
				onPreviewCancel?.();
				done();
			},
			onPreview,
			getPreview,
			footer,
		);
	}

	/**
	 * Create a text input submenu for a plain string setting.
	 */
	#createTextInput(
		def: SettingDef & { type: "text" },
		_currentValue: string,
		done: (value?: string) => void,
	): Container {
		this.#textInputActive = true;
		const wrappedDone = (value?: string) => {
			this.#textInputActive = false;
			done(value);
		};
		return new TextInputSubmenu(
			translatedLabel(def.path, def.label),
			translatedDescription(def.path, def.description),
			this.#formatTextInputEditValue(def.path, settings.get(def.path)),
			def.secret,
			value => {
				// Empty string clears the setting; undefined-typed string settings
				// store "" which the browser.ts expandPath ignores (no-op fallback).
				this.#setSettingValue(def.path, value);
				this.callbacks.onChange(def.path, settings.get(def.path));
				wrappedDone(this.#formatTextInputValue(def, settings.get(def.path)));
			},
			() => wrappedDone(),
		);
	}

	#createProviderLimitsInput(done: (value?: string) => void): Container {
		return new ProviderLimitsSubmenu(
			this.context.providers,
			value => {
				this.callbacks.onChange("providers.maxInFlightRequests", value);
				done(this.#formatProviderLimitsValue(value));
			},
			() => done(),
			this.context.requestRender,
		);
	}

	#formatProviderLimitsValue(value: unknown): string {
		const limits = normalizeProviderMaxInFlightRequests(value);
		const entries = Object.entries(limits).sort(([a], [b]) => a.localeCompare(b));
		if (entries.length === 0) return t("Unlimited");
		return entries.map(([provider, limit]) => `${provider}: ${limit}`).join(", ");
	}

	#createMultiSelect(def: SettingDef & { type: "multiselect" }, done: (value?: string) => void): Container {
		let options = translatedOptions(def.path, def.options);
		if (def.path === "providers.webSearchOrder") {
			const excluded: unknown = settings.get("providers.webSearchExclude");
			if (Array.isArray(excluded)) {
				options = options.filter(option => !excluded.includes(option.value));
			}
		}

		const current: unknown = settings.get(def.path);
		const initial = Array.isArray(current)
			? current.filter((entry): entry is string => typeof entry === "string")
			: [];
		return new MultiSelectSubmenu(
			translatedLabel(def.path, def.label),
			translatedDescription(def.path, def.description),
			options,
			initial,
			def.ordered,
			value => {
				settings.set(def.path, value as never);
				this.callbacks.onChange(def.path, value);
			},
			() => done(this.#formatMultiSelectValue(def, settings.get(def.path))),
		);
	}

	#formatMultiSelectValue(def: SettingDef & { type: "multiselect" }, value: unknown): string {
		const ids = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
		if (ids.length === 0) return def.ordered ? "default" : "none";
		const labels = ids.map(
			id => translatedOptions(def.path, def.options).find(option => option.value === id)?.label ?? id,
		);
		return def.ordered ? labels.join(" → ") : labels.join(", ");
	}

	#formatTextInputValue(def: SettingDef & { type: "text" }, value: unknown): string {
		if (def.secret) return value ? "••••••••" : "";
		return this.#formatTextInputEditValue(def.path, value);
	}

	#formatTextInputEditValue(_path: SettingPath, value: unknown): string {
		if (value === undefined || value === null) return "";
		if (typeof value === "object") return JSON.stringify(value);
		return String(value);
	}

	/**
	 * Set a setting value, handling type conversion.
	 */
	#setSettingValue(path: SettingPath, value: string): void {
		const currentValue = settings.get(path);
		const schemaType = getType(path);
		if (path === "compaction.thresholdPercent" && value === "default") {
			settings.set(path, -1 as never);
		} else if (path === "compaction.thresholdTokens" && value === "default") {
			settings.set(path, -1 as never);
		} else if (schemaType === "record") {
			let parsed: unknown;
			try {
				parsed = JSON.parse(value || "{}");
			} catch {
				throw new Error(t("Invalid record JSON for {path}", { path }));
			}
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error(t("Invalid record JSON for {path}", { path }));
			}
			if (path === "providers.maxInFlightRequests") {
				parsed = validateProviderMaxInFlightRequests(parsed);
			}
			settings.set(path, parsed as never);
		} else if (typeof currentValue === "number") {
			settings.set(path, Number(value) as never);
		} else if (typeof currentValue === "boolean") {
			settings.set(path, (value === "true") as never);
		} else {
			settings.set(path, value as never);
		}
		// Applying the Language setting re-pins the locale immediately so the
		// panel and the rest of the UI switch languages without a restart.
		if (path === "display.language") setLocale(value);
	}

	/**
	 * Show a settings tab using definitions.
	 */
	#showSettingsTab(tabId: SettingTab): void {
		const defs = getSettingsForTab(tabId);

		const items = this.#buildItemsForDefs(defs);
		// Mirror SettingsList's section detection (leading ungrouped items form
		// an implicit section) so the footer hint only advertises PgUp/PgDn
		// when the jump actually changes sections.
		const sectionCount = items.filter(item => item.heading).length + (items.length > 0 && !items[0].heading ? 1 : 0);
		this.#hasSectionJump = sectionCount >= 2;

		this.#currentList = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				const def = defs.find(d => d.path === id);
				if (!def) return;

				const path = def.path;

				if (def.type === "boolean") {
					const boolValue = newValue === "true";
					settings.set(path, boolValue as never);
					this.callbacks.onChange(path, boolValue);

					if (tabId === "appearance") {
						this.#triggerStatusLinePreview();
					}
				} else if (def.type === "enum") {
					settings.set(path, newValue as never);
					this.callbacks.onChange(path, newValue);
				}
				// Submenu/text types already persisted the value inside their own
				// done callbacks before SettingsList re-dispatches here. Re-run the
				// definition-to-item mapping so condition-gated settings (e.g. the
				// Hindsight cluster guarded by memory.backend) appear/disappear
				// immediately instead of waiting for the next tab switch.
				this.#refreshCurrentTabItems(defs);
			},
			() => this.callbacks.onCancel(),
			// The selector owns type-to-search and the footer hint; pin the
			// split sidebar width so the divider never jumps between tabs.
			{ typeToSearch: false, hint: "", sidebarWidth: settingsSidebarWidth() },
		);
	}

	/**
	 * Map a definition list to UI items, dropping any whose condition is false.
	 * Inserts a heading row whenever the (group-sorted) definition list crosses
	 * into a new group; groups whose items are all condition-hidden emit none.
	 */
	#buildItemsForDefs(defs: SettingDef[]): SettingItem[] {
		const items: SettingItem[] = [];
		let lastGroup: string | undefined;
		for (const def of defs) {
			const item = this.#defToItem(def);
			if (!item) continue;
			if (def.group && def.group !== lastGroup) {
				items.push({ id: `__heading:${def.group}`, label: groupLabel(def.group), currentValue: "", heading: true });
				lastGroup = def.group;
			}
			items.push(item);
		}
		return items;
	}

	/** Re-evaluate condition gates against the current settings and refresh the active list. */
	#refreshCurrentTabItems(defs: SettingDef[]): void {
		if (this.#currentTabId === "plugins" || !this.#currentList) return;
		this.#currentList.setItems(this.#buildItemsForDefs(defs));
	}

	/**
	 * Get the status line preview string.
	 */
	#getStatusPreviewString(): string {
		if (this.callbacks.getStatusLinePreview) {
			return this.callbacks.getStatusLinePreview();
		}
		return theme.fg("dim", t("(preview not available)"));
	}

	/**
	 * Trigger status line preview with current settings.
	 */
	#triggerStatusLinePreview(): void {
		const statusLineSettings: StatusLinePreviewSettings = {
			preset: settings.get("statusLine.preset"),
			leftSegments: settings.get("statusLine.leftSegments"),
			rightSegments: settings.get("statusLine.rightSegments"),
			separator: settings.get("statusLine.separator"),
			sessionAccent: settings.get("statusLine.sessionAccent"),
			transparent: settings.get("statusLine.transparent"),
		};
		this.callbacks.onStatusLinePreview?.(statusLineSettings);
	}

	#showPluginsTab(): void {
		this.#pluginComponent = new PluginSettingsComponent(this.context.cwd, {
			onClose: () => this.callbacks.onCancel(),
			onPluginChanged: () => this.callbacks.onPluginsChanged?.(),
		});
	}

	handleInput(data: string): void {
		// SGR mouse reports (the fullscreen overlay enables tracking).
		if (data.startsWith("\x1b[<")) {
			this.#handleMouse(data);
			return;
		}

		// Text-input submenus take every byte: arrow keys must reach the
		// cursor and Tab must not switch tabs.
		if (this.#textInputActive) {
			(this.#searchList ?? this.#currentList)?.handleInput(data);
			return;
		}

		const activeList = this.#searchList ?? this.#currentList;

		// An open submenu owns input entirely — Tab/arrows/typing belong to it.
		if (activeList?.hasOpenSubmenu()) {
			activeList.handleInput(data);
			return;
		}

		if (this.#searchList) {
			this.#handleSearchModeInput(data, this.#searchList);
			return;
		}

		// Tab toggles keyboard focus between section headings and setting rows
		// (fast section hopping); tabs without sections keep Tab switching tabs.
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			if (this.#currentList?.hasSectionFocusTargets()) {
				this.#currentList.toggleSectionFocus();
				return;
			}
			this.#tabBar.handleInput(data);
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "right")) {
			this.#tabBar.handleInput(data);
			return;
		}

		// Printable characters start a search across every settings tab. The
		// plugins tab keeps its own local filtering instead.
		if (this.#currentTabId !== "plugins") {
			const printable = extractPrintableText(data);
			if (printable !== undefined && printable.trim().length > 0) {
				this.#startSearch(printable);
				return;
			}
		}

		if (this.#currentList) {
			this.#currentList.handleInput(data);
		} else if (this.#pluginComponent) {
			this.#pluginComponent.handleInput(data);
		}
	}

	#handleSearchModeInput(data: string, list: SettingsList): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			// Exit search, landing on the tab of the selected result.
			this.#endSearch(true);
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			// Jump between tabs that have matches (muted tabs are skipped).
			this.#tabBar.handleInput(data);
			return;
		}
		// Selection, paging, and activation stay with the result list.
		if (
			kb.matches(data, "tui.select.up") ||
			kb.matches(data, "tui.select.down") ||
			kb.matches(data, "tui.select.pageUp") ||
			kb.matches(data, "tui.select.pageDown") ||
			kb.matches(data, "tui.select.confirm") ||
			data === "\n"
		) {
			list.handleInput(data);
			return;
		}
		// Everything else edits the query like a regular single-line editor:
		// cursor movement, word ops, kill ring, undo, paste.
		this.#searchInput.handleInput(data);
		const value = this.#searchInput.getValue();
		if (value !== this.#searchQuery) this.#setSearchQuery(value);
	}
}
