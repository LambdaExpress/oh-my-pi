import { XMLParser } from "@oh-my-pi/pi-utils/xml";
import { ToolError } from "../tools/tool-errors";
import type { AdbUiBounds, AdbUiElement, AdbUiHierarchy, AdbUiSelector } from "./ui-types";

const MAX_XML_BYTES = 4 * 1024 * 1024;
const MAX_NODES = 20_000;
const MAX_DEPTH = 128;
const XML_SPACE = /^[\t\n\r ]*$/;
const INVALID_XML_CHARACTER = /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;
const ENTITY = /&(?:amp|apos|gt|lt|quot|#[0-9]+|#x[0-9a-fA-F]+);/y;
const STANDARD_ENTITIES: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' };
const STRING_SELECTOR_FIELDS = [
	"text",
	"textContains",
	"resourceId",
	"description",
	"className",
	"packageName",
] as const;
const BOOLEAN_SELECTOR_FIELDS = ["enabled", "checked", "focused", "selected"] as const;
const SELECTOR_FIELDS = new Set<string>([...STRING_SELECTOR_FIELDS, ...BOOLEAN_SELECTOR_FIELDS]);
const EMPTY_CHILDREN: readonly unknown[] = [];

const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "@_",
	trimValues: false,
	parseTagValue: false,
	parseAttributeValue: false,
	// Decode once below: the shared parser does not decode numeric character references.
	processEntities: false,
	isArray: (name, _path, _leaf, attribute) => name === "node" && !attribute,
});

function invalidXml(reason: string): never {
	throw new ToolError(`Invalid Android UI hierarchy XML: ${reason}`);
}

function entityValue(entity: string): string {
	const name = entity.slice(1, -1);
	if (!name.startsWith("#")) return STANDARD_ENTITIES[name]!;
	const codePoint = name.startsWith("#x") ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
	if (
		!Number.isInteger(codePoint) ||
		!(
			codePoint === 9 ||
			codePoint === 10 ||
			codePoint === 13 ||
			(codePoint >= 0x20 && codePoint <= 0xd7ff) ||
			(codePoint >= 0xe000 && codePoint <= 0xfffd) ||
			(codePoint >= 0x10000 && codePoint <= 0x10ffff)
		)
	) {
		invalidXml("invalid character reference");
	}
	return String.fromCodePoint(codePoint);
}

function validateEntities(value: string): void {
	let position = value.indexOf("&");
	while (position !== -1) {
		ENTITY.lastIndex = position;
		const match = ENTITY.exec(value);
		if (!match) invalidXml("invalid or unsupported entity");
		entityValue(match[0]);
		position = value.indexOf("&", ENTITY.lastIndex);
	}
}

function validateAttributes(attributes: string): void {
	const pattern = /[\t\n\r ]+([A-Za-z_][A-Za-z0-9_.:-]*)[\t\n\r ]*=[\t\n\r ]*(?:"([^"<]*)"|'([^'<]*)')/y;
	const names = new Set<string>();
	let position = 0;
	while (position < attributes.length) {
		pattern.lastIndex = position;
		const match = pattern.exec(attributes);
		if (!match) {
			if (XML_SPACE.test(attributes.slice(position))) return;
			invalidXml("attributes must have unique names and quoted values");
		}
		const name = match[1]!;
		if (names.has(name)) invalidXml("duplicate attribute");
		names.add(name);
		validateEntities(match[2] ?? match[3]!);
		position = pattern.lastIndex;
	}
}

/**
 * The shared XML parser intentionally tolerates incomplete documents. Validate the
 * bounded UIAutomator grammar first, without constructing a second parsed tree.
 */
