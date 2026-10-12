import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter, sessionResolveContext } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { splitAddressableFileLines } from "@oh-my-pi/pi-tui/tools/hashline-format";

function createSession(): ToolSession {
	const session: ToolSession = {
		cwd: os.tmpdir(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
	const evalTool = new EvalTool(session);
	session.getToolByName = name => (name === "eval" ? (evalTool as unknown as AgentTool) : undefined);
	return session;
}

describe("xd documentation read selectors", () => {
	it("selects lines from the same eval helpers topic instead of including the selector in its name", async () => {
		const session = createSession();
		const resource = await InternalUrlRouter.instance().resolve("xd://eval/helpers", sessionResolveContext(session));
		const lines = splitAddressableFileLines(resource.content);
		const result = await new ReadTool(session).execute("read-eval-helpers-range", {
			path: "xd://eval/helpers:1-140",
		});

		expect(result.details?.displayContent).toEqual({
			text: lines.slice(0, 140).join("\n"),
			startLine: 1,
			lineNumbers: Array.from({ length: Math.min(140, lines.length) }, (_, index) => index + 1),
		});
		expect(result.details?.totalLines).toBe(lines.length);
		expect(session.editStore).toBeUndefined();
	});

	it("honors both raw selector orders for a bounded topic slice", async () => {
		const session = createSession();
		const resource = await InternalUrlRouter.instance().resolve("xd://eval/helpers", sessionResolveContext(session));
		const expected = resource.content.split("\n").slice(2, 7).join("\n");
		const tool = new ReadTool(session);
		const leadingRaw = await tool.execute("read-eval-leading-raw", { path: "xd://eval/helpers:raw:3-7" });
		const trailingRaw = await tool.execute("read-eval-trailing-raw", { path: "xd://eval/helpers:3-7:raw" });

		expect(leadingRaw.details?.displayContent).toEqual({
			text: expected,
			startLine: 3,
			lineNumbers: [3, 4, 5, 6, 7],
		});
		expect(leadingRaw.content).toEqual(trailingRaw.content);
		expect(leadingRaw.content[0]).toEqual({ type: "text", text: expect.stringContaining(expected) });
	});

	it("returns the raw tail of the topic without line prefixes", async () => {
		const session = createSession();
		const resource = await InternalUrlRouter.instance().resolve("xd://eval/helpers", sessionResolveContext(session));
		const lines = resource.content.split("\n");
		const result = await new ReadTool(session).execute("read-eval-raw-tail", { path: "xd://eval/helpers:raw:-2" });

		expect(result.content).toEqual([{ type: "text", text: lines.slice(-2).join("\n") }]);
		expect(result.details?.displayContent?.startLine).toBe(lines.length - 1);
	});
});
