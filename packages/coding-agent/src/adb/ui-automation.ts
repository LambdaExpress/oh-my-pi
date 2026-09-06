import { randomUUID } from "node:crypto";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { ToolAbortError, ToolError, throwIfAborted } from "../tools/tool-errors";
import type { AdbBinaryResult, AdbCommandResult } from "./adb-executor";
import { matchUiElements, parseUiHierarchy, sameUiElement } from "./ui-hierarchy";
import type {
	AdbUiBounds,
	AdbUiClickResult,
	AdbUiElement,
	AdbUiObservation,
	AdbUiSelector,
	AdbUiTarget,
	AdbUiWaitResult,
	AdbUiWaitUntil,
} from "./ui-types";

const POLL_INTERVAL_MS = 250;
const MAX_CAPTURE_RETRIES = 2;
const MAX_CACHED_DEVICES = 16;
const LONG_CLICK_MS = 600;
const RETRYABLE_CAPTURE_ERROR = /could not get idle state|null root node returned by UiTestAutomationBridge/i;
const decoder = new TextDecoder("utf-8", { fatal: true });

interface AdbUiAutomationDependencies {
	runBinary(args: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<AdbBinaryResult>;
	runText(args: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<AdbCommandResult>;
}

interface Deadline {
	expiresAt: number;
	signal: AbortSignal;
}

interface DeviceSnapshot {
	observation?: AdbUiObservation;
}

function remaining(deadline: Deadline): number {
	throwIfAborted(deadline.signal);
	const ms = Math.ceil(deadline.expiresAt - performance.now());
	if (ms <= 0) throw new ToolError("ADB UI operation timed out");
	return ms;
}

async function pause(deadline: Deadline): Promise<void> {
	await untilAborted(deadline.signal, () => Bun.sleep(Math.min(POLL_INTERVAL_MS, remaining(deadline))));
	remaining(deadline);
}

function validBounds(bounds: AdbUiBounds): boolean {
	return (
		Number.isSafeInteger(bounds.left) &&
		Number.isSafeInteger(bounds.top) &&
		Number.isSafeInteger(bounds.right) &&
		Number.isSafeInteger(bounds.bottom) &&
		bounds.left >= 0 &&
		bounds.top >= 0 &&
		bounds.right > bounds.left &&
		bounds.bottom > bounds.top &&
		bounds.right <= 2_147_483_647 &&
		bounds.bottom <= 2_147_483_647
	);
}

function clickPoint(
	observation: AdbUiObservation,
	element: AdbUiElement,
	longClick: boolean,
): { x: number; y: number } {
	let node: AdbUiElement | undefined = element;
	let actionable = false;
	let left = element.bounds.left;
	let top = element.bounds.top;
	let right = element.bounds.right;
	let bottom = element.bounds.bottom;
	while (node) {
		if (!node.visible || !node.enabled || !validBounds(node.bounds)) {
			throw new ToolError("ADB UI target or its ancestor is invisible, disabled, or has invalid bounds");
		}
		if (longClick ? node.longClickable : node.clickable) actionable = true;
		left = Math.max(left, node.bounds.left);
		top = Math.max(top, node.bounds.top);
		right = Math.min(right, node.bounds.right);
		bottom = Math.min(bottom, node.bounds.bottom);
		if (node.parentIndex === undefined) break;
		const parent: AdbUiElement | undefined = observation.elements[node.parentIndex];
		if (!parent || parent.depth >= node.depth) throw new ToolError("ADB UI target has an invalid ancestor");
		node = parent;
	}
	if (!actionable) {
		throw new ToolError(`ADB UI target has no ${longClick ? "long-clickable" : "clickable"} ancestor or action`);
	}
	if (right <= left || bottom <= top) throw new ToolError("ADB UI target has no visible clickable bounds");
	const centerX = Math.floor((element.bounds.left + element.bounds.right) / 2);
	const centerY = Math.floor((element.bounds.top + element.bounds.bottom) / 2);
	if (centerX >= left && centerX < right && centerY >= top && centerY < bottom) {
		return { x: centerX, y: centerY };
	}
	return { x: Math.floor((left + right) / 2), y: Math.floor((top + bottom) / 2) };
}

function referenceElement(previous: AdbUiObservation, current: AdbUiObservation, element: AdbUiElement): AdbUiElement {
	const index = previous.elements.indexOf(element);
	const fresh = current.elements[index];
	if (previous.rotation !== current.rotation || !fresh) {
		throw new ToolError("ADB UI reference is stale; observe the device again");
	}
	let before: AdbUiElement | undefined = element;
	let after: AdbUiElement | undefined = fresh;
	while (before && after) {
		if (!sameUiElement(before, after)) throw new ToolError("ADB UI reference is stale; observe the device again");
		if (before.parentIndex === undefined) return fresh;
		before = previous.elements[before.parentIndex];
		after = after.parentIndex === undefined ? undefined : current.elements[after.parentIndex];
	}
	throw new ToolError("ADB UI reference is stale; observe the device again");
}

function dumpText(result: AdbBinaryResult, path: string): string {
	let text: string;
	try {
		text = decoder.decode(result.bytes).trim();
	} catch {
		throw new ToolError("ADB UI hierarchy is not complete valid UTF-8");
	}
	// The raw exec-out protocol may merge device stderr with stdout. Only remove
	// the known UIAutomator success banner; unexpected output must fail parsing.
	for (const spelling of ["hierchary", "hierarchy"]) {
		const banner = `UI ${spelling} dumped to: ${path}`;
		if (text.startsWith(`${banner}\n`) || text.startsWith(`${banner}\r\n`)) {
			text = text.slice(banner.length).trimStart();
			break;
		}
	}
	return text;
}

/** Uses the on-device UIAutomator already shipped with Android; no server or APK is installed. */
export class AdbUiAutomation {
	#dependencies: AdbUiAutomationDependencies;
	#snapshots = new Map<string, DeviceSnapshot>();

	constructor(dependencies: AdbUiAutomationDependencies) {
		this.#dependencies = dependencies;
	}

	invalidate(serial?: string): void {
		if (serial === undefined) this.#snapshots.clear();
		else this.#snapshots.delete(serial);
	}

	async observe(serial: string, timeoutMs: number, signal?: AbortSignal): Promise<AdbUiObservation> {
		return this.#withinDeadline(timeoutMs, signal, async deadline => {
			const state = this.#begin(serial);
			const observation = await this.#capture(serial, deadline);
			this.#assertCurrent(serial, state);
			state.observation = observation;
			return observation;
		});
	}

