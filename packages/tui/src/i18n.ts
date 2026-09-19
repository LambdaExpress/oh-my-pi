/**
 * Translation runtime for pi-tui.
 *
 * pi-tui renders terminal components but cannot depend on the coding agent, so
 * the locale preference and the catalog live in the host application, which
 * configures this module once at startup. Without a configured host, `t`
 * renders the English source key unchanged, which keeps standalone consumers
 * (unit tests, `omp stats`, embeds) working.
 */

/** Catalog for one locale: English source key -> localized text. */
export type LocaleCatalog = Record<string, string>;

export interface I18nHost {
	/** Locale to use when none is pinned. */
	resolveLocale(): string;
	/** Catalog for a locale, or undefined when the host has no translations for it. */
	catalogFor(locale: string): LocaleCatalog | undefined;
}

let host: I18nHost | null = null;
let pinnedLocale: string | null = null;

/** Configure the host's locale source and catalog. Called once by the coding agent at startup. */
export function configureI18n(next: I18nHost): void {
	host = next;
}

/** Pin the active locale; a null or empty value restores the host's own resolution. */
export function setLocale(locale: string | null | undefined): void {
	pinnedLocale = typeof locale === "string" && locale.length > 0 ? locale : null;
}

/** Active locale, pinned value first, then the host's preference, then English. */
export function getLocale(): string {
	if (pinnedLocale) return pinnedLocale;
	return host ? host.resolveLocale() : "en";
}

/** Replace `{name}` placeholders. */
export function interpolate(text: string, params?: Record<string, unknown>): string {
	if (!params) return text;
	let result = text;
	for (const [name, value] of Object.entries(params)) {
		result = result.replaceAll(`{${name}}`, value === undefined ? "undefined" : String(value));
	}
	return result;
}

/** Render user-visible text. The key is the English source; unmatched keys fall back to it. */
export function t(key: string, params?: Record<string, unknown>): string {
	const locale = getLocale();
	const catalog = locale === "en" ? undefined : host?.catalogFor(locale);
	return interpolate(catalog?.[key] ?? key, params);
}
