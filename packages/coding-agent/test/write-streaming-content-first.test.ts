import { describe, expect, it } from "bun:test";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { writeToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/write";

const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

describe("write streaming preview renders when content precedes path", () => {
	let initialized = false;

	async function getUiTheme() {
		if (!initialized) {
			await themeModule.initTheme();
			initialized = true;
		}
		const uiTheme = (await themeModule.getThemeByName("dark")) ?? (await themeModule.getThemeByName("light"));
		if (!uiTheme) throw new Error("expected an initialized theme");
		return uiTheme;
	}

	const options = { expanded: false, isPartial: true, spinnerFrame: 0 };

	it("renders the streaming content with the path placeholder before the path arrives", async () => {
		const uiTheme = await getUiTheme();
		const component = writeToolRenderer.renderCall({ content: "line 1\nline 2" }, options, uiTheme);
		// Regression: models that emit `content` before `path` used to hit the
		// hasPath gate and show no preview at all until the args completed.
		if (!component) throw new Error("expected a rendered component for a content-first write stream");
		const text = stripAnsi(component.render(120).join("\n"));
		expect(text).toContain("Write");
		expect(text).toContain("line 1");
		expect(text).toContain("line 2");
		// Placeholder path, swapped for the real one once the path lands.
		expect(text).toContain("…");
		expect(text).toContain("(streaming)");
	});

	it("swaps the placeholder path for the streamed path once it arrives", async () => {
		const uiTheme = await getUiTheme();
		const withoutPath = writeToolRenderer.renderCall({ content: "line 1\nline 2" }, options, uiTheme);
		if (!withoutPath) throw new Error("expected a rendered component for a content-first write stream");
		expect(stripAnsi(withoutPath.render(120).join("\n"))).toContain("…");

		const withPath = writeToolRenderer.renderCall(
			{ content: "line 1\nline 2", path: "/tmp/content-first.ts" },
			options,
			uiTheme,
		);
		if (!withPath) throw new Error("expected a rendered component once the path arrives");
		const text = stripAnsi(withPath.render(120).join("\n"));
		expect(text).toContain("content-first.ts");
		// The streaming footer stays while the call is still partial.
		expect(text).toContain("(streaming)");
	});

	it("renders nothing when neither field has streamed yet", async () => {
		const uiTheme = await getUiTheme();
		expect(writeToolRenderer.renderCall({}, options, uiTheme)).toBeUndefined();
	});

	it("still defers a half-typed xd:// path without content", async () => {
		const uiTheme = await getUiTheme();
		expect(writeToolRenderer.renderCall({ path: "xd://ast_e" }, options, uiTheme)).toBeUndefined();
	});
});
