/**
 * Contracts of the fullscreen /agents hub: frame geometry, scope sidebar
 * filtering, type-to-filter search, the Space enable/disable toggle, and the
 * strip-driven configuration flows (property strips, pattern input, and the
 * model-browser pick) persisting one agent's entry at a time.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import { AgentsHubComponent, type HubAgent } from "../src/overlays/agents-hub";
import { initTheme } from "../src/theme";
import type { TUI } from "../src/index";
import type { DescribeContext, NativeChild, NativeNode } from "../src/native/node";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OVERRIDE_KEYS = {
	model: "task.agentModelOverrides",
	prewalk: "task.agentPrewalk",
	advisor: "task.agentAdvisor",
} as const;

/** Settings double with entry-level writers; `writes` records every entry the hub touched. */
class TestSettings {
	readonly lists = new Map<string, string[]>();
	readonly records = new Map<string, Record<string, string>>();
	readonly writes: string[] = [];

	setMember(key: string, item: string, { member }: { member: boolean }): void {
		const rest = (this.lists.get(key) ?? []).filter(entry => entry !== item);
		this.lists.set(key, member ? [...rest, item] : rest);
		this.writes.push(`${key}[${item}]`);
	}

	setEntry(key: string, name: string, value: string | undefined): void {
		const record = { ...this.records.get(key) };
		if (value === undefined) delete record[name];
		else record[name] = value;
		this.records.set(key, record);
		this.writes.push(`${key}.${name}`);
	}
}

// Narrow TUI stub: the hub only reads terminal rows and requests renders.
const tuiStub = { requestRender: () => {}, terminal: { rows: 30 } } as unknown as TUI;

const sonnet = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	thinking: { mode: "budget", efforts: [Effort.Low, Effort.Medium, Effort.High] },
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200000,
	maxTokens: 8192,
});

async function createHub(settings: TestSettings): Promise<{
	hub: AgentsHubComponent;
	strip: () => string;
	type: (text: string) => void;
	cancelled: () => boolean;
}> {
	let cancelled = false;
	const hub = await AgentsHubComponent.create(
		tuiStub,
		{
			browserSource: {
				revision: 0,
				defaultThinkingLevel: "high",
				modelProviderOrder: [],
				knownRoleIds: [],
				mruOrder: [],
				modelPerf: new Map(),
				getModelRole: () => undefined,
				getRoleInfo: role => ({ name: role, section: "chat", accepts: () => true }),
				defaultRoleChain: () => [],
				resolveRoleValue: () => ({ model: undefined, explicitThinkingLevel: false }),
			},
			loadAgents: async () => {
				const agents: HubAgent[] = [
					{ name: "dev", description: "Development agent", systemPrompt: "", source: "project", disabled: false },
					{
						name: "scout",
						description: "Read-only research",
						systemPrompt: "",
						source: "bundled",
						disabled: false,
					},
					{
						name: "task",
						description: "Generic task agent",
						systemPrompt: "",
						source: "bundled",
						disabled: false,
					},
				];
				for (const agent of agents) {
					agent.disabled = settings.lists.get("task.disabledAgents")?.includes(agent.name) ?? false;
					agent.overrideModel = settings.records.get(OVERRIDE_KEYS.model)?.[agent.name];
					agent.prewalkOverride = settings.records.get(OVERRIDE_KEYS.prewalk)?.[agent.name];
					agent.advisorOverride = settings.records.get(OVERRIDE_KEYS.advisor)?.[agent.name];
				}
				return agents;
			},
			getAvailableModels: () => [sonnet],
			effectiveModelPatterns: agent => (agent.overrideModel ? [agent.overrideModel] : []),
			resolvePatterns: () => undefined,
			effectivePrewalkPattern: () => undefined,
			effectiveAdvisorPattern: agent => (agent.advisorOverride === "on" ? "@advisor" : undefined),
			setAgentDisabled: (name, { disabled }) =>
				settings.setMember("task.disabledAgents", name, { member: disabled }),
			setAgentOverride: (property, name, value) => settings.setEntry(OVERRIDE_KEYS[property], name, value),
			generateAgent: async () => {
				throw new Error("Agent generation is not used by configuration tests");
			},
			saveAgent: async () => {
				throw new Error("Agent creation is not used by configuration tests");
			},
		},
		{ onCancel: () => (cancelled = true) },
	);
	return {
		hub,
		strip: () => hub.render(120).join("\n").replace(ANSI_PATTERN, ""),
		type: (text: string) => {
			for (const char of text) hub.handleInput(char);
		},
		cancelled: () => cancelled,
	};
}

beforeAll(async () => {
	await initTheme(false);
});

