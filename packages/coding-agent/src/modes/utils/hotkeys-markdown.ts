import { type AppKeybinding, type KeybindingsManager, keyHintPlatform, modifierLabel } from "../../config/keybindings";
import { t } from "../../i18n";

export interface HotkeysMarkdownBindings {
	keybindings: Pick<KeybindingsManager, "getDisplayString">;
}

function appKey(bindings: HotkeysMarkdownBindings, action: AppKeybinding): string {
	return bindings.keybindings.getDisplayString(action) || "Disabled";
}

export function buildHotkeysMarkdown(bindings: HotkeysMarkdownBindings): string {
	const platform = keyHintPlatform();
	const isMac = platform === "darwin";
	const alt = modifierLabel("alt", platform);
	const cmd = modifierLabel("super", platform);
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
		`| \`${appKey(bindings, "app.clipboard.copyLine")}\` | ${t("Copy current line")} |`,
		`| \`${appKey(bindings, "app.clipboard.copyPrompt")}\` | ${t("Copy whole prompt")} |`,
		"",
		t("**Other**"),
		t("| Key | Action |"),
		"|-----|--------|",
		t("| `Tab` | Path completion / accept autocomplete |"),
		`| \`${appKey(bindings, "app.interrupt")}\` | ${t("Cancel autocomplete / interrupt active work")} |`,
		`| \`${appKey(bindings, "app.clear")}\` | ${t("Clear editor (first) / exit (second)")} |`,
		`| \`${appKey(bindings, "app.exit")}\` | ${t("Exit (saves current prompt as draft)")} |`,
		`| \`${appKey(bindings, "app.suspend")}\` | ${t("Suspend to background")} |`,
		`| \`${appKey(bindings, "app.display.reset")}\` | ${t("Reset terminal display")} |`,
		`| \`${appKey(bindings, "app.thinking.cycle")}\` | ${t("Cycle thinking level")} |`,
		`| \`${appKey(bindings, "app.model.cycleForward")}\` | ${t("Cycle role models (slow/default/smol)")} |`,
		`| \`${appKey(bindings, "app.model.cycleBackward")}\` | ${t("Cycle role models (backward)")} |`,
		`| \`${appKey(bindings, "app.model.selectTemporary")}\` | ${t("Select model (temporary)")} |`,
		`| \`${appKey(bindings, "app.model.select")}\` | ${t("Select model (set roles)")} |`,
		`| \`${appKey(bindings, "app.plan.toggle")}\` | ${t("Toggle plan mode")} |`,
		`| \`${appKey(bindings, "app.history.search")}\` | ${t("Search prompt history")} |`,
		`| \`${appKey(bindings, "app.tools.expand")}\` | ${t("Toggle tool output expansion")} |`,
		`| \`${appKey(bindings, "app.completedRuns.toggle")}\` | ${t("Toggle completed run collapse")} |`,
		`| \`${appKey(bindings, "app.tools.toggleVisibility")}\` | ${t("Toggle tool activity visibility")} |`,
		`| \`${appKey(bindings, "app.tools.foldRows")}\` | ${t("Fold tool rows into one-line summaries")} |`,
		`| \`${appKey(bindings, "app.thinking.toggle")}\` | ${t("Toggle thinking block visibility")} |`,
		`| \`${appKey(bindings, "app.editor.external")}\` | ${t("Edit message in external editor")} |`,
		`| \`${appKey(bindings, "app.retry")}\` | ${t("Retry last failed assistant turn")} |`,
		`| \`${appKey(bindings, "app.clipboard.pasteImage")}\` | ${t("Paste image or text from clipboard")} |`,
		`| Hold \`Space\` | ${t("Speech-to-text (push-to-talk): hold to record, release to transcribe")} |`,
		`| \`${appKey(bindings, "app.live.toggle")}\` | ${t("Start/stop live voice mode (/live)")} |`,
		`| \`${appKey(bindings, "app.agents.hub")}\` / \`${appKey(bindings, "app.session.observe")}\` / double-tap \`←\` (empty editor) | ${t("Open the agent hub")} |`,
		`| \`${appKey(bindings, "app.jobs.hub")}\` | ${t("Open the background jobs hub")} |`,
		t("| `#<number>` | GitHub issue/PR reference (e.g. `#3164` → `pr://`/`issue://`) |"),
		t("| `#` / `#<text>` | Prompt actions (copy / undo / move cursor) |"),
		t("| `/` | Slash commands |"),
		t("| `!` | Run bash command |"),
		t("| `!!` | Run bash command (excluded from context) |"),
		t("| `$` | Run Python in shared kernel |"),
		t("| `$$` | Run Python (excluded from context) |"),
	].join("\n");
}
