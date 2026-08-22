import { ArrowUp, Folder, SendHorizontal, Square } from "lucide-react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GuestClient, GuestSnapshot } from "../../lib/client";
import { desktopBridge } from "../../lib/desktop-bridge";
import { shortenPath } from "../../lib/format";
import { ModelPicker, ThinkingPicker } from "./ModelPicker";

export interface ComposerProps {
	client: GuestClient;
	snapshot: GuestSnapshot;
}

export interface NewSessionComposerProps {
	cwd: string | undefined;
	pending: boolean;
	disabled: boolean;
	onSubmit(prompt: string): void;
}

/** Textarea metrics: line-height 20px + 8px vertical padding × 2 (kept in sync with composer.css). */
const LINE_PX = 20;
const PAD_Y = 16;
const MAX_ROWS = 8;

function autosize(el: HTMLTextAreaElement | null): void {
	if (!el) return;
	el.style.height = "0px";
	const max = MAX_ROWS * LINE_PX + PAD_Y;
	el.style.height = `${Math.max(LINE_PX + PAD_Y, Math.min(el.scrollHeight, max))}px`;
	el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
}

/**
 * Decides whether an Enter keydown should commit the composer. Returns `false` while an IME
 * composition is active so the keystroke confirms the composition instead of submitting.
 * `nativeEvent.isComposing` covers most browsers; `composing` bridges WebKit, which fires the
 * confirming Enter keydown *after* `compositionend`.
 */
export function shouldSubmitOnEnter(e: KeyboardEvent<HTMLTextAreaElement>, composing: boolean): boolean {
	if (e.key !== "Enter" || e.shiftKey) return false;
	return !(e.nativeEvent.isComposing || composing);
}

/**
 * Tracks IME composition state via a ref the keydown handler reads synchronously. The
 * `compositionend` reset is deferred a tick because WebKit dispatches the confirming Enter
 * keydown after `compositionend`, when `nativeEvent.isComposing` is already `false`.
 */
function useCompositionGuard(): {
	composingRef: RefObject<boolean>;
	onCompositionStart(): void;
	onCompositionEnd(): void;
} {
	const composingRef = useRef(false);
	const onCompositionStart = useCallback((): void => {
		composingRef.current = true;
	}, []);
	const onCompositionEnd = useCallback((): void => {
		setTimeout(() => {
			composingRef.current = false;
		}, 0);
	}, []);
	return { composingRef, onCompositionStart, onCompositionEnd };
}

interface AskEditorProps {
	prefill: string | undefined;
	onSubmit(value: string): void;
}

/**
 * Editor ask input. Rendered with `key={reqId}` so a new request remounts it with a fresh
 * draft seeded from `prefill`, while re-sends of the same request never clobber a half-typed
 * draft. Submits verbatim — whitespace-only responses are intentional.
 */
function AskEditor({ prefill, onSubmit }: AskEditorProps): ReactNode {
	const [draft, setDraft] = useState(prefill ?? "");
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [draft]);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (shouldSubmitOnEnter(e, composingRef.current)) {
			e.preventDefault();
			onSubmit(draft);
		}
	};

	return (
		<div className="sh-composer-editor">
			<textarea
				ref={taRef}
				className="sh-composer-input"
				value={draft}
				onChange={e => setDraft(e.target.value)}
				onKeyDown={onKeyDown}
				onCompositionStart={onCompositionStart}
				onCompositionEnd={onCompositionEnd}
				placeholder="type your response…"
				rows={1}
				spellCheck={false}
			/>
			<div className="sh-composer-controls sh-ask-editor-controls">
				<span className="sh-composer-hint">Enter to submit · Shift+Enter for newline</span>
				<button
					type="button"
					className="sh-composer-submit"
					onClick={() => onSubmit(draft)}
					title="submit response"
				>
					<SendHorizontal size={13} />
					Submit
				</button>
			</div>
		</div>
	);
}