	async click(
		serial: string,
		target: AdbUiTarget,
		longClick: boolean,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AdbUiClickResult> {
		try {
			return await this.#withinDeadline(timeoutMs, signal, async deadline => {
				const previous = this.#snapshots.get(serial)?.observation;
				let referenced: AdbUiElement | undefined;
				if ("ref" in target) {
					referenced = previous?.elements.find(element => element.ref === target.ref);
					if (!referenced)
						throw new ToolError("ADB UI reference is unknown or stale for this device; observe it again");
				} else {
					// Validate before performing device I/O, including rejecting empty selectors.
					matchUiElements({ rotation: 0, elements: [] }, target);
				}
				const state = this.#begin(serial);
				const observation = await this.#capture(serial, deadline);
				this.#assertCurrent(serial, state);
				let element: AdbUiElement;
				if ("ref" in target) {
					if (!previous || !referenced) throw new ToolError("ADB UI reference is stale; observe the device again");
					element = referenceElement(previous, observation, referenced);
				} else {
					const matches = matchUiElements(observation, target).filter(candidate => candidate.visible);
					if (matches.length !== 1) {
						throw new ToolError(`ADB UI selector requires exactly one visible match; found ${matches.length}`);
					}
					element = matches[0]!;
				}
				const { x, y } = clickPoint(observation, element, longClick);
				const budget = remaining(deadline);
				if (longClick && budget <= LONG_CLICK_MS)
					throw new ToolError("ADB UI operation timed out before long click");
				const args = ["-s", serial, "shell", "input"];
				if (longClick) args.push("swipe", String(x), String(y), String(x), String(y), String(LONG_CLICK_MS));
				else args.push("tap", String(x), String(y));
				await untilAborted(deadline.signal, () => this.#dependencies.runText(args, budget, deadline.signal));
				remaining(deadline);
				return { element, x, y };
			});
		} finally {
			// Even a failed input command can have reached the device.
			this.invalidate(serial);
		}
	}

