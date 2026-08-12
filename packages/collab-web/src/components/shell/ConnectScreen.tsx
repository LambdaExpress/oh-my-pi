import { ArrowRight, RotateCcw } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { ThemeToggle } from "./ThemeToggle";

export interface ConnectScreenProps {
	defaultName: string;
	error: string | null;
	onConnect(link: string, name: string): void;
	/** Optional stored control-room link — shown as a one-click restore hint. */
	savedControlLink?: string | null;
}

export function ConnectScreen({ defaultName, error, onConnect, savedControlLink }: ConnectScreenProps): ReactNode {
	const [link, setLink] = useState("");
	const [name, setName] = useState(defaultName);
	const [localError, setLocalError] = useState<string | null>(null);

	const submit = (e: FormEvent<HTMLFormElement>): void => {
		e.preventDefault();
		const trimmed = link.trim();
		if (!trimmed) {
			setLocalError("paste a join link first");
			return;
		}
		setLocalError(null);
		onConnect(trimmed, name.trim() || "guest");
	};

	const restore = (): void => {
		if (!savedControlLink) return;
		onConnect(savedControlLink, name.trim() || "guest");
	};

	const shown = localError ?? error;

	return (
		<div className="sh-connect">
			<main className="sh-connect-card" aria-labelledby="sh-connect-title">
				<div className="sh-connect-head">
					<div className="sh-lockup">
						<span className="sh-lockup-mark" aria-hidden="true" />
						<span>
							<span className="sh-lockup-pi">π</span> omp collab
						</span>
					</div>
					<ThemeToggle />
				</div>
				<div className="sh-connect-intro">
					<p className="sh-connect-kicker">Browser collaboration</p>
					<h1 id="sh-connect-title">Join a live agent session</h1>
					<p className="sh-connect-sub">Use a secure join link shared from an omp session.</p>
				</div>
				<form className="sh-connect-form" onSubmit={submit} noValidate>
					<label className="sh-field">
						<span className="sh-field-label">Join link</span>
						<input
							className="sh-input sh-input-mono"
							type="text"
							value={link}
							onChange={e => {
								setLink(e.target.value);
								if (localError) setLocalError(null);
							}}
							placeholder="ws://host:port/r/room.key"
							spellCheck={false}
							autoComplete="off"
							autoFocus
							aria-describedby="sh-connect-link-hint"
							aria-invalid={shown ? true : undefined}
							aria-errormessage={shown ? "sh-connect-error" : undefined}
						/>
						<span className="sh-field-hint" id="sh-connect-link-hint">
							Paste the /collab link from your host.
						</span>
					</label>
					<label className="sh-field">
						<span className="sh-field-label">Display name</span>
						<input
							className="sh-input"
							type="text"
							value={name}
							onChange={e => setName(e.target.value)}
							placeholder="guest"
							spellCheck={false}
							autoComplete="off"
							maxLength={32}
						/>
					</label>
					{shown && (
						<div className="sh-connect-error" id="sh-connect-error" role="alert">
							{shown}
						</div>
					)}
					{savedControlLink && (
						<div className="sh-connect-restore">
							<div>
								<strong>Saved control room</strong>
								<span>Continue where you left off.</span>
							</div>
							<button type="button" className="sh-btn" onClick={restore} aria-label="Restore saved control room">
								<RotateCcw size={14} aria-hidden="true" /> Restore
							</button>
						</div>
					)}
					<button className="sh-btn sh-btn-primary sh-connect-submit" type="submit">
						Connect <ArrowRight size={14} aria-hidden="true" />
					</button>
				</form>
			</main>
		</div>
	);
}
