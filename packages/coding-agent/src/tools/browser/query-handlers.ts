import { untilAborted } from "@oh-my-pi/pi-utils";
import type {
	CustomQueryHandler,
	ElementHandle,
	Page,
	default as PuppeteerInstance,
	Puppeteer as PuppeteerClass,
} from "puppeteer-core";
import { throwIfAborted } from "../tool-errors";
import type { ObservationEntry } from "./tab-protocol";

/** Root node Puppeteer passes to a custom query handler (the document for page-level queries). */
type QueryNode = Parameters<NonNullable<CustomQueryHandler["queryAll"]>>[0];

interface QueryRoot {
	querySelectorAll(selector: string): readonly Element[];
}

// Each handler is serialized with `Function.prototype.toString()` — by Puppeteer's custom query
// handler registry and by the Tern page kit — so it MUST stay self-contained: no references to
// module scope, imports, or other handlers.

/** `text/` handler: smallest elements containing the normalized rendered text. */
export function queryByText(node: QueryNode, selector: string): Element[] {
	const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();
	const wanted = normalize(selector);
	const result: Element[] = [];
	const visit = (root: QueryNode): boolean => {
		const element = root as unknown as Element & { innerText?: string; shadowRoot?: QueryNode };
		if (element.nodeType === 1) {
			if (["HEAD", "SCRIPT", "STYLE", "TEMPLATE"].includes(element.tagName)) return false;
			if (getComputedStyle(element).display === "none") return false;
		}
		let descendantMatches = false;
		for (const child of Array.from(element.children ?? [])) {
			if (visit(child as unknown as QueryNode)) descendantMatches = true;
		}
		if (element.shadowRoot && visit(element.shadowRoot)) descendantMatches = true;
		if (descendantMatches) return true;
		if (element.nodeType !== 1) return false;
		const style = getComputedStyle(element);
		if (style.visibility === "hidden" || style.visibility === "collapse") return false;
		const text =
			element.tagName === "INPUT" || element.tagName === "TEXTAREA"
				? element.value
				: (element.innerText ?? element.textContent ?? "");
		if (!normalize(text).includes(wanted)) return false;
		result.push(element);
		return true;
	};
	visit(node);
	return result;
}

/**
 * `label/` handler: controls whose `<label>` text, `aria-label`, or `aria-labelledby` text contains the
 * query (case-insensitive).
 */
export function queryByLabel(node: QueryNode, selector: string): Element[] {
	const root = node as unknown as QueryRoot;
	const wanted = selector.trim().toLocaleLowerCase();
	const matches = (value: string | null | undefined): boolean =>
		(value ?? "").trim().toLocaleLowerCase().includes(wanted);
	const elements = Array.from(root.querySelectorAll("*"));
	const result: Element[] = [];
	const seen = new Set<Element>();
	const add = (element: Element | null): void => {
		if (element && !seen.has(element)) {
			seen.add(element);
			result.push(element);
		}
	};
	for (const label of root.querySelectorAll("label")) {
		if (!matches(label.textContent)) continue;
		const htmlFor = label.getAttribute("for");
		if (htmlFor) {
			const target = label.ownerDocument?.getElementById(htmlFor) ?? null;
			if (
				target &&
				(node === target || (node as unknown as { contains(element: Element): boolean }).contains(target))
			) {
				add(target);
			}
		} else {
			const control = label.querySelector(
				"button,input,meter,output,progress,select,textarea",
			) as unknown as Element | null;
			add(control);
		}
	}
	for (const element of elements) {
		if (matches(element.getAttribute("aria-label"))) add(element);
		const labelledBy = element.getAttribute("aria-labelledby");
		if (!labelledBy) continue;
		const labelText = labelledBy
			.split(/\s+/)
			.map(id => element.ownerDocument?.getElementById(id)?.textContent ?? "")
			.join(" ");
		if (matches(labelText)) add(element);
	}
	return result;
}