	async wait(
		serial: string,
		selector: AdbUiSelector,
		until: AdbUiWaitUntil,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AdbUiWaitResult> {
		matchUiElements({ rotation: 0, elements: [] }, selector);
		if (!["visible", "hidden", "enabled", "disabled"].includes(until))
			throw new ToolError("Invalid ADB UI wait condition");
		return this.#withinDeadline(timeoutMs, signal, async deadline => {
			const state = this.#begin(serial);
			for (;;) {
				const observation = await this.#capture(serial, deadline);
				this.#assertCurrent(serial, state);
				const matches = matchUiElements(observation, selector).filter(element => element.visible);
				if (until !== "hidden" && matches.length > 1) {
					throw new ToolError(`ADB UI wait requires exactly one visible match; found ${matches.length}`);
				}
				const element = matches[0];
				const satisfied =
					until === "hidden"
						? matches.length === 0
						: element !== undefined &&
							(until === "visible" || (until === "enabled" ? element.enabled : !element.enabled));
				if (satisfied) {
					state.observation = observation;
					return { observation, matches, until };
				}
				await pause(deadline);
			}
		});
	}

	#begin(serial: string): DeviceSnapshot {
		this.#snapshots.delete(serial);
		if (this.#snapshots.size >= MAX_CACHED_DEVICES) {
			const oldest = this.#snapshots.keys().next().value;
			if (oldest !== undefined) this.#snapshots.delete(oldest);
		}
		const state: DeviceSnapshot = {};
		this.#snapshots.set(serial, state);
		return state;
	}

	#assertCurrent(serial: string, state: DeviceSnapshot): void {
		if (this.#snapshots.get(serial) !== state) {
			throw new ToolError("ADB UI observation was superseded or invalidated; observe the device again");
		}
	}

	async #capture(serial: string, deadline: Deadline): Promise<AdbUiObservation> {
		for (let attempt = 0; ; attempt++) {
			const path = `/data/local/tmp/omp-ui-${randomUUID()}.xml`;
			const script = `path=${path}; trap 'rm -f "$path"' EXIT; trap 'exit 1' HUP INT TERM; uiautomator dump "$path" >&2 && { if [ -s "$path" ]; then cat "$path"; fi; }`;
			// exec-out escapes argv itself; quoting the script again turns it into
			// a literal filename for the remote sh instead of executable code.
			let xml: string;
			try {
				const result = await untilAborted(deadline.signal, () =>
					this.#dependencies.runBinary(
						["-s", serial, "exec-out", "sh", "-c", script],
						remaining(deadline),
						deadline.signal,
					),
				);
				remaining(deadline);
				xml = dumpText(result, path);
				const transient =
					RETRYABLE_CAPTURE_ERROR.exec(result.stderr ?? "") ??
					(!xml.startsWith("<") ? RETRYABLE_CAPTURE_ERROR.exec(xml) : null);
				if (transient) throw new ToolError(`ADB UIAutomator ${transient[0]}`);
			} catch (error) {
				remaining(deadline);
				if (
					error instanceof ToolAbortError ||
					!(error instanceof Error) ||
					!RETRYABLE_CAPTURE_ERROR.test(error.message)
				)
					throw error;
				if (attempt >= MAX_CAPTURE_RETRIES) throw error;
				await pause(deadline);
				continue;
			}
			const snapshot = randomUUID();
			const hierarchy = parseUiHierarchy(xml, snapshot);
			remaining(deadline);
			return { ...hierarchy, serial, snapshot };
		}
	}

	async #withinDeadline<T>(
		timeoutMs: number,
		signal: AbortSignal | undefined,
		action: (deadline: Deadline) => Promise<T>,
	): Promise<T> {
		throwIfAborted(signal);
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
			throw new ToolError("ADB UI timeout must be a positive finite duration no greater than 2147483647ms");
		}
		const timeout = new AbortController();
		const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
		const deadline: Deadline = { expiresAt: performance.now() + timeoutMs, signal: combined };
		const timer = setTimeout(() => timeout.abort(), Math.ceil(timeoutMs));
		try {
			return await action(deadline);
		} catch (error) {
			if (signal?.aborted) throw new ToolAbortError(undefined, { cause: error });
			if (timeout.signal.aborted || performance.now() >= deadline.expiresAt)
				throw new ToolError("ADB UI operation timed out");
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}
}
