import { Copy, Minus, Square, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { type DesktopBridge, desktopBridge } from "../../lib/desktop-bridge";

export interface DesktopFrameProps {
	children: ReactNode;
	bridge?: DesktopBridge;
}

/** Tauri-only custom window chrome; ordinary browser sessions remain unchanged. */
export function DesktopFrame({ children, bridge = desktopBridge }: DesktopFrameProps): ReactNode {
	const [maximized, setMaximized] = useState(false);
	const [title, setTitle] = useState(() => (typeof document === "undefined" ? "Oh My Pi" : document.title));

	useEffect(() => {
		if (!bridge.runtime) return;
		let active = true;
		void bridge
			.windowIsMaximized()
			.then(value => {
				if (active) setMaximized(value);
			})
			.catch(() => {});
		const titleElement = document.querySelector("title");
		if (titleElement === null) {
			return () => {
				active = false;
			};
		}
		const observer = new MutationObserver(() => setTitle(document.title));
		observer.observe(titleElement, { childList: true });
		return () => {
			active = false;
			observer.disconnect();
		};
	}, [bridge]);

	if (!bridge.runtime) return children;

	const toggleMaximize = (): void => {
		void bridge
			.windowToggleMaximize()
			.then(setMaximized)
			.catch(() => {});
	};

	return (
		<div className="sh-desktop-frame">
			<header className="sh-desktop-titlebar" data-tauri-drag-region>
				<div
					className="sh-desktop-drag-region"
					data-tauri-drag-region
					onPointerDown={event => {
						if (event.button === 0 && event.detail === 1) void bridge.windowStartDragging().catch(() => {});
					}}
					onDoubleClick={toggleMaximize}
				>
					<span className="sh-desktop-mark" aria-hidden="true" />
					<span className="sh-desktop-title">{title || "Oh My Pi"}</span>
				</div>
				<div className="sh-desktop-window-controls">
					<button
						type="button"
						className="sh-desktop-window-button"
						onClick={() => void bridge.windowMinimize()}
						aria-label="minimize window"
						title="Minimize"
					>
						<Minus size={14} aria-hidden="true" />
					</button>
					<button
						type="button"
						className="sh-desktop-window-button"
						onClick={toggleMaximize}
						aria-label={maximized ? "restore window" : "maximize window"}
						title={maximized ? "Restore" : "Maximize"}
					>
						{maximized ? <Copy size={12} aria-hidden="true" /> : <Square size={11} aria-hidden="true" />}
					</button>
					<button
						type="button"
						className="sh-desktop-window-button sh-desktop-window-close"
						onClick={() => void bridge.windowClose()}
						aria-label="close window"
						title="Close to tray"
					>
						<X size={15} aria-hidden="true" />
					</button>
				</div>
			</header>
			<div className="sh-desktop-content">{children}</div>
		</div>
	);
}
