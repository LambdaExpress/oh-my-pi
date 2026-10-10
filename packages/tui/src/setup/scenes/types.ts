import type { AuthStorage, Model } from "@oh-my-pi/pi-ai";
import type { OAuthBrowserSessionRequest } from "@oh-my-pi/pi-ai/oauth/types";
import type { SgrMouseEvent } from "../../mouse";
import type { ComposerPreviewStatusSource } from "../../overlays/composer-shape-preview";
import type { ComposerShape } from "../../overlays/composer-shape-registry";
import type { ModelBrowserSource } from "../../overlays/model-browser";
import type { SymbolPreset, ThemeColor } from "../../theme/theme";
import type { SearchProviderId } from "../../tools/web-search-types";
import type { Component, TUI } from "../../tui";

/** One line of status copy kept as raw text plus its theme colour, never as pre-styled ANSI. */
export interface StyledLine {
	readonly text: string;
	readonly color: ThemeColor;
}

/** Terminal capabilities used by setup overlays and the startup splash. */
export interface SetupUiHost {
	readonly ui: Pick<TUI, "showOverlay" | "setFocus" | "requestRender" | "invalidate"> & {
		readonly terminal: { readonly rows: number };
	};
}

/** Application-owned preferences and effects consumed by setup scenes. */
export interface SetupHost extends SetupUiHost {
	readonly statusLine: ComposerPreviewStatusSource | undefined;
	readonly composerShape: ComposerShape;
	readonly symbolPreset: SymbolPreset;
	readonly colorBlindMode: boolean;
	readonly webSearchOrder: readonly string[];
	readonly disabledProviders: readonly string[];
	readonly authStorage: AuthStorage;
	readonly modelSource: ModelBrowserSource;
	getModels(): { available: Model[]; all: Model[]; current: Model | undefined };
	refreshModels(): Promise<void>;
	selectModel(model: Model, selector: string): Promise<void>;
	refreshProvider(provider: string): Promise<void>;
	saveComposerShape(shape: ComposerShape): Promise<void>;
	saveSymbolPreset(preset: SymbolPreset): void;
	saveColorBlindMode(enabled: boolean): void;
	saveTheme(mode: "dark" | "light", name: string): void;
	isSearchProviderAvailable(id: SearchProviderId): Promise<boolean>;
	saveSearchProvider(id: SearchProviderId | "auto"): Promise<void>;
	captureBrowserSession(request: OAuthBrowserSessionRequest, signal?: AbortSignal): Promise<string>;
	copyToClipboard(text: string): Promise<void>;
	openInBrowser(url: string): void;
	markComplete(version: number): Promise<void>;
	playWelcomeIntro(): void;
	showError(message: string): void;
}

/** Outcome reported when an onboarding scene finishes. */
export type SetupSceneResult = "done" | "skipped";

/** Per-scene focus, rendering, completion, and application callbacks. */
export interface SetupSceneHost {
	ctx: SetupHost;
	requestRender(): void;
	finish(result: SetupSceneResult): void;
	setFocus(component: Component | null): void;
	restoreFocus(): void;
}

/** Interactive content hosted inside the setup wizard frame. */
export interface SetupSceneController extends Component {
	title: string;
	subtitle?: string;
	onMount?(): void | Promise<void>;
	onUnmount?(): void;
	dispose?(): void;
	/**
	 * Render the scene body. `maxLines` is the number of body rows the wizard
	 * will actually display (header and footer already subtracted); scenes
	 * shrink list windows and drop decorative chrome so the selected row stays
	 * inside the budget. Overflow beyond `maxLines` is clipped by the wizard.
	 */
	render(width: number, maxLines?: number): readonly string[];
	/**
	 * Route an SGR mouse report (tracking is on while the wizard holds the
	 * alternate screen). `line`/`col` are 0-based within this controller's
	 * last rendered output. When absent, the wizard falls back to synthesizing
	 * arrow keys from wheel notches.
	 */
	routeMouse?(event: SgrMouseEvent, line: number, col: number): void;
}

/** Independent panel composed inside a tabbed setup scene. */
export interface SetupTab extends Component {
	readonly id: string;
	readonly label: string;
	/** Modal panels own input and prevent their parent from switching tabs or finishing. */
	readonly modal: boolean;
	render(width: number, maxLines?: number): readonly string[];
	handleInput(data: string): void;
	invalidate(): void;
	onActivate?(): void;
	/** Mouse coordinates are local to the panel's last rendered body. */
	routeMouse?(event: SgrMouseEvent, line: number, col: number): void;
	dispose(): void;
}

/** Versioned onboarding scene definition. */
export interface SetupScene {
	id: string;
	title: string;
	minVersion: number;
	shouldRun?(ctx: SetupHost): boolean | Promise<boolean>;
	mount(host: SetupSceneHost): SetupSceneController;
}
