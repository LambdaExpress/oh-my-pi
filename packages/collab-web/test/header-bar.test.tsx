import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HeaderBar } from "../src/components/shell/HeaderBar";
import type { GuestSnapshot } from "../src/lib/client";

function snapshot(): GuestSnapshot {
	return {
		phase: "live",
		endedReason: null,
		header: null,
		entries: [],
		state: {
			isStreaming: false,
			queuedMessageCount: 0,
			cwd: "D:\\project\\oh-my-pi",
			contextUsage: { tokens: 80_000, contextWindow: 200_000, percent: 40 },
			participants: [
				{ name: "Tang", role: "host" },
				{ name: "Guest", role: "guest" },
			],
		},
		agents: [],
		progress: new Map(),
		lifecycle: new Map(),
		stream: null,
		streamDone: false,
		activeTools: new Map(),
		working: false,
		readOnly: false,
		uiRequest: null,
		models: null,
		notices: [],
	};
}

describe("HeaderBar participants", () => {
	it("does not render participant initials in the session toolbar", () => {
		const html = renderToStaticMarkup(
			<HeaderBar
				snapshot={snapshot()}
				subCount={0}
				railOpen={false}
				onToggleRail={() => {}}
				onLeave={() => {}}
				settingsOpen={false}
				onToggleSettings={() => {}}
			/>,
		);

		expect(html).not.toContain('title="Tang · host"');
		expect(html).not.toContain('title="Guest · guest"');
		expect(html).not.toContain("sh-gauge");
		expect(html).not.toContain("context · 40%");
	});
});
