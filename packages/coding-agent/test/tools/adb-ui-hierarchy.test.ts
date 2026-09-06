import { describe, expect, it } from "bun:test";
import { matchUiElements, parseUiHierarchy, sameUiElement } from "@oh-my-pi/pi-coding-agent/adb/ui-hierarchy";
import type { AdbUiElement, AdbUiSelector } from "@oh-my-pi/pi-coding-agent/adb/ui-types";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

function hierarchy(nodes: string, rotation = "0"): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><hierarchy rotation="${rotation}">${nodes}</hierarchy>`;
}

function node(attributes = "", children = ""): string {
	return `<node bounds="[0,0][200,200]" enabled="true" ${attributes}>${children}</node>`;
}

describe("Android UI hierarchy parsing", () => {
	it("preserves attribute whitespace and Unicode while decoding entities exactly once", () => {
		const result = parseUiHierarchy(
			hierarchy(
				node(
					`text="  中文 &amp; &lt; &gt; &quot; &apos; &#65; &#x20000; &amp;#65;  " resource-id="001" content-desc=" false " class="android.widget.TextView" package="example.app" clickable="true" long-clickable="true" scrollable="true" checkable="true" checked="false" focusable="true" focused="true" selected="false"`,
					node('text="child"'),
				) + node('text="sibling"'),
				"3",
			),
			"first",
		);
		expect(result.rotation).toBe(3);
		expect(result.elements.map(element => [element.ref, element.parentIndex, element.depth, element.text])).toEqual([
			["first:0", undefined, 0, `  中文 & < > " ' A 𠀀 &#65;  `],
			["first:1", 0, 1, "child"],
			["first:2", undefined, 0, "sibling"],
		]);
		expect(result.elements[0]).toMatchObject({
			resourceId: "001",
			description: " false ",
			className: "android.widget.TextView",
			packageName: "example.app",
			visible: true,
			enabled: true,
			clickable: true,
			longClickable: true,
			scrollable: true,
			checkable: true,
			checked: false,
			focusable: true,
			focused: true,
			selected: false,
		});
	});

	it("accepts a well-formed empty hierarchy but never a truncated or malformed dump", () => {
		expect(parseUiHierarchy('<hierarchy rotation="0"/>', "empty")).toEqual({ rotation: 0, elements: [] });
		const malformed = [
			"",
			'<hierarchy rotation="0">',
			'<hierarchy rotation="0"><node bounds="[0,0][1,1]"></hierarchy>',
			'<hierarchy rotation="0"></hierarchySuffix>',
			'<hierarchy rotation="0"><node bounds="[0,0][1,1]"/></hierarchy',
			'<hierarchy rotation="0" rotation="1"/>',
			"<hierarchy rotation=0/>",
			'<hierarchy rotation="0"><unexpected/></hierarchy>',
			'<hierarchy rotation="0"/>garbage',
			'<hierarchy rotation="0"/><hierarchy rotation="0"/>',
			'<!DOCTYPE hierarchy [<!ENTITY x "value">]><hierarchy rotation="0"/>',
			hierarchy(node('text="&unknown;"')),
			hierarchy(node('text="&#0;"')),
			hierarchy(node('text="&#xD800;"')),
			hierarchy(node('text="raw & text"')),
			hierarchy(node('text="unfinished')),
			hierarchy(node('text="\u0000"')),
		];
		for (const xml of malformed) expect(() => parseUiHierarchy(xml, "bad")).toThrow(ToolError);
	});

	it("rejects unsafe structural size and recursion before parsing the hierarchy", () => {
		const deeplyNested = '<node bounds="[0,0][1,1]">'.repeat(129) + "</node>".repeat(129);
		expect(() => parseUiHierarchy(hierarchy(deeplyNested), "deep")).toThrow(ToolError);
		expect(() => parseUiHierarchy(hierarchy('<node bounds="[0,0][1,1]"/>'.repeat(20_001)), "wide")).toThrow(
			ToolError,
		);
		expect(() => parseUiHierarchy(hierarchy(node(`text="${"字".repeat(1_400_000)}"`)), "large")).toThrow(ToolError);
	});

	it("validates rotation, bounds and supplied booleans rather than guessing state", () => {
		for (const xml of [
			hierarchy("", "4"),
			hierarchy("", "false"),
			"<hierarchy/>",
			hierarchy('<node bounds="[0,0][2147483648,1]"/>'),
			hierarchy("<node/>"),
			hierarchy(node('checked="0"')),
			hierarchy(node('visible-to-user="TRUE"')),
		]) {
			expect(() => parseUiHierarchy(xml, "invalid-state")).toThrow(ToolError);
		}
		const [missingEnabled] = parseUiHierarchy(hierarchy('<node bounds="[0,0][1,1]"/>'), "state").elements;
		expect(matchUiElements({ rotation: 0, elements: [missingEnabled!] }, { enabled: true })).toEqual([]);
	});

	it("keeps unsafe and ancestor-clipped nodes nonvisible while preserving original bounds", () => {
		const result = parseUiHierarchy(
			hierarchy(
				'<node bounds="[0,0][100,100]" enabled="true">' +
					'<node bounds="[90,90][150,150]" enabled="true"/>' +
					'<node bounds="[110,0][150,50]" enabled="true"/>' +
					'<node bounds="[-1,0][50,50]" enabled="true"/>' +
					'<node bounds="[10,10][10,20]" enabled="true"/>' +
					'<node bounds="[0,0][100,100]" enabled="true" visible-to-user="false">' +
					'<node bounds="[10,10][20,20]" enabled="true" visible-to-user="true"/>' +
					"</node></node>",
			),
			"bounds",
		);
		expect(result.elements.map(element => element.visible)).toEqual([true, true, false, false, false, false, false]);
		expect(result.elements[1]!.bounds).toEqual({ left: 90, top: 90, right: 150, bottom: 150 });
	});

	it("keeps observable settings rows when UIAutomator reports inverted offscreen bounds", () => {
		const result = parseUiHierarchy(
			hierarchy(
				'<node bounds="[0,0][1080,2274]" enabled="true">' +
					'<node text="Apps" bounds="[189,1000][553,1100]" enabled="true"/>' +
					'<node text="Display &amp; touch" bounds="[189,2376][553,2274]" enabled="true"/>' +
					"</node>",
			),
			"settings",
		);
		expect(result.elements.filter(element => element.visible).map(element => element.text)).toEqual(["", "Apps"]);
		expect(result.elements[2]!.bounds).toEqual({ left: 189, top: 2376, right: 553, bottom: 2274 });
	});

	it("redacts password text and descriptions before matching or comparing observations", () => {
		const first = parseUiHierarchy(
			hierarchy(node('password="true" text="secret-one" content-desc="secret-description" resource-id="password"')),
			"first",
		);
		const second = parseUiHierarchy(
			hierarchy(node('password="true" text="secret-two" content-desc="changed-secret" resource-id="password"')),
			"second",
		);
		expect(first.elements[0]!.text).toBe("");
		expect(first.elements[0]!.description).toBe("");
		expect(matchUiElements(first, { textContains: "secret" })).toEqual([]);
		expect(matchUiElements(first, { description: "secret-description" })).toEqual([]);
		expect(matchUiElements(first, { text: "" })).toEqual([]);
		expect(matchUiElements(first, { resourceId: "password" })).toEqual(first.elements);
		expect(sameUiElement(first.elements[0]!, second.elements[0]!)).toBe(true);
	});
});

