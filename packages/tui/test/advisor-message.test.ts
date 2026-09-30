import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { createAdvisorMessageCard } from "@oh-my-pi/pi-tui/chat/advisor-message";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import { setLocale } from "../src/i18n";

function rows(transcript: TranscriptContainer, width = 100): string[] {
	return transcript.renderViewport(width, 50).map(line => stripVTControlCharacters(line));
}

describe("advisor transcript card folding", () => {
	beforeAll(async () => {
		setLocale("en");
		await initTheme();
	});

	afterAll(() => setLocale(null));

	it("mounts two-note cards as adjacent folded rows and restores both notes when unfolded", () => {
		const transcript = new TranscriptContainer();
		transcript.setToolRowsFolded(true);
		transcript.addChild(
			createAdvisorMessageCard(
				{
					notes: [
						{ severity: "concern", note: "Consider the retry limit" },
						{ severity: "blocker", advisor: "Security", note: "Reject the unsafe path\nbefore writing" },
					],
				},
				() => false,
				theme,
			),
		);
		transcript.addChild(
			createAdvisorMessageCard({ notes: [{ severity: "nit", note: "Document the response" }] }, () => false, theme),
		);

		const folded = rows(transcript);
		expect(folded).toHaveLength(2);
		expect(folded[0]).toContain("Advisor");
		expect(folded[0]).toContain("2 notes");
		expect(folded[0]).toContain("1 blocker");
		expect(folded[0]).toContain("Reject the unsafe path before writing");
		expect(folded[0]).not.toContain("Consider the retry limit");
		expect(folded[1]).toContain("Document the response");

		transcript.setToolRowsFolded(false);
		const unfolded = rows(transcript);
		expect(unfolded.join("\n")).toContain("Consider the retry limit");
		expect(unfolded.join("\n")).toContain("Reject the unsafe path");
		expect(unfolded.join("\n")).toContain("before writing");
	});

	it("preserves controlled disclosure expansion through folding and theme invalidation", () => {
		let expanded = false;
		const card = createAdvisorMessageCard(
			{
				notes: [
					{ note: "First finding" },
					{ note: "Second finding" },
					{ note: "Third finding" },
					{ severity: "blocker", note: "Fourth finding" },
				],
			},
			() => expanded,
			theme,
		);
		const transcript = new TranscriptContainer();
		transcript.addChild(card);
		const collapsed = rows(transcript).join("\n");
		expect(collapsed).toContain("First finding");
		expect(collapsed).not.toContain("Fourth finding");
		expect(collapsed).toContain("+1 more note");

		transcript.setToolRowsFolded(true);
		expect(rows(transcript)).toHaveLength(1);
		expanded = true;
		card.invalidate?.();
		transcript.setToolRowsFolded(false);
		const opened = rows(transcript).join("\n");
		expect(opened).toContain("First finding");
		expect(opened).toContain("Fourth finding");
		expect(opened).not.toContain("+1 more note");

		expanded = false;
		expect(rows(transcript).join("\n")).not.toContain("Fourth finding");
	});

	it("keeps the blocker count and useful preview within a narrow terminal", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(
			createAdvisorMessageCard(
				{
					notes: [
						{ severity: "nit", note: "Unimportant note" },
						{ severity: "blocker", note: "Must fix authorization before release" },
					],
				},
				() => false,
				theme,
			),
		);
		transcript.setToolRowsFolded(true);
		const narrow = rows(transcript, 46);
		expect(narrow).toHaveLength(1);
		expect(narrow[0]).toContain("Advisor");
		expect(narrow[0]).toContain("2 notes");
		expect(narrow[0]).toContain("1 blocker");
		expect(narrow[0]).toContain("Must fix");
		expect(visibleWidth(narrow[0]!)).toBeLessThanOrEqual(46);
		expect(rows(transcript, 14)).toHaveLength(1);
		expect(rows(transcript, 14).every(line => visibleWidth(line) <= 14)).toBe(true);
	});
});