/** `placeholder/` handler: elements whose `placeholder` contains the query (case-insensitive). */
export function queryByPlaceholder(node: QueryNode, selector: string): Element[] {
	const wanted = selector.trim().toLocaleLowerCase();
	return Array.from((node as unknown as QueryRoot).querySelectorAll("[placeholder]")).filter(element =>
		(element.getAttribute("placeholder") ?? "").trim().toLocaleLowerCase().includes(wanted),
	);
}

/** `testid/` handler: elements whose `data-testid` equals the trimmed query. */
export function queryByTestId(node: QueryNode, selector: string): Element[] {
	const wanted = selector.trim();
	return Array.from((node as unknown as QueryRoot).querySelectorAll("[data-testid]")).filter(
		element => element.getAttribute("data-testid") === wanted,
	);
}

/** `alt/` handler: elements whose `alt` contains the query (case-insensitive). */
export function queryByAlt(node: QueryNode, selector: string): Element[] {
	const wanted = selector.trim().toLocaleLowerCase();
	return Array.from((node as unknown as QueryRoot).querySelectorAll("[alt]")).filter(element =>
		(element.getAttribute("alt") ?? "").trim().toLocaleLowerCase().includes(wanted),
	);
}

/** `title/` handler: elements whose `title` contains the query (case-insensitive). */
export function queryByTitle(node: QueryNode, selector: string): Element[] {
	const wanted = selector.trim().toLocaleLowerCase();
	return Array.from((node as unknown as QueryRoot).querySelectorAll("[title]")).filter(element =>
		(element.getAttribute("title") ?? "").trim().toLocaleLowerCase().includes(wanted),
	);
}

/**
 * `role/` handler: `role[name="…" exact]` — explicit or implicit ARIA role, optionally filtered by
 * accessible name.
 */
export function queryByRole(node: QueryNode, selector: string): Element[] {
	const root = node as unknown as QueryRoot;
	const roleMatch = /^\s*([^\s[]+)/.exec(selector);
	const wantedRole = (roleMatch?.[1] ?? "").toLocaleLowerCase();
	const nameMatch = /\[\s*name\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))(?:\s+(exact))?\s*\]/i.exec(selector);
	const wantedName = (nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3])?.trim().toLocaleLowerCase();
	const exact = nameMatch?.[4]?.toLocaleLowerCase() === "exact";
	const implicitRole = (element: Element): string | null => {
		const tag = element.tagName.toLocaleLowerCase();
		if (tag === "a" && element.hasAttribute("href")) return "link";
		if (tag === "button") return "button";
		if (tag === "textarea") return "textbox";
		if (tag === "select") {
			const select = element as unknown as { multiple: boolean; size: number };
			return select.multiple || select.size > 1 ? "listbox" : "combobox";
		}
		if (tag === "option") return "option";
		if (tag === "img") return "img";
		if (tag === "ul" || tag === "ol") return "list";
		if (tag === "li") return "listitem";
		if (tag === "nav") return "navigation";
		if (tag === "main") return "main";
		if (tag === "form") return "form";
		if (tag === "article") return "article";
		if (/^h[1-6]$/.test(tag)) return "heading";
		if (tag === "table") return "table";
		if (tag === "tr") return "row";
		if (tag === "th") return element.getAttribute("scope") === "row" ? "rowheader" : "columnheader";
		if (tag === "td") return "cell";
		if (tag !== "input") return null;
		const type = ((element as unknown as { type?: string }).type || "text").toLocaleLowerCase();
		if (type === "checkbox") return "checkbox";
		if (type === "radio") return "radio";
		if (type === "range") return "slider";
		if (type === "number") return "spinbutton";
		if (type === "search") return "searchbox";
		if (["button", "submit", "reset", "image"].includes(type)) return "button";
		if (!["hidden", "file", "color", "date", "datetime-local", "month", "time", "week"].includes(type)) {
			return "textbox";
		}
		return null;
	};
	const accessibleName = (element: Element): string => {
		const ariaLabel = element.getAttribute("aria-label");
		if (ariaLabel) return ariaLabel.trim();
		const labelledBy = element.getAttribute("aria-labelledby");
		if (labelledBy) {
			const value = labelledBy
				.split(/\s+/)
				.map(id => element.ownerDocument?.getElementById(id)?.textContent ?? "")
				.join(" ")
				.trim();
			if (value) return value;
		}
		if (element.id) {
			for (const label of element.ownerDocument?.querySelectorAll("label") ?? []) {
				if (label.getAttribute("for") === element.id) return (label.textContent ?? "").trim();
			}
		}
		const wrappingLabel = element.closest("label");
		if (wrappingLabel) return (wrappingLabel.textContent ?? "").trim();
		return (
			element.getAttribute("alt") ??
			element.getAttribute("title") ??
			(element.tagName.toLocaleLowerCase() === "input" &&
			["button", "submit", "reset"].includes((element as unknown as { type: string }).type.toLocaleLowerCase())
				? (element as unknown as { value: string }).value
				: element.textContent) ??
			element.getAttribute("placeholder") ??
			""
		).trim();
	};
	return Array.from(root.querySelectorAll("*")).filter(element => {
		const role = (element.getAttribute("role")?.trim().split(/\s+/)[0] ?? implicitRole(element))?.toLocaleLowerCase();
		if (role !== wantedRole) return false;
		if (wantedName === undefined) return true;
		const name = accessibleName(element).toLocaleLowerCase();
		return exact ? name === wantedName : name.includes(wantedName);
	});
}

