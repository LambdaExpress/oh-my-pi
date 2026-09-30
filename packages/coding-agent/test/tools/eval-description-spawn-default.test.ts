import { describe, expect, it } from "bun:test";
import { getEvalDocTopics, getEvalToolDescription } from "../../src/tools/eval";

describe("eval tool description", () => {
	it("routes routine tool calls away from eval orchestration", () => {
		const description = getEvalToolDescription({ py: false, js: true, spawns: "reviewer" });

		// The long-form prohibition lives in the system prompt (see system-prompt-inventory.test.ts);
		// the tool description carries the compressed gate.
		expect(description).toContain("Default → direct tools/`task` batch.");
		expect(description).toContain("Complex value-dependent workflow → eval orchestration.");
	});

	it("advertises the first allowed spawn as the agent() default", () => {
		const agents = getEvalDocTopics({ py: true, js: false, spawns: "fact-finder,oracle" }).agents;

		expect(agents).toContain('agent(prompt, agent?="fact-finder"');
		expect(agents).toContain("Allowed agents: `fact-finder`, `oracle`.");
	});

	it("renders distinct Python and JavaScript schema-mode signatures by default", () => {
		const agents = getEvalDocTopics().agents;

		expect(agents).toContain('agent(prompt, agent?="task", label?=None, schema?=None, schemaMode?="permissive"');
		expect(agents).not.toContain('schema_mode?="permissive"');
		expect(agents).toContain(
			"JS: ONE trailing object — agent(prompt, { agent, label, schema, schemaMode, isolated, apply, merge, tools })",
		);
	});

	it("keeps schema-mode casing correct in single-language topic docs", () => {
		const python = getEvalDocTopics({ py: true, js: false }).agents;
		const javascript = getEvalDocTopics({ py: false, js: true }).agents;

		expect(python).toContain('schema_mode?="permissive"');
		expect(python).not.toContain('schemaMode?="permissive"');
		expect(python).not.toContain("JS: ONE trailing object");

		expect(javascript).toContain('schemaMode?="permissive"');
		expect(javascript).not.toContain('schema_mode?="permissive"');
		expect(javascript).toContain(
			"JS: ONE trailing object — agent(prompt, { agent, label, schema, schemaMode, isolated, apply, merge, tools })",
		);
	});

	it("omits the agents topic when spawning is disabled", () => {
		const topics = getEvalDocTopics({ py: true, js: false, spawns: "" });
		const description = getEvalToolDescription({ py: true, js: false, spawns: "" });

		expect(topics.agents).toBeUndefined();
		expect(description).not.toContain("xd://eval/agents");
		expect(description).not.toContain("<dag>");
	});
});
