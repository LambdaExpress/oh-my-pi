import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { TUI } from "@oh-my-pi/pi-tui";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import { InjectNoticeComponent } from "@oh-my-pi/pi-tui/chat/inject-notice";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ContextInjectionItem } from "@oh-my-pi/pi-tui/chat/context-injection";
import { createContextInjectionMessage } from "@oh-my-pi/pi-tui/chat/context-injection";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

const AGENTS_MD: ContextInjectionItem = {
	kind: "context-file",
	label: "AGENTS.md",
	detail: "1.2 KB · ~/project/AGENTS.md",
	preview: "# Project rules",
};

const STAMP = new Date(0).toISOString();

beforeAll(async () => {
	await initTheme();
});

function entry(id: string, parentId: string | null, message: AgentMessage): SessionMessageEntry {
	return { type: "message", id, parentId, timestamp: STAMP, message };
}

function injectionEntry(id: string): SessionMessageEntry {
	return entry(id, null, createContextInjectionMessage([AGENTS_MD], STAMP) as unknown as AgentMessage);
}

function userEntry(id: string, parentId: string | null): SessionMessageEntry {
	return entry(id, parentId, {
		role: "user",
		content: [{ type: "text", text: "hello" }],
		attribution: "user",
		timestamp: Number(STAMP),
	} as unknown as AgentMessage);
}

function blockKinds(builder: ChatTranscriptBuilder): string[] {
	return builder.container.children.map(child => {
		if (child instanceof InjectNoticeComponent) return "inject";
		if (child instanceof UserMessageComponent) return "user";
		return child.constructor.name;
	});
}

function makeBuilder(): ChatTranscriptBuilder {
	return new ChatTranscriptBuilder({
		ui: { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI,
		cwd: process.cwd(),
		requestRender: () => {},
	});
}

describe("ChatTranscriptBuilder injection notices", () => {
	beforeEach(async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		settings.set("display.hideToolActivity", false);
	});
	afterEach(() => {
		resetSettingsForTest();
	});

	it("holds a startup notice until the transcript's first user message", () => {
		const builder = makeBuilder();

		builder.rebuild([injectionEntry("i1"), userEntry("m1", "i1")]);

		expect(blockKinds(builder)).toEqual(["user", "inject"]);
	});

	it("omits a startup notice when the transcript has no user message yet", () => {
		const builder = makeBuilder();

		builder.rebuild([injectionEntry("i1")]);

		expect(blockKinds(builder)).toEqual([]);
	});

	it("keeps a notice that follows a user message in place", () => {
		const builder = makeBuilder();

		builder.rebuild([userEntry("m1", null), injectionEntry("i1")]);

		expect(blockKinds(builder)).toEqual(["user", "inject"]);
	});
});
