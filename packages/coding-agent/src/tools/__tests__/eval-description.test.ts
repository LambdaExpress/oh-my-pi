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

	it("renders distinct Python and JavaScript schema-mode signatures by default", () => {
		const description = getEvalToolDescription();

		expect(description).toContain(
			'agent(prompt, agent?="task", label?=None, schema?=None, schema_mode?="permissive"',
		);
		expect(description).not.toContain('schemaMode?="permissive"');
		expect(description).toContain(
			"JS: ONE trailing object — agent(prompt, { agent, label, schema, schemaMode, isolated, apply, merge, handle })",
		);
	});

	it("keeps schema-mode casing correct in single-language descriptions", () => {
		const python = getEvalToolDescription({ py: true, js: false });
		const javascript = getEvalToolDescription({ py: false, js: true });

		expect(python).toContain('schema_mode?="permissive"');
		expect(python).not.toContain('schemaMode?="permissive"');
		expect(python).not.toContain("JS: ONE trailing object");

		expect(javascript).toContain('schemaMode?="permissive"');
		expect(javascript).not.toContain('schema_mode?="permissive"');
		expect(javascript).toContain(
			"JS: ONE trailing object — agent(prompt, { agent, label, schema, schemaMode, isolated, apply, merge, handle })",
		);
	});

	it("omits agent() when spawning is disabled", () => {
		const description = getEvalToolDescription({ py: true, js: false, spawns: "" });

		expect(description).not.toContain("agent(prompt");
		expect(description).not.toContain("<dag>");
	});
});