/** Semantic selector prefixes (`label/`, `role/`, …) and their self-contained `queryAll` handlers. */
export const SEMANTIC_QUERY_HANDLERS = {
	label: queryByLabel,
	placeholder: queryByPlaceholder,
	testid: queryByTestId,
	alt: queryByAlt,
	title: queryByTitle,
	role: queryByRole,
} as const satisfies Record<string, (node: QueryNode, selector: string) => Element[]>;

/** Register the browser tool's semantic selector prefixes on a worker-local Puppeteer instance. */
export function registerSemanticQueryHandlers(puppeteer: typeof PuppeteerInstance): void {
	const Puppeteer = puppeteer.constructor as typeof PuppeteerClass;
	const registered = new Set(Puppeteer.customQueryHandlerNames());
	const handlers = { text: queryByText, ...SEMANTIC_QUERY_HANDLERS };
	for (const name in handlers) {
		const queryAll = handlers[name as keyof typeof handlers];
		if (!registered.has(name)) Puppeteer.registerCustomQueryHandler(name, { queryAll });
	}
}

/**
 * Check rendered geometry synchronously, including clipping and occlusion, without
 * waiting for IntersectionObserver in an inactive browser window. Offscreen controls
 * remain observable unless viewportOnly is requested, so they can be scrolled to.
 */
