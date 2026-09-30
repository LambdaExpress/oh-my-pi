import { MessageNoticeComponent } from "../chrome/message-notice";
import { Text } from "../components/text";
import { t } from "../i18n";
import { Container } from "../tui";
import { theme } from "../theme";
import type { TodoItem } from "../tools/todo";
import { truncateToWidth } from "../utils";

const NO_ROWS: readonly string[] = [];

/**
 * Component that renders a todo completion reminder notification, committed into
 * the transcript like a TTSR notification so it stays anchored in history rather
 * than floating above the editor.
 * Shows when the agent stops with incomplete todos.
 */
export class TodoReminderComponent extends Container {
	readonly #notice: MessageNoticeComponent;
	readonly #todos: readonly TodoItem[];
	#toolActivityVisible = true;
	// `display.foldToolRows`: one `Reminder:` row instead of the yellow panel.
	#toolRowsFolded = false;

	constructor(todos: TodoItem[], attempt: number, maxAttempts: number) {
		super();
		this.#todos = todos;
		this.#notice = new MessageNoticeComponent({
			presentation: () => {
				const count = this.#todos.length;
				const label = count === 1 ? t("todo") : t("todos");
				const header = t("{count} incomplete {label} - reminder {attempt}/{maxAttempts}", {
					count,
					label,
					attempt,
					maxAttempts,
				});
				const todoList = this.#todos.map(todo => `  ${theme.checkbox.unchecked} ${todo.content}`).join("\n");
				return { icon: theme.icon.warning, header, body: new Text(theme.italic(todoList), 0, 0) };
			},
		});
		this.addChild(this.#notice);
	}

	setToolActivityVisible(visible: boolean): void {
		this.#toolActivityVisible = visible;
		this.#notice.setToolActivityVisible(visible);
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
		if (!this.#toolActivityVisible) return NO_ROWS;
		if (this.#toolRowsFolded) return [this.#foldedRow(width)];
		return super.render(width);
	}

	/** `Reminder: <first task> (+N more)`, truncated to the row's width. */
	#foldedRow(width: number): string {
		const label = theme.fg("warning", theme.bold(t("Reminder")));
		const count = this.#todos.length;
		const first = this.#todos[0]?.content?.replace(/\s+/g, " ").trim();
		const detail = first
			? `${theme.fg("muted", first)}${count > 1 ? theme.fg("dim", ` (+${count - 1} more)`) : ""}`
			: theme.fg("muted", t("{count} incomplete {label}", { count, label: count === 1 ? t("todo") : t("todos") }));
		return truncateToWidth(` ${label}${theme.fg("dim", ":")} ${detail}`, width);
	}
}
