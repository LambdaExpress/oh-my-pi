import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsModal } from "../src/components/shell/SettingsModal";

describe("SettingsModal", () => {
	it("advertises the keyboard shortcut reference as a settings section", () => {
		const html = renderToStaticMarkup(<SettingsModal onClose={() => {}} />);

		expect(html).toContain("Keyboard shortcuts");
		expect(html).toContain('aria-controls="sh-settings-panel-shortcuts"');
	});
});