export function isObservationElementVisible(
	element: Element,
	options: { viewportOnly: boolean; interactive: boolean },
): boolean {
	if (!element.isConnected) return false;
	const style = getComputedStyle(element);
	if (style.visibility === "hidden" || style.visibility === "collapse") return false;
	if (options.interactive && style.pointerEvents === "none") return false;
	const box = element.getBoundingClientRect();
	if (box.width <= 0 || box.height <= 0) return false;
	let left = Math.max(0, box.left);
	let right = Math.min(innerWidth, box.right);
	let top = Math.max(0, box.top);
	let bottom = Math.min(innerHeight, box.bottom);
	const parent = (node: Element): Element | null =>
		(node.parentElement ??
			(node as unknown as { getRootNode(): { host?: Element } }).getRootNode().host ??
			null) as Element | null;
	for (let current: Element | null = element; current; current = parent(current)) {
		const currentStyle = getComputedStyle(current);
		if (currentStyle.display === "none" || Number(currentStyle.opacity) === 0 || current.hasAttribute("inert")) {
			return false;
		}
		if (current === element) continue;
		const clip = current.getBoundingClientRect();
		if (["auto", "scroll", "hidden", "clip"].includes(String(currentStyle.overflowX))) {
			left = Math.max(left, clip.left);
			right = Math.min(right, clip.right);
		}
		if (["auto", "scroll", "hidden", "clip"].includes(String(currentStyle.overflowY))) {
			top = Math.max(top, clip.top);
			bottom = Math.min(bottom, clip.bottom);
		}
	}
	if (right <= left || bottom <= top) return !options.viewportOnly;
	if (!options.interactive) return true;
	const contains = (ancestor: Element, descendant: Element): boolean => {
		for (let current: Element | null = descendant; current; current = parent(current)) {
			if (current === ancestor) return true;
		}
		return false;
	};
	const insetX = Math.min(1, (right - left) / 2);
	const insetY = Math.min(1, (bottom - top) / 2);
	for (const [x, y] of [
		[(left + right) / 2, (top + bottom) / 2],
		[left + insetX, top + insetY],
		[right - insetX, top + insetY],
		[left + insetX, bottom - insetY],
		[right - insetX, bottom - insetY],
	]) {
		let hit = document.elementFromPoint(x!, y!);
		for (let depth = 0; hit && depth < 16; depth++) {
			const shadow = (hit as unknown as { shadowRoot?: { elementFromPoint(x: number, y: number): Element | null } })
				.shadowRoot;
			const nested = shadow?.elementFromPoint(x!, y!);
			if (!nested || nested === hit) break;
			hit = nested;
		}
		if (hit && contains(element, hit)) return true;
	}
	return false;
}

