import { expect, it } from "bun:test";
import type { UsageLimit } from "@oh-my-pi/pi-ai";
import { isRedundantLimitWindowLabel } from "@oh-my-pi/pi-tui/overlays/usage-display";

it("retains source-label duplicate detection when translation changes the title", () => {
	const limit: UsageLimit = {
		id: "balance",
		label: "Credit balance",
		scope: { provider: "openai-codex", windowId: "balance" },
		amount: { remaining: 10, unit: "credits" },
	};

	expect(isRedundantLimitWindowLabel(limit, "额度余额", "BALANCE")).toBe(true);
	expect(isRedundantLimitWindowLabel(limit, "额度余额", "weekly")).toBe(false);
});