function Workspace({ cwd }: { cwd: string | undefined }): ReactNode {
	const [desktopAvailable, setDesktopAvailable] = useState(desktopBridge.available);
	useEffect(() => {
		let active = true;
		void desktopBridge
			.listProjects()
			.then(() => {
				if (active) setDesktopAvailable(desktopBridge.available);
			})
			.catch(() => {
				if (active) setDesktopAvailable(false);
			});
		return () => {
			active = false;
		};
	}, []);

	if (!cwd) return <span className="sh-workspace sh-workspace-empty">workspace unavailable</span>;

	const normalized = cwd.replace(/[\\/]+$/, "");
	const segments = normalized.split(/[\\/]/);
	const project = segments[segments.length - 1] || cwd;
	return (
		<button
			type="button"
			className="sh-workspace sh-workspace-button"
			disabled={!desktopAvailable}
			onClick={() => void desktopBridge.openProject().catch(() => {})}
			title="select project folder"
			aria-label={`select project folder (current: ${cwd})`}
		>
			<Folder size={13} aria-hidden="true" />
			<span className="sh-workspace-project">{project}</span>
			<span className="sh-workspace-path">{shortenPath(cwd)}</span>
		</button>
	);
}

function ContextGauge({ snapshot }: { snapshot: GuestSnapshot }): ReactNode {
	const usage = snapshot.state?.contextUsage;
	const percent =
		usage?.percent ??
		(usage?.tokens != null && usage.contextWindow !== null && usage.contextWindow > 0
			? (usage.tokens / usage.contextWindow) * 100
			: null);
	if (percent === null || !Number.isFinite(percent)) return null;
	const clamped = Math.min(100, Math.max(0, percent));
	const rounded = Math.round(clamped);
	return (
		<span
			className={clamped > 80 ? "sh-context-gauge sh-context-gauge-warn" : "sh-context-gauge"}
			title={`context usage · ${rounded}%`}
			aria-label={`context usage ${rounded}%`}
		>
			<svg viewBox="0 0 24 24" aria-hidden="true">
				<circle className="sh-context-gauge-track" cx="12" cy="12" r="9" pathLength="100" />
				<circle
					className="sh-context-gauge-fill"
					cx="12"
					cy="12"
					r="9"
					pathLength="100"
					strokeDasharray={`${clamped} 100`}
				/>
			</svg>
			<span>{rounded}</span>
		</span>
	);
}

/** Composer shown on the control-room home before a concrete session exists. */
export function NewSessionComposer({ cwd, pending, disabled, onSubmit }: NewSessionComposerProps): ReactNode {
	const [text, setText] = useState("");
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();
	const unavailable = disabled || pending;
	const canSend = !unavailable && text.trim().length > 0;

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [text]);

	const send = useCallback((): void => {
		const prompt = text.trim();
		if (!prompt || unavailable) return;
		onSubmit(prompt);
	}, [onSubmit, text, unavailable]);

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (!shouldSubmitOnEnter(event, composingRef.current)) return;
		event.preventDefault();
		send();
	};

	return (
		<div className="sh-composer sh-new-session-composer">
			<div className="sh-composer-card">
				<textarea
					ref={taRef}
					className="sh-composer-input"
					value={text}
					onChange={event => setText(event.target.value)}
					onKeyDown={onKeyDown}
					onCompositionStart={onCompositionStart}
					onCompositionEnd={onCompositionEnd}
					placeholder={pending ? "starting session…" : "prompt the host agent…"}
					disabled={unavailable}
					rows={1}
					spellCheck={false}
					autoFocus={!unavailable}
				/>
				<div className="sh-composer-controls">
					<Workspace cwd={cwd} />
					<span className="sh-composer-control-spacer" />
					<button
						type="button"
						className="sh-composer-send"
						onClick={send}
						disabled={!canSend}
						title="start a new session and send prompt"
						aria-label="start a new session and send prompt"
					>
						<ArrowUp size={14} />
					</button>
				</div>
			</div>
		</div>
	);
}

