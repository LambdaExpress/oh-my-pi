import { test } from "bun:test";
import { runAdbProcessSmoke } from "./adb-process-smoke";

test("fake ADB process smoke exercises inherited pipes, executor bytes, tool consumers, deadlines, and cancellation", async () => {
	await runAdbProcessSmoke();
}, 30_000);
