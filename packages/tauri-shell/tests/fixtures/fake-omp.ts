// Fake omp core for Rust integration tests: mirrors the real core stdout contract.
import { writeSync } from "node:fs";

const args = process.argv.slice(2);
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