describe("AgentsHub layout", () => {
	test("renders the full-height split frame with sidebar scopes and agent rows", async () => {
		const { hub, strip } = await createHub(new TestSettings());
		const lines = hub.render(120);
		// top border + content rows + divider + footer + bottom border = terminal rows.
		expect(lines.length).toBe(30);
		const rendered = strip();
		expect(rendered).toContain("dev");
		expect(rendered).toContain("scout");
	});

	test("sidebar scope filters the rows to one source", async () => {
		const { hub } = await createHub(new TestSettings());
		hub.handleInput("\x1b[D"); // left → scope focus
		hub.handleInput("\x1b[B"); // down → Project
		expect(pickerProps(hub).scope).toBe("source:project");
		expect(pickerProps(hub).items?.map(item => item.id)).toEqual(["agent:project:dev", "new"]);
	});

	test("type-to-filter narrows the list and Esc clears the query first", async () => {
		const { hub, type, cancelled } = await createHub(new TestSettings());
		type("sco");
		expect(pickerProps(hub).items?.map(item => item.id)).toEqual(["agent:bundled:scout", "new"]);
		hub.handleInput("\x1b"); // Esc clears the query, not the hub
		expect(cancelled()).toBe(false);
		expect(pickerProps(hub).query).toBe("");
		expect(pickerProps(hub).items?.map(item => item.id)).toEqual([
			"agent:project:dev",
			"agent:bundled:scout",
			"agent:bundled:task",
			"new",
		]);
		hub.handleInput("\x1b");
		expect(cancelled()).toBe(true);
	});
});

describe("AgentsHub configuration strips", () => {
	test("Space toggles only the selected agent's entry", async () => {
		const settings = new TestSettings();
		settings.lists.set("task.disabledAgents", ["scout", "unavailable"]);
		const { hub } = await createHub(settings);
		// Persisted settings may change after discovery, independently of this hub's snapshot.
		settings.lists.set("task.disabledAgents", ["scout", "unavailable", "another"]);
		hub.handleInput(" ");
		expect(settings.lists.get("task.disabledAgents")).toEqual(["scout", "unavailable", "another", "dev"]);
		hub.handleInput(" ");
		expect(settings.lists.get("task.disabledAgents")).toEqual(["scout", "unavailable", "another"]);
		expect(settings.writes).toEqual(["task.disabledAgents[dev]", "task.disabledAgents[dev]"]);
	});

	test("Enter opens the property strip; advisor → on persists only that agent's entry", async () => {
		const settings = new TestSettings();
		settings.records.set("task.agentAdvisor", { scout: "off", unavailable: "on" });
		const { hub } = await createHub(settings);
		settings.records.set("task.agentAdvisor", { scout: "on", unavailable: "on" });
		hub.handleInput("\r"); // agent strip for `dev`
		expect(pickerProps(hub).focus).toBe("strip");
		hub.handleInput("\x1b[C"); // model → prewalk
		hub.handleInput("\x1b[C"); // prewalk → advisor
		hub.handleInput("\r"); // advisor value strip
		hub.handleInput("\x1b[C"); // agent default → on
		hub.handleInput("\r");
		expect(settings.records.get("task.agentAdvisor")).toEqual({ scout: "on", unavailable: "on", dev: "on" });
		expect(settings.writes).toEqual(["task.agentAdvisor.dev"]);
		expect(pickerProps(hub).strip).toBeNull();
	});

	test("pattern… commits a custom advisor pattern and empty submit clears it", async () => {
		const settings = new TestSettings();
		settings.records.set("task.agentAdvisor", { dev: "on", unavailable: "off" });
		const { hub, type } = await createHub(settings);
		hub.handleInput("\r");
		hub.handleInput("\x1b[C");
		hub.handleInput("\x1b[C");
		hub.handleInput("\r"); // advisor strip
		// agent default → on → off → pick model… → pattern…
		for (let i = 0; i < 4; i++) hub.handleInput("\x1b[C");
		hub.handleInput("\r"); // pattern input, pre-filled "on"
		type("\x7f\x7f"); // clear the prefill
		type("moonshot/k3:high");
		hub.handleInput("\r");
		expect(settings.records.get("task.agentAdvisor")).toEqual({ dev: "moonshot/k3:high", unavailable: "off" });

		hub.handleInput("\r"); // agent strip
		hub.handleInput("\x1b[C");
		hub.handleInput("\x1b[C");
		hub.handleInput("\r"); // advisor strip
		for (let i = 0; i < 4; i++) hub.handleInput("\x1b[C");
		hub.handleInput("\r"); // pattern input
		type("\x7f".repeat("moonshot/k3:high".length));
		hub.handleInput("\r");
		expect(settings.records.get("task.agentAdvisor")).toEqual({ unavailable: "off" });
		expect(settings.writes).toEqual(["task.agentAdvisor.dev", "task.agentAdvisor.dev"]);
	});

	test("pick model… dives into the model browser and persists the model override", async () => {
		const settings = new TestSettings();
		settings.records.set("task.agentModelOverrides", { unavailable: "moonshot/k3:high" });
		const { hub, strip } = await createHub(settings);
		hub.handleInput("\r"); // agent strip (model chip preselected)
		hub.handleInput("\r"); // model value strip → [pick model…] first
		hub.handleInput("\r"); // assign mode: model browser
		expect(hub.nativeSheet(pickerCx)).toBe(false);
		expect(strip()).toContain("claude-sonnet-4-5");
		hub.handleInput("\r"); // pick the only model
		expect(settings.records.get("task.agentModelOverrides")).toEqual({
			unavailable: "moonshot/k3:high",
			dev: "anthropic/claude-sonnet-4-5",
		});
		// Back on the list with the override reflected.
		expect(strip()).toContain("anthropic/claude-sonnet-4-5");
	});

	test("clear override chip removes an existing model override", async () => {
		const settings = new TestSettings();
		settings.records.set("task.agentModelOverrides", {
			dev: "anthropic/claude-sonnet-4-5",
			unavailable: "moonshot/k3:high",
		});
		const { hub } = await createHub(settings);
		hub.handleInput("\r"); // agent strip
		hub.handleInput("\r"); // model value strip
		hub.handleInput("\x1b[C"); // pick model… → pattern…
		hub.handleInput("\x1b[C"); // pattern… → clear override
		hub.handleInput("\r");
		expect(settings.records.get("task.agentModelOverrides")).toEqual({ unavailable: "moonshot/k3:high" });
	});

	test("Esc steps back to the agent strip so its enable toggle remains available", async () => {
		const settings = new TestSettings();
		const { hub, cancelled } = await createHub(settings);
		hub.handleInput("\r"); // agent strip
		hub.handleInput("\r"); // model value strip
		hub.handleInput("\x1b"); // back to agent strip
		hub.handleInput("\x1b[D"); // model → enable toggle
		hub.handleInput("\r");
		expect(settings.lists.get("task.disabledAgents")).toEqual(["dev"]);
		hub.handleInput("\r"); // reopen agent strip
		hub.handleInput("\x1b"); // close strip
		expect(pickerProps(hub).strip).toBeNull();
		expect(cancelled()).toBe(false);
	});
});

