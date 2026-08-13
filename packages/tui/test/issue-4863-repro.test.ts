import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Regression probe for https://github.com/can1357/oh-my-pi/issues/4863
//
// History: main's #truncateLargeConptyFrame bounded a full paint over a large
// transcript on ConPTY hosts (native Windows + WSL): it kept only the tail and
// replaced the older committed prefix with an "older lines hidden" marker —
// wanted for the *initial* session resume (issue #2115), where a
// multi-megabyte synchronized frame stalls conhost. But it also fired on the
// user-initiated Ctrl+O expand (resetDisplay), so pressing Ctrl+O to review the
// whole session dropped everything above the retained tail. The reporter hit
// this under WSL. Reset fixed the intent keying (#unboundedConptyPaintRequested,
// 0f385b2435 + 432e54dfdc), and the origin/main (17.3.0) merge kept reset's
// #isLargeConptyReplay: a large ConPTY replay now keeps EVERY row and disables
// DEC 2026 synchronized output for that paint (PAINT_BEGIN_NO_SYNC =
// `ESC[?25l ESC[?7l`), so legacy hosts process the ConPTY-bounded chunks
// incrementally instead of buffering one giant transaction (#2115).
// #truncateLargeConptyFrame and the "older lines hidden" marker no longer
// exist in the source; these tests assert the merged contract.

const PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, "platform");
const WSL_DISTRO_NAME = process.env.WSL_DISTRO_NAME;
const TMUX = process.env.TMUX;
const HERDR_ENV = process.env.HERDR_ENV;

// A full paint clears the viewport with ED2 (`CSI 2 J`), or — when it also
// clears native scrollback — homes the cursor and emits ED3 (`CSI H CSI 3 J`)
// without blanking first. Match either so the probe tracks the paint intent,
// not one emitter's escape choice.
const isFullPaint = (write: string): boolean => write.includes("\x1b[2J") || write.includes("\x1b[H\x1b[3J");

class LargeContent implements Component {
	#lines: string[];