export function Composer({ client, snapshot }: ComposerProps): ReactNode {
	const [text, setText] = useState("");
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();

	const live = snapshot.phase === "live";
	const readOnly = snapshot.readOnly;
	const uiRequest = snapshot.uiRequest;
	const canPrompt = live && !readOnly;
	const busy = snapshot.working;
	const queued = snapshot.state?.queuedMessageCount ?? 0;
	const canSend = canPrompt && text.trim().length > 0;
	const thinkingLevels = snapshot.state?.availableThinkingLevels ?? [];
	const configuredThinkingLevel = snapshot.state?.configuredThinkingLevel;

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [text, uiRequest?.reqId]);

	const send = useCallback((): void => {
		const trimmed = text.trim();
		if (!trimmed || !live || readOnly) return;
		client.sendPrompt(trimmed);
		setText("");
	}, [client, live, readOnly, text]);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (shouldSubmitOnEnter(e, composingRef.current)) {
			e.preventDefault();
			send();
		}
	};

	if (uiRequest && canPrompt) {
		return (
			<div className="sh-composer sh-composer-ask">
				<div className="sh-composer-card">
					<div className="sh-ask-title">{uiRequest.title}</div>
					{uiRequest.kind === "select" ? (
						<div className="sh-ask-options">
							{uiRequest.options.map((option, index) => {
								const label = typeof option === "string" ? option : option.label;
								const checked = uiRequest.checkedIndices?.includes(index) ?? false;
								return (
									<button
										key={`${uiRequest.reqId}-${index}-${label}`}
										type="button"
										className={`sh-ask-option${checked ? " sh-ask-option-checked" : ""}`}
										onClick={() => client.sendUiResponse(uiRequest.reqId, label)}
									>
										<span className="sh-ask-option-marker">
											{uiRequest.selectionMarker === "checkbox"
												? checked
													? "☑"
													: "☐"
												: checked
													? "◉"
													: "○"}
										</span>
										<span className="sh-ask-option-copy">
											<span className="sh-ask-option-label">{label}</span>
											{typeof option !== "string" && option.description && (
												<span className="sh-ask-option-description">{option.description}</span>
											)}
										</span>
									</button>
								);
							})}
						</div>
					) : (
						<AskEditor
							key={uiRequest.reqId}
							prefill={uiRequest.prefill}
							onSubmit={value => client.sendUiResponse(uiRequest.reqId, value)}
						/>
					)}
					<div className="sh-composer-controls sh-ask-actions">
						<Workspace cwd={snapshot.state?.cwd} />
						<span className="sh-composer-control-spacer" />
						<button type="button" className="sh-btn" onClick={() => client.sendUiResponse(uiRequest.reqId)}>
							Cancel
						</button>
						{busy && (
							<button
								type="button"
								className="sh-composer-send sh-composer-stop"
								onClick={() => client.sendAbort()}
								disabled={!live}
								title="stop the current turn"
								aria-label="stop the current turn"
							>
								<Square size={12} fill="currentColor" />
							</button>
						)}
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="sh-composer">
			<div className="sh-composer-card">
				<textarea
					ref={taRef}
					className="sh-composer-input"
					value={text}
					onChange={e => setText(e.target.value)}
					onKeyDown={onKeyDown}
					onCompositionStart={onCompositionStart}
					onCompositionEnd={onCompositionEnd}
					placeholder={
						readOnly
							? "read-only session — watching only"
							: live
								? "prompt the host agent…"
								: "waiting for session…"
					}
					disabled={!canPrompt}
					rows={1}
					spellCheck={false}
				/>
				<div className="sh-composer-controls">
					<Workspace cwd={snapshot.state?.cwd} />
					{thinkingLevels.length > 0 && configuredThinkingLevel && (
						<ThinkingPicker
							levels={thinkingLevels}
							value={configuredThinkingLevel}
							disabled={!canPrompt}
							onChange={level => client.sendThinkingChange(level)}
						/>
					)}
					<ModelPicker
						snapshot={snapshot}
						disabled={!canPrompt}
						onModelList={() => client.sendModelList()}
						onModelChange={(provider, id) => client.sendModelChange(provider, id)}
					/>
					<span className="sh-composer-control-spacer" />
					{busy && queued > 0 && (
						<span className="sh-queued">
							<span className="sh-queued-label">queued </span>×{queued}
						</span>
					)}
					<ContextGauge snapshot={snapshot} />
					{busy && !readOnly ? (
						<button
							type="button"
							className="sh-composer-send sh-composer-stop"
							onClick={() => client.sendAbort()}
							disabled={!live}
							title="stop the current turn"
							aria-label="stop the current turn"
						>
							<Square size={12} fill="currentColor" />
						</button>
					) : (
						<button
							type="button"
							className="sh-composer-send"
							onClick={send}
							disabled={!canSend}
							title="send (Enter)"
							aria-label="send prompt"
						>
							<ArrowUp size={14} />
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