describe("Android UI selectors and identity", () => {
	it("keeps ambiguous matches and applies exact strings, conjunction and explicit false", () => {
		const result = parseUiHierarchy(
			hierarchy(
				node('text="Save" resource-id="save" checked="false" selected="false" focused="false"') +
					node('text="Save" resource-id="other" checked="true"') +
					node('text=" Save " resource-id="save" checked="false"'),
			),
			"selectors",
		);
		expect(matchUiElements(result, { text: "Save" }).map(element => element.ref)).toEqual([
			"selectors:0",
			"selectors:1",
		]);
		expect(matchUiElements(result, { text: "save" })).toEqual([]);
		expect(
			matchUiElements(result, { textContains: "Save", resourceId: "save", checked: false }).map(
				element => element.ref,
			),
		).toEqual(["selectors:0", "selectors:2"]);
		expect(
			matchUiElements(result, { text: "Save", resourceId: "save", checked: false, focused: false, selected: false }),
		).toEqual([result.elements[0]!]);
		expect(matchUiElements(result, { text: "Save", enabled: false })).toEqual([]);
		expect(() => matchUiElements(result, {})).toThrow(ToolError);
		expect(() => matchUiElements(result, { text: undefined })).toThrow(ToolError);
	});

	it("rejects unsupported selectors before a caller can mistake them for a successful wait", () => {
		for (const selector of [
			{ ref: "old:0" },
			{ text: "Save", ref: "old:0" },
			{ enabled: "false" },
			{ text: false },
			null,
		]) {
			expect(() => matchUiElements({ rotation: 0, elements: [] }, selector as unknown as AdbUiSelector)).toThrow(
				ToolError,
			);
		}
	});

	it("ignores only snapshot refs, detecting structural identity, bounds and state changes", () => {
		const xml = hierarchy(
			node(
				'text="Save" resource-id="save" content-desc="Submit" class="Button" package="app"',
				node('text="child"'),
			),
		);
		const first = parseUiHierarchy(xml, "first").elements[1]!;
		const second = parseUiHierarchy(xml, "second").elements[1]!;
		expect(sameUiElement(first, second)).toBe(true);
		const changed: AdbUiElement[] = [
			{ ...second, text: "changed" },
			{ ...second, description: "changed" },
			{ ...second, resourceId: "changed" },
			{ ...second, className: "changed" },
			{ ...second, packageName: "changed" },
			{ ...second, parentIndex: 1 },
			{ ...second, depth: 2 },
			{ ...second, bounds: { ...second.bounds, left: 1 } },
			{ ...second, bounds: { ...second.bounds, top: 1 } },
			{ ...second, bounds: { ...second.bounds, right: 199 } },
			{ ...second, bounds: { ...second.bounds, bottom: 199 } },
		];
		for (const field of [
			"visible",
			"enabled",
			"clickable",
			"longClickable",
			"scrollable",
			"checkable",
			"checked",
			"focusable",
			"focused",
			"selected",
			"password",
		] as const) {
			changed.push({ ...second, [field]: !second[field] });
		}
		for (const element of changed) expect(sameUiElement(first, element)).toBe(false);
	});
});
