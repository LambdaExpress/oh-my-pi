import { Box, Container, Spacer, Text } from "@oh-my-pi/pi-tui";
import { t } from "../../i18n";
import { theme } from "../../modes/theme/theme";
import type { TodoItem } from "../../tools/todo";
import { truncateToWidth } from "../../tools/render-utils";

/**
 * Component that renders a todo completion reminder notification, committed into
 * the transcript like a TTSR notification so it stays anchored in history rather
 * than floating above the editor.
 * Shows when the agent stops with incomplete todos.
 */
export class TodoReminderComponent extends Container {
	#box: Box;
	#toolActivityVisible = true;
	// `display.foldToolRows`: one `Reminder:` row instead of the yellow panel.
	#toolRowsFolded = false;

	constructor(
		private readonly todos: TodoItem[],
		private readonly attempt: number,
		private readonly maxAttempts: number,
	) {
		super();

		this.addChild(new Spacer(1));

		this.#box = new Box(1, 1, t => theme.inverse(theme.fg("warning", t)));
		this.#box.setIgnoreTight(true);
		this.addChild(this.#box);

		this.#rebuild();
	}

	setToolActivityVisible(visible: boolean): void {
		if (this.#toolActivityVisible === visible) return;
		this.#toolActivityVisible = visible;
		this.invalidate();
	}

	/**
	 * Fold the reminder into one activity row (`display.foldToolRows`), matching
	 * how every other transcript activity row reads while the transcript is
	 * folded. Unfolding restores the full task list.
	 */
	setToolRowsFolded(folded: boolean): void {
		if (this.#toolRowsFolded === folded) return;
		this.#toolRowsFolded = folded;
		this.invalidate();
	}

	override render(width: number): readonly string[] {
		if (!this.#toolActivityVisible) return [];
		if (this.#toolRowsFolded) return [this.#foldedRow(width)];
		return super.render(width);
	}

	/** `Reminder: <first task> (+N more)`, truncated to the row's width. */
	#foldedRow(width: number): string {
		const label = theme.fg("warning", theme.bold(t("Reminder")));
		const count = this.todos.length;
		const first = this.todos[0]?.content?.replace(/\s+/g, " ").trim();
		const detail = first
			? `${theme.fg("muted", first)}${count > 1 ? theme.fg("dim", ` (+${count - 1} more)`) : ""}`
			: theme.fg("muted", t("{count} incomplete {label}", { count, label: count === 1 ? t("todo") : t("todos") }));
		return truncateToWidth(` ${label}${theme.fg("dim", ":")} ${detail}`, width);
	}

	#rebuild(): void {
		this.#box.clear();

		const count = this.todos.length;
		const label = count === 1 ? t("todo") : t("todos");
		const header = `${theme.icon.warning} ${t("{count} incomplete {label} - reminder {attempt}/{maxAttempts}", {
			count,
			label,
			attempt: this.attempt,
			maxAttempts: this.maxAttempts,
		})}`;

		this.#box.addChild(new Text(header, 0, 0));
		this.#box.addChild(new Spacer(1));

		const todoList = this.todos.map(todo => `  ${theme.checkbox.unchecked} ${todo.content}`).join("\n");
		this.#box.addChild(new Text(theme.italic(todoList), 0, 0));
	}
}