/** Supplement AX omissions with rendered DOM controls, preserving cached-handle ownership. */
export async function collectDomObservationCandidates(
	root: Page | ElementHandle,
	options: { viewportOnly: boolean; seenBackendNodeIds: Set<number>; signal?: AbortSignal },
): Promise<Array<{ handle: ElementHandle; entry: Omit<ObservationEntry, "id"> }>> {
	const selector =
		"button,a[href],input:not([type=hidden]),textarea,select,[contenteditable],[role=button],[role=link]," +
		"[role=textbox],[role=combobox],[role=listbox],[role=option],[role=checkbox],[role=radio],[role=switch]," +
		"[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=slider],[role=spinbutton]," +
		"[role=searchbox],[role=treeitem]";
	const handles = (await untilAborted(options.signal, () => root.$$(`pierce/${selector}`))) as ElementHandle[];
	const candidates: Array<{ handle: ElementHandle; entry: Omit<ObservationEntry, "id"> }> = [];
	const retained = new Set<ElementHandle>();
	try {
		if ("asElement" in root) {
			const proxy = await untilAborted(options.signal, () =>
				root.evaluateHandle((element, query) => (element.matches(query) ? element : null), selector),
			);
			const element = proxy.asElement();
			if (element) handles.unshift(element);
			else await proxy.dispose();
		}
		for (const handle of handles) {
			throwIfAborted(options.signal);
			try {
				const backendNodeId = await untilAborted(options.signal, () => handle.backendNodeId());
				if (options.seenBackendNodeIds.has(backendNodeId)) continue;
				const visible = await untilAborted(options.signal, () =>
					handle.evaluate(isObservationElementVisible, { viewportOnly: options.viewportOnly, interactive: true }),
				);
				if (!visible) continue;
				const entry = await untilAborted(options.signal, () =>
					handle.evaluate(el => {
						const element = el as Element & {
							innerText?: string;
							type?: string;
							labels?: ArrayLike<{ textContent: string | null }>;
							readOnly?: boolean;
							required?: boolean;
							multiple?: boolean;
							size?: number;
							isContentEditable?: boolean;
						};
						const normalize = (text: string | null | undefined): string =>
							(text ?? "").replace(/\s+/g, " ").trim();
						const tag = element.tagName.toLowerCase();
						const type = element.type?.toLowerCase() ?? "text";
						let role = element.getAttribute("role")?.trim().split(/\s+/)[0]?.toLowerCase();
						if (!role) {
							if (tag === "button") role = "button";
							else if (tag === "a") role = "link";
							else if (tag === "select")
								role = element.multiple || (element.size ?? 0) > 1 ? "listbox" : "combobox";
							else if (tag === "textarea" || element.isContentEditable) role = "textbox";
							else if (tag === "input") {
								if (["button", "submit", "reset", "image"].includes(type)) role = "button";
								else if (type === "checkbox" || type === "radio") role = type;
								else if (type === "range") role = "slider";
								else if (type === "number") role = "spinbutton";
								else if (type === "search") role = "searchbox";
								else role = "textbox";
							}
						}
						if (!role || role === "none" || role === "presentation") return null;
						const idref = (attribute: string): string =>
							normalize(
								(element.getAttribute(attribute) ?? "")
									.split(/\s+/)
									.map(id => element.ownerDocument?.getElementById(id)?.textContent ?? "")
									.join(" "),
							);
						const name =
							normalize(element.getAttribute("aria-label")) ||
							idref("aria-labelledby") ||
							normalize(
								Array.from(element.labels ?? [])
									.map(label => label.textContent ?? "")
									.join(" "),
							) ||
							normalize(
								tag === "input"
									? role === "button"
										? element.value
										: element.getAttribute("alt")
									: (element.innerText ?? element.textContent),
							) ||
							normalize(element.getAttribute("title")) ||
							normalize(element.getAttribute("placeholder"));
						const states: string[] = [];
						if (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true")
							states.push("disabled");
						for (const state of ["checked", "pressed", "selected", "expanded"]) {
							const value = element.getAttribute(`aria-${state}`);
							if (value !== null) states.push(`${state}=${value}`);
							else if (state === "checked" && tag === "input" && (type === "checkbox" || type === "radio")) {
								states.push(`checked=${element.checked}`);
							}
						}
						if (element.readOnly || element.getAttribute("aria-readonly") === "true") states.push("readonly");
						if (element.required || element.getAttribute("aria-required") === "true") states.push("required");
						if (element.multiple || element.getAttribute("aria-multiselectable") === "true")
							states.push("multiselectable");
						if (tag === "textarea" || element.getAttribute("aria-multiline") === "true") states.push("multiline");
						if (element.matches(":focus")) states.push("focused");
						return {
							role,
							name: name || undefined,
							value:
								type !== "password" &&
								["textbox", "searchbox", "combobox", "spinbutton", "slider"].includes(role)
									? element.isContentEditable
										? element.innerText
										: element.value
									: undefined,
							description:
								idref("aria-describedby") || normalize(element.getAttribute("aria-description")) || undefined,
							keyshortcuts: element.getAttribute("aria-keyshortcuts") || undefined,
							states,
						};
					}),
				);
				if (!entry) continue;
				options.seenBackendNodeIds.add(backendNodeId);
				candidates.push({ handle, entry });
				retained.add(handle);
			} catch (error) {
				// DOM churn can invalidate a single candidate; cancellation still aborts the observation.
				throwIfAborted(options.signal);
				const connected = await untilAborted(options.signal, () =>
					handle.evaluate(element => element.isConnected),
				).catch(() => false);
				throwIfAborted(options.signal);
				if (connected) throw error;
			}
		}
		return candidates;
	} catch (error) {
		retained.clear();
		throw error;
	} finally {
		await Promise.all(
			handles.filter(handle => !retained.has(handle)).map(handle => handle.dispose().catch(() => undefined)),
		);
	}
}
