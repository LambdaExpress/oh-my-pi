import { type SgrMouseEvent } from "../../mouse";
import { type SelectItem, SelectList } from "../../components/select-list";
import { Spacer } from "../../components/spacer";
import { Text } from "../../components/text";
import { WizardStep } from "../../components/wizard-step";
import { Container } from "../../tui";
import { truncateToWidth } from "../../utils";
import { SEARCH_PROVIDER_OPTIONS, type SearchProviderId } from "../../tools/web-search-types";
import { t } from "../../i18n";
import { getSelectListTheme, theme } from "../../theme/theme";
import { col, span, text } from "../../native/describe";
import { Memo } from "../../native/memo";
import type { NativeChild, NativeNode } from "../../native/node";
import type { SetupSceneHost, SetupTab, StyledLine } from "./types";

const MAX_VISIBLE = 8;

/** Reuse the shared provider options as the single source of truth for labels/descriptions. */
function webSearchItems(): SelectItem[] {
	return SEARCH_PROVIDER_OPTIONS.map(option => ({
		value: option.value,
		label: t(option.label),
		description: option.description ? t(option.description) : undefined,
	}));
}

type Availability = "checking" | boolean;

/**
 * "Web search" panel: picks the provider the web_search tool should prefer and
 * reports whether the highlighted provider is ready to use given current
 * credentials (env keys or OAuth sign-ins from the Sign in tab) or an
 * unauthenticated fallback.
 */
export class WebSearchTab implements SetupTab {
	readonly id = "web-search";
	readonly label = t("Web search");
	readonly modal = false;

	#list: SelectList;
	#availability = new Map<SearchProviderId, Availability>();
	#status: StyledLine[] = [];
	#disposed = false;
	#step: WizardStep | undefined;
	#native = new Memo();
	readonly #items = webSearchItems();

	readonly #host: SetupSceneHost;

	constructor(host: SetupSceneHost) {
		this.#host = host;
		this.#list = new SelectList(this.#items, MAX_VISIBLE, getSelectListTheme());
		const order = host.ctx.webSearchOrder;
		const current = Array.isArray(order) && typeof order[0] === "string" ? order[0] : "auto";
		const index = this.#items.findIndex(item => item.value === current);
		if (index >= 0) this.#list.setSelectedIndex(index);
		this.#list.onSelectionChange = item => this.#onHighlight(item.value);
		this.#list.onSelect = item => {
			void this.#apply(item.value);
		};
		this.#list.onCancel = () => host.finish("skipped");
	}

	onActivate(): void {
		// Auth may have changed in the Sign in tab; re-check from scratch.
		this.#availability.clear();
		this.#status = [];
		const selected = this.#list.getSelectedItem();
		if (selected) this.#onHighlight(selected.value);
		this.#host.requestRender();
	}

	handleInput(data: string): void {
		if (this.#step) this.#step.handleInput(data);
		else this.#list.handleInput(data);
	}

	/** Wheel moves the highlight; hover lights the row under the pointer; click confirms it. */
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		this.#step?.routeMouse(event, line, col);
	}

	invalidate(): void {
		this.#native.clear();
		this.#step?.invalidate();
		this.#list.invalidate();
	}

	dispose(): void {
		this.#disposed = true;
	}

	render(width: number, maxLines?: number): readonly string[] {
		const intro = new Text(theme.fg("muted", t("Choose the provider the web_search tool should prefer.")), 0, 0);
		const status = new Container();
		const selected = this.#list.getSelectedItem();
		if (selected) {
			for (const line of this.#readinessLines(selected.value)) {
				status.addChild(new Text(truncateToWidth(theme.fg(line.color, line.text), width), 0, 0));
			}
		}
		if (selected && this.#status.length > 0) status.addChild(new Spacer(1));
		for (const line of this.#status) {
			status.addChild(new Text(truncateToWidth(theme.fg(line.color, line.text), width), 0, 0));
		}
		if (!this.#step) {
			this.#step = new WizardStep({
				kind: "choice",
				intro,
				content: this.#list,
				status,
				minContentLines: 1,
				fitContent: budget => {
					// Above: hint + blank. Below: the list's own search-status row plus
					// blank + readiness line. Shrinking keeps the selection centered.
					const visible = budget === undefined ? MAX_VISIBLE : budget - 1;
					this.#list.setMaxVisible(Math.max(1, Math.min(MAX_VISIBLE, visible)));
				},
			});
		} else {
			this.#step.setIntro(intro);
			this.#step.setStatus(status);
		}
		this.#step.setMaxHeight(maxLines);
		return this.#step.render(width);
	}

	describe(): NativeNode {
		const selected = this.#list.getSelectedItem();
		const readiness = selected ? this.#availability.get(selected.value as SearchProviderId) : undefined;
		return this.#native.get([selected?.value, readiness, this.#status], () => {
			const children: NativeChild[] = [
				text([span(t("Choose the provider the web_search tool should prefer."), "muted")]),
				this.#list,
			];
			if (selected) {
				for (const line of this.#readinessLines(selected.value)) {
					children.push(text([span(line.text, line.color)]));
				}
			}
			if (this.#status.length > 0) {
				children.push(col(this.#status.map(line => text([span(line.text, line.color)]))));
			}
			return col(children, { gap: "sm", role: "omp.setup.web-search" });
		});
	}

	#onHighlight(value: string): void {
		this.#status = [];
		if (value !== "auto") this.#checkAvailability(value as SearchProviderId);
		this.#host.requestRender();
	}

	#checkAvailability(id: SearchProviderId): void {
		if (this.#availability.has(id)) return;
		this.#availability.set(id, "checking");
		void (async () => {
			let ready = false;
			try {
				ready = await this.#host.ctx.isSearchProviderAvailable(id);
			} catch {
				ready = false;
			}
			if (this.#disposed) return;
			this.#availability.set(id, ready);
			this.#host.requestRender();
		})();
	}

	async #apply(value: string): Promise<void> {
		const option = SEARCH_PROVIDER_OPTIONS.find(option => option.value === value);
		if (!option) return;
		// Persist the preferred provider through the host's web model role;
		// auto clears that preference and restores normal role resolution.
		try {
			await this.#host.ctx.saveSearchProvider(option.value);
			if (this.#disposed) return;
			const label = this.#items.find(item => item.value === value)?.label ?? value;
			this.#status = [
				{
					text: `${theme.status.success} ${t("Web search set to {provider}", { provider: label })}`,
					color: "success",
				},
			];
			if (value !== "auto" && this.#availability.get(value as SearchProviderId) === false) {
				this.#status.push({
					text: t("Not configured yet — add its API key or sign in to enable it."),
					color: "dim",
				});
			}
		} catch (error) {
			if (this.#disposed) return;
			this.#status = [
				{
					text: t("Error: {message}", { message: error instanceof Error ? error.message : String(error) }),
					color: "error",
				},
			];
		}
		this.#host.requestRender();
	}

	#readinessLines(value: string): StyledLine[] {
		if (value === "auto") {
			return [{ text: t("Automatically uses the first configured provider."), color: "dim" }];
		}
		const state = this.#availability.get(value as SearchProviderId);
		if (state === undefined || state === "checking") {
			return [{ text: `${t("Checking availability")}…`, color: "dim" }];
		}
		return state
			? [{ text: `${theme.status.success} ${t("Ready to use")}`, color: "success" }]
			: [{ text: `${theme.status.pending} ${t("Needs credentials")}`, color: "warning" }];
	}
}
