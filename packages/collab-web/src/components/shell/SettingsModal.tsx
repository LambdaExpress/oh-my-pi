import { X } from "lucide-react";
import type { ReactNode } from "react";
import { type ThemePreference, useThemePreference } from "../../lib/theme";

export interface SettingsModalProps {
	onClose(): void;
}

/**
 * Settings panel. The only persisted preference today is the theme
 * (`omp-collab-theme` in localStorage, owned by `lib/theme.ts`); the radio
 * pairs the resolved light/dark state with an explicit preference write, so
 * the ThemeToggle and this panel share one store.
 */
export function SettingsModal({ onClose }: SettingsModalProps): ReactNode {
	const { resolved, setPreference } = useThemePreference();
	const choose = (pref: ThemePreference): void => setPreference(pref);

	return (
		<div className="sh-settings-backdrop" onClick={onClose}>
			<div
				className="sh-settings-modal"
				role="dialog"
				aria-label="Settings"
				onClick={event => event.stopPropagation()}
			>
				<div className="sh-settings-head">
					<span className="sh-settings-title">Settings</span>
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={onClose}
						title="close settings"
						aria-label="close settings"
					>
						<X size={14} />
					</button>
				</div>
				<div className="sh-settings-body">
					<div className="sh-settings-section">
						<span className="sh-settings-label">Theme</span>
						<label className="sh-settings-option">
							<input type="radio" name="theme" checked={resolved === "light"} onChange={() => choose("light")} />
							<span>Light</span>
						</label>
						<label className="sh-settings-option">
							<input type="radio" name="theme" checked={resolved === "dark"} onChange={() => choose("dark")} />
							<span>Dark</span>
						</label>
					</div>
				</div>
			</div>
		</div>
	);
}
