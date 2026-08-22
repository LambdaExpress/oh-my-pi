import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DesktopFrame } from "../src/components/shell/DesktopFrame";
import type { DesktopBridge } from "../src/lib/desktop-bridge";

function bridge(runtime: boolean): DesktopBridge {
	return {
		runtime,
		available: runtime,
		async listProjects() {
			return [];
		},
		async openProject() {},
		async switchProject() {},
		async windowMinimize() {},
		async windowToggleMaximize() {
			return false;
		},
		async windowIsMaximized() {
			return false;
		},
		async windowStartDragging() {},
		async windowClose() {},
	};
}

describe("DesktopFrame", () => {
	it("draws the complete window chrome only inside the desktop runtime", () => {
		const html = renderToStaticMarkup(
			<DesktopFrame bridge={bridge(true)}>
				<main>content</main>
			</DesktopFrame>,
		);

		expect(html).toContain('data-tauri-drag-region="true"');
		expect(html).toContain('aria-label="minimize window"');
		expect(html).toContain('aria-label="maximize window"');
		expect(html).toContain('aria-label="close window"');
		expect(html).toContain("content");
	});

	it("does not add desktop chrome to a normal browser session", () => {
		const html = renderToStaticMarkup(
			<DesktopFrame bridge={bridge(false)}>
				<main>content</main>
			</DesktopFrame>,
		);

		expect(html).toBe("<main>content</main>");
	});
});
