/**
 * `buildJobResult` output rendering for settled background jobs.
 * Regression coverage: valid results must not inline a truncated JSON
 * block (breaks async-result.md's contract of pointing to `agent://<id>`
 * instead, and can emit invalid JSON once truncated at 4k), and any result
 * carrying data must advertise the `agent://<id>` handle (PR #10625 review).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { AsyncJobRunResult } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { StructuredSubagentOutput } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { buildJobResult } from "@oh-my-pi/pi-coding-agent/async/job-control";
import { outputMeta } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { formatArtifactErrorNotice, formatOutputNotice } from "@oh-my-pi/pi-tui/tools/output-meta";
import { OutputSink, type OutputSummary } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { TempDir } from "@oh-my-pi/pi-utils";

const SELF_ID = "Main";

function makeSession(manager: AsyncJobManager): ToolSession {
	const stub = {
		cwd: process.cwd(),
		settings: {
			get(key: string): unknown {
				if (key === "launch.enabled") return false;
				return undefined;
			},
		},
		agentRegistry: AgentRegistry.global(),
		asyncJobManager: manager,
		getAgentId: () => SELF_ID,
	};
	// Structurally-partial test session: snapshot rendering only touches these fields.
	return stub as unknown as ToolSession;
}

/** Register a job that immediately settles with the given text + structured payload. */
function registerSettledJob(
	manager: AsyncJobManager,
	label: string,
	text: string,
	structured: StructuredSubagentOutput,
	agentId?: string,
): string {
	return manager.register("task", label, async () => ({ text, structured }), { ownerId: SELF_ID, agentId });
}

describe("wait structured output rendering", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	test("a schema-valid result advertises the agent:// pointer instead of inlining JSON", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const jobId = registerSettledJob(
			manager,
			"ValidJob",
			"<task-result>done</task-result>",
			{ source: "agent", mode: "permissive", status: "valid", data: { ok: true, count: 7 } },
			"ValidJob",
		);
		await manager.getJob(jobId)!.promise;

		const result = buildJobResult(makeSession(manager), manager, "wait", [manager.getJob(jobId)!], []);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("Structured output: schema valid");
		expect(text).toContain("full payload at agent://ValidJob");
		expect(text).toContain("fields via agent://ValidJob/<field>");
		// The truncated inline JSON block must not appear for a valid result.
		expect(text).not.toContain("```json");
	});

	test("a schema-invalid result keeps the truncated JSON preview alongside the pointer", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const jobId = registerSettledJob(
			manager,
			"InvalidJob",
			"<task-result>done</task-result>",
			{ source: "agent", mode: "permissive", status: "invalid", data: { wrong: "shape" }, error: "missing field" },
			"InvalidJob",
		);
		await manager.getJob(jobId)!.promise;

		const result = buildJobResult(makeSession(manager), manager, "wait", [manager.getJob(jobId)!], []);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("Structured output: schema invalid: missing field");
		expect(text).toContain("full payload at agent://InvalidJob");
		expect(text).toContain("```json");
		expect(text).toContain('"wrong": "shape"');
	});

	test("a run that failed before yielding reports the provider error, not a schema verdict", async () => {
		// Production 2026-09-21: the delivery read `Structured output: schema
		// invalid: Anthropic stream envelope error: ...` with the half-streamed
		// prose as a JSON preview. No payload existed to judge.
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const error = "Anthropic stream envelope error: stream ended before message_stop";
		const jobId = registerSettledJob(
			manager,
			"DeadStream",
			'<task-result status="failed (exit 1)">partial</task-result>',
			{ source: "agent", mode: "permissive", status: "unavailable", error },
			"DeadStream",
		);
		await manager.getJob(jobId)!.promise;

		const result = buildJobResult(makeSession(manager), manager, "wait", [manager.getJob(jobId)!], []);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain(`Structured output: unavailable: ${error}`);
		expect(text).not.toContain("schema invalid");
		expect(text).not.toContain("schema unavailable");
		expect(text).not.toContain("full payload at");
		expect(text).not.toContain("```json");
	});

	test.each([
		{ op: "wait", appendedNotice: false },
		{ op: "cancel", appendedNotice: false },
		{ op: "wait", appendedNotice: true },
	] as const)("retains a real failed capture without duplicating its notice (%j)", async ({ op, appendedNotice }) => {
		await using temp = await TempDir.create("@wait-capture-");
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const start = Promise.withResolvers<void>();
		const preview = "visible preview\n";
		const capture: { summary?: OutputSummary } = {};
		try {
			const jobId = manager.register(
				"bash",
				"failed artifact capture",
				async ({ reportProgress }) => {
					await start.promise;
					// A directory cannot be opened as the capture file. Keep the
					// actual sink failure and bounded preview, without I/O mocks.
					const sink = new OutputSink({
						artifactPath: temp.path(),
						artifactId: "incomplete",
						spillThreshold: 16,
					});
					try {
						sink.push("raw prefix that must spill\n" + preview);
						const summary = await sink.dump();
						capture.summary = summary;
						const meta = outputMeta().truncationFromSummary(summary, { direction: "tail" }).get();
						const text = summary.output + (appendedNotice ? formatOutputNotice(meta) : "");
						await reportProgress(text, { meta });
						return text;
					} finally {
						await sink.dispose();
					}
				},
				{ ownerId: SELF_ID, toolCallId: "capture-call" },
			);
			manager.watchJobs([jobId]);
			start.resolve();
			const job = manager.getJob(jobId);
			if (!job) throw new Error("Expected the registered capture job");
			await job.promise;

			expect(job.status).toBe("completed");
			const summary = capture.summary;
			expect(summary?.output).toBe(preview);
			if (!summary?.artifactError) throw new Error("Expected a real artifact capture failure");
			expect(summary.artifactId).toBeUndefined();
			const result = buildJobResult(makeSession(manager), manager, op, [job], []);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const warning = formatArtifactErrorNotice(summary.artifactError);
			expect(text).toContain(preview.trimEnd());
			expect(text.split(warning).length - 1).toBe(1);
			expect(text).not.toContain("artifact://");
			expect(manager.isJobResultConsumed(jobId)).toBe(true);
		} finally {
			start.resolve();
			await manager.dispose();
		}
	});

	test("advertises the disambiguated agentId, not the collision-suffixed job id", async () => {
		// A task job can reuse a vibe turn's job id, forcing the manager to
		// suffix `jobId` (e.g. `Foo` -> `Foo-2`) while the task's artifacts
		// are still written under its own agent id.
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const { promise: hangs } = Promise.withResolvers<AsyncJobRunResult>();
		manager.register("task", "collider", async () => hangs, { ownerId: SELF_ID, id: "Foo" });
		const jobId = registerSettledJob(
			manager,
			"Foo",
			"<task-result>done</task-result>",
			{ source: "agent", mode: "permissive", status: "valid", data: { ok: true } },
			"Foo",
		);
		expect(jobId).not.toBe("Foo");
		await manager.getJob(jobId)!.promise;
		const result = buildJobResult(makeSession(manager), manager, "wait", [manager.getJob(jobId)!], []);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain(`full payload at agent://Foo,`);
	});
});
