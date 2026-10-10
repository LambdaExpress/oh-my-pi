/**
 * Regression for issue #4348: cursor-agent persisted transcripts lose tool-call
 * structure, so replay renders header-less tool results.
 *
 * Before the fix, the Cursor provider only synthesized `toolCall` content
 * blocks for `mcpToolCall` and `updateTodosToolCall`. Native exec-channel tools
 * (`bash`/`read`/`write`/`grep`/`ls`/`delete`/`lsp`) executed via the bridge
 * and never appeared in `AssistantMessage.content`. `renderSessionContext`
 * then had no matching toolCall block for each `toolResult` message, and the
 * results fell through to `addMessageToChat`, rendering as bare `⎿` lines
 * beneath the last assistant text.
 *
 * The fix (in `packages/ai/src/providers/cursor.ts` `handleExecServerMessage`)
 * synthesizes a `toolCall` block on the exec channel using the same tool name
 * and args the bridge emits via `tool_execution_start`. This test asserts the
 * post-fix persisted shape rebuilds into proper `ToolExecutionComponent`s
 * that own their tool results, not into orphan `⎿` toolResult lines.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext, RenderSessionContextOptions } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function transcriptWith(messages: AgentMessage[]): SessionContext {
	return {
		messages,
		thinkingLevel: "off",
		serviceTier: undefined,
		models: {},
		injectedTtsrRules: [],
		mode: "none",
	};
}

function makeRenderCtx(transcript: SessionContext): {
	ctx: InteractiveModeContext;
	chatContainer: TranscriptContainer;
} {
	const settings = Settings.isolated();
	settings.set("read.toolResultPreview", false);
	const ctx = createInteractiveModeContext({
		settings,
		editor: { addToHistory: vi.fn() },
		viewSession: {
			buildTranscriptSessionContext: () => transcript,
		},
		addMessageToChat: (message: AgentMessage, options?: { imageLinks?: readonly (string | undefined)[] }) =>
			helpers.addMessageToChat(message, options),
		renderSessionContext: (context: SessionContext, options?: RenderSessionContextOptions) =>
			helpers.renderSessionContext(context, options),
		renderSessionContextIncrementally: (
			context: SessionContext,
			options: RenderSessionContextOptions,
			renderChunk?: () => void,
		) => helpers.renderSessionContextIncrementally(context, options, renderChunk),
	});
	const helpers = new UiHelpers(ctx);
	return { ctx, chatContainer: ctx.chatContainer };
}

/** Build the cursor-shaped assistant + toolResults message set for one turn. */
function cursorTurn(): AgentMessage[] {
	// After the fix, the Cursor provider synthesizes `toolCall` blocks with the
	// bridge's mapped tool names ("bash"/"read"). The stopReason for cursor
	// turns with tool results is "toolUse" mid-turn — this matches how the
	// agent-loop finalizes cursor exec turns.
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "text", text: "Reading and listing:" },
			{ type: "toolCall", id: "tc-read", name: "read", arguments: { path: "src/foo.ts" } },
			{
				type: "toolCall",
				id: "tc-bash",
				name: "bash",
				arguments: { command: "ls -1" },
			},
		],
		api: "cursor-agent",
		provider: "cursor",
		model: "cursor-composer-2.5",
		usage: emptyUsage,
		stopReason: "toolUse",
		timestamp: 1,
	};
	return [
		assistant,
		{
			role: "toolResult",
			toolCallId: "tc-read",
			toolName: "read",
			content: [{ type: "text", text: "READ_RESULT_MARKER content of foo.ts" }],
			isError: false,
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "tc-bash",
			toolName: "bash",
			content: [{ type: "text", text: "BASH_RESULT_MARKER file1\nfile2" }],
			isError: false,
			timestamp: 3,
		},
	];
}

describe("issue #4348: cursor exec-channel tool results pair with synthesized toolCall blocks on rebuild", () => {
	it("renders bash toolResult inside a ToolExecutionComponent, not as an orphan `⎿` line", async () => {
		await Settings.init({ inMemory: true });
		const transcript = transcriptWith(cursorTurn());
		const { ctx, chatContainer } = makeRenderCtx(transcript);

		try {
			await new UiHelpers(ctx).renderInitialMessages();

			// Synthesized calls own their persisted results after replay.
			const rendered = Bun.stripANSI(chatContainer.render(120).join("\n"));
			expect(rendered).toContain("Reading and listing:");
			expect(rendered).toContain("ls -1");
			expect(rendered).toContain("BASH_RESULT_MARKER");
			// The compact read group shows the paired path with preview disabled.
			expect(rendered).toContain("Read src/foo.ts");
		} finally {
			chatContainer.disposeChildren();
		}
	});
});
