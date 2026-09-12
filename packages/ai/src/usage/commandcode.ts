import { ProviderHttpError } from "../error";
import type {
	UsageCredential,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageWindow,
} from "../usage";
import { isRecord } from "../utils";
import { DAY_MS, HOUR_MS, parsePositiveTimestamp, usageStatus } from "./shared";

const COMMANDCODE_PROVIDER = "commandcode";
const DEFAULT_API_BASE = "https://api.commandcode.ai";
const WHOAMI_PATH = "/alpha/whoami";
const CREDITS_PATH = "/alpha/billing/credits";

/**
 * Subscription windows reported by `GET /alpha/billing/credits`. Each entry
 * carries the credits spent inside the rolling span against the plan's cap
 * (`windowLimits.fiveHour` / `.weekly`), where `used: 0, cap: 0` means the plan
 * does not meter that window at all.
 */
const COMMANDCODE_WINDOWS = [
	{ key: "fiveHour", limitId: "five-hour", windowId: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS },
	{ key: "weekly", limitId: "weekly", windowId: "7d", label: "Weekly", durationMs: 7 * DAY_MS },
] as const;

/**
 * The catalog `baseUrl` is the Provider API root (`/provider/v1`), while the
 * account routes live at the deployment root, so that suffix has to come off
 * before the `/alpha` paths are appended. Same split the retired
 * `pi-commandcode-provider` extension handled in its `legacyApiBase`.
 */
function resolveApiBase(baseUrl?: string): string {
	const trimmed = baseUrl?.trim();
	if (!trimmed) return DEFAULT_API_BASE;
	const root = trimmed
		.replace(/\/+$/, "")
		.replace(/\/provider\/v1$/i, "")
		.replace(/\/v1$/i, "");
	return root || DEFAULT_API_BASE;
}

/** Command Code stores its bearer in the OAuth slot; plain keys use `apiKey`. */
function bearerToken(credential: UsageCredential): string | undefined {
	const token = credential.accessToken?.trim() || credential.apiKey?.trim();
	return token ? token : undefined;
}

function isAuthFailure(status: number): boolean {
	return status === 401 || status === 403;
}

function buildWindowLimit(descriptor: (typeof COMMANDCODE_WINDOWS)[number], entry: unknown): UsageLimit | undefined {
	if (!isRecord(entry)) return undefined;
	const used =
		typeof entry.used === "number" && Number.isFinite(entry.used) && entry.used >= 0 ? entry.used : undefined;
	const cap = typeof entry.cap === "number" && Number.isFinite(entry.cap) && entry.cap > 0 ? entry.cap : undefined;
	// An unusable cap cannot express a fraction; `0 / 0` is an unmetered window,
	// not a fully spent one, so it is dropped rather than reported as exhausted.
	if (used === undefined || cap === undefined) return undefined;
	const usedFraction = Math.min(1, used / cap);
	const resetsAt = parsePositiveTimestamp(entry.resetAt);
	const window: UsageWindow = { id: descriptor.windowId, label: descriptor.label, durationMs: descriptor.durationMs };
	if (resetsAt !== undefined) window.resetsAt = resetsAt;
	return {
		id: descriptor.limitId,
		label: `${descriptor.label} limit`,
		scope: { provider: COMMANDCODE_PROVIDER, windowId: descriptor.windowId, shared: true },
		window,
		amount: {
			used,
			limit: cap,
			usedFraction,
			remainingFraction: Math.max(0, 1 - usedFraction),
			unit: "credits",
		},
		// The payload's own `exceeded` flag is authoritative: it accounts for the
		// plan's rounding, which a raw `used / cap` comparison cannot see.
		status: entry.exceeded === true ? "exhausted" : usageStatus(usedFraction),
	};
}

interface CommandCodeAccount {
	orgId?: string;
	email?: string;
	user?: string;
}