/** The generic composition: a terminal without the `picker` kind. */
const cx: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: kind => kind !== "picker",
	feature: () => true,
};
const pickerCx: DescribeContext = { ...cx, supports: () => true };

function pickerProps(hub: AgentsHubComponent): TspPickerProps {
	const root = hub.describe(pickerCx);
	if (root.k !== "picker" || !root.p) throw new Error(`expected a picker root, got ${root.k}`);
	return root.p;
}

/** The described node keyed `key` and its key path (the `key` its native events carry). */
function findKeyed(root: NativeNode, key: string): { node: NativeNode; path: string } | undefined {
	const walk = (node: NativeNode, path: string[]): { node: NativeNode; path: string } | undefined => {
		const children: readonly NativeChild[] = node.c ?? [];
		for (let i = 0; i < children.length; i++) {
			const child = children[i];
			if (!child || !("k" in child)) continue;
			const childPath = [...path, child.key ?? String(i)];
			if (child.key === key) return { node: child, path: childPath.join("/") };
			const found = walk(child, childPath);
			if (found) return found;
		}
		return undefined;
	};
	return walk(root, []);
}

function mustFind(hub: AgentsHubComponent, key: string): { node: NativeNode; path: string } {
	const found = findKeyed(hub.describe(cx), key);
	if (!found) throw new Error(`no described node keyed ${key}`);
	return found;
}

