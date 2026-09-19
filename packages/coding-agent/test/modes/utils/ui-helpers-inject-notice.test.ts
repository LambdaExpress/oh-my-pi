import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UserMessage } from "@oh-my-pi/pi-ai";
import { Container } from "@oh-my-pi/pi-tui";
import { InjectNoticeComponent } from "@oh-my-pi/pi-coding-agent/modes/components/inject-notice";
import { UserMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/user-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { collapsedRunProjections } from "@oh-my-pi/pi-coding-agent/modes/utils/transcript-render-helpers";
import {
	type ContextInjectionItem,
	createContextInjectionMessage,
} from "@oh-my-pi/pi-coding-agent/session/context-injection";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";
import { setLocale } from "../../../src/i18n";

beforeAll(() => {
	initTheme();
});

// Notice labels are localized; pin the locale so the rendered text is assertable.
beforeEach(() => {
	setLocale("en");
});

afterEach(() => {
	setLocale(null);
});

const AGENTS_MD: ContextInjectionItem = {
	kind: "context-file",
	label: "AGENTS.md",
	detail: "1.2 KB · ~/project/AGENTS.md",
	preview: "# Project rules",
};
const SKILLS: ContextInjectionItem = { kind: "skill", label: "Skills", count: 3 };

/** Transcript order as coarse kinds, so assertions read like the screen. */
function blockKinds(ctx: InteractiveModeContext): string[] {
	return ctx.chatContainer.children.map(child => {
		if (child instanceof InjectNoticeComponent) return "inject";
		if (child instanceof UserMessageComponent) return "user";
		return child.constructor.name;
	});
}

function notices(ctx: InteractiveModeContext): InjectNoticeComponent[] {
	return ctx.chatContainer.children.filter(
		(child): child is InjectNoticeComponent => child instanceof InjectNoticeComponent,
	);
}

function userMessage(text: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		attribution: "user",
		timestamp: Date.now(),
	};
}