function validateDocument(xml: string): void {
	if (xml.length > MAX_XML_BYTES || Buffer.byteLength(xml, "utf8") > MAX_XML_BYTES) {
		invalidXml(`document exceeds ${MAX_XML_BYTES} bytes`);
	}
	if (INVALID_XML_CHARACTER.test(xml)) invalidXml("invalid XML character");
	const token = /<(\/?)(hierarchy|node)(?=[\t\n\r />])((?:"[^"<]*"|'[^'<]*'|[^'"<>])*)>/y;
	const declaration =
		/<\?xml[\t\n\r ]+version[\t\n\r ]*=[\t\n\r ]*(?:"1\.0"|'1\.0')(?:[\t\n\r ]+encoding[\t\n\r ]*=[\t\n\r ]*(?:"[A-Za-z][A-Za-z0-9._-]*"|'[A-Za-z][A-Za-z0-9._-]*'))?(?:[\t\n\r ]+standalone[\t\n\r ]*=[\t\n\r ]*(?:"(?:yes|no)"|'(?:yes|no)'))?[\t\n\r ]*\?>/y;
	const whitespace = /[\t\n\r ]*/y;
	const stack: string[] = [];
	let position = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
	let rootSeen = false;
	let nodes = 0;
	if (xml.startsWith("<?xml", position)) {
		declaration.lastIndex = position;
		if (!declaration.exec(xml)) invalidXml("invalid XML declaration");
		position = declaration.lastIndex;
	}
	while (position < xml.length) {
		whitespace.lastIndex = position;
		whitespace.exec(xml);
		position = whitespace.lastIndex;
		if (position === xml.length) break;
		if (xml.startsWith("<!--", position)) {
			const end = xml.indexOf("-->", position + 4);
			if (end === -1 || xml.slice(position + 4, end).includes("--") || xml[end - 1] === "-") {
				invalidXml("invalid or truncated comment");
			}
			position = end + 3;
			continue;
		}
		token.lastIndex = position;
		const match = token.exec(xml);
		if (!match) invalidXml("unexpected or truncated markup");
		position = token.lastIndex;
		const closing = match[1] === "/";
		const name = match[2]!;
		let attributes = match[3]!;
		if (closing) {
			if (!XML_SPACE.test(attributes) || stack.pop() !== name) invalidXml("mismatched closing tag");
			continue;
		}
		const selfClosing = attributes.endsWith("/");
		if (selfClosing) attributes = attributes.slice(0, -1);
		validateAttributes(attributes);
		if (name === "hierarchy") {
			if (rootSeen || stack.length !== 0) invalidXml("expected exactly one hierarchy root");
			rootSeen = true;
		} else {
			if (stack.length === 0) invalidXml("node outside hierarchy root");
			if (++nodes > MAX_NODES) invalidXml(`hierarchy exceeds ${MAX_NODES} nodes`);
			if (stack.length > MAX_DEPTH) invalidXml(`hierarchy exceeds depth ${MAX_DEPTH}`);
		}
		if (!selfClosing) stack.push(name);
	}
	if (!rootSeen || stack.length !== 0) invalidXml("missing or unclosed hierarchy root");
}

function record(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		invalidXml("invalid hierarchy element");
	}
	return value as Record<string, unknown>;
}

