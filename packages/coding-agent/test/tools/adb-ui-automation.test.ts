import { describe, expect, it } from "bun:test";
import type { AdbBinaryResult, AdbCommandResult } from "@oh-my-pi/pi-coding-agent/adb/adb-executor";
import { AdbUiAutomation } from "@oh-my-pi/pi-coding-agent/adb/ui-automation";
import { ToolAbortError, ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

const SERIAL = "emulator-5554";
const OTHER_SERIAL = "device-two";

interface CommandCall {
	args: readonly string[];
	timeoutMs: number;
	signal?: AbortSignal;
}

type Frame = string | AdbBinaryResult | Error;

function node(attributes: Record<string, string> = {}, children = ""): string {
	const values = {
		text: "Save",
		"resource-id": "app:id/save",
		class: "android.widget.Button",
		package: "app",
		enabled: "true",
		clickable: "true",
		bounds: "[10,20][110,80]",
		...attributes,
	};
	const encoded = Object.entries(values)
		.map(
			([key, value]) =>
				`${key}="${value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}"`,
		)
		.join(" ");
	return `<node ${encoded}>${children}</node>`;
}

function hierarchy(...nodes: string[]): string {
	return `<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0">${nodes.join("")}</hierarchy>`;
}

function harness(
	frames: Frame[] = [hierarchy(node())],
	options: {
		read?: (call: CommandCall, index: number) => Frame | Promise<Frame>;
		input?: (call: CommandCall) => void | Promise<void>;
	} = {},
) {
	const captures: CommandCall[] = [];
	const inputs: CommandCall[] = [];
	let current: Frame = frames[0] ?? hierarchy();
	const automation = new AdbUiAutomation({
		async runBinary(args, timeoutMs, signal) {
			const call = { args, timeoutMs, signal };
			captures.push(call);
			current = options.read ? await options.read(call, captures.length - 1) : (frames.shift() ?? current);
			if (current instanceof Error) throw current;
			return typeof current === "string"
				? { bytes: new TextEncoder().encode(current), exitCode: 0, cancelled: false }
				: current;
		},
		async runText(args, timeoutMs, signal): Promise<AdbCommandResult> {
			const call = { args, timeoutMs, signal };
			inputs.push(call);
			await options.input?.(call);
			return {
				output: "",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				totalLines: 0,
				totalBytes: 0,
				outputLines: 0,
				outputBytes: 0,
			};
		},
	});
	return { automation, captures, inputs };
}

describe("ADB UI reference safety", () => {
	it("rejects a reference from an older observation before mutation", async () => {
		const { automation, inputs } = harness();
		const previous = await automation.observe(SERIAL, 2_000);
		await automation.observe(SERIAL, 2_000);
		await expect(automation.click(SERIAL, { ref: previous.elements[0]!.ref }, false, 2_000)).rejects.toBeInstanceOf(
			ToolError,
		);
		expect(inputs).toEqual([]);
	});

	it("cannot use another device's reference but keeps the original device scoped", async () => {
		const { automation, inputs } = harness();
		const observed = await automation.observe(SERIAL, 2_000);
		await expect(
			automation.click(OTHER_SERIAL, { ref: observed.elements[0]!.ref }, false, 2_000),
		).rejects.toBeInstanceOf(ToolError);
		expect(inputs).toEqual([]);
		await automation.click(SERIAL, { ref: observed.elements[0]!.ref }, false, 2_000);
		expect(inputs[0]!.args).toEqual(["-s", SERIAL, "shell", "input", "tap", "60", "50"]);
	});

	it("does not accept references from another automation instance", async () => {
		const first = harness();
		const second = harness();
		const observed = await first.automation.observe(SERIAL, 2_000);
		await second.automation.observe(SERIAL, 2_000);
		await expect(
			second.automation.click(SERIAL, { ref: observed.elements[0]!.ref }, false, 2_000),
		).rejects.toBeInstanceOf(ToolError);
		expect(second.inputs).toEqual([]);
	});

	it.each([
		["bounds changed", { bounds: "[110,20][210,80]" }],
		["target became disabled", { enabled: "false" }],
	] satisfies Array<[string, Record<string, string>]>)("rejects a fresh hierarchy when %s", async (_name, changed) => {
		const { automation, inputs } = harness([hierarchy(node()), hierarchy(node(changed))]);
		const observed = await automation.observe(SERIAL, 2_000);
		await expect(automation.click(SERIAL, { ref: observed.elements[0]!.ref }, false, 2_000)).rejects.toBeInstanceOf(
			ToolError,
		);
		expect(inputs).toEqual([]);
	});

	it("rejects an unchanged label inside a replaced ancestor", async () => {
		const label = node({ clickable: "false" });
		const { automation, inputs } = harness([
			hierarchy(node({ text: "", "resource-id": "app:id/first", bounds: "[0,0][300,300]" }, label)),
			hierarchy(node({ text: "", "resource-id": "app:id/second", bounds: "[0,0][300,300]" }, label)),
		]);
		const observed = await automation.observe(SERIAL, 2_000);
		await expect(automation.click(SERIAL, { ref: observed.elements[1]!.ref }, false, 2_000)).rejects.toBeInstanceOf(
			ToolError,
		);
		expect(inputs).toEqual([]);
	});

	it("invalidates references after successful and failed input", async () => {
		for (const fail of [false, true]) {
			const { automation, inputs } = harness(undefined, {
				input() {
					if (fail) throw new ToolError("Device disconnected during input");
				},
			});
			const observed = await automation.observe(SERIAL, 2_000);
			const target = { ref: observed.elements[0]!.ref };
			if (fail) await expect(automation.click(SERIAL, target, false, 2_000)).rejects.toBeInstanceOf(ToolError);
			else await automation.click(SERIAL, target, false, 2_000);
			await expect(automation.click(SERIAL, target, false, 2_000)).rejects.toBeInstanceOf(ToolError);
			expect(inputs).toHaveLength(1);
		}
	});

	it("cannot publish or act on a capture invalidated while in flight", async () => {
		const pending = Promise.withResolvers<Frame>();
		const { automation, inputs } = harness(undefined, { read: () => pending.promise });
		const click = automation.click(SERIAL, { text: "Save" }, false, 2_000);
		automation.invalidate(SERIAL);
		pending.resolve(hierarchy(node()));
		await expect(click).rejects.toBeInstanceOf(ToolError);
		expect(inputs).toEqual([]);
	});
});

describe("ADB UI semantic clicking", () => {
	it("rejects ambiguous visible matches instead of choosing the first", async () => {
		const { automation, inputs } = harness([hierarchy(node(), node({ bounds: "[120,20][220,80]" }))]);
		await expect(automation.click(SERIAL, { text: "Save" }, false, 2_000)).rejects.toBeInstanceOf(ToolError);
		expect(inputs).toEqual([]);
	});

	it("clicks the label center within its clickable ancestor, ignoring hidden duplicates", async () => {
		const label = node({ clickable: "false", bounds: "[20,30][80,50]" });
		const { automation, inputs } = harness([
			hierarchy(node({ text: "", bounds: "[0,0][300,300]" }, label), node({ "visible-to-user": "false" })),
		]);
		const result = await automation.click(SERIAL, { text: "Save" }, false, 2_000);
		expect({ x: result.x, y: result.y }).toEqual({ x: 50, y: 40 });
		expect(inputs[0]!.args).toEqual(["-s", SERIAL, "shell", "input", "tap", "50", "40"]);
	});

	it("uses the visible intersection when a label center lies outside its ancestor", async () => {
		const { automation, inputs } = harness([
			hierarchy(
				node({ text: "", bounds: "[0,0][100,100]" }, node({ clickable: "false", bounds: "[80,20][180,80]" })),
			),
		]);
		await automation.click(SERIAL, { text: "Save" }, false, 2_000);
		expect(inputs[0]!.args).toEqual(["-s", SERIAL, "shell", "input", "tap", "90", "50"]);
	});

	it.each([
		["disabled", { enabled: "false" }],
		["not actionable", { clickable: "false" }],
		["invalid bounds", { bounds: "[10,20][10,80]" }],
	] satisfies Array<[string, Record<string, string>]>)("never blindly clicks a %s node", async (_name, attributes) => {
		const { automation, inputs } = harness([hierarchy(node(attributes))]);
		await expect(automation.click(SERIAL, { text: "Save" }, false, 2_000)).rejects.toBeInstanceOf(ToolError);
		expect(inputs).toEqual([]);
	});

	it("requires long-click support and dispatches a stationary 600ms swipe", async () => {
		const unsupported = harness();
		await expect(unsupported.automation.click(SERIAL, { text: "Save" }, true, 2_000)).rejects.toBeInstanceOf(
			ToolError,
		);
		expect(unsupported.inputs).toEqual([]);
		const supported = harness([
			hierarchy(
				node({ text: "", "long-clickable": "true", bounds: "[0,0][300,300]" }, node({ clickable: "false" })),
			),
		]);
		await supported.automation.click(SERIAL, { text: "Save" }, true, 2_000);
		expect(supported.inputs[0]!.args).toEqual([
			"-s",
			SERIAL,
			"shell",
			"input",
			"swipe",
			"60",
			"50",
			"60",
			"50",
			"600",
		]);
	});
});

describe("ADB UI capture and conditional waits", () => {
	it("polls a condition transition and returns a usable fresh reference", async () => {
		const { automation, captures, inputs } = harness([hierarchy(node({ enabled: "false" })), hierarchy(node())]);
		const result = await automation.wait(SERIAL, { text: "Save" }, "enabled", 2_000);
		expect(result.matches.map(element => element.enabled)).toEqual([true]);
		expect(captures).toHaveLength(2);
		await automation.click(SERIAL, { ref: result.matches[0]!.ref }, false, 2_000);
		expect(inputs[0]!.args).toEqual(["-s", SERIAL, "shell", "input", "tap", "60", "50"]);
	});

	it("observes disappearance rather than treating visible disabled nodes as hidden", async () => {
		const { automation, captures } = harness([hierarchy(node({ enabled: "false" })), hierarchy()]);
		const result = await automation.wait(SERIAL, { text: "Save" }, "hidden", 2_000);
		expect(captures).toHaveLength(2);
		expect(result.matches).toEqual([]);
	});

	it("rejects ambiguous positive conditions even if only one match has the desired state", async () => {
		const { automation } = harness([hierarchy(node(), node({ enabled: "false" }))]);
		await expect(automation.wait(SERIAL, { text: "Save" }, "enabled", 2_000)).rejects.toBeInstanceOf(ToolError);
	});

	it.each([
		["truncated hierarchy", '<?xml version="1.0"?><hierarchy rotation="0"><node'],
		["device failure", new ToolError("ADB device disconnected")],
		["unexpected trailing output", `${hierarchy()}\nUnexpected failure`],
	] satisfies Array<[string, Frame]>)("never reports hidden on %s", async (_name, frame) => {
		const { automation, captures } = harness([frame]);
		await expect(automation.wait(SERIAL, { text: "Save" }, "hidden", 2_000)).rejects.toBeInstanceOf(ToolError);
		expect(captures).toHaveLength(1);
	});

	it("rejects incomplete UTF-8 instead of parsing replacement characters", async () => {
		const prefix = new TextEncoder().encode(hierarchy(node()).replace("Save", ""));
		const bytes = new Uint8Array(prefix.length + 1);
		bytes.set(prefix);
		bytes[prefix.length] = 0xc3;
		const { automation } = harness([{ bytes, exitCode: 0, cancelled: false }]);
		await expect(automation.observe(SERIAL, 2_000)).rejects.toBeInstanceOf(ToolError);
	});

	it("accepts only the known success banner before complete XML", async () => {
		const { automation } = harness(undefined, {
			read(call) {
				const path = /path=(\/data\/local\/tmp\/omp-ui-[a-f\d-]+\.xml)/.exec(call.args[5]!);
				if (!path) throw new Error("Capture did not supply a generated dump path");
				return `UI hierchary dumped to: ${path[1]}\r\n${hierarchy(node())}`;
			},
		});
		const observed = await automation.observe(SERIAL, 2_000);
		expect(observed.elements[0]!.text).toBe("Save");
	});

	it("recovers a UIAutomator idle failure reported with exit status zero", async () => {
		const { automation, captures } = harness(["ERROR: could not get idle state.\n", hierarchy(node())]);
		const result = await automation.observe(SERIAL, 2_000);
		expect(result.elements[0]!.resourceId).toBe("app:id/save");
		expect(captures).toHaveLength(2);
	});

	it("bounds idle recovery attempts instead of retrying until an unlimited success", async () => {
		const { automation, captures } = harness(["ERROR: could not get idle state.\n"]);
		await expect(automation.observe(SERIAL, 2_000)).rejects.toBeInstanceOf(ToolError);
		expect(captures).toHaveLength(3);
	});

	it("waits through a transient null root without mistaking a failed dump for disappearance", async () => {
		const nullRoot = "ERROR: null root node returned by UiTestAutomationBridge.\n";
		const recovered = harness([nullRoot, hierarchy(node()), hierarchy()]);
		const result = await recovered.automation.wait(SERIAL, { text: "Save" }, "hidden", 2_000);
		expect(result.matches).toEqual([]);
		expect(recovered.captures).toHaveLength(3);
		const persistent = harness([nullRoot]);
		await expect(persistent.automation.wait(SERIAL, { text: "Save" }, "hidden", 2_000)).rejects.toThrow(
			/null root node/,
		);
	});

	it("honors one deadline across polling and a stalled later capture", async () => {
		// Exercise the production timer/performance.now boundary without changing
		// process-global clocks used by other tool tests.
		const pending = Promise.withResolvers<Frame>();
		const { automation, captures } = harness(undefined, {
			read: (_call, index) => (index === 0 ? hierarchy() : pending.promise),
		});
		try {
			await expect(automation.wait(SERIAL, { text: "Save" }, "visible", 700)).rejects.toBeInstanceOf(ToolError);
			expect(captures).toHaveLength(2);
			expect(captures[1]!.timeoutMs).toBeLessThan(captures[0]!.timeoutMs - 150);
			expect(captures[1]!.signal?.aborted).toBe(true);
		} finally {
			pending.resolve(hierarchy(node()));
		}
	});

	it("does not dispatch input when capture exceeds the shared click deadline", async () => {
		// Real deadline integration: the injected capture deliberately never settles.
		const pending = Promise.withResolvers<Frame>();
		const { automation, inputs } = harness(undefined, { read: () => pending.promise });
		await expect(automation.click(SERIAL, { text: "Save" }, false, 30)).rejects.toBeInstanceOf(ToolError);
		pending.resolve(hierarchy(node()));
		await Promise.resolve();
		expect(inputs).toEqual([]);
	});

	it("aborts a stalled capture promptly without relying on the callback", async () => {
		const controller = new AbortController();
		const pending = Promise.withResolvers<Frame>();
		const { automation, inputs } = harness(undefined, { read: () => pending.promise });
		const click = automation.click(SERIAL, { text: "Save" }, false, 2_000, controller.signal);
		controller.abort();
		await expect(click).rejects.toBeInstanceOf(ToolAbortError);
		pending.resolve(hierarchy(node()));
		expect(inputs).toEqual([]);
	});

	it("aborts idle recovery during the interruptible retry pause", async () => {
		const controller = new AbortController();
		const { automation, captures } = harness(["ERROR: could not get idle state.\n"]);
		// Exercise cancellation of the actual retry timer, not a fake-clock callback.
		const timer = setTimeout(() => controller.abort(), 20);
		try {
			await expect(automation.observe(SERIAL, 2_000, controller.signal)).rejects.toBeInstanceOf(ToolAbortError);
			expect(captures).toHaveLength(1);
		} finally {
			clearTimeout(timer);
		}
	});
});
