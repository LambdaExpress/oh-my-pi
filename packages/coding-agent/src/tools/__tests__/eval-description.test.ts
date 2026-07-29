import { describe, expect, it } from "bun:test";
import { getEvalToolDescription } from "../eval";

describe("eval tool description", () => {
	it("routes routine tool calls away from eval orchestration", () => {
		const description = getEvalToolDescription({ py: false, js: true, spawns: "reviewer" });

		expect(description).toContain("Call session tools directly by default.");
		expect(description).toContain(
			"NEVER enter eval merely to wrap, batch, or parallelize independent tool/subagent calls",
		);
		expect(description).toContain("Use eval orchestration only for complex, value-dependent workflows");
	});

	it("advertises the first allowed spawn as the agent() default", () => {
		const description = getEvalToolDescription({ py: true, js: false, spawns: "fact-finder,oracle" });

		expect(description).toContain('agent(prompt, agent?="fact-finder"');
		expect(description).toContain("Allowed agents: `fact-finder`, `oracle`.");
	});

	it("omits agent() when spawning is disabled", () => {
		const description = getEvalToolDescription({ py: true, js: false, spawns: "" });

		expect(description).not.toContain("agent(prompt");
		expect(description).not.toContain("<dag>");
	});
});
