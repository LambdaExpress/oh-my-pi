import {
	type AppKeybinding,
	formatKeyHints,
	type KeybindingsManager,
	keyHintPlatform,
	modifierLabel,
} from "./app-keybindings";
import { t } from "./i18n";
import { canonicalKeyId } from "./keybindings";

/** Effective keybinding operations used to render the hotkey reference. */
export interface HotkeysMarkdownBindings {
	keybindings: Pick<KeybindingsManager, "getDisplayString" | "getKeys" | "matchesCanonical">;
}

function hotkeyLabel(bindings: HotkeysMarkdownBindings, action: AppKeybinding): string {
	return bindings.keybindings.getDisplayString(action) || "Disabled";
}

/** Build the platform-aware Markdown reference for effective application hotkeys. */
export function buildHotkeysMarkdown(bindings: HotkeysMarkdownBindings): string {
	const platform = keyHintPlatform();
	const isMac = platform === "darwin";
	const alt = modifierLabel("alt", platform);
	const cmd = modifierLabel("super", platform);
	// CustomEditor tests the chord that was actually pressed, so exit keys split by role: a key
	// that also carries tui.editor.deleteCharForward (the readline `^D` overlap) forward-deletes
	// while the prompt holds a draft, any other exit key quits immediately. Mixed bindings such as
	// `["ctrl+d", "ctrl+q"]` therefore get one row per behavior instead of a single row claiming
	// both keys delete.
	const exitKeys = bindings.keybindings.getKeys("app.exit");
	const deletingExitKeys = exitKeys.filter(key =>
		bindings.keybindings.matchesCanonical(canonicalKeyId(key), "tui.editor.deleteCharForward"),
	);
	const quittingExitKeys = exitKeys.filter(
		key => !bindings.keybindings.matchesCanonical(canonicalKeyId(key), "tui.editor.deleteCharForward"),
	);
	const exitRows: string[] = [];
	if (deletingExitKeys.length > 0) {
		exitRows.push(
			`| \`${formatKeyHints(deletingExitKeys)}\` | Delete char forward (with draft) / exit (empty prompt) |`,
		);
	}
	// An unbound exit action still gets its row, mirroring the `Disabled` hint every other row uses.
	if (quittingExitKeys.length > 0 || deletingExitKeys.length === 0) {
		exitRows.push(`| \`${formatKeyHints(quittingExitKeys) || "Disabled"}\` | Exit |`);
	}
	return [
		t("**Navigation**"),
		t("| Key | Action |"),
		"|-----|--------|",
		t("| `Arrow keys` | Move cursor / browse history (Up when empty) |"),
		`| \`${alt}+Left/Right\` | ${t("Move by word")} |`,
		isMac
			? `| \`Ctrl+A\` / \`Home\` / \`${cmd}+Left\` | ${t("Start of line")} |`
			: t("| `Ctrl+A` / `Home` | Start of line |"),
		isMac
			? `| \`Ctrl+E\` / \`End\` / \`${cmd}+Right\` | ${t("End of line")} |`
			: t("| `Ctrl+E` / `End` | End of line |"),
		"",
		t("**Editing**"),
		t("| Key | Action |"),
		"|-----|--------|",
		t("| `Enter` | Send message |"),
		`| \`Shift+Enter\` / \`${alt}+Enter\` | ${t("New line")} |`,
		`| \`Ctrl+W\` / \`${alt}+Backspace\` | ${t("Delete word backwards")} |`,
		t("| `Ctrl+U` | Delete to start of line |"),
		t("| `Ctrl+K` | Delete to end of line |"),
		`| \`${hotkeyLabel(bindings, "app.clipboard.copyLine")}\` | ${t("Copy current line")} |`,
		`| \`${hotkeyLabel(bindings, "app.clipboard.copyPrompt")}\` | ${t("Copy whole prompt")} |`,
		"",
		t("**Other**"),
		t("| Key | Action |"),
		"|-----|--------|",
		t("| `Tab` | Path completion / accept autocomplete |"),
		`| \`${hotkeyLabel(bindings, "app.interrupt")}\` | ${t("Cancel autocomplete / interrupt active work")} |`,
		`| \`${hotkeyLabel(bindings, "app.clear")}\` | ${t("Clear editor (first) / exit (second)")} |`,
		...exitRows,
		`| \`${hotkeyLabel(bindings, "app.suspend")}\` | ${t("Suspend to background")} |`,
		`| \`${hotkeyLabel(bindings, "app.display.reset")}\` | ${t("Reset terminal display")} |`,
		`| \`${hotkeyLabel(bindings, "app.thinking.cycle")}\` | ${t("Cycle thinking level")} |`,
		`| \`${hotkeyLabel(bindings, "app.model.cycleForward")}\` | ${t("Cycle role models (slow/default/smol)")} |`,
		`| \`${hotkeyLabel(bindings, "app.model.cycleBackward")}\` | ${t("Cycle role models (backward)")} |`,
		`| \`${hotkeyLabel(bindings, "app.model.selectTemporary")}\` | ${t("Select model (temporary)")} |`,
		`| \`${hotkeyLabel(bindings, "app.model.select")}\` | ${t("Select model (set roles)")} |`,
		`| \`${hotkeyLabel(bindings, "app.plan.toggle")}\` | ${t("Toggle plan mode")} |`,
		`| \`${hotkeyLabel(bindings, "app.history.search")}\` | ${t("Search prompt history")} |`,
		`| \`${hotkeyLabel(bindings, "app.tools.expand")}\` | ${t("Toggle tool output expansion")} |`,
		`| \`${hotkeyLabel(bindings, "app.completedRuns.toggle")}\` | ${t("Toggle completed run collapse")} |`,
		`| \`${hotkeyLabel(bindings, "app.tools.toggleVisibility")}\` | ${t("Toggle tool activity visibility")} |`,
		`| \`${hotkeyLabel(bindings, "app.tools.foldRows")}\` | ${t("Fold tool rows into one-line summaries")} |`,
		`| \`${hotkeyLabel(bindings, "app.thinking.toggle")}\` | ${t("Toggle thinking block visibility")} |`,
		`| \`${hotkeyLabel(bindings, "app.editor.external")}\` | ${t("Edit message in external editor")} |`,
		`| \`${hotkeyLabel(bindings, "app.retry")}\` | ${t("Retry last failed assistant turn")} |`,
		`| \`${hotkeyLabel(bindings, "app.clipboard.pasteImage")}\` | ${t("Paste image or text from clipboard")} |`,
		`| Hold \`Space\` | ${t("Speech-to-text (push-to-talk): hold to record, release to transcribe")} |`,
		`| \`${hotkeyLabel(bindings, "app.live.toggle")}\` | ${t("Start/stop live voice mode (/live)")} |`,
		`| \`${hotkeyLabel(bindings, "app.agents.hub")}\` / \`${hotkeyLabel(bindings, "app.session.observe")}\` / double-tap \`←\` (empty editor) | ${t("Open the agent hub")} |`,
		`| \`${hotkeyLabel(bindings, "app.jobs.hub")}\` | ${t("Open the background jobs hub")} |`,
		t("| `#<number>` | GitHub issue/PR reference (e.g. `#3164` → `pr://`/`issue://`) |"),
		t("| `#` / `#<text>` | Prompt actions (copy / undo / move cursor) |"),
		t("| `/` | Slash commands |"),
		t("| `!` | Run bash command |"),
		t("| `!!` | Run bash command (excluded from context) |"),
		t("| `$` | Run Python in shared kernel |"),
		t("| `$$` | Run Python (excluded from context) |"),
	].join("\n");
}
