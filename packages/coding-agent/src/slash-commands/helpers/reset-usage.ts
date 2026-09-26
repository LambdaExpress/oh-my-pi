/**
 * Shared helpers for the `/usage reset` command (TUI selector + ACP): turn the
 * live per-account reset-credit status into selector rows, and map a redeem
 * outcome code to a human message.
 */
import { t } from "../../i18n";
import type { ResetCreditAccountStatus, ResetCreditRedeemOutcome, ResetCreditTarget } from "../../session/auth-storage";
import type { ResetUsageAccount } from "@oh-my-pi/pi-tui/overlays/reset-usage-selector";
import { summarizeUsageResetCredits } from "@oh-my-pi/pi-tui/overlays/usage-display";

const CODEX_PROVIDER_ID = "openai-codex";
const CLAUDE_PROVIDER_ID = "anthropic";

/** Provider name shown beside each exact saved-reset account option. */
export function formatResetProviderName(provider: string): string {
	if (provider === CODEX_PROVIDER_ID) return "Codex";
	if (provider === CLAUDE_PROVIDER_ID) return "Claude";
	return provider;
}

/**
 * Map live per-account reset status to selector rows. Sorted with the active
 * account first, then most-credits, then label.
 */
export function toResetUsageAccounts(statuses: ResetCreditAccountStatus[]): ResetUsageAccount[] {
	return statuses
		.map(status => {
			const provider = status.provider;
			const providerLabel = formatResetProviderName(provider);
			const credit = status.nextCreditId
				? status.credits.find(candidate => candidate.id === status.nextCreditId)
				: (status.credits.find(candidate => candidate.usable !== false) ?? status.credits[0]);
			const advertisedRedeemable = status.redeemableCount ?? status.availableCount;
			const summary = summarizeUsageResetCredits(status);
			// Claude's listing endpoint chooses the one grant that may be spent.
			// Never degrade a missing pin into "spend whichever grant is current".
			const redeemableCount = provider === CLAUDE_PROVIDER_ID && !status.nextCreditId ? 0 : advertisedRedeemable;
			const identity = status.email ?? status.accountId ?? "account";
			const organization = status.orgName ?? status.orgId;
			const label = organization ? `${identity} · ${organization}` : identity;
			const unavailableReason =
				summary?.unavailableReason ??
				(provider === CLAUDE_PROVIDER_ID && advertisedRedeemable > 0 && !status.nextCreditId
					? "the provider did not identify a grant that can be safely spent"
					: undefined) ??
				(status.availableCount > 0 && redeemableCount === 0 ? "not usable right now" : undefined);
			return {
				label,
				provider,
				providerLabel,
				availableCount: status.availableCount,
				redeemableCount,
				target: {
					credentialId: status.credentialId,
					provider,
					...(status.accountId ? { accountId: status.accountId } : {}),
					...(status.email ? { email: status.email } : {}),
					...(status.orgId ? { orgId: status.orgId } : {}),
					...(status.nextCreditId ? { creditId: status.nextCreditId } : {}),
				} satisfies ResetCreditTarget,
				active: status.active,
				error: status.error,
				unavailableReason,
				expiresAt: summary?.soonestExpiry,
				credit,
			};
		})
		.sort((a, b) => {
			if (a.active !== b.active) return a.active ? -1 : 1;
			if (a.redeemableCount !== b.redeemableCount) return b.redeemableCount - a.redeemableCount;
			if (a.availableCount !== b.availableCount) return b.availableCount - a.availableCount;
			if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
			return a.label.localeCompare(b.label);
		});
}

/** Human-facing summary of a redeem outcome for status lines and ACP output. */
export function describeRedeemOutcome(outcome: ResetCreditRedeemOutcome, label: string): string {
	const provider = outcome.provider ? ` (${formatResetProviderName(outcome.provider)})` : "";
	const reason = outcome.reason ? ` — ${outcome.reason}` : "";
	switch (outcome.code) {
		case "reset": {
			const cleared = outcome.cleared ?? [];
			const scopedLabel = label + provider;
			if (cleared.length === 1 && cleared[0] === "anthropic:5h") {
				const scope = t("Claude's 5h session limit has been refreshed; weekly limits are unchanged");
				return `${t("Reset applied for {label}", { label: scopedLabel })} — ${scope}.`;
			}
			if (cleared.length > 0) {
				const scope = t("the covered rate-limit window{s} {have} been refreshed", {
					s: cleared.length === 1 ? "" : "s",
					have: cleared.length === 1 ? "has" : "have",
				});
				return `${t("Reset applied for {label}", { label: scopedLabel })} — ${scope}.`;
			}
			return t("Reset applied for {label} — your rate-limit window has been refreshed.", { label: scopedLabel });
		}
		case "already_redeemed":
			return t("{label}: that reset was already redeemed.", { label: label + provider });
		case "no_credit":
			return (
				t("{label}: no saved resets available to spend.", { label: label + provider }) +
				(reason ? `${reason}.` : "")
			);
		case "credit_list_failed":
			return t("{label}: couldn't load this account's saved resets (network/auth) — nothing was spent, try again.", {
				label: label + provider,
			});
		case "nothing_to_reset":
			return t("{label}: nothing to reset right now — your limits aren't constrained, so no credit was spent.", {
				label: label + provider,
			});
		case "no_account":
			return t("Could not find the stored account {label}{provider}.", { label, provider });
		case "account_unavailable":
			return t("{label}: could not authenticate this account — try /login.", { label: label + provider });
		case "offer_changed":
			return t("{label}{provider}: the reset offer changed — nothing was spent; reopen /usage reset.", {
				label,
				provider,
			});
		case "reset_in_progress":
			return t("{label}{provider}: a reset is already in progress.", { label, provider });
		case "reset_unconfirmed":
		case "network_error":
		case "malformed_response":
			return t(
				"{label}{provider}: couldn't confirm whether the reset applied — check /usage before trying again{reason}.",
				{ label, provider, reason },
			);
		default:
			return (
				t("{label}: reset did not apply ({code}).", { label: label + provider, code: outcome.code }) +
				(reason ? `${reason}.` : "")
			);
	}
}
