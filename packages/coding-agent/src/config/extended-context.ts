export const DEFAULT_EXTENDED_CONTEXT_WINDOW = 1_000_000;

const EXTENDED_CONTEXT_WINDOW_PATTERN = /^(\d+(?:\.\d+)?)\s*([km])$/iu;

/** Parse a positive K/M token amount such as `372K` or `1.5M`. */
export function parseExtendedContextWindow(value: string | undefined): number | undefined {
	const match = value?.trim().match(EXTENDED_CONTEXT_WINDOW_PATTERN);
	if (!match) return undefined;

	const amount = Number(match[1]);
	const multiplier = match[2]?.toLowerCase() === "m" ? 1_000_000 : 1_000;
	const tokens = amount * multiplier;
	return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

/** Validate and canonicalize a K/M token amount for persistence. */
export function normalizeExtendedContextWindow(value: string): string | undefined {
	if (parseExtendedContextWindow(value) === undefined) return undefined;
	return value.trim().replaceAll(/\s+/gu, "").toUpperCase();
}
