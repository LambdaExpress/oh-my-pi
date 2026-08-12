// Fake omp core for Rust integration tests: mirrors the real core stdout contract.
import { writeSync } from "node:fs";

const args = process.argv.slice(2);
const expectedCwdArg = args.find(arg => arg.startsWith("--expect-project-cwd="));
if (expectedCwdArg) {
	const expected = expectedCwdArg.slice("--expect-project-cwd=".length);
	const cwdIndex = args.indexOf("--cwd");
	const actual = cwdIndex >= 0 ? args[cwdIndex + 1] : args.find(arg => arg.startsWith("--cwd="))?.slice(6);
	if (actual !== expected) {
		writeSync(2, `Expected explicit project --cwd ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.\n`);
		process.exit(1);
	}
}
if (args.includes("--fail")) {
	// Synchronous stderr write so the Rust side reliably captures it before exit.
	writeSync(2, "No models available.\n");
	process.exit(1);
}
if (!args.includes("--silent")) {
	console.log("ctrl: http://127.0.0.1:0/#ws://127.0.0.1:0/r/ctrl-fake.key");
	console.log("session: http://127.0.0.1:0/#ws://127.0.0.1:0/r/room.key");
}
// Keep the process alive until killed (mirrors the real core running silently).
setInterval(() => {}, 60_000);
