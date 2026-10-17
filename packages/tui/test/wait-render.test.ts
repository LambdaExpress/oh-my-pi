/**
 * The job tool's TUI preview must not leak the model-facing `<task-result>`
 * envelope (prompts/tools/task-summary.md): a settled task job previews the
 * inner <output>/<preview> body, while non-envelope result text (bash jobs)
 * passes through unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { prompt } from "@oh-my-pi/pi-utils";
import taskSummaryTemplate from "../../coding-agent/src/prompts/tools/task-summary.md" with { type: "text" };
import { bashToolRenderer } from "@oh-my-pi/pi-tui/tools/bash";
import { formatArtifactErrorNotice } from "@oh-my-pi/pi-tui/tools/output-meta";
import { createIrcMessageCard, waitToolRenderer } from "@oh-my-pi/pi-tui/tools/wait";
import { setLocale } from "../src/i18n";

function renderLines(resultText: string): string {
	const result = {
		content: [{ type: "text", text: "" }],
		details: {
			op: "wait" as const,
			jobs: [
				{
					id: "SpawnProbe",
					type: "task" as const,
					status: "completed" as const,
					label: "SpawnProbe",
					durationMs: 8_700,
					resultText,
				},
			],
		},
	};
	const component = waitToolRenderer.renderResult(
		result,
		{ expanded: true } as Parameters<typeof waitToolRenderer.renderResult>[1],
		theme,
	);
	return (component.render(120) as readonly string[]).join("\n");
}

describe("job renderer task-result preview", () => {
	beforeAll(async () => {
		// Job rows render through `t(...)`; the host locale is whatever the
		// ambient environment resolves to, so pin English like the other
		// renderer tests that assert on the untranslated row text.
		setLocale("en");
		await initTheme();
	});

	afterAll(() => {
		setLocale(null);
	});

	it("renders the consumed peer message as a sender card", () => {
		const component = waitToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "[42] Worker: file unlocked" }],
				details: {
					op: "wait",
					waited: { id: "42", from: "Worker", to: "Main", body: "file unlocked", ts: Date.now() },
				},
			},
			{ expanded: true, isPartial: false },
			theme,
		);
		const output = Bun.stripANSI(component.render(120).join("\n"));
		expect(output).toContain("Worker");
		expect(output).toContain("file unlocked");
	});

	it("folds IRC cards into adjacent one-line activity rows and restores their bodies", () => {
		const transcript = new TranscriptContainer();
		transcript.setToolRowsFolded(true);
		transcript.addChild(
			createIrcMessageCard(
				{ kind: "incoming", from: "Peer", body: "check\tlocation\nthen inspect GPS", timestamp: Date.now() },
				() => false,
				theme,
			),
		);
		transcript.addChild(
			createIrcMessageCard(
				{ kind: "relay", from: "Peer", to: "Other", body: "confirmed", timestamp: Date.now() },
				() => false,
				theme,
			),
		);

		const folded = transcript.renderViewport(120, 12).map(Bun.stripANSI);
		expect(folded).toHaveLength(2);
		expect(folded[0]).toContain("IRC");
		expect(folded[0]).toContain("Peer");
		expect(folded[0]).toContain("check location then inspect GPS");
		expect(folded[1]).toContain("Peer");
		expect(folded[1]).toContain("Other");
		expect(folded[1]).toContain("confirmed");

		transcript.setToolRowsFolded(false);
		const unfolded = transcript.renderViewport(120, 12).map(Bun.stripANSI);
		expect(unfolded.some(line => line.includes("check") && !line.includes("IRC"))).toBe(true);
		expect(unfolded.some(line => line.includes("then inspect GPS"))).toBe(true);
	});

	it("previews the envelope body, not the wrapper markup", () => {
		const summary = prompt.render(taskSummaryTemplate, {
			agentName: "sonic",
			id: "SpawnProbe",
			status: "completed",
			duration: "8.7s",
			preview: "Probe finished: spawned worker, ping ok.",
			truncated: false,
			meta: { lineCount: 3, charSize: "120 B" },
			mergeSummary: "",
		});
		const deliveryText = `${summary}\n\nSpawnProbe is now idle — message it via \`write agent://SpawnProbe\` to follow up; transcript at history://SpawnProbe`;

		const output = renderLines(deliveryText);
		expect(output).toContain("Probe finished: spawned worker, ping ok.");
		expect(output).not.toContain("<task-result");
		expect(output).not.toContain("<output>");
	});

	it("previews the truncated <preview> body the same way", () => {
		const summary = prompt.render(taskSummaryTemplate, {
			agentName: "task",
			id: "BigOne",
			status: "completed",
			duration: "2m",
			preview: "first line of long output",
			truncated: true,
			mergeSummary: "",
		});

		const output = renderLines(summary);
		expect(output).toContain("first line of long output");
		expect(output).not.toContain("<task-result");
	});

	it("flattens a pretty-printed JSON body instead of previewing a lone brace", () => {
		const summary = prompt.render(taskSummaryTemplate, {
			agentName: "sonic",
			id: "EchoAlpha",
			status: "completed",
			duration: "11.6s",
			preview: '{\n  "echo": "alpha",\n  "ok": true\n}',
			truncated: false,
			mergeSummary: "",
		});

		const output = Bun.stripANSI(renderLines(summary));
		expect(output).toContain('{ "echo": "alpha", "ok": true }');
		expect(output.split("\n").some(line => line.trim() === "{")).toBe(false);
	});

	it("passes non-envelope result text through unchanged", () => {
		const output = renderLines("42 pass, 0 fail (18.4s)");
		expect(output).toContain("42 pass, 0 fail (18.4s)");
	});

	it("drops the id column when the label repeats it", () => {
		// Task jobs label themselves with their agent id; rendering both columns
		// stutters ("SpawnProbe ⟨task⟩ SpawnProbe").
		const output = Bun.stripANSI(renderLines("done"));
		const header = output.split("\n").find(line => line.includes("SpawnProbe"));
		expect(header).toBeDefined();
		expect(header!.match(/SpawnProbe/g)).toHaveLength(1);
	});

	it("shows the shared SSH transfer progress summary", () => {
		const result = {
			content: [{ type: "text" as const, text: "" }],
			details: {
				op: "jobs" as const,
				jobs: [
					{
						id: "job-ssh",
						type: "ssh_transfer" as const,
						status: "running" as const,
						label: "upload blob",
						durationMs: 2_000,
						toolCallId: "tool-ssh",
						progress: {
							text: "Upload [fixture]  /tmp/blob.bin → /srv/blob.bin\n█████░░░░░  50.0% · 512.0KB / 1.0MB · 256.0KB/s · 2.0s",
							updatedAt: 200,
						},
					},
				],
			},
		};
		const options: Parameters<typeof waitToolRenderer.renderResult>[1] = { expanded: true, isPartial: true };
		const component = waitToolRenderer.renderResult(result, options, theme);
		const output = Bun.stripANSI(component.render(120).join("\n"));
		expect(output).toContain("█████░░░░░  50.0%");
		expect(output).toContain("256.0KB/s");
	});

	it("renders unsettled cancellation as cleanup in progress", () => {
		const result = {
			content: [{ type: "text" as const, text: "" }],
			details: {
				op: "cancel" as const,
				jobs: [
					{
						id: "job-ssh",
						type: "ssh_transfer" as const,
						status: "cancelled" as const,
						label: "upload blob",
						durationMs: 2_000,
						progress: { text: "25.0% · 256.0KB / 1.0MB", updatedAt: 200 },
					},
				],
			},
		};
		const options: Parameters<typeof waitToolRenderer.renderResult>[1] = { expanded: true, isPartial: true };
		const component = waitToolRenderer.renderResult(result, options, theme);
		const output = Bun.stripANSI(component.render(120).join("\n"));
		expect(output).toContain("cleanup in progress");
		expect(output).toContain("25.0%");
	});

	describe("live and sealed waiting snapshots", () => {
		const jobsData = [
			{
				id: "Job1",
				type: "task" as const,
				status: "running" as const,
				label: "Job1 running",
				durationMs: 1200,
			},
			{
				id: "Job2",
				type: "task" as const,
				status: "completed" as const,
				label: "Job2 completed",
				durationMs: 3400,
				resultText: "Job2 result",
			},
			{
				id: "Job3",
				type: "task" as const,
				status: "running" as const,
				label: "Job3 running",
				durationMs: 500,
			},
		];

		it("shows all jobs when isPartial is true", () => {
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: { op: "wait" as const, jobs: jobsData },
			};
			const component = waitToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: true } as Parameters<typeof waitToolRenderer.renderResult>[1],
				theme,
			);
			const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
			expect(output).toContain("Job1 running");
			expect(output).toContain("Job2 completed");
			expect(output).toContain("Job3 running");
			expect(output).toContain("waiting on 2 of 3 jobs");
		});

		it("retains running and settled jobs after a poll is sealed", () => {
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: { op: "wait" as const, jobs: jobsData },
			};
			const component = waitToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: false } as Parameters<typeof waitToolRenderer.renderResult>[1],
				theme,
			);
			const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
			expect(output).toContain("Job1 running");
			expect(output).toContain("Job2 completed");
			expect(output).toContain("Job3 running");
			expect(output).toContain("waiting on 2 of 3 jobs");
		});

		it("retains the worker identity in a sealed all-running poll", () => {
			const runningJobsOnly = [
				{
					id: "Job1",
					type: "task" as const,
					status: "running" as const,
					label: "Job1 running",
					durationMs: 1200,
				},
			];
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: { op: "wait" as const, jobs: runningJobsOnly },
			};
			const component = waitToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: false } as Parameters<typeof waitToolRenderer.renderResult>[1],
				theme,
			);
			const lines = component.render(120) as readonly string[];
			expect(Bun.stripANSI(lines.join("\n"))).toContain("Job1 running");
		});

		it("retains the running job in the sealed native wait card", () => {
			const result = {
				content: [{ type: "text" as const, text: "Still Running" }],
				details: { op: "wait" as const, jobs: [jobsData[0]] },
			};
			const view = waitToolRenderer.describeResult!(result, { expanded: true, isPartial: false });
			expect(view?.head).toEqual(expect.arrayContaining([expect.objectContaining({ t: "waiting on 1 job" })]));
			expect(JSON.stringify(view?.body)).toContain("Job1 running");
		});

		it.each([true, false])("animates running native rows only while the poll is live (%s)", isPartial => {
			const result = {
				content: [{ type: "text" as const, text: "Still Running" }],
				details: {
					op: "wait" as const,
					jobs: [jobsData[0], jobsData[1]],
					agents: [{ id: "Worker", ageMs: 1_000, live: true }],
				},
			};
			const view = waitToolRenderer.describeResult!(result, { expanded: true, isPartial });
			const rows = view!.body!;
			expect(rows[0]).toMatchObject({
				c: [
					{ k: "badge" },
					{ k: "text", p: { spans: [isPartial ? { fx: "shimmer" } : { t: "Job1" }, expect.any(Object)] } },
					{ k: "elapsed", p: isPartial ? { age: 1200 } : { age: 1200, stopped: 1200 } },
				],
			});
			expect(rows[2]).toMatchObject({
				c: [
					expect.any(Object),
					expect.any(Object),
					{ k: "elapsed", p: isPartial ? { age: 1000 } : { age: 1000, stopped: 1000 } },
				],
			});
			if (!isPartial) expect(JSON.stringify(view)).not.toContain('"fx":"shimmer"');
			else {
				expect(JSON.stringify(rows[0])).not.toContain('"stopped"');
				expect(JSON.stringify(rows[2])).not.toContain('"stopped"');
			}
		});

		it("keeps a settled native job to its one line: output and errors fill the call's own card", () => {
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: {
					op: "wait" as const,
					jobs: [
						{
							id: "bg_2",
							type: "bash" as const,
							status: "failed" as const,
							label: "hyperfine --runs 30 bench",
							durationMs: 61_000,
							toolCallId: "tool-bash",
							exitCode: 1,
							resultText: "Benchmark 1: calc_ir",
							errorText: "Command exited with code 1",
							meta: { artifactError: "write" as const },
						},
					],
				},
			};
			const view = waitToolRenderer.describeResult!(result, { expanded: true, isPartial: false });
			const [job] = view!.body!;
			expect(job).toMatchObject({ k: "row", p: { role: "omp.wait.job", tone: "error" } });
			const json = JSON.stringify(view);
			expect(json).toContain("hyperfine --runs 30 bench");
			expect(json).not.toContain("Benchmark 1");
			expect(json).not.toContain("exited with code 1");
			expect(json).not.toContain("artifact write failed");

			const ownCard = bashToolRenderer.describeResult(
				{
					content: [{ type: "text", text: "Benchmark 1: calc_ir" }],
					details: { exitCode: 1, meta: result.details.jobs[0].meta },
					isError: true,
				},
				{ expanded: true, isPartial: false },
				{ command: "hyperfine --runs 30 bench" },
			);
			expect(JSON.stringify(ownCard)).toContain("Benchmark 1: calc_ir");
			expect(JSON.stringify(ownCard)).toContain(formatArtifactErrorNotice("write"));
		});

		it.each([{ meta: { artifactError: "write" as const } }, { artifactError: "write" as const }])(
			"retains an unowned job's capture warning outside its native activity row (%j)",
			capture => {
				const result = {
					content: [{ type: "text" as const, text: "" }],
					details: {
						op: "wait" as const,
						jobs: [
							{
								id: "bg_legacy",
								type: "bash" as const,
								status: "failed" as const,
								label: "legacy job",
								durationMs: 1_000,
								resultText: "do not duplicate the job output",
								...capture,
							},
						],
					},
				};
				const view = waitToolRenderer.describeResult(result, { expanded: true, isPartial: false });
				const [job, warning] = view!.body!;
				expect(job).toMatchObject({ k: "row", p: { role: "omp.wait.job" } });
				expect(JSON.stringify(job)).not.toContain(formatArtifactErrorNotice("write"));
				expect(warning).toMatchObject({ k: "text", p: { role: "omp.tool.notice" } });
				expect(JSON.stringify(warning)).toContain(formatArtifactErrorNotice("write"));
				expect(JSON.stringify(view)).not.toContain("do not duplicate the job output");
			},
		);

		it("renders agent rows for running agents outside job control", () => {
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: {
					op: "wait" as const,
					jobs: [],
					agents: [{ id: "Worker", parentId: "Main", activity: "grepping the tree", ageMs: 65_000, live: true }],
				},
			};
			const component = waitToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: false } as Parameters<typeof waitToolRenderer.renderResult>[1],
				theme,
			);
			const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
			expect(output).toContain("1 running agent — no jobs");
			expect(output).toContain("Worker");
			expect(output).toContain("grepping the tree");
		});

		it("keeps a sealed bare-poll result visible when it carries an agent roster", () => {
			const result = {
				content: [{ type: "text" as const, text: "No running background jobs to wait for." }],
				details: { op: "wait" as const, jobs: [], agents: [{ id: "Worker", ageMs: 1_000, live: false }] },
			};
			const component = waitToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: false } as Parameters<typeof waitToolRenderer.renderResult>[1],
				theme,
			);
			const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
			expect(output).toContain("Worker");
			// A ref claiming `running` with no turn in flight is flagged, not shown
			// as live work.
			expect(output).toContain("no turn");
		});
	});
});
