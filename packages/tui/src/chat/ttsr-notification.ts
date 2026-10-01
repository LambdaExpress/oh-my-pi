import { Text } from "../components/text";
import { type Component, Container } from "../tui";
import {
	MessageNoticeComponent,
	type MessageNoticeNativePresentation,
	type MessageNoticePresentation,
} from "../chrome/message-notice";
import { t } from "../i18n";
import { theme } from "../theme";
import { truncateToWidth } from "../utils";
import { expandKeyHint } from "../render/render-utils";
import { span, text, withHidden } from "../native/describe";
import type { DescribeContext, NativeNode } from "../native/node";
import { styledSpans } from "../native/spans";

/** Rule fields shown in rewind notifications. */
export interface NotificationRule {
	name: string;
	description?: string;
	content?: string;
	/**
	 * Rule provenance, when the host tracks it. Bundled default rules carry
	 * English summaries that the locale catalog translates; every other rule
	 * keeps the text its author wrote.
	 */
	_source?: { provider?: string };
}

/** Provider id the host stamps on the default rules it ships. */
const BUILTIN_DEFAULTS_PROVIDER_ID = "builtin-defaults";

/** Collapsed view shows at most this many rules before eliding the rest. */
const MAX_COLLAPSED_RULES = 4;

function displayRuleDescription(rule: NotificationRule): string | undefined {
	const description = (rule.description || rule.content)?.trim();
	if (!description) return undefined;
	return rule._source?.provider === BUILTIN_DEFAULTS_PROVIDER_ID ? t(description) : description;
}

/**
 * Component that renders a TTSR (Time Traveling Stream Rules) notification.
 * Shows when a rule violation is detected and the stream is being rewound.
 * One block can carry several rules: a single event may match multiple rules,
 * and consecutive notifications merge into the previous block via
 * {@link addRules} while it is still the live transcript tail.
 */
export class TtsrNotificationComponent extends Container {
	#rules: NotificationRule[];
	#toolActivityVisible = true;
	// `display.foldToolRows`: one `TTSR:` row instead of the yellow banner.
	#toolRowsFolded = false;
	readonly #notice: MessageNoticeComponent;