/** `whoami` carries the account label and the org a subscription bills to. */
function parseAccount(payload: unknown): CommandCodeAccount | undefined {
	if (!isRecord(payload)) return undefined;
	const account: CommandCodeAccount = {};
	if (isRecord(payload.user)) {
		const email = payload.user.email;
		if (typeof email === "string" && email.trim()) account.email = email.trim();
		const { name, userName } = payload.user;
		const display =
			(typeof name === "string" && name.trim() ? name.trim() : undefined) ??
			(typeof userName === "string" && userName.trim() ? userName.trim() : undefined);
		if (display) account.user = display;
	}
	const org = payload.org;
	const orgId =
		typeof org === "string" && org.trim()
			? org.trim()
			: isRecord(org) && typeof org.id === "string" && org.id.trim()
				? org.id.trim()
				: undefined;
	if (orgId) account.orgId = orgId;
	else if (typeof payload.orgId === "string" && payload.orgId.trim()) account.orgId = payload.orgId.trim();
	return account;
}

type AlphaResponse = { ok: true; payload: unknown } | { ok: false; status: number };

async function requestAlpha(
	url: string,
	token: string,
	params: UsageFetchParams,
	ctx: UsageFetchContext,
): Promise<AlphaResponse> {
	try {
		const response = await ctx.fetch(url, {
			headers: { accept: "application/json", authorization: `Bearer ${token}` },
			signal: params.signal,
		});
		if (!response.ok) return { ok: false, status: response.status };
		return { ok: true, payload: (await response.json()) as unknown };
	} catch (error) {
		if (error instanceof ProviderHttpError) throw error;
		ctx.logger?.warn("Command Code usage request failed", { url, error: String(error) });
		return { ok: false, status: 0 };
	}
}

async function fetchCommandCodeUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== COMMANDCODE_PROVIDER) return null;
	const token = bearerToken(params.credential);
	if (!token) return null;
	const apiBase = resolveApiBase(params.baseUrl);

	// Identity is optional metadata: an org-scoped subscription still reports
	// through the same credits route, so a transient `whoami` failure must not
	// hide the limits. A rejected bearer is different — it fails both routes and
	// has to surface so credential health can flag it.
	const whoami = await requestAlpha(`${apiBase}${WHOAMI_PATH}`, token, params, ctx);
	if (!whoami.ok && isAuthFailure(whoami.status)) {
		throw new ProviderHttpError(`Command Code account lookup returned ${whoami.status}`, whoami.status);
	}
	const account = whoami.ok ? parseAccount(whoami.payload) : undefined;

	const orgId = account?.orgId ?? params.credential.orgId?.trim();
	const creditsUrl = `${apiBase}${CREDITS_PATH}${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`;
	const credits = await requestAlpha(creditsUrl, token, params, ctx);
	if (!credits.ok) {
		if (isAuthFailure(credits.status)) {
			throw new ProviderHttpError(`Command Code credits endpoint returned ${credits.status}`, credits.status);
		}
		// Transient failure — `null` keeps the last good report serving.
		ctx.logger?.warn("Command Code credits fetch failed", { status: credits.status });
		return null;
	}
	if (!isRecord(credits.payload)) {
		ctx.logger?.warn("Command Code credits response was not an object");
		return null;
	}
	const windowLimits = credits.payload.windowLimits;
	if (windowLimits !== undefined && !isRecord(windowLimits)) {
		ctx.logger?.warn("Command Code credits response had a malformed windowLimits block");
		return null;
	}

	const limits: UsageLimit[] = [];
	for (const descriptor of COMMANDCODE_WINDOWS) {
		const limit = buildWindowLimit(descriptor, isRecord(windowLimits) ? windowLimits[descriptor.key] : undefined);
		if (limit) limits.push(limit);
	}

	return {
		provider: COMMANDCODE_PROVIDER,
		fetchedAt: Date.now(),
		// An account without an active subscription reports no metered window;
		// an empty report leaves the spend readout in place instead of claiming
		// a limit that does not exist.
		limits,
		metadata: {
			...(account?.email ? { email: account.email } : {}),
			...(account?.user ? { user: account.user } : {}),
			endpoint: creditsUrl,
		},
		raw: credits.payload,
	};
}

export const commandCodeUsageProvider: UsageProvider = {
	id: COMMANDCODE_PROVIDER,
	fetchUsage: fetchCommandCodeUsage,
	supports: params => params.provider === COMMANDCODE_PROVIDER && bearerToken(params.credential) !== undefined,
	validatesCredentials: true,
};