function attribute(node: Record<string, unknown>, name: string): string | undefined {
	const value = node[`@_${name}`];
	if (value === undefined) return undefined;
	if (typeof value !== "string") invalidXml("invalid attribute value");
	return value.includes("&") ? value.replace(/&(?:amp|apos|gt|lt|quot|#[0-9]+|#x[0-9a-fA-F]+);/g, entityValue) : value;
}

function flag(node: Record<string, unknown>, name: string, fallback = false): boolean {
	const value = attribute(node, name);
	if (value === undefined) return fallback;
	if (value !== "true" && value !== "false") invalidXml(`invalid ${name} boolean`);
	return value === "true";
}

function coordinate(value: string): number {
	const result = Number(value);
	if (!Number.isInteger(result) || result < -0x80000000 || result > 0x7fffffff) {
		invalidXml("bounds exceed Android coordinate range");
	}
	return result;
}

function boundsOf(node: Record<string, unknown>): AdbUiBounds {
	const value = attribute(node, "bounds");
	const match = value?.match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/);
	if (!match) invalidXml("missing or invalid bounds");
	const left = coordinate(match[1]!);
	const top = coordinate(match[2]!);
	const right = coordinate(match[3]!);
	const bottom = coordinate(match[4]!);
	// UIAutomator can emit inverted rectangles for offscreen rows clipped by
	// their scroll container. Preserve them; visibility excludes empty areas.
	return { left, top, right, bottom };
}

function childrenOf(node: Record<string, unknown>): readonly unknown[] {
	const children = node.node;
	if (children === undefined) return EMPTY_CHILDREN;
	if (!Array.isArray(children)) invalidXml("invalid node list");
	return children;
}

interface NodeFrame {
	node: unknown;
	parentIndex?: number;
	depth: number;
	clip?: AdbUiBounds;
	visible: boolean;
}

export function parseUiHierarchy(xml: string, snapshot: string): AdbUiHierarchy {
	validateDocument(xml);
	let document: unknown;
	try {
		document = parser.parse(xml);
	} catch {
		invalidXml("XML parser rejected the document");
	}
	const root = record(record(document).hierarchy);
	const rotationValue = attribute(root, "rotation");
	if (rotationValue === undefined || !/^[0-3]$/.test(rotationValue))
		invalidXml("rotation must be an integer from 0 to 3");
	const elements: AdbUiElement[] = [];
	const stack: NodeFrame[] = [];
	const roots = childrenOf(root);
	for (let index = roots.length - 1; index >= 0; index--) {
		stack.push({ node: roots[index], depth: 0, visible: true });
	}
	while (stack.length > 0) {
		const frame = stack.pop()!;
		const node = record(frame.node);
		const bounds = boundsOf(node);
		const clip = frame.clip
			? {
					left: Math.max(bounds.left, frame.clip.left),
					top: Math.max(bounds.top, frame.clip.top),
					right: Math.min(bounds.right, frame.clip.right),
					bottom: Math.min(bounds.bottom, frame.clip.bottom),
				}
			: bounds;
		const explicitVisible = flag(node, "visible-to-user", true);
		const visible =
			frame.visible &&
			explicitVisible &&
			bounds.left >= 0 &&
			bounds.top >= 0 &&
			clip.right > clip.left &&
			clip.bottom > clip.top;
		const password = flag(node, "password");
		const index = elements.length;
		const element: AdbUiElement = {
			ref: `${snapshot}:${index}`,
			parentIndex: frame.parentIndex,
			depth: frame.depth,
			text: password ? "" : (attribute(node, "text") ?? ""),
			resourceId: attribute(node, "resource-id") ?? "",
			description: password ? "" : (attribute(node, "content-desc") ?? ""),
			className: attribute(node, "class") ?? "",
			packageName: attribute(node, "package") ?? "",
			bounds,
			visible,
			enabled: flag(node, "enabled"),
			clickable: flag(node, "clickable"),
			longClickable: flag(node, "long-clickable"),
			scrollable: flag(node, "scrollable"),
			checkable: flag(node, "checkable"),
			checked: flag(node, "checked"),
			focusable: flag(node, "focusable"),
			focused: flag(node, "focused"),
			selected: flag(node, "selected"),
			password,
		};
		elements.push(element);
		const children = childrenOf(node);
		for (let child = children.length - 1; child >= 0; child--) {
			stack.push({ node: children[child], parentIndex: index, depth: frame.depth + 1, clip, visible });
		}
	}
	return { rotation: Number(rotationValue), elements };
}

export function matchUiElements(hierarchy: AdbUiHierarchy, selector: AdbUiSelector): AdbUiElement[] {
	if (selector === null || typeof selector !== "object" || Array.isArray(selector)) {
		throw new ToolError("UI selector must be an object");
	}
	for (const field of Object.keys(selector)) {
		if (!SELECTOR_FIELDS.has(field)) throw new ToolError(`Unknown UI selector field: ${field}`);
	}
	let hasSelector = false;
	for (const field of STRING_SELECTOR_FIELDS) {
		if (selector[field] === undefined) continue;
		if (typeof selector[field] !== "string") throw new ToolError(`UI selector ${field} must be a string`);
		hasSelector = true;
	}
	for (const field of BOOLEAN_SELECTOR_FIELDS) {
		if (selector[field] === undefined) continue;
		if (typeof selector[field] !== "boolean") throw new ToolError(`UI selector ${field} must be a boolean`);
		hasSelector = true;
	}
	if (!hasSelector) throw new ToolError("UI selector must contain at least one condition");
	return hierarchy.elements.filter(
		element =>
			(!element.password ||
				(selector.text === undefined &&
					selector.textContains === undefined &&
					selector.description === undefined)) &&
			(selector.text === undefined || element.text === selector.text) &&
			(selector.textContains === undefined || element.text.includes(selector.textContains)) &&
			(selector.resourceId === undefined || element.resourceId === selector.resourceId) &&
			(selector.description === undefined || element.description === selector.description) &&
			(selector.className === undefined || element.className === selector.className) &&
			(selector.packageName === undefined || element.packageName === selector.packageName) &&
			(selector.enabled === undefined || element.enabled === selector.enabled) &&
			(selector.checked === undefined || element.checked === selector.checked) &&
			(selector.focused === undefined || element.focused === selector.focused) &&
			(selector.selected === undefined || element.selected === selector.selected),
	);
}

export function sameUiElement(a: AdbUiElement, b: AdbUiElement): boolean {
	return (
		a.parentIndex === b.parentIndex &&
		a.depth === b.depth &&
		a.password === b.password &&
		(a.password || (a.text === b.text && a.description === b.description)) &&
		a.resourceId === b.resourceId &&
		a.className === b.className &&
		a.packageName === b.packageName &&
		a.bounds.left === b.bounds.left &&
		a.bounds.top === b.bounds.top &&
		a.bounds.right === b.bounds.right &&
		a.bounds.bottom === b.bounds.bottom &&
		a.visible === b.visible &&
		a.enabled === b.enabled &&
		a.clickable === b.clickable &&
		a.longClickable === b.longClickable &&
		a.scrollable === b.scrollable &&
		a.checkable === b.checkable &&
		a.checked === b.checked &&
		a.focusable === b.focusable &&
		a.focused === b.focused &&
		a.selected === b.selected
	);
}
