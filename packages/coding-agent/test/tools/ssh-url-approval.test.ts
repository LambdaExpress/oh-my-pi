import { beforeAll, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { type ExtensionRunner, ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import * as fileTransfer from "@oh-my-pi/pi-coding-agent/ssh/file-transfer";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

// Minimal ToolSession stub (block-images.test.ts shape). Approval functions are
// pure over their args, and the write-execute selector reject throws before any
// session/SSH access, so no real cwd/fs is needed.
function createTestToolSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

function callApproval(tool: { approval?: unknown }, args: unknown): string {
	const approval = tool.approval;
	if (typeof approval !== "function") throw new Error("expected a dynamic approval function");
	return approval(args) as string;
}

describe("ssh:// approval separates fixed reads from remote mutations", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	it("read: fixed ssh:// reads and local paths stay read", () => {
		const tool = new ReadTool(createTestToolSession(os.tmpdir()));
		expect(callApproval(tool, { path: "ssh://icaro/etc/hostname" })).toBe("read");
		expect(callApproval(tool, { path: "/etc/hostname" })).toBe("read");
		expect(callApproval(tool, { path: "local://notes" })).toBe("read");
		expect(callApproval(tool, {})).toBe("read");
	});

	it("grep: fixed ssh:// reads remain read tier in delimited and array paths", () => {
		const tool = new GrepTool(createTestToolSession(os.tmpdir()));
		expect(callApproval(tool, { paths: "src,ssh://icaro/etc/hosts" })).toBe("read");
		expect(callApproval(tool, { paths: ["src", "ssh://icaro/etc/hosts"] })).toBe("read");
		expect(callApproval(tool, { paths: ["src", "lib"] })).toBe("read");
		expect(callApproval(tool, { paths: "src" })).toBe("read");
		expect(callApproval(tool, {})).toBe("read");
	});

	it("write: ssh:// is exec even when wrapped in a hashline header", () => {
		const tool = new WriteTool(createTestToolSession(os.tmpdir()));
		expect(callApproval(tool, { path: "ssh://icaro/tmp/x" })).toBe("exec");
		// A pasted `[path#TAG]` wrapper must not let an ssh write dodge the exec tier.
		expect(callApproval(tool, { path: "[ssh://icaro/tmp/x#ABCD]" })).toBe("exec");
		expect(callApproval(tool, { path: "/tmp/local-file.txt" })).toBe("write");
	});

	it("edit: hashline remote sections and move destinations use write policy", () => {
		const tool = new EditTool(createTestToolSession(os.tmpdir()), "hashline");
		expect(callApproval(tool, { input: "[ssh://icaro/tmp/x#ABCD]\nREM" })).toBe("exec");
		expect(
			callApproval(tool, {
				input: [
					"[src/local.ts#ABCD]",
					"PUT 1.=1:",
					"+local",
					"[ssh://icaro/tmp/x#BCDE]",
					"PUT 1.=1:",
					"+remote",
				].join("\n"),
			}),
		).toBe("exec");
		expect(
			callApproval(tool, {
				input: "[ssh://icaro/tmp/x#ABCD]\nMV ssh://icaro/tmp/y",
			}),
		).toBe("exec");
		expect(
			callApproval(tool, {
				input: "[ssh://icaro/tmp/x#ABCD]\nMV [ssh://icaro/tmp/y#BCDE]",
			}),
		).toBe("exec");
		expect(callApproval(tool, { input: "[local.ts#ABCD]\nPUT 1.=1:\n+local" })).toBe("write");
	});

	it("edit: apply_patch remote mutations are exec in apply_patch mode", () => {
		const tool = new EditTool(createTestToolSession(os.tmpdir()), "apply_patch");
		for (const body of [
			"*** Add File: ssh://icaro/tmp/x\n+new",
			"*** Add File: [ssh://icaro/tmp/x#ABCD]\n+new",
			"*** Update File: ssh://icaro/tmp/x\n@@\n-old\n+new",
			"*** Delete File: ssh://icaro/tmp/x",
			"*** Update File: ssh://icaro/tmp/x\n*** Move to: ssh://icaro/tmp/y\n@@\n-old\n+new",
			"*** Update File: local.ts\n@@\n-old\n+new\n*** Update File: ssh://icaro/tmp/x\n@@\n-old\n+new",
		]) {
			expect(callApproval(tool, { input: `*** Begin Patch\n${body}\n*** End Patch\n` })).toBe("exec");
		}
		expect(
			callApproval(tool, {
				input: "*** Begin Patch\n*** Update File: local.ts\n@@\n-old\n+new\n*** End Patch\n",
			}),
		).toBe("write");
	});

	it("edit: structured patch mutations keep SSH writes at exec", () => {
		const tool = new EditTool(createTestToolSession(os.tmpdir()), "patch");
		for (const remote of ["ssh://icaro/tmp/x", "[ssh://icaro/tmp/x#ABCD]"]) {
			expect(
				callApproval(tool, {
					path: remote,
					edits: [{ op: "update", rename: "[ssh://icaro/tmp/y#BCDE]", diff: "@@\n-old\n+new\n" }],
				}),
			).toBe("exec");
		}
		const replace = new EditTool(createTestToolSession(os.tmpdir()), "replace");
		expect(callApproval(replace, { path: "[ssh://icaro/tmp/x#ABCD]", old_string: "old", new_string: "new" })).toBe(
			"exec",
		);
	});

	it("edit: production write-mode approval blocks legal remote payloads before transfer", async () => {
		const stat = vi.spyOn(fileTransfer, "statRemotePath").mockRejectedValue(new Error("Unexpected transfer"));
		const runner = {
			consumeToolCallEmitted: () => false,
			hasHandlers: () => false,
			hasUI: () => false,
		} as unknown as ExtensionRunner;
		const resolvedTiers: string[] = [];
		try {
			for (const [mode, input] of [
				["hashline", "[ssh://icaro/tmp/x#ABCD]\nREM"],
				["apply_patch", "*** Begin Patch\n*** Add File: ssh://icaro/tmp/x\n+new\n*** End Patch\n"],
				["apply_patch", "*** Begin Patch\n*** Add File: [ssh://icaro/tmp/x#ABCD]\n+new\n*** End Patch\n"],
			] as const) {
				const tool = new ExtensionToolWrapper(new EditTool(createTestToolSession(os.tmpdir()), mode), runner);
				await expect(
					tool.execute("remote-edit", { input }, undefined, undefined, {
						settings: Settings.isolated({ "tools.approvalMode": "write" }),
						xdevTierResolved: (tier: string) => resolvedTiers.push(tier),
					} as unknown as AgentToolContext),
				).rejects.toThrow();
			}
			expect(resolvedTiers).toEqual(["exec", "exec", "exec"]);
			expect(stat).not.toHaveBeenCalled();
		} finally {
			stat.mockRestore();
		}
	});
});

describe("write rejects ssh:// line-range/malformed selectors before connecting", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	it("execute throws on a line-range or malformed selector without any SSH op", async () => {
		const tool = new WriteTool(createTestToolSession(os.tmpdir()));
		const write = vi.spyOn(fileTransfer, "writeRemoteFile").mockRejectedValue(new Error("Unexpected transfer"));
		try {
			for (const remote of ["ssh://icaro/tmp/f:1-20", "ssh://icaro/tmp/f:-10"]) {
				await expect(tool.execute("invalid-selector", { path: remote, content: "x" })).rejects.toBeInstanceOf(
					ToolError,
				);
			}
			expect(write).not.toHaveBeenCalled();
		} finally {
			write.mockRestore();
		}
	});
});