	constructor(rules: NotificationRule[]) {
		super();
		this.#rules = [...rules];
		this.#notice = new MessageNoticeComponent({
			presentation: context => this.#presentation(context.expanded),
			nativePresentation: () => this.#nativePresentation(),
			role: "omp.notice.ttsr",
		});
		this.addChild(this.#notice);
	}

	setToolActivityVisible(visible: boolean): void {
		if (this.#toolActivityVisible === visible) return;
		this.#toolActivityVisible = visible;
		this.#notice.setToolActivityVisible(visible);
	}

	/**
	 * Fold the whole notice into one activity row (`display.foldToolRows`):
	 * `TTSR: <rules>` in place of the banner, so an injection reads like every
	 * other row in a folded transcript. Unfolding restores the banner with its
	 * descriptions.
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

	override describe(cx: DescribeContext): NativeNode | null {
		if (!this.#toolRowsFolded) return super.describe(cx);
		return withHidden(
			text(styledSpans(this.#foldedRow(Number.POSITIVE_INFINITY)), {
				role: "omp.notice.ttsr",
				lines: 1,
				wrap: "none",
				truncate: "end",
			}),
			!this.#toolActivityVisible,
		);
	}

	/** Merge additional rules into this block (deduped by rule name). */
	addRules(rules: NotificationRule[]): void {
		let changed = false;
		for (const rule of rules) {
			if (this.#rules.some(existing => existing.name === rule.name)) continue;
			this.#rules.push(rule);
			changed = true;
		}
		if (changed) this.#notice.refresh();
	}

	setExpanded(expanded: boolean): void {
		this.#notice.setExpanded(expanded);
	}

	isExpanded(): boolean {
		return this.#notice.isExpanded();
	}

	/**
	 * One row for the whole notice: rule name(s), plus the description when a
	 * single rule was injected. Warning-colored so an injection still stands out
	 * in a long run of folded activity rows.
	 */
	#foldedRow(width: number): string {
		const label = theme.fg("warning", theme.bold(t("TTSR")));
		const rules = this.#rules;
		let detail: string;
		if (rules.length === 1) {
			const rule = rules[0]!;
			const description = displayRuleDescription(rule)?.replace(/\s+/g, " ").trim();
			detail = description ? `${rule.name} — ${description}` : rule.name;
		} else {
			detail = t("{count} rules · {names}", {
				count: rules.length,
				names: rules.map(rule => rule.name).join(", "),
			});
		}
		return truncateToWidth(` ${label}${theme.fg("dim", ":")} ${theme.fg("muted", detail)}`, width);
	}

	/**
	 * An inline warning notice, "Rule applied: no-unwrap", with every rule's
	 * full description as the disclosure below it.
	 */
	#nativePresentation(): MessageNoticeNativePresentation {
		const single = this.#rules.length === 1 ? this.#rules[0] : undefined;
		const head = single
			? [span(t("Rule applied: "), "warning"), span(single.name, "mono strong")]
			: [
					span(t("{count} rules applied: ", { count: this.#rules.length }), "warning"),
					span(this.#rules.map(rule => rule.name).join(", "), "mono strong"),
				];
		const body: NativeNode[] = [];
		for (const rule of this.#rules) {
			const desc = displayRuleDescription(rule);
			if (single) {
				if (desc) body.push(text([span(desc, "em")], { wrap: "word", key: rule.name }));
				continue;
			}
			body.push(
				text(desc ? [span(rule.name, "strong"), span(": "), span(desc, "em")] : [span(rule.name, "strong")], {
					wrap: "word",
					key: rule.name,
				}),
			);
		}
		return { head, body, inline: { icon: "shield-alert" } };
	}

	#presentation(expanded: boolean): MessageNoticePresentation {
		// fg colors conflict with inverse, so styling inside the block is limited
		// to bold (names) and italic (descriptions).
		if (this.#rules.length === 1) {
			return this.#presentationSingle(this.#rules[0]!, expanded);
		}
		return this.#presentationMulti(expanded);
	}

	#presentationSingle(rule: NotificationRule, expanded: boolean): MessageNoticePresentation {
		const header = `${theme.icon.warning} ${t("Injecting rule: {name}", { name: theme.bold(rule.name) })}  ${theme.icon.rewind}`;

		const desc = displayRuleDescription(rule);
		if (!desc) return { icon: theme.icon.warning, header };

		let displayText = desc;
		let truncated = false;
		if (!expanded) {
			const lines = desc.split("\n");
			if (lines.length > 2) {
				displayText = `${lines.slice(0, 2).join("\n")}…`;
				truncated = true;
			}
		}

		const body: Component[] = [new Text(theme.italic(displayText), 0, 0)];
		if (truncated) {
			body.push(new Text(theme.italic(` ${t("({key} to expand)", { key: expandKeyHint() })}`), 0, 0));
		}
		return { icon: theme.icon.warning, header, body };
	}

	#presentationMulti(expanded: boolean): MessageNoticePresentation {
		const header = `${theme.icon.warning} ${t("Injecting {count} rules:", { count: this.#rules.length })}  ${theme.icon.rewind}`;

		const visible = expanded ? this.#rules : this.#rules.slice(0, MAX_COLLAPSED_RULES);
		const body: Component[] = [];
		let elidedDetail = false;
		for (const rule of visible) {
			const desc = displayRuleDescription(rule);
			let line = theme.bold(rule.name);
			if (desc) {
				let displayText = desc;
				if (!expanded) {
					// One line per rule when collapsed; full description when expanded.
					const newline = desc.indexOf("\n");
					if (newline !== -1) {
						displayText = `${desc.slice(0, newline).trimEnd()}…`;
						elidedDetail = true;
					}
				}
				line += `: ${theme.italic(displayText)}`;
			}
			body.push(new Text(line, 0, 0));
		}

		const hidden = this.#rules.length - visible.length;
		if (hidden > 0) {
			body.push(
				new Text(
					theme.italic(t("… +{count} more ({key} to expand)", { count: hidden, key: expandKeyHint() })),
					0,
					0,
				),
			);
		} else if (elidedDetail) {
			body.push(new Text(theme.italic(` ${t("({key} to expand)", { key: expandKeyHint() })}`), 0, 0));
		}
		return { icon: theme.icon.warning, header, body };
	}
}
