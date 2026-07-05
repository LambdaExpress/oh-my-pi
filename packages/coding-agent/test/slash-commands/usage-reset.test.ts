import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	type BuiltinSlashCommandRuntime,
	executeBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createUsageResetRuntime(redeemOutcome: { ok: boolean; code: string }) {
	const setText = vi.fn();
	const showStatus = vi.fn();
	const refreshUsage = vi.fn();
	const requestRender = vi.fn();
	const listResetCredits = vi.fn(async () => [
		{
			credentialId: "cred-active",
			accountId: "acct-active",
			email: "active@example.com",
			availableCount: 1,
			active: true,
		},
	]);
	const redeemResetCredit = vi.fn(async () => redeemOutcome);
	const runtime = {
		ctx: {
			editor: { setText } as unknown as InteractiveModeContext["editor"],
			session: { listResetCredits, redeemResetCredit } as unknown as InteractiveModeContext["session"],
			showStatus,
			statusLine: { refreshUsage } as unknown as InteractiveModeContext["statusLine"],
			ui: { requestRender } as unknown as InteractiveModeContext["ui"],
		} as unknown as InteractiveModeContext,
	} satisfies BuiltinSlashCommandRuntime;

	return { listResetCredits, redeemResetCredit, refreshUsage, requestRender, runtime, setText, showStatus };
}

describe("/usage reset slash command", () => {
	it("refreshes the status-line usage segment after successfully redeeming the active account reset", async () => {
		const harness = createUsageResetRuntime({ ok: true, code: "reset" });

		const handled = await executeBuiltinSlashCommand("/usage reset active", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.listResetCredits).toHaveBeenCalledTimes(1);
		expect(harness.redeemResetCredit).toHaveBeenCalledWith({
			credentialId: "cred-active",
			accountId: "acct-active",
			email: "active@example.com",
		});
		expect(harness.refreshUsage).toHaveBeenCalledTimes(1);
		expect(harness.requestRender).toHaveBeenCalledTimes(1);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.showStatus).toHaveBeenCalledWith(
			"Reset applied for active@example.com — your rate-limit window has been refreshed.",
		);
	});

	it("does not refresh usage when redeeming the active account reports no applied reset", async () => {
		const harness = createUsageResetRuntime({ ok: false, code: "nothing_to_reset" });

		const handled = await executeBuiltinSlashCommand("/usage reset active", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.redeemResetCredit).toHaveBeenCalledTimes(1);
		expect(harness.refreshUsage).not.toHaveBeenCalled();
		expect(harness.requestRender).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.showStatus).toHaveBeenCalledWith(
			"active@example.com: nothing to reset right now — your limits aren't constrained, so no credit was spent.",
		);
	});
});
