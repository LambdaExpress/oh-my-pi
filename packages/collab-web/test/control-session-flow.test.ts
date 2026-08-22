import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ControlGuestFrame, ControlHostFrame } from "@oh-my-pi/pi-wire";
import { ControlClient } from "../src/lib/control-client";
import { ControlSessionFlow } from "../src/lib/control-session-flow";
import { encodeBase64Url } from "../src/lib/link";
import { CollabSocket } from "../src/lib/socket";

const WRITE_SECRET_B64 = encodeBase64Url(new Uint8Array(48));
const SESSION_KEY = encodeBase64Url(new Uint8Array(32).fill(7));

interface LiveControl {
	client: ControlClient;
	socket: CollabSocket;
	sent: ControlGuestFrame[];
}

const clients: ControlClient[] = [];

afterEach(() => {
	for (const client of clients) client.close();
	clients.length = 0;
	vi.restoreAllMocks();
});

function makeControl(suffix: string): LiveControl {
	let socket: CollabSocket | null = null;
	const sent: ControlGuestFrame[] = [];
	const connectSpy = vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
		socket = this;
	});
	const room = `ctrl-${suffix.padEnd(22, suffix.at(-1) ?? "A")}`;
	const client = new ControlClient(`${room}.${WRITE_SECRET_B64}`, "tester");
	clients.push(client);
	client.connect();
	connectSpy.mockRestore();
	vi.spyOn(client, "sendCreate").mockImplementation(() => sent.push({ t: "ctrl-create" }));
	vi.spyOn(client, "sendResume").mockImplementation(id => sent.push({ t: "ctrl-resume", id }));
	if (socket === null) throw new Error("failed to capture control socket");
	client.close();
	return { client, socket, sent };
}

function reply(op: "created" | "resumed", id: string): ControlHostFrame {
	return { t: "ctrl-session", op, id, link: `session-${id}.${SESSION_KEY}` };
}

function bind(flow: ControlSessionFlow, control: LiveControl, opened: string[]): void {
	control.client.onSession = info => {
		const accepted = flow.accept(control.client, info);
		if (accepted) opened.push(accepted.id);
	};
}

describe("App control-session coordination", () => {
	it("blocks a create double-click and cannot overwrite Create with Resume", () => {
		const control = makeControl("pending");
		const flow = new ControlSessionFlow();
		const opened: string[] = [];
		flow.activate(control.client);
		bind(flow, control, opened);

		expect(flow.startCreate(control.client)).toBe(true);
		expect(flow.startCreate(control.client)).toBe(false);
		expect(flow.startResume(control.client, "existing")).toBe(false);
		expect(control.sent).toEqual([{ t: "ctrl-create" }]);
		expect(flow.pending).toBe(true);

		control.socket.onFrame?.(reply("resumed", "existing"), 0);
		expect(opened).toEqual([]);
		expect(flow.pending).toBe(true);
		control.socket.onFrame?.(reply("created", "host-assigned"), 0);
		expect(opened).toEqual(["host-assigned"]);
		expect(flow.pending).toBe(false);
	});

	it("carries the first prompt through the directed create reply", () => {
		const control = makeControl("initial-prompt");
		const flow = new ControlSessionFlow();
		flow.activate(control.client);

		expect(flow.startCreate(control.client, "inspect the current project")).toBe(true);
		const accepted = flow.accept(control.client, {
			op: "created",
			id: "fresh-session",
			link: `session-fresh.${SESSION_KEY}`,
		});

		expect(accepted?.initialPrompt).toBe("inspect the current project");
	});

	it("ignores unmatched directed replies until the authoritative reply opens its session id", () => {
		const control = makeControl("match");
		const flow = new ControlSessionFlow();
		const opened: string[] = [];
		flow.activate(control.client);
		bind(flow, control, opened);
		expect(flow.startResume(control.client, "wanted")).toBe(true);

		control.socket.onFrame?.(reply("created", "wanted"), 0);
		control.socket.onFrame?.(reply("resumed", "other"), 0);
		expect(opened).toEqual([]);
		expect(flow.pending).toBe(true);

		control.socket.onFrame?.(reply("resumed", "wanted"), 0);
		expect(opened).toEqual(["wanted"]);
		expect(flow.pending).toBe(false);
	});

	it("only clears pending for an error from the request's active ControlClient", () => {
		const control = makeControl("error-owner");
		const staleControl = makeControl("stale-error");
		const flow = new ControlSessionFlow();
		flow.activate(control.client);
		expect(flow.startCreate(control.client)).toBe(true);

		expect(flow.fail(staleControl.client)).toBe(false);
		expect(flow.pending).toBe(true);
		expect(flow.fail(control.client)).toBe(true);
		expect(flow.pending).toBe(false);
	});

	it("does not let a late reply reopen a session after Leave", () => {
		const control = makeControl("leave");
		const flow = new ControlSessionFlow();
		const opened: string[] = [];
		flow.activate(control.client);
		bind(flow, control, opened);
		expect(flow.startCreate(control.client)).toBe(true);

		flow.deactivate();
		control.socket.onFrame?.(reply("created", "late-after-leave"), 0);

		expect(opened).toEqual([]);
		expect(flow.activeClient).toBeNull();
		expect(flow.pending).toBe(false);
	});

	it("does not let a late reply reopen a session after Back", () => {
		const control = makeControl("back");
		const flow = new ControlSessionFlow();
		const opened: string[] = [];
		flow.activate(control.client);
		bind(flow, control, opened);
		expect(flow.startResume(control.client, "old-session")).toBe(true);

		flow.cancelPending();
		control.socket.onFrame?.(reply("resumed", "old-session"), 0);

		expect(opened).toEqual([]);
		expect(flow.activeClient).toBe(control.client);
		expect(flow.pending).toBe(false);
	});

	it("does not let the replaced ControlClient open or revive a session", () => {
		const oldControl = makeControl("old");
		const replacement = makeControl("new");
		const flow = new ControlSessionFlow();
		const opened: string[] = [];
		flow.activate(oldControl.client);
		bind(flow, oldControl, opened);
		expect(flow.startResume(oldControl.client, "shared-session")).toBe(true);

		const replaced = flow.activate(replacement.client);
		expect(replaced).toBe(oldControl.client);
		replaced?.close();
		bind(flow, replacement, opened);
		expect(flow.startResume(replacement.client, "shared-session")).toBe(true);
		oldControl.socket.onFrame?.(reply("resumed", "shared-session"), 0);

		expect(opened).toEqual([]);
		expect(flow.activeClient).toBe(replacement.client);
		expect(flow.pending).toBe(true);
		expect(flow.startResume(oldControl.client, "stale")).toBe(false);
		expect(oldControl.sent).toEqual([{ t: "ctrl-resume", id: "shared-session" }]);

		replacement.socket.onFrame?.(reply("resumed", "shared-session"), 0);
		expect(opened).toEqual(["shared-session"]);
		expect(flow.pending).toBe(false);
	});
});