describe("AgentsHub picker", () => {
	test("select then Configure opens the agent strip; a strip chip persists like Enter on it", async () => {
		const settings = new TestSettings();
		settings.lists.set("task.disabledAgents", ["dev", "scout", "unavailable"]);
		const { hub } = await createHub(settings);
		expect(hub.nativeSheet(pickerCx)).toBe(true);
		expect(hub.nativeSheet(cx)).toBe(false);
		expect(pickerProps(hub).items?.find(item => item.id === "agent:bundled:scout")?.disabled).toBeUndefined();

		hub.handleNativeEvent({ type: "select", key: "", item: "agent:bundled:scout" });
		expect(pickerProps(hub).selected).toBe("agent:bundled:scout");
		hub.handleNativeEvent({ type: "action", key: "", act: "configure", mods: [] });
		expect(pickerProps(hub).focus).toBe("strip");

		hub.handleNativeEvent({ type: "action", key: "", act: "strip", value: "0", mods: [] });
		expect(settings.lists.get("task.disabledAgents")).toEqual(["dev", "unavailable"]);
		expect(settings.writes).toEqual(["task.disabledAgents[scout]"]);
		expect(pickerProps(hub).strip).toBeNull();
		expect(pickerProps(hub).selected).toBe("agent:bundled:scout");
		expect(pickerProps(hub).items?.find(item => item.id === "agent:bundled:scout")?.dot).toBe("success");
	});

	test("the Toggle action flips the selected agent even while a search query is typed", async () => {
		const settings = new TestSettings();
		const { hub, type } = await createHub(settings);
		type("dev");
		hub.handleNativeEvent({ type: "action", key: "", act: "toggle", mods: [] });
		expect(settings.lists.get("task.disabledAgents")).toEqual(["dev"]);
		expect(pickerProps(hub).query).toBe("dev");
	});

	test("the pattern input leaves the picker for the generic overlay", async () => {
		const { hub } = await createHub(new TestSettings());
		hub.handleNativeEvent({ type: "action", key: "", act: "model", mods: [] });
		// pattern… is the second chip of the model strip
		hub.handleNativeEvent({ type: "action", key: "", act: "strip", value: "1", mods: [] });
		expect(hub.nativeSheet(pickerCx)).toBe(false);
		expect(hub.describe(pickerCx).k).not.toBe("picker");
	});

	test("scope action narrows items to that source and disables empty sources", async () => {
		const { hub } = await createHub(new TestSettings());
		expect(pickerProps(hub).scopes?.find(scope => scope.id === "source:user")?.disabled).toBeTruthy();
		hub.handleNativeEvent({ type: "action", key: "", act: "scope", value: "source:bundled", mods: [] });
		const props = pickerProps(hub);
		expect(props.scope).toBe("source:bundled");
		expect(props.items?.map(item => item.id)).toEqual(["agent:bundled:scout", "agent:bundled:task", "new"]);
	});
});

describe("AgentsHub native events", () => {
	test("list select mirrors the selection; activate opens the agent strip whose chips persist", async () => {
		const settings = new TestSettings();
		settings.lists.set("task.disabledAgents", ["scout", "unavailable"]);
		const { hub } = await createHub(settings);
		const agents = mustFind(hub, "agents");
		expect(agents.node.k === "list" && agents.node.p?.selected).toBe("agent:project:dev");

		hub.handleNativeEvent({ type: "select", key: agents.path, item: "agent:bundled:scout" });
		const selected = mustFind(hub, "agents").node;
		expect(selected.k === "list" && selected.p?.selected).toBe("agent:bundled:scout");
		expect(findKeyed(hub.describe(cx), "strip")).toBeUndefined();

		hub.handleNativeEvent({ type: "activate", key: agents.path, item: "agent:bundled:scout" });
		const strip = mustFind(hub, "strip");

		// Chip 0 is the enable/disable toggle; activating it persists only scout.
		hub.handleNativeEvent({ type: "activate", key: strip.path, item: "0" });
		expect(settings.lists.get("task.disabledAgents")).toEqual(["unavailable"]);
		expect(settings.writes).toEqual(["task.disabledAgents[scout]"]);
		expect(findKeyed(hub.describe(cx), "strip")).toBeUndefined();
	});

	test("scope select filters the described agent list to that source", async () => {
		const { hub } = await createHub(new TestSettings());
		const scopes = mustFind(hub, "scopes");
		hub.handleNativeEvent({ type: "select", key: scopes.path, item: "source:bundled" });
		const agents = mustFind(hub, "agents").node;
		expect(agents.c?.map(child => ("k" in child ? child.key : undefined))).toEqual([
			"agent:bundled:scout",
			"agent:bundled:task",
			"new",
		]);
		const sidebar = mustFind(hub, "scopes").node;
		expect(sidebar.k === "list" && sidebar.p?.selected).toBe("source:bundled");
	});

	test("the agent list ignores select while a strip is open", async () => {
		const { hub } = await createHub(new TestSettings());
		const agents = mustFind(hub, "agents");
		hub.handleInput("\r"); // agent strip for dev
		hub.handleNativeEvent({ type: "activate", key: agents.path, item: "agent:bundled:scout" });
		hub.handleInput("\x1b"); // close the strip
		const list = mustFind(hub, "agents").node;
		expect(list.k === "list" && list.p?.selected).toBe("agent:project:dev");
	});
});
