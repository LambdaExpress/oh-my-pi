import { writeSync } from "node:fs";
import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin });
for await (const line of input) {
	const request = JSON.parse(line);
	if (request.method !== "initialize") continue;
	if (process.argv[2] === "long") {
		writeSync(2, `Authorization: Bearer ${"fixture-truncated-secret-".repeat(600)}\n`);
	}
	const diagnostic = Buffer.from(
		[
			"Traceback (most recent call last):",
			"RuntimeError: Unity editor 启动失败: backend refused connection",
			"Authorization: Bearer fixture-bearer-secret",
			"endpoint=https://example.invalid/mcp?access_token=fixture-url-secret&mode=startup",
			"password=fixture-password-secret",
			"",
		].join("\n"),
	);
	// Exercise decoding when a multi-byte character spans stderr reads.
	const split = diagnostic.indexOf(Buffer.from("启动")) + 1;
	writeSync(2, diagnostic.subarray(0, split));
	await Bun.sleep(10);
	writeSync(2, diagnostic.subarray(split));
	process.exit(23);
}
