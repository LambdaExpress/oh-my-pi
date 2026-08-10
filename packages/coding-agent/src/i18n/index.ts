import { settings } from "../config/settings";
import { zhCN } from "./locales/zh-CN";

export const SUPPORTED_LOCALES = ["en", "zh-CN"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

const CATALOGS: Record<Exclude<Locale, "en">, Record<string, string>> = { "zh-CN": zhCN };

let pinnedLocale: Locale | null = null; // setLocale 固定；null = 从 settings 惰性解析

/** 固定当前 locale；null/非法值 = 恢复为 settings 驱动。main.ts、runCli 帮助路径、设置面板保存、测试使用。 */
export function setLocale(locale: string | null | undefined): void {
	pinnedLocale =
		typeof locale === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(locale)
			? (locale as Locale)
			: null;
}

export function getLocale(): Locale {
	if (pinnedLocale) return pinnedLocale;
	try {
		const setting = settings.get("display.language");
		return setting === "auto" ? detectSystemLocale() : setting;
	} catch {
		return detectSystemLocale(); // settings 未初始化（测试、CLI 早期路径）：跟随系统语言
	}
}

/**
 * Detect the system UI language. Prefers explicit locale env vars (POSIX
 * convention), falling back to the runtime's default ICU locale, which
 * follows the OS UI language on Windows (Bun resolves it via ICU).
 */
export function detectSystemLocale(): Locale {
	const envLang = process.env.LANG ?? process.env.LC_ALL ?? process.env.LC_MESSAGES ?? "";
	if (/^zh/i.test(envLang)) return "zh-CN";
	// A non-C locale env var is authoritative (e.g. en_US.UTF-8).
	if (envLang && !/^C\b|^POSIX\b/i.test(envLang)) return "en";
	try {
		const locale = Intl.DateTimeFormat().resolvedOptions().locale;
		return /^zh/i.test(locale) ? "zh-CN" : "en";
	} catch {
		return "en";
	}
}

/** 渲染用户可见文本。键 = 英文原文；zh-CN 命中返回译文，未命中回退英文。params 插值 {name}。 */
export function t(key: string, params?: Record<string, unknown>): string {
	const locale = getLocale();
	let text = locale === "en" ? key : (CATALOGS[locale][key] ?? key);
	if (params) {
		for (const [name, value] of Object.entries(params)) {
			text = text.replaceAll(`{${name}}`, value === undefined ? "undefined" : String(value));
		}
	}
	return text;
}