	constructor(lineCount: number) {
		this.#lines = [];
		for (let i = 0; i < lineCount; i++) {
			this.#lines.push(`row ${i.toString().padStart(5, "0")}: ${"x".repeat(100)}`);
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const rendered = new Array<string>(this.#lines.length);
		for (let i = 0; i < this.#lines.length; i++) rendered[i] = this.#lines[i]!.slice(0, width);
		return rendered;
	}
}

beforeEach(() => {
	delete process.env.HERDR_ENV;
});

describe("issue #4863: Ctrl+O full-view expand truncates the session on ConPTY", () => {
	afterEach(() => {
		if (PLATFORM_DESCRIPTOR) Object.defineProperty(process, "platform", PLATFORM_DESCRIPTOR);
		if (WSL_DISTRO_NAME === undefined) delete process.env.WSL_DISTRO_NAME;
		else process.env.WSL_DISTRO_NAME = WSL_DISTRO_NAME;
		if (TMUX === undefined) delete process.env.TMUX;
		else process.env.TMUX = TMUX;
		if (HERDR_ENV === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = HERDR_ENV;
		vi.restoreAllMocks();
	});

	it("does not drop older transcript rows on a user-driven resetDisplay under WSL", async () => {
		// Reporter's environment: WSL. isConPTYHosted() is true on linux when a
		// WSL marker is present (stdout still crosses into ConPTY at wslhost).
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		process.env.WSL_DISTRO_NAME = "Ubuntu";
		const term = new VirtualTerminal(80, 24, 20_000);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});
		const tui = new TUI(term);
		// ~8000 * ~110 bytes ≈ 880 KiB — over the 512 KiB ConPTY sync threshold.
		tui.addChild(new LargeContent(8000));

		try {
			tui.start();
			await term.waitForRender();

			// The user presses Ctrl+O; the app calls resetDisplay() to replay the
			// whole transcript at its expanded heights.
			writes.length = 0;
			tui.resetDisplay();
			await term.waitForRender();

			const resetPaint = writes.find(isFullPaint);
			expect(resetPaint).toBeDefined();
			// The Ctrl+O replay must NOT hide the top of the session.
			expect(resetPaint).not.toContain("older lines hidden");
			expect(term.getScrollBuffer().some(line => line.includes("row 00000"))).toBe(true);
		} finally {
			tui.stop();
		}
	});

	it("keeps every row of the initial session-resume paint and disables DEC 2026 sync on ConPTY (issue #2115)", async () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const term = new VirtualTerminal(80, 24, 20_000);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});
		const tui = new TUI(term);
		tui.addChild(new LargeContent(8000));

		try {
			tui.start({ clearScrollback: true });
			await term.waitForRender();

			const resumePaint = writes.find(isFullPaint);
			expect(resumePaint).toBeDefined();
			// The first paint is a resume replay. The origin/main (17.3.0) merge
			// kept reset's #isLargeConptyReplay and dropped main's
			// #truncateLargeConptyFrame (the marker no longer exists in the
			// source): a large ConPTY replay keeps EVERY row and bounds the frame
			// by disabling DEC 2026 sync for the paint (PAINT_BEGIN_NO_SYNC), so
			// legacy hosts process the ConPTY-bounded chunks incrementally
			// instead of buffering one giant synchronized transaction.
			expect(resumePaint).not.toContain("older lines hidden");
			expect(resumePaint).toContain("row 00000");
			// Whole transcript retained — the replay crossed the 512 KiB
			// #CONPTY_SYNC_THRESHOLD_BYTES (main's truncation capped the frame at
			// < 128 KiB).
			expect(Buffer.byteLength(resumePaint ?? "", "utf8")).toBeGreaterThan(512 * 1024);
			// The bound is the sync scope: PAINT_BEGIN_NO_SYNC (`ESC[?25l ESC[?7l`)
			// opens no DEC 2026 transaction.
			expect(resumePaint).toMatch(/^\x1b\[\?25l\x1b\[\?7l/);
			expect(resumePaint).not.toContain("\x1b[?2026h");
		} finally {
			tui.stop();
		}
	});

	it("keeps every row of a session replace after a resetDisplay update under WSL+tmux", async () => {
		// Under a multiplexer, resetDisplay() is an in-place update rather than
		// a full paint. Its one-shot unbounded intent must be consumed by that
		// update, not leak into the next /resume or handoff replacement.
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		process.env.WSL_DISTRO_NAME = "Ubuntu";
		process.env.TMUX = "/tmp/tmux-1000/default,1,0";
		const term = new VirtualTerminal(80, 24, 20_000);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});
		const tui = new TUI(term);
		tui.addChild(new LargeContent(8000));

		try {
			tui.start();
			await term.waitForRender();

			// Ctrl+O/toggle reset: resizeRepaintsInPlace() makes this an update.
			writes.length = 0;
			tui.resetDisplay();
			await term.waitForRender();
			expect(writes.some(isFullPaint)).toBe(false);

			// Then simulate /resume: the later bulk replace must still be a full
			// retained replay carrying the large-replay DEC 2026 sync bound.
			writes.length = 0;
			tui.requestRender(true, { clearScrollback: true });
			await term.waitForRender();

			const replacePaint = writes.find(isFullPaint);
			expect(replacePaint).toBeDefined();
			// Same merged contract as the resume paint: the bulk replace keeps
			// every row (no truncation marker) and bounds the frame by disabling
			// DEC 2026 sync (PAINT_BEGIN_NO_SYNC).
			expect(replacePaint).not.toContain("older lines hidden");
			expect(replacePaint).toContain("row 00000");
			expect(Buffer.byteLength(replacePaint ?? "", "utf8")).toBeGreaterThan(512 * 1024);
			expect(replacePaint).toMatch(/^\x1b\[\?25l\x1b\[\?7l/);
			expect(replacePaint).not.toContain("\x1b[?2026h");
		} finally {
			tui.stop();
		}
	});
});
