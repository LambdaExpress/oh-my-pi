import { describe, expect, it } from "bun:test";
import type { SessionSummary } from "@oh-my-pi/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionsPanel, groupSessionsByProject } from "../src/components/sessions/SessionsPanel";
import type { ControlSnapshot } from "../src/lib/control-client";

function session(id: string, cwd: string, modifiedAt: string, title = id): SessionSummary {
	return {
		id,
		title,
		cwd,
		createdAt: "2026-08-01T00:00:00.000Z",
		modifiedAt,
		messageCount: 0,
		status: "complete",
		running: false,
		streaming: false,
	};
}

function snapshot(sessions: readonly SessionSummary[], readOnly = false): ControlSnapshot {
	return {
		phase: "live",
		endedReason: null,
		readOnly,
		sessions,
	};
}

function renderPanel(snap: ControlSnapshot, activeSessionId: string | null = null): string {
	return renderToStaticMarkup(
		<SessionsPanel
			snapshot={snap}
			activeSessionId={activeSessionId}
			onOpenSettings={() => {}}
			onOpenSession={() => {}}
			onNewSession={() => {}}
			onDropSession={() => {}}
			onLeave={() => {}}
		/>,
	);
}

describe("SessionsPanel project grouping", () => {
	it("normalizes cwd separators, trailing slashes, and Windows path case", () => {
		const groups = groupSessionsByProject([
			session("windows-new", "C:\\Work\\Repo\\", "2026-08-10T12:00:00.000Z"),
			session("windows-old", "c:/work//repo/", "2026-08-09T12:00:00.000Z"),
			session("posix", "/srv/project///", "2026-08-08T12:00:00.000Z"),
		]);

		expect(groups).toHaveLength(2);
		expect(groups[0]?.path).toBe("C:/Work/Repo");
		expect(groups[0]?.sessions.map(item => item.id)).toEqual(["windows-new", "windows-old"]);
		expect(groups[1]?.path).toBe("/srv/project");
		expect(groups[1]?.sessions.map(item => item.id)).toEqual(["posix"]);
	});

	it("sorts sessions newest first and projects by their latest activity", () => {
		const groups = groupSessionsByProject([
			session("alpha-old", "/work/alpha", "2026-08-03T09:00:00.000Z"),
			session("beta", "/work/beta", "2026-08-04T09:00:00.000Z"),
			session("alpha-new", "/work/alpha", "2026-08-05T09:00:00.000Z"),
		]);

		expect(groups.map(group => group.name)).toEqual(["alpha", "beta"]);
		expect(groups[0]?.sessions.map(item => item.id)).toEqual(["alpha-new", "alpha-old"]);
		expect(groups[1]?.sessions.map(item => item.id)).toEqual(["beta"]);
	});
});

describe("SessionsPanel session actions", () => {
	it("maps activeSessionId to the active row's aria-current state", () => {
		const html = renderPanel(
			snapshot([
				session("other", "/work/project", "2026-08-05T09:00:00.000Z", "Other session"),
				session("active", "/work/project", "2026-08-04T09:00:00.000Z", "Active session"),
			]),
			"active",
		);

		expect(html).toContain('aria-current="page" title="Open Active session"');
		expect(html).not.toContain('aria-current="page" title="Open Other session"');
	});

	it("renders read-only session rows without resume, create, or drop controls", () => {
		const html = renderPanel(
			snapshot([session("readonly", "/work/project", "2026-08-05T09:00:00.000Z", "Read only session")], true),
			"readonly",
		);

		expect(html).toContain('<div class="sh-sessions-item-open" title="Read only session">');
		expect(html).not.toContain('title="Open Read only session"');
		expect(html).not.toContain("Resume");
		expect(html).not.toContain("New session");
		expect(html).not.toContain("Drop Read only session");
	});
});
