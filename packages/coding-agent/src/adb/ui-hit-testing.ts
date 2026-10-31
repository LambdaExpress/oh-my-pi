import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { AdbUiBounds, AdbUiElement, AdbUiObservation } from "./ui-types";

function contains(bounds: AdbUiBounds, x: number, y: number): boolean {
	return x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom;
}

/** UIAutomator visibility is ancestor clipping, not a physical hit test. */
export function assertHierarchyTouchPoint(
	observation: AdbUiObservation,
	target: AdbUiElement,
	x: number,
	y: number,
): void {
	const ancestors = new Set<AdbUiElement>();
	let ancestor: AdbUiElement | undefined = target;
	while (ancestor) {
		ancestors.add(ancestor);
		ancestor = ancestor.parentIndex === undefined ? undefined : observation.elements[ancestor.parentIndex];
	}
	for (const candidate of observation.elements) {
		if (
			ancestors.has(candidate) ||
			!candidate.visible ||
			!(candidate.clickable || candidate.longClickable || candidate.scrollable) ||
			!contains(candidate.bounds, x, y)
		) {
			continue;
		}
		let branch: AdbUiElement | undefined = candidate;
		let overlaps = true;
		while (branch) {
			if (branch === target || !branch.visible || !contains(branch.bounds, x, y)) {
				overlaps = false;
				break;
			}
			branch = branch.parentIndex === undefined ? undefined : observation.elements[branch.parentIndex];
		}
		if (overlaps) {
			// Stock UIAutomator dumps omit View drawing order / elevation. Do not
			// guess that the selected branch is above an overlapping touch receiver.
			throw new ToolError(
				`ADB UI target is occluded or has an ambiguous touch receiver at (${x}, ${y}): another interactive hierarchy branch ${candidate.ref} occupies the point. Reveal the target before clicking.`,
			);
		}
	}
}

/**
 * InputDispatcher lists windows front-to-back with logical-display touch regions.
 * Unlike an IME's full window frame, these regions also handle floating keyboards.
 * AOSP: frameworks/native/libs/gui/WindowInfo.cpp and dispatcher/InputDispatcher.cpp.
 */
export function assertInputWindowTouchPoint(dump: string, packageName: string, x: number, y: number): void {
	if (!/Input Dispatcher State:/i.test(dump) || !/^\s*Windows:/m.test(dump) || !packageName) {
		throw new ToolError(
			"ADB UI cannot establish the touch receiver from Android input-window data; no input was sent",
		);
	}
	let parsed = false;
	for (const match of dump.matchAll(/^\s*\d+: name=(.+)$/gm)) {
		const window = match[1]!;
		const display = /(?:^|,\s*)displayId=(-?\d+)(?:,|$)/.exec(window);
		if (display && Number(display[1]) !== 0) continue;
		parsed = true;
		const config = /(?:^|,\s*)inputConfig=([^,]*)/.exec(window)?.[1];
		const visible = /(?:^|,\s*)visible=(true|false)(?:,|$)/.exec(window)?.[1];
		const flags = /(?:^|,\s*)flags=(0x[\da-f]+)(?:,|$)/i.exec(window)?.[1];
		if (config !== undefined) {
			if (/\b(?:NOT_VISIBLE|NOT_TOUCHABLE|SPY)\b/.test(config)) continue;
		} else if (visible !== undefined && flags !== undefined) {
			if (visible === "false" || (Number(flags) & 0x10) !== 0) continue;
		} else {
			throw new ToolError("ADB UI cannot determine input-window visibility/touchability; no input was sent");
		}
		const region =
			/(?:^|,\s*)touchableRegion=(<empty>|(?:\[-?\d+,-?\d+\]\[-?\d+,-?\d+\]\|?)+)(?=,\s*[A-Za-z]|$)/.exec(
				window,
			)?.[1];
		if (region === undefined) {
			throw new ToolError("ADB UI cannot determine an input window's complete touchable region; no input was sent");
		}
		if (region === "<empty>") continue;
		let receives = false;
		for (const rect of region.matchAll(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/g)) {
			if (
				contains(
					{ left: Number(rect[1]), top: Number(rect[2]), right: Number(rect[3]), bottom: Number(rect[4]) },
					x,
					y,
				)
			) {
				receives = true;
				break;
			}
		}
		if (!receives) continue;
		const name = window.slice(0, window.indexOf(", "));
		const application = /(?:^|,\s*)applicationInfo\.name=([^,]*)/.exec(window)?.[1] ?? "";
		if (
			![name, application].some(
				value => value.includes(`${packageName}/`) || value === packageName || value === `'${packageName}'`,
			)
		) {
			throw new ToolError(
				`ADB UI target is occluded at (${x}, ${y}) by input window ${JSON.stringify(name)} (possibly an IME or overlay); no input was sent. Reveal the target before clicking.`,
			);
		}
		return;
	}
	throw new ToolError(
		parsed
			? `ADB UI has no verified input receiver at (${x}, ${y}); no input was sent`
			: "ADB UI input-window data has no supported default-display window entries; no input was sent",
	);
}
