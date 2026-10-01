import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgDisplayCollapseCompacted, cfgDisplayCollapseCompletedRuns } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";
import { setLocale } from "../../../src/i18n";
import { assistantMsg, createTestSession, type TestSessionContext, userMsg } from "../../utilities";

const userMarker = "SCROLLBACK_USER";
const assistantMarkers = Array.from(
	{ length: 24 },
	(_, index) => `SCROLLBACK_ANSWER_${String(index).padStart(2, "0")}`,
);
const summaryMarker = "SCROLLBACK_SUMMARY";

describe("compaction native scrollback", () => {
	let testSession: TestSessionContext;
	let terminal: VirtualTerminal;
	let mode: InteractiveMode;

	beforeEach(async () => {
		setLocale("en");
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
		testSession = await createTestSession({ inMemory: true });
		terminal = new VirtualTerminal(80, 12);
		mode = new InteractiveMode(
			testSession.session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			new Composer({ terminal }),
		);
		mode.toolOutputExpanded = true;
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		resetSettingsForTest();
		await testSession?.cleanup();
		setLocale(null);
	});

	for (const route of ["automatic", "manual"] as const) {
		for (const collapseCompacted of [false, true]) {
			it(`${route} compaction ${collapseCompacted ? "replaces compacted history" : "preserves history without duplicating it"} and retains the draft`, async () => {
				cfgDisplayCollapseCompacted.override(mode.settings, collapseCompacted);
				cfgDisplayCollapseCompletedRuns.override(mode.settings, false);
				const manager = testSession.sessionManager;
				manager.appendMessage(userMsg(userMarker));
				manager.appendMessage(assistantMsg(assistantMarkers.join("\n")));
				const firstKeptEntryId = manager.appendMessage(userMsg("SCROLLBACK_KEPT_USER"));
				await mode.init({ suppressWelcomeIntro: true });
				await mode.renderInitialMessages({ preserveExistingChat: true });
				void mode.getUserInput();
				for (let frame = 0; frame < 40; frame++) {
					mode.ui.renderNow();
					await terminal.flush();
				}
				const committed = terminal
					.getScrollBuffer()
					.slice(0, terminal.getBufferPosition().baseY)
					.map(row => Bun.stripANSI(row).trimEnd());
				expect(committed.some(row => row.includes(userMarker))).toBe(true);
				expect(committed.some(row => row.includes(assistantMarkers[0]!))).toBe(true);
				terminal.sendInput("SCROLLBACK_DRAFT");
				await terminal.waitForRender();

				const result = { summary: summaryMarker, firstKeptEntryId, tokensBefore: 100_000 };
				const persistCompaction = () => {
					manager.appendCompaction(summaryMarker, undefined, firstKeptEntryId, result.tokensBefore);
					return result;
				};
				if (route === "automatic") {
					persistCompaction();
					await mode.eventController.handleEvent({
						type: "auto_compaction_end",
						action: "snapcompact",
						result,
						aborted: false,
						willRetry: false,
					});
				} else {
					vi.spyOn(testSession.session, "compact").mockImplementation(async () => persistCompaction());
					await new CommandController(mode).executeCompaction();
				}
				for (let frame = 0; frame < 40; frame++) {
					mode.ui.renderNow();
					await terminal.flush();
				}

				const rows = terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
				for (const marker of [userMarker, ...assistantMarkers]) {
					expect(
						rows.filter(row => row.includes(marker)),
						marker,
					).toHaveLength(collapseCompacted ? 0 : 1);
				}
				expect(rows.filter(row => row.includes(summaryMarker))).toHaveLength(1);
				expect(rows.filter(row => row.includes("SCROLLBACK_KEPT_USER"))).toHaveLength(1);
				expect(mode.editor.getExpandedText()).toBe("SCROLLBACK_DRAFT");
				expect(terminal.getViewport().some(row => Bun.stripANSI(row).includes("SCROLLBACK_DRAFT"))).toBe(true);
			});
		}
	}
});