function makeHarness(): { ctx: InteractiveModeContext; helpers: UiHelpers } {
	const ctx = createInteractiveModeContext({
		getUserMessageText: message =>
			typeof message.content === "string"
				? message.content
				: message.content
						.map(block => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
						.join(""),
	});
	const helpers = new UiHelpers(ctx);
	// The fixture stubs `ctx.addMessageToChat`; production forwards it to these
	// helpers, so wire it back for the tests that drive `renderSessionContext`.
	ctx.addMessageToChat = (message, options) => helpers.addMessageToChat(message, options);
	return { ctx, helpers };
}

describe("injection notices around the first user message", () => {
	it("holds a startup notice until the user sends their first message", () => {
		const { ctx, helpers } = makeHarness();

		// Startup context (fresh launch, `/new`, resume) is replayed before any
		// user turn exists; an empty transcript must not open with an Inject block.
		helpers.addMessageToChat(createContextInjectionMessage([AGENTS_MD], Date.now()));
		expect(blockKinds(ctx)).toEqual([]);

		helpers.addMessageToChat(userMessage("hello"));
		// The live path publishes at message_start, once the run gate is behind
		// the request (see EventController#handleMessageStart).
		helpers.flushDeferredInjectNotice();
		expect(blockKinds(ctx)).toEqual(["user", "inject"]);
	});

	it("renders a notice in place once the user has submitted something", () => {
		const { ctx, helpers } = makeHarness();

		helpers.addMessageToChat(userMessage("hello"));
		helpers.flushDeferredInjectNotice();
		helpers.addMessageToChat(createContextInjectionMessage([AGENTS_MD], Date.now()));

		expect(blockKinds(ctx)).toEqual(["user", "inject"]);
	});

	it("publishes a notice for a command the user ran, without waiting for a prompt", () => {
		const { ctx, helpers } = makeHarness();

		// The command is the user's own action, and the session re-derives the
		// injected context because of it: the notice belongs on screen now.
		helpers.markUserSubmission();
		helpers.presentInjectNotice([AGENTS_MD]);

		expect(blockKinds(ctx)).toEqual(["inject"]);
	});

	it("folds several startup sets into the one notice that follows the first message", () => {
		const { ctx, helpers } = makeHarness();

		helpers.presentInjectNotice([AGENTS_MD]);
		helpers.presentInjectNotice([SKILLS]);
		helpers.addMessageToChat(userMessage("hello"));
		helpers.flushDeferredInjectNotice();

		expect(blockKinds(ctx)).toEqual(["user", "inject"]);
		const rendered = stripVTControlCharacters(notices(ctx)[0]!.render(120).join("\n"));
		expect(rendered).toContain("AGENTS.md");
		expect(rendered).toContain("Skills");
	});

	it("merges a later set into the live-tail notice", () => {
		const { ctx, helpers } = makeHarness();

		helpers.addMessageToChat(userMessage("hello"));
		helpers.flushDeferredInjectNotice();
		helpers.presentInjectNotice([AGENTS_MD]);
		helpers.presentInjectNotice([SKILLS]);

		expect(notices(ctx)).toHaveLength(1);
		expect(stripVTControlCharacters(notices(ctx)[0]!.render(120).join("\n"))).toContain("Skills");
	});

	it("merges a set that lands between the optimistic render and the run gate", () => {
		const { ctx, helpers } = makeHarness();

		helpers.addMessageToChat(createContextInjectionMessage([AGENTS_MD], Date.now()));
		// The request is already on screen (optimistic render) while the held
		// notice still waits for message_start to publish it behind the gate.
		helpers.addMessageToChat(userMessage("hello"));
		helpers.presentInjectNotice([SKILLS]);
		helpers.flushDeferredInjectNotice();

		expect(blockKinds(ctx)).toEqual(["user", "inject"]);
		const rendered = stripVTControlCharacters(notices(ctx)[0]!.render(120).join("\n"));
		expect(rendered).toContain("AGENTS.md");
		expect(rendered).toContain("Skills");
	});

	it("drops a held notice when the transcript it belonged to is discarded", () => {
		const { ctx, helpers } = makeHarness();

		helpers.presentInjectNotice([AGENTS_MD]);
		// `/new` and session switches reset the transcript; the held notice must
		// not leak onto the next session's first user message.
		helpers.resetInjectNotices();
		helpers.addMessageToChat(userMessage("hello"));

		expect(blockKinds(ctx)).toEqual(["user"]);
	});

	it("publishes the notice behind the run gate so a collapse takes it along", () => {
		const { ctx, helpers } = makeHarness();
		const gate = new Container();
		const injection = createContextInjectionMessage([AGENTS_MD], Date.now());
		const request = userMessage("hello");

		helpers.renderSessionContext({ messages: [injection, request] } as SessionContext, {
			insertAfterMessage: message => (message === request ? gate : undefined),
		});

		// [request, gate, notice]: the completed-run span starts at the gate, so
		// the notice is inside the span the collapse will hide.
		expect(blockKinds(ctx)).toEqual(["user", "Container", "inject"]);
	});

	it("keeps the notice out of a replay whose run is already collapsed", () => {
		const { ctx, helpers } = makeHarness();
		const summary = new Container();
		collapsedRunProjections.add(summary);
		const injection = createContextInjectionMessage([AGENTS_MD], Date.now());
		const request = userMessage("hello");

		// A collapsed replay leaves the request and the summary row only; the
		// notice belongs to the hidden span and must not resurface below it.
		helpers.renderSessionContext({ messages: [injection, request] } as SessionContext, {
			insertAfterMessage: message => (message === request ? summary : undefined),
		});

		expect(blockKinds(ctx)).toEqual(["user", "Container"]);
	});

	it("holds a resumed session's own context until the user submits there", () => {
		const { ctx, helpers } = makeHarness();
		const replayed = createContextInjectionMessage([AGENTS_MD], Date.now());
		const request = userMessage("hello");
		// The resumed session replays its journal: the previous session's context
		// notice and the request it belonged to are history on screen.
		helpers.renderSessionContext({ messages: [replayed, request] } as SessionContext);
		const startup = createContextInjectionMessage([SKILLS], Date.now());

		// The resumed process assembles its own context on launch. Its notice is
		// not a reaction to anything the user did here, so it must wait even
		// though the replayed transcript already shows a user request.
		helpers.addMessageToChat(startup);
		helpers.presentInjectNotice([SKILLS]);
		expect(notices(ctx)).toHaveLength(1);

		helpers.addMessageToChat(userMessage("second"));
		helpers.flushDeferredInjectNotice();

		expect(notices(ctx)).toHaveLength(2);
		expect(blockKinds(ctx)).toEqual(["user", "inject", "user", "inject"]);
	});
});
