import { describe, expect, it } from "bun:test";
import type { KeyboardEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GuestClient } from "../src/lib/client";
import type { ComposerProps } from "../src/components/shell/Composer";
import { Composer, NewSessionComposer, shouldSubmitOnEnter } from "../src/components/shell/Composer";
import { ModelPicker } from "../src/components/shell/ModelPicker";
import { encodeBase64Url } from "../src/lib/link";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;
const client = new GuestClient(LINK, "tester");

function props(uiRequest: ComposerProps["uiRequest"]): ComposerProps {
	return {
		client,
		phase: "live",
		state: { isStreaming: true, queuedMessageCount: 0, cwd: "/work", participants: [] },
		working: true,
		readOnly: false,
		uiRequest,
		models: null,
		queuedMessageCount: 0,
	};
}

function renderComposer(overrides: Partial<ComposerProps> = {}): string {
	return renderToStaticMarkup(<Composer {...props(null)} working={false} {...overrides} />);
}

describe("Composer host UI requests", () => {
	it("renders selectable ask responses for mobile guests", () => {
		const html = renderToStaticMarkup(
			<Composer
				{...props({
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
			<Composer {...props({ reqId: 2, kind: "editor", title: "Other", prefill: "draft" })} />,
		);

		expect(html).toContain("Other");
		expect(html).toContain("draft");
		expect(html).toContain("Submit");
	});

	it("keeps the editor submit enabled for whitespace-only drafts", () => {
		const html = renderToStaticMarkup(
			<Composer {...props({ reqId: 3, kind: "editor", title: "Other", prefill: "   " })} />,
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
		const snap = props(null);
		snap.working = false;
		snap.state = {
			isStreaming: false,
			queuedMessageCount: 0,
			cwd: "/work/oh-my-pi",
			model: { id: "sonnet", name: "Sonnet", provider: "anthropic", contextWindow: 200_000 },
			contextUsage: { tokens: 80_000, contextWindow: 200_000, percent: 40 },
			participants: [],
		};

		const html = renderToStaticMarkup(<Composer {...snap} />);

		expect(html).toContain('class="sh-composer-card"');
		expect(html).toContain('class="sh-workspace sh-workspace-button" disabled=""');
		expect(html).toContain('title="select project folder"');
		expect(html).toContain('class="sh-workspace-project">oh-my-pi');
		expect(html).toContain('title="switch model"');
		expect(html).toContain('aria-label="context usage 40%"');
		expect(html).not.toContain("<select");
	});

	it("disables prompt entry and sending in read-only and waiting sessions", () => {
		for (const overrides of [{ readOnly: true }, { phase: "waiting" as const }]) {
			const controls = { input: false, send: false };
			new HTMLRewriter()
				.on("textarea.sh-composer-input", {
					element(el) {
						controls.input = el.hasAttribute("disabled");
					},
				})
				.on("button.sh-composer-send", {
					element(el) {
						controls.send = el.hasAttribute("disabled");
					},
				})
				.transform(renderComposer(overrides));

			expect(controls).toEqual({ input: true, send: true });
		}
	});

	it("keeps queue and abort controls observable while the host is working", () => {
		const snap = props(null);
		snap.queuedMessageCount = 2;
		const html = renderToStaticMarkup(<Composer {...snap} />);

		expect(html).toContain("queued");
		expect(html).toContain("×2");
		expect(html).toContain('class="sh-composer-send sh-composer-stop"');
		expect(html).toContain('aria-label="stop the current turn"');
		expect(html).not.toContain('aria-label="send prompt"');
	});

	it("renders host-advertised thinking levels with the configured selector selected", () => {
		const snap = props(null);
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

		const html = renderToStaticMarkup(<Composer {...snap} />);

		expect(html).toContain('title="change thinking level"');
		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain(">Auto</span>");
		expect(html).not.toContain("<select");
	});

	it("hides unavailable thinking controls and disables them for read-only sessions", () => {
		const unavailable = props(null);
		unavailable.working = false;
		unavailable.state = { ...unavailable.state!, isStreaming: false };
		const readOnly = props(null);
		readOnly.working = false;
		readOnly.readOnly = true;
		readOnly.state = {
			...readOnly.state!,
			isStreaming: false,
			configuredThinkingLevel: "high",
			availableThinkingLevels: ["off", "auto", "low", "high"],
		};

		expect(renderToStaticMarkup(<Composer {...unavailable} />)).not.toContain(
			'title="change thinking level"',
		);
		const readOnlyHtml = renderToStaticMarkup(<Composer {...readOnly} />);
		expect(readOnlyHtml).toContain('title="change thinking level"');
		expect(readOnlyHtml).toContain('class="sh-composer-picker-trigger" disabled=""');
	});
});

describe("ModelPicker model states", () => {
	it("renders the unloaded model state without treating a missing fixture field as an empty list", () => {
		const snap = props(null);
		const html = renderToStaticMarkup(
			<ModelPicker
				model={snap.state?.model}
				models={snap.models}
				onModelList={() => {}}
				onModelChange={() => {}}
			/>,
		);

		expect(snap.models).toBeNull();
		expect(html).toContain("Select model");
		expect(html).toContain('aria-expanded="false"');
		expect(html).not.toContain("no models available");
	});

	it("renders the selected model from session state", () => {
		const snap = props(null);
		snap.state = {
			...snap.state!,
			model: { id: "opus", name: "Opus", provider: "anthropic", contextWindow: 200_000 },
		};
		snap.models = [snap.state.model!];
		const html = renderToStaticMarkup(
			<ModelPicker
				model={snap.state.model}
				models={snap.models}
				onModelList={() => {}}
				onModelChange={() => {}}
			/>,
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
