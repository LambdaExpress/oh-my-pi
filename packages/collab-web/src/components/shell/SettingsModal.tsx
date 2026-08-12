import {
	ArrowLeft,
	CircleGauge,
	Folder,
	Monitor,
	Moon,
	Network,
	Palette,
	PanelsTopLeft,
	Settings2,
	ShieldCheck,
	Sparkles,
	Sun,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { type ThemePreference, useThemePreference } from "../../lib/theme";

export interface SettingsModalProps {
	onClose(): void;
	/** Read-only session metadata. Omitted values are reported as unavailable. */
	project?: string | null;
	session?: string | null;
	readOnly?: boolean | null;
	connection?: string | null;
	model?: string | null;
	context?: string | null;
}

type SettingsSection = "general" | "appearance";

const THEME_OPTIONS: readonly {
	preference: ThemePreference;
	label: string;
	description: string;
	Icon: typeof Monitor;
}[] = [
	{ preference: "system", label: "System", description: "Match your device appearance", Icon: Monitor },
	{ preference: "light", label: "Light", description: "Use the light appearance", Icon: Sun },
	{ preference: "dark", label: "Dark", description: "Use the dark appearance", Icon: Moon },
];

const UNAVAILABLE = "Not available";

/**
 * Settings sheet. Theme is the only writable preference; session facts remain
 * metadata so the surface never implies unsupported controls.
 */
export function SettingsModal({
	onClose,
	project,
	session,
	readOnly,
	connection,
	model,
	context,
}: SettingsModalProps): ReactNode {
	const { preference, resolved, setPreference } = useThemePreference();
	const [section, setSection] = useState<SettingsSection>("general");
	const surfaceRef = useRef<HTMLDivElement>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const returnFocusRef = useRef<HTMLElement | null>(
		typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
	);
	const choose = (pref: ThemePreference): void => setPreference(pref);

	useEffect(() => {
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		surfaceRef.current?.focus();

		const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			onCloseRef.current();
		};
		document.addEventListener("keydown", closeOnEscape);

		return () => {
			document.removeEventListener("keydown", closeOnEscape);
			document.body.style.overflow = previousOverflow;
			returnFocusRef.current?.focus();
		};
	}, []);

	const trapFocus = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (event.key !== "Tab") return;
		const focusable = surfaceRef.current?.querySelectorAll<HTMLElement>(
			'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
		);
		if (!focusable || focusable.length === 0) return;
		const first = focusable.item(0);
		const last = focusable.item(focusable.length - 1);
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	};

	const closeFromBackdrop = (): void => {
		if (window.matchMedia("(max-width: 720px)").matches) onClose();
	};

	const access = readOnly == null ? UNAVAILABLE : readOnly ? "Read only" : "Read and write";
	const activeLabel = section === "general" ? "General" : "Appearance";

	return (
		<div className="sh-settings-backdrop" onClick={closeFromBackdrop}>
			<div
				className="sh-settings-sheet"
				role="dialog"
				aria-modal="true"
				aria-label="Settings"
				tabIndex={-1}
				ref={surfaceRef}
				onKeyDown={trapFocus}
				onClick={event => event.stopPropagation()}
			>
				<aside className="sh-settings-sidebar" aria-label="Settings categories">
					<button type="button" className="sh-settings-back" onClick={onClose} aria-label="Back to application">
						<ArrowLeft size={18} aria-hidden="true" />
						<span>Back to application</span>
					</button>
					<div className="sh-settings-sidebar-title">Settings</div>
					<nav className="sh-settings-nav" aria-label="Settings sections">
						<button
							type="button"
							className={section === "general" ? "sh-settings-nav-item is-active" : "sh-settings-nav-item"}
							aria-current={section === "general" ? "page" : undefined}
							aria-controls="sh-settings-panel-general"
							onClick={() => setSection("general")}
						>
							<Settings2 size={18} aria-hidden="true" />
							<span>General</span>
						</button>
						<button
							type="button"
							className={section === "appearance" ? "sh-settings-nav-item is-active" : "sh-settings-nav-item"}
							aria-current={section === "appearance" ? "page" : undefined}
							aria-controls="sh-settings-panel-appearance"
							onClick={() => setSection("appearance")}
						>
							<Palette size={18} aria-hidden="true" />
							<span>Appearance</span>
						</button>
					</nav>
				</aside>

				<main className="sh-settings-main">
					<div className="sh-settings-content">
						<header className="sh-settings-head">
							<p className="sh-settings-eyebrow">{activeLabel}</p>
							<h1 className="sh-settings-title">Settings</h1>
							<p className="sh-settings-description">Manage local appearance and inspect the active session.</p>
						</header>

						{section === "general" && (
							<section
								className="sh-settings-section"
								id="sh-settings-panel-general"
								aria-labelledby="sh-settings-general-title"
							>
								<div className="sh-settings-section-head">
									<h2 id="sh-settings-general-title">Session information</h2>
									<p>Read-only details supplied by the current session.</p>
								</div>
								<dl className="sh-settings-metadata">
									<div className="sh-settings-metadata-row">
										<dt>
											<Folder size={16} aria-hidden="true" /> Current project
										</dt>
										<dd title={project ?? undefined}>{project ?? UNAVAILABLE}</dd>
									</div>
									<div className="sh-settings-metadata-row">
										<dt>
											<PanelsTopLeft size={16} aria-hidden="true" /> Session
										</dt>
										<dd title={session ?? undefined}>{session ?? UNAVAILABLE}</dd>
									</div>
									<div className="sh-settings-metadata-row">
										<dt>
											<ShieldCheck size={16} aria-hidden="true" /> Access
										</dt>
										<dd>{access}</dd>
									</div>
									<div className="sh-settings-metadata-row">
										<dt>
											<Network size={16} aria-hidden="true" /> Connection
										</dt>
										<dd>{connection ?? UNAVAILABLE}</dd>
									</div>
									<div className="sh-settings-metadata-row">
										<dt>
											<Sparkles size={16} aria-hidden="true" /> Model
										</dt>
										<dd title={model ?? undefined}>{model ?? UNAVAILABLE}</dd>
									</div>
									<div className="sh-settings-metadata-row">
										<dt>
											<CircleGauge size={16} aria-hidden="true" /> Context
										</dt>
										<dd>{context ?? UNAVAILABLE}</dd>
									</div>
								</dl>
							</section>
						)}

						{section === "appearance" && (
							<section
								className="sh-settings-section"
								id="sh-settings-panel-appearance"
								aria-labelledby="sh-settings-appearance-title"
							>
								<div className="sh-settings-section-head">
									<h2 id="sh-settings-appearance-title">Theme</h2>
									<p>Stored locally for this browser. System currently resolves to {resolved}.</p>
								</div>
								<div className="sh-settings-themes" role="radiogroup" aria-label="Theme preference">
									{THEME_OPTIONS.map(({ preference: option, label, description, Icon }) => (
										<label
											key={option}
											className={
												preference === option ? "sh-settings-theme is-selected" : "sh-settings-theme"
											}
										>
											<span className="sh-settings-theme-copy">
												<Icon size={18} aria-hidden="true" />
												<span>
													<strong>{label}</strong>
													<small>{description}</small>
												</span>
											</span>
											<input
												type="radio"
												name="theme"
												value={option}
												checked={preference === option}
												onChange={() => choose(option)}
											/>
										</label>
									))}
								</div>
							</section>
						)}
					</div>
				</main>
			</div>
		</div>
	);
}
