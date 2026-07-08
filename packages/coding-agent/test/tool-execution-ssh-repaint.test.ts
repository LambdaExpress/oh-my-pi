import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { StressRenderScheduler } from "../../tui/test/render-stress-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

function sshResult(text: string) {
	return { content: [{ type: "text", text }] };
}

class Footer implements Component {
	constructor(
		readonly rows: number,
		readonly prefix = "editor",
	) {}
	invalidate(): void {}
	render(_width: number): string[] {
		return Array.from({ length: this.rows }, (_, i) => `${this.prefix}-${i}`);
	}
}

function plainBuffer(term: VirtualTerminal): string[] {
	return term
		.getScrollBuffer()
		.map(row => Bun.stripANSI(row).trimEnd())
		.filter(Boolean);
}

function visibleRows(term: VirtualTerminal): string[] {
	return term.getViewport().map(row => Bun.stripANSI(row).trimEnd());
}

function captureWrites(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	vi.spyOn(term, "write").mockImplementation((data: string) => {
		writes.push(data);
		realWrite(data);
	});
	return writes;
}

async function drain(scheduler: StressRenderScheduler, term: VirtualTerminal): Promise<void> {
	await scheduler.drain(term);
}

describe("ToolExecutionComponent SSH repaint seams", () => {
	const components: ToolExecutionComponent[] = [];

	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		for (const component of components) component.stopAnimation();
		components.length = 0;
		vi.restoreAllMocks();
	});

	function makeComponent(args: unknown) {
		const resetDisplay = vi.fn();
		const refreshDisplay = vi.fn();
		const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay, refreshDisplay } as unknown as TUI;
		const component = new ToolExecutionComponent("ssh", args, {}, undefined, ui);
		components.push(component);
		resetDisplay.mockClear();
		refreshDisplay.mockClear();
		return { component, resetDisplay, refreshDisplay };
	}

	it("forces a viewport repaint when a painted streamed SSH placeholder receives its first result", () => {
		const { component, resetDisplay, refreshDisplay } = makeComponent({ __partialJson: '{"host"' });
		// A paint has to land for the placeholder to actually reach the terminal.
		component.render(80);

		component.updateResult(sshResult("partial output"), true);

		expect(refreshDisplay).toHaveBeenCalledTimes(1);
		expect(refreshDisplay).toHaveBeenCalledWith("tool-result-topology-change");
		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("does not repaint when the streamed placeholder never reaches the terminal", () => {
		const { component, resetDisplay, refreshDisplay } = makeComponent({ __partialJson: '{"host"' });
		// A topology repaint here would spend a refresh for a shape the user never saw.

		component.updateResult(sshResult("partial output"), true);

		expect(refreshDisplay).not.toHaveBeenCalled();
		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("does not repaint complete SSH args on the first result", () => {
		const { component, resetDisplay, refreshDisplay } = makeComponent({ host: "router", command: "uptime" });
		component.render(80);

		component.updateResult(sshResult("partial output"), true);

		expect(refreshDisplay).not.toHaveBeenCalled();
		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("forces a viewport repaint when a painted provisional SSH partial result settles", () => {
		const { component, resetDisplay, refreshDisplay } = makeComponent({ host: "router", command: "uptime" });
		component.updateResult(sshResult("partial output"), true);
		component.render(80);
		resetDisplay.mockClear();
		refreshDisplay.mockClear();

		component.updateResult(sshResult("final output"), false);

		expect(refreshDisplay).toHaveBeenCalledTimes(1);
		expect(refreshDisplay).toHaveBeenCalledWith("tool-result-topology-change");
		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("does not repaint when the provisional partial result never reaches the terminal", () => {
		const { component, resetDisplay, refreshDisplay } = makeComponent({ host: "router", command: "uptime" });
		component.updateResult(sshResult("partial output"), true);
		// No render() between the partial and the final update — the provisional
		// frame never reached the terminal, so no topology repaint should fire.

		component.updateResult(sshResult("final output"), false);

		expect(refreshDisplay).not.toHaveBeenCalled();
		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("preserves a scrolled SSH placeholder viewport and shows the first result at bottom", async () => {
		const term = new VirtualTerminal(90, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const component = new ToolExecutionComponent("ssh", { __partialJson: '{"host"' }, {}, undefined, tui);
		components.push(component);
		tui.addChild(new Footer(16, "history"));
		tui.addChild(component);
		tui.addChild(new Footer(2));

		try {
			tui.start();
			await drain(scheduler, term);
			expect(plainBuffer(term).some(row => row.includes("SSH: […]"))).toBe(true);
			expect(plainBuffer(term).some(row => row.includes("$ …"))).toBe(true);

			component.updateArgs({
				host: "router",
				command: "uptime",
				__partialJson: '{"host":"router","command":"uptime"}',
			});
			component.setArgsComplete();
			tui.requestRender();
			await drain(scheduler, term);

			term.scrollLines(-10);
			await term.flush();
			const before = term.getBufferPosition();
			const anchoredRows = visibleRows(term);
			expect(before.viewportY).toBeLessThan(before.baseY);
			expect(before.viewportY).toBeGreaterThan(0);
			const writes = captureWrites(term);

			component.updateResult(sshResult("partial output"), true);
			tui.requestRender();
			await drain(scheduler, term);

			const paint = writes.join("");
			expect(paint).not.toContain("\x1b[3J");
			expect(paint).not.toContain("\x1b[2J\x1b[H");
			const after = term.getBufferPosition();
			expect(after.viewportY).toBe(before.viewportY);
			expect(after.viewportY).toBeLessThan(after.baseY);
			expect(visibleRows(term)).toEqual(anchoredRows);

			term.scrollLines(1_000_000);
			await term.flush();
			const currentRows = [...visibleRows(term), ...plainBuffer(term).slice(-term.rows)];
			expect(currentRows.some(row => row.includes("⏳ SSH: [router]"))).toBe(true);
			expect(currentRows.some(row => row.includes("Output"))).toBe(true);
			expect(currentRows.some(row => row.includes("partial output"))).toBe(true);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("preserves a scrolled SSH partial-result viewport and shows the settled result at bottom", async () => {
		const term = new VirtualTerminal(90, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const component = new ToolExecutionComponent("ssh", { host: "router", command: "uptime" }, {}, undefined, tui);
		components.push(component);
		tui.addChild(new Footer(16, "history"));
		tui.addChild(component);
		tui.addChild(new Footer(2));

		try {
			tui.start();
			await drain(scheduler, term);
			component.updateResult(sshResult("partial output"), true);
			tui.requestRender();
			await drain(scheduler, term);
			const partialRows = plainBuffer(term);
			expect(partialRows.some(row => row.includes("SSH: [router]"))).toBe(true);
			expect(partialRows.some(row => row.includes("partial output"))).toBe(true);

			term.scrollLines(-10);
			await term.flush();
			const before = term.getBufferPosition();
			const anchoredRows = visibleRows(term);
			expect(before.viewportY).toBeLessThan(before.baseY);
			expect(before.viewportY).toBeGreaterThan(0);
			const writes = captureWrites(term);

			component.updateResult(sshResult("final output"), false);
			tui.requestRender();
			await drain(scheduler, term);

			const paint = writes.join("");
			expect(paint).not.toContain("\x1b[3J");
			expect(paint).not.toContain("\x1b[2J\x1b[H");
			const after = term.getBufferPosition();
			expect(after.viewportY).toBe(before.viewportY);
			expect(after.viewportY).toBeLessThan(after.baseY);
			expect(visibleRows(term)).toEqual(anchoredRows);

			term.scrollLines(1_000_000);
			await term.flush();
			const currentRows = [...visibleRows(term), ...plainBuffer(term).slice(-term.rows)];
			expect(currentRows.some(row => row.includes("SSH: [router]"))).toBe(true);
			expect(currentRows.some(row => row.includes("Output"))).toBe(true);
			expect(currentRows.some(row => row.includes("final output"))).toBe(true);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

});
