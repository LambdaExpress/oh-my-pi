import { MessageNoticeComponent } from "../chrome/message-notice";
import { Text } from "../components/text";
import { t } from "../i18n";
import { Container } from "../tui";
import { theme } from "../theme";
import { type TodoItem, todoChecklistPhases } from "../tools/todo";
import { truncateToWidth } from "../utils";
import { node, span, text, withHidden } from "../native/describe";
import type { DescribeContext, NativeNode } from "../native/node";
import { styledSpans } from "../native/spans";

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
	readonly #note: string;
	#toolActivityVisible = true;
	// `display.foldToolRows`: one `Reminder:` row instead of the yellow panel.
	#toolRowsFolded = false;

	constructor(todos: TodoItem[], attempt: number, maxAttempts: number) {
		super();
		this.#todos = todos;
		this.#note = t("reminder {attempt}/{maxAttempts}", { attempt, maxAttempts });
		const header = () => {
			const count = this.#todos.length;
			return t("{count} incomplete {label} - reminder {attempt}/{maxAttempts}", {
				count,
				label: count === 1 ? t("todo") : t("todos"),
				attempt,
				maxAttempts,
			});
		};
		this.#notice = new MessageNoticeComponent({
			presentation: () => {
				const todoList = this.#todos.map(todo => `  ${theme.checkbox.unchecked} ${todo.content}`).join("\n");
				return { icon: theme.icon.warning, header: header(), body: new Text(theme.italic(todoList), 0, 0) };
			},
			nativePresentation: () => ({
				head: [span(`${theme.icon.warning} ${header()}`)],
				body: [
					node(
						"list",
						{},
						todos.map((todo, index) =>
							node("item", { label: [span(todo.content, "em")], tone: "pending" }, [], `t${index}`),
						),
					),
				],
			}),
			role: "omp.notice.todo",
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

	/** A `checklist` reminder of the open items where the terminal lists the kind (§7.5); else the notice card. */
	override describe(cx?: DescribeContext): NativeNode {
		if (this.#toolRowsFolded) {
			return withHidden(
				text(styledSpans(this.#foldedRow(Number.POSITIVE_INFINITY)), {
					role: "omp.notice.todo",
					lines: 1,
					wrap: "none",
					truncate: "end",
				}),
				!this.#toolActivityVisible,
			);
		}
		if (cx?.supports("checklist") !== true) return this.#notice.describe();
		const phases = todoChecklistPhases([{ name: "", tasks: this.#todos }]);
		return withHidden(
			node("checklist", { mode: "reminder", phases, note: this.#note, role: "omp.notice.todo" }),
			!this.#toolActivityVisible,
		);
	}
}
