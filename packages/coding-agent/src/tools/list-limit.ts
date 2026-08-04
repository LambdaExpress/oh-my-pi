import type { LimitsMeta } from "./output-meta";

export interface ListLimitResult<T> {
	items: T[];
	limitReached?: number;
	meta: Partial<LimitsMeta>;
}

export interface ListLimitOptions {
	limit?: number;
	headLimit?: number;
	limitType?: "match" | "result";
	/** Ceiling for the suggested follow-up limit. Lets callers cap the hint at
	 * the value they can actually honor (e.g. a hard tool cap), so a user who
	 * follows the suggestion never hits the same truncation again. */
	maxSuggestion?: number;
}

export function applyListLimit<T>(items: T[], options: ListLimitOptions): ListLimitResult<T> {
	const meta: Partial<LimitsMeta> = {};
	const limitType = options.limitType ?? "result";
	const maxSuggestion = options.maxSuggestion ?? Infinity;
	const effectiveLimit = options.limit !== undefined && options.limit > 0 ? options.limit : undefined;
	const effectiveHeadLimit = options.headLimit !== undefined && options.headLimit > 0 ? options.headLimit : undefined;
	let limited = items;
	let limitReached: number | undefined;

	if (effectiveLimit !== undefined && items.length >= effectiveLimit) {
		limited = items.slice(0, effectiveLimit);
		limitReached = effectiveLimit;
		const suggestion = Math.min(effectiveLimit * 2, maxSuggestion);
		if (limitType === "match") {
			meta.matchLimit = { reached: effectiveLimit, suggestion };
		} else {
			meta.resultLimit = { reached: effectiveLimit, suggestion };
		}
	}

	if (effectiveHeadLimit !== undefined && limited.length > effectiveHeadLimit) {
		limited = limited.slice(0, effectiveHeadLimit);
		meta.headLimit = { reached: effectiveHeadLimit, suggestion: Math.min(effectiveHeadLimit * 2, maxSuggestion) };
	}

	return { items: limited, limitReached, meta };
}
