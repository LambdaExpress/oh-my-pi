import { TERMINAL } from "@oh-my-pi/pi-tui";
import { SETTING_TABS, type SettingsDisplayEntry, type SettingsHost } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { t } from "../i18n";
import { normalizeExtendedContextWindow } from "./extended-context";
import {
	normalizeProviderMaxInFlightRequests,
	Settings,
	settings,
	validateProviderMaxInFlightRequests,
} from "./settings";
import {
	getDefault,
	getEnumValues,
	getPathsForTab,
	getType,
	getUi,
	isCredential,
	type SettingPath,
} from "./settings-schema";

const CONDITIONS: Record<string, () => boolean> = {
	macOS: () => process.platform === "darwin",
	hasImageProtocol: () => !!TERMINAL.imageProtocol,
	advisorEnabled: () => {
		try {
			return Settings.instance.get("advisor.enabled") === true;
		} catch {
			return false;
		}
	},
	vimModeEnabled: () => {
		try {
			return Settings.instance.get("tui.vimMode") === true;
		} catch {
			return false;
		}
	},
	hindsightActive: () => {
		try {
			return Settings.instance.get("memory.backend") === "hindsight";
		} catch {
			return false;
		}
	},
	mnemopiActive: () => {
		try {
			return Settings.instance.get("memory.backend") === "mnemopi";
		} catch {
			return false;
		}
	},
	autolearnActive: () => {
		try {
			return Settings.instance.get("autolearn.enabled") === true;
		} catch {
			return false;
		}
	},
	autoThinkingActive: () => {
		try {
			return Settings.instance.get("defaultThinkingLevel") === "auto";
		} catch {
			return false;
		}
	},
	usageAwareFallbackEnabled: () => {
		try {
			return Settings.instance.get("retry.usageAwareFallback") === true;
		} catch {
			return false;
		}
	},
	planModeEnabled: () => {
		try {
			return Settings.instance.get("plan.enabled");
		} catch {
			return false;
		}
	},
	planAutosaveEnabled: () => {
		try {
			return Settings.instance.get("plan.enabled") && Settings.instance.get("plan.autosave");
		} catch {
			return false;
		}
	},
	unexpectedStopSmart: () => {
		try {
			return Settings.instance.get("features.unexpectedStopDetection") === "smart";
		} catch {
			return false;
		}
	},
};

/** Adapt the application schema and settings store to the terminal overlay. */
export function createSettingsHost(): SettingsHost {
	const entries: SettingsDisplayEntry[] = [];
	for (const tab of SETTING_TABS) {
		for (const path of getPathsForTab(tab)) {
			const ui = getUi(path);
			entries.push({
				path,
				type: getType(path),
				defaultValue: getDefault(path),
				ui,
				enumValues: getEnumValues(path),
				credential: isCredential(path),
				condition: ui?.condition ? CONDITIONS[ui.condition] : undefined,
			});
		}
	}
	return {
		entries,
		get: path => settings.get(path as SettingPath),
		set: (path, value) => {
			// The extended-context window is persisted as a canonical K/M token
			// amount: malformed input is rejected instead of stored verbatim, and
			// an emptied field resets the setting to its schema default.
			if (path === "extendedContextWindow") {
				const raw = typeof value === "string" ? value.trim() : "";
				const normalized = raw ? normalizeExtendedContextWindow(raw) : getDefault(path);
				if (!normalized) {
					throw new Error(t("Enter a positive context window with a K or M suffix, such as 372K or 1M"));
				}
				settings.set(path, normalized);
				return;
			}
			settings.set(path as SettingPath, value as never);
		},
		normalizeProviderLimits: normalizeProviderMaxInFlightRequests,
		validateProviderLimits: validateProviderMaxInFlightRequests,
	};
}
