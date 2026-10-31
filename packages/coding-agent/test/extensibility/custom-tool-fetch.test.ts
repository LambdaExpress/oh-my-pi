import { expect, it } from "bun:test";
import * as path from "node:path";

it("gives SDK custom tools TLS-aware fetch while preserving explicit adapter capabilities and borrowed contexts", async () => {
	const child = Bun.spawn(
		[process.execPath, path.join(import.meta.dir, "../fixtures/custom-tool-fetch-consumer.ts")],
		{
			cwd: path.resolve(import.meta.dir, "../../../.."),
			env: {
				...process.env,
				NODE_EXTRA_CA_CERTS: undefined,
				NODE_TLS_REJECT_UNAUTHORIZED: undefined,
			},
			stdout: "pipe",
			stderr: "pipe",
			timeout: 30_000,
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	expect(JSON.parse(stdout)).toEqual({
		untrustedRejected: true,
		defaultFetchBytes: 6091,
		explicitFetchBytes: [6091, 6091],
		borrowedContextPreserved: true,
		isolatedSessionFiles: true,
	});
}, 35_000);
