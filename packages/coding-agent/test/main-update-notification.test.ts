import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { checkForNewVersion } from "@oh-my-pi/pi-coding-agent/main";

function startLatestVersionServer(version: string): { url: string; requests: () => number; stop: () => void } {
	let requestCount = 0;
	const server = Bun.serve({
		port: 0,
		fetch: () => {
			requestCount++;
			return Response.json({ version });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/latest`,
		requests: () => requestCount,
		stop: () => server.stop(true),
	};
}

describe("startup update notification check", () => {
	it("skips the registry request when startup update notifications are disabled", async () => {
		const local = startLatestVersionServer("99.0.0");
		try {
			const disabled = Settings.isolated({ "startup.checkUpdate": false });

			await expect(
				checkForNewVersion("1.0.0", { settings: disabled, latestUrl: local.url }),
			).resolves.toBeUndefined();
			expect(local.requests()).toBe(0);
		} finally {
			local.stop();
		}
	});

	it("returns a newer version when startup update notifications are enabled", async () => {
		const local = startLatestVersionServer("1.0.1");
		try {
			const enabled = Settings.isolated({ "startup.checkUpdate": true });

			await expect(checkForNewVersion("1.0.0", { settings: enabled, latestUrl: local.url })).resolves.toBe("1.0.1");
			expect(local.requests()).toBe(1);
		} finally {
			local.stop();
		}
	});
});
