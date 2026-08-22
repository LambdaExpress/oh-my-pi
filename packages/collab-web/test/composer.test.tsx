import { describe, expect, it } from "bun:test";
import type { KeyboardEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GuestSnapshot } from "../src/lib/client";
import { GuestClient } from "../src/lib/client";
import { Composer, NewSessionComposer, shouldSubmitOnEnter } from "../src/components/shell/Composer";
import { ModelPicker } from "../src/components/shell/ModelPicker";
import { encodeBase64Url } from "../src/lib/link";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;
const client = new GuestClient(LINK, "tester");

function snapshot(uiRequest: GuestSnapshot["uiRequest"]): GuestSnapshot {
	return {
		phase: "live",
		endedReason: null,
		header: null,
		entries: [],
		state: { isStreaming: true, queuedMessageCount: 0, cwd: "/work", participants: [] },
		agents: [],
		progress: new Map(),
		lifecycle: new Map(),
		stream: null,
		streamDone: false,
		activeTools: new Map(),
		working: true,
		readOnly: false,
		uiRequest,
		models: null,
		notices: [],
	};
}

function renderComposer(overrides: Partial<GuestSnapshot> = {}): string {
	return renderToStaticMarkup(<Composer client={client} snapshot={{ ...snapshot(null), working: false, ...overrides }} />);
}

describe("Composer host UI requests", () => {
	it("renders selectable ask responses for mobile guests", () => {
		const html = renderToStaticMarkup(
			<Composer
				client={client}
				snapshot={snapshot({
					reqId: 1,
					kind: "select",
					title: "Continue?",
					options: ["Yes", { label: "No", description: "Stop here" }],
					selectionMarker: "radio",
				})}
			/>,
		);

		expect(html).toContain("Continue?");
		expect(html).toContain("Yes");
		expect(html).toContain("Stop here");
	});

	it("renders a submit field for custom ask responses", () => {
		const html = renderToStaticMarkup(
			<Composer client={client} snapshot={snapshot({ reqId: 2, kind: "editor", title: "Other", prefill: "draft" })} />,
		);

		expect(html).toContain("Other");
		expect(html).toContain("draft");
		expect(html).toContain("Submit");
	});

	it("keeps the editor submit enabled for whitespace-only drafts", () => {
		const html = renderToStaticMarkup(
			<Composer client={client} snapshot={snapshot({ reqId: 3, kind: "editor", title: "Other", prefill: "   " })} />,
		);

		const submit = { found: false, disabled: false };
		new HTMLRewriter()
			.on('button[title="submit response"]', {
				element(el) {
					submit.found = true;
					submit.disabled = el.hasAttribute("disabled");
				},
			})
			.transform(html);

		expect(submit.found).toBe(true);
		expect(submit.disabled).toBe(false);
	});
});

