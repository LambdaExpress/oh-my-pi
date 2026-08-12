import { describe, expect, it } from "bun:test";
import { createDesktopBridge, desktopBridge, type TauriInvoke } from "../src/lib/desktop-bridge";

interface InvokeCall {
	command: string;
	args?: Record<string, unknown>;
}

function respondingInvoke(response: unknown, calls: InvokeCall[]): TauriInvoke {
	return async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
		calls.push({ command, args });
		return response as T;
	};
}

describe("DesktopBridge browser fallback", () => {
	it("imports without Tauri and exposes no desktop capability", async () => {
		expect(desktopBridge.available).toBe(false);
		expect(await desktopBridge.listProjects()).toEqual([]);
		await expect(desktopBridge.openProject()).resolves.toBeUndefined();
		await expect(desktopBridge.switchProject("/work/project")).resolves.toBeUndefined();
	});
});

describe("DesktopBridge Tauri capability probe", () => {
	it("maps authorized projects and enables mutations only after project_list succeeds", async () => {
		const calls: InvokeCall[] = [];
		const bridge = createDesktopBridge(
			respondingInvoke(
				{
					recent_projects: ["C:\\Work\\Current\\", "/srv/other"],
					last_project: "/ignored/last-project",
					current_project: "c:/work/current",
				},
				calls,
			),
		);

		expect(bridge.available).toBe(false);
		expect(await bridge.listProjects()).toEqual([
			{ path: "C:\\Work\\Current\\", name: "Current", current: true },
			{ path: "/srv/other", name: "other", current: false },
		]);
		expect(bridge.available).toBe(true);

		await bridge.openProject();
		await bridge.switchProject("/srv/other");
		expect(calls).toEqual([
			{ command: "project_list", args: undefined },
			{ command: "project_open", args: undefined },
			{ command: "project_switch", args: { path: "/srv/other" } },
		]);
	});

	it("inserts the active project when it is absent from recent projects", async () => {
		const bridge = createDesktopBridge(
			respondingInvoke(
				{
					recent_projects: ["/work/older"],
					last_project: "/work/older",
					current_project: "/work/live/",
				},
				[],
			),
		);

		expect(await bridge.listProjects()).toEqual([
			{ path: "/work/live/", name: "live", current: true },
			{ path: "/work/older", name: "older", current: false },
		]);
	});

	it("falls back after a denied probe and never invokes project mutations", async () => {
		const calls: InvokeCall[] = [];
		const deniedInvoke: TauriInvoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
			calls.push({ command, args });
			throw new Error("command project_list not allowed by capability");
		};
		const bridge = createDesktopBridge(deniedInvoke);

		expect(await bridge.listProjects()).toEqual([]);
		expect(bridge.available).toBe(false);
		await expect(bridge.openProject()).resolves.toBeUndefined();
		await expect(bridge.switchProject("/work/project")).resolves.toBeUndefined();
		expect(await bridge.listProjects()).toEqual([]);
		expect(calls).toEqual([{ command: "project_list", args: undefined }]);
	});

	it("disables later mutations when an authorized command is denied", async () => {
		const calls: InvokeCall[] = [];
		const invoke: TauriInvoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
			calls.push({ command, args });
			if (command === "project_list") {
				return { recent_projects: [], last_project: null, current_project: null } as T;
			}
			throw new Error(`command ${command} not allowed by capability`);
		};
		const bridge = createDesktopBridge(invoke);

		await bridge.listProjects();
		expect(bridge.available).toBe(true);
		await expect(bridge.openProject()).rejects.toThrow("not allowed by capability");
		expect(bridge.available).toBe(false);
		await expect(bridge.switchProject("/work/project")).resolves.toBeUndefined();
		expect(calls.map(call => call.command)).toEqual(["project_list", "project_open"]);
	});
});