describe("Composer session metadata and controls", () => {
	it("renders an enabled first-prompt composer before a session exists", () => {
		const html = renderToStaticMarkup(
			<NewSessionComposer cwd="D:/project/21cp" pending={false} disabled={false} onSubmit={() => {}} />,
		);

		expect(html).toContain('placeholder="prompt the host agent…"');
		expect(html).toContain('aria-label="start a new session and send prompt"');
		expect(html).toContain('class="sh-workspace-project">21cp');
		expect(html).toContain('class="sh-composer-input" placeholder="prompt the host agent…"');
		expect(html).toContain('class="sh-composer-send" disabled=""');
	});

	it("renders the real cwd as plain workspace metadata and keeps model selection in the bottom controls", () => {
		const snap = snapshot(null);
		snap.working = false;
		snap.state = {
			isStreaming: false,
			queuedMessageCount: 0,
			cwd: "/work/oh-my-pi",
			model: { id: "sonnet", name: "Sonnet", provider: "anthropic", contextWindow: 200_000 },
			contextUsage: { tokens: 80_000, contextWindow: 200_000, percent: 40 },
			participants: [],
		};

		const html = renderToStaticMarkup(<Composer client={client} snapshot={snap} />);

		expect(html).toContain('class="sh-composer-card"');
		expect(html).toContain('class="sh-workspace sh-workspace-button" disabled=""');
		expect(html).toContain('title="select project folder"');
		expect(html).toContain('class="sh-workspace-project">oh-my-pi');
		expect(html).toContain('title="switch model"');
		expect(html).toContain('aria-label="context usage 40%"');
		expect(html).not.toContain("<select");
	});

	it("keeps read-only and waiting composer states disabled with accurate placeholders", () => {
		const readOnly = renderComposer({ readOnly: true });
		const waiting = renderComposer({ phase: "waiting" });

		expect(readOnly).toContain("read-only session — watching only");
		expect(readOnly).toContain('disabled=""');
		expect(waiting).toContain("waiting for session…");
		expect(waiting).toContain('disabled=""');
	});

	it("keeps queue and abort controls observable while the host is working", () => {
		const snap = snapshot(null);
		snap.state = { ...snap.state!, queuedMessageCount: 2 };
		const html = renderToStaticMarkup(<Composer client={client} snapshot={snap} />);

		expect(html).toContain("queued");
		expect(html).toContain("×2");
		expect(html).toContain('class="sh-composer-send sh-composer-stop"');
		expect(html).toContain('aria-label="stop the current turn"');
		expect(html).not.toContain("sh-btn-stop");
		expect(html).not.toContain(">Stop</span>");
		expect(html).not.toContain('aria-label="send prompt"');
	});

	it("renders host-advertised thinking levels with the configured selector selected", () => {
		const snap = snapshot(null);
		snap.working = false;
		snap.state = {
			isStreaming: false,
			queuedMessageCount: 0,
			cwd: "/work",
			model: { id: "opus", name: "Opus", provider: "anthropic", contextWindow: 200_000 },
			thinkingLevel: "medium",
			configuredThinkingLevel: "auto",
			availableThinkingLevels: ["off", "auto", "low", "medium", "high"],
			participants: [],
		};

		const html = renderToStaticMarkup(<Composer client={client} snapshot={snap} />);

		expect(html).toContain('title="change thinking level"');
		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain(">Auto</span>");
		expect(html).not.toContain("<select");
	});

	it("hides unavailable thinking controls and disables them for read-only sessions", () => {
		const unavailable = snapshot(null);
		unavailable.working = false;
		unavailable.state = { ...unavailable.state!, isStreaming: false };
		const readOnly = snapshot(null);
		readOnly.working = false;
		readOnly.readOnly = true;
		readOnly.state = {
			...readOnly.state!,
			isStreaming: false,
			configuredThinkingLevel: "high",
			availableThinkingLevels: ["off", "auto", "low", "high"],
		};

		expect(renderToStaticMarkup(<Composer client={client} snapshot={unavailable} />)).not.toContain(
			'title="change thinking level"',
		);
		const readOnlyHtml = renderToStaticMarkup(<Composer client={client} snapshot={readOnly} />);
		expect(readOnlyHtml).toContain('title="change thinking level"');
		expect(readOnlyHtml).toContain('class="sh-composer-picker-trigger" disabled=""');
	});
});

describe("ModelPicker model states", () => {
	it("renders the unloaded model state without treating a missing fixture field as an empty list", () => {
		const snap = snapshot(null);
		const html = renderToStaticMarkup(
			<ModelPicker snapshot={snap} onModelList={() => {}} onModelChange={() => {}} />,
		);

		expect(snap.models).toBeNull();
		expect(html).toContain("Select model");
		expect(html).toContain('aria-expanded="false"');
		expect(html).not.toContain("no models available");
	});

	it("renders the selected model from session state", () => {
		const snap = snapshot(null);
		snap.state = {
			...snap.state!,
			model: { id: "opus", name: "Opus", provider: "anthropic", contextWindow: 200_000 },
		};
		snap.models = [snap.state.model!];
		const html = renderToStaticMarkup(
			<ModelPicker snapshot={snap} onModelList={() => {}} onModelChange={() => {}} />,
		);

		expect(html).toContain("Opus");
		expect(html).toContain('title="switch model"');
	});
});

type KeyEvt = KeyboardEvent<HTMLTextAreaElement>;

function keydown(key: string, opts: { shiftKey?: boolean; isComposing?: boolean } = {}): KeyEvt {
	return {
		key,
		shiftKey: opts.shiftKey ?? false,
		nativeEvent: { isComposing: opts.isComposing ?? false },
	} as KeyEvt;
}

describe("shouldSubmitOnEnter IME guard", () => {
	it("submits on a plain Enter with no composition", () => {
		expect(shouldSubmitOnEnter(keydown("Enter"), false)).toBe(true);
	});

	it("does not submit while nativeEvent.isComposing is true", () => {
		expect(shouldSubmitOnEnter(keydown("Enter", { isComposing: true }), false)).toBe(false);
	});

	it("does not submit while the WebKit composing ref is still set", () => {
		expect(shouldSubmitOnEnter(keydown("Enter"), true)).toBe(false);
	});

	it("does not submit on Shift+Enter (newline)", () => {
		expect(shouldSubmitOnEnter(keydown("Enter", { shiftKey: true }), false)).toBe(false);
	});

	it("ignores non-Enter keys", () => {
		expect(shouldSubmitOnEnter(keydown("a"), false)).toBe(false);
	});
});
