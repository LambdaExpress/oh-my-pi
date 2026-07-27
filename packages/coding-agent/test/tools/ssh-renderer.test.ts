import { afterEach, describe, expect, it, vi } from "bun:test";
import type { SSHHost } from "@oh-my-pi/pi-coding-agent/capability/ssh";
import { getThemeByName, highlightCode } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { streamTailUpdates, TailBuffer } from "@oh-my-pi/pi-coding-agent/session/streaming-output";
import * as connectionManager from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import * as sshExecutor from "@oh-my-pi/pi-coding-agent/ssh/ssh-executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type SSHToolDetails, SshTool, sshToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/ssh";
import { renderXdevCall } from "@oh-my-pi/pi-coding-agent/tools/xdev";

const host: SSHHost = {
	name: "remote",
	host: "remote.example",
	_source: { provider: "test", providerName: "Test", path: "test://ssh", level: "project" },
};

function createTool(): SshTool {
	const session = {
		settings: { get: () => undefined },
	} as unknown as ToolSession;
	return new SshTool(session, [host.name], new Map([[host.name, host]]), "Test SSH tool");
}

async function darkTheme() {
	const uiTheme = await getThemeByName("dark");
	if (!uiTheme) throw new Error("Expected dark theme");
	return uiTheme;
}

describe("SSH command highlighting", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("preserves the detected command language through streaming and final details", async () => {
		vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
			version: 5,
			os: "windows",
			shell: "powershell",
			compatEnabled: false,
		});
		vi.spyOn(sshExecutor, "executeSSH").mockImplementation(async (_target, _command, options) => {
			options?.onChunk?.("complete\n");
			return {
				output: "complete\n",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				totalLines: 1,
				totalBytes: 9,
				outputLines: 1,
				outputBytes: 9,
			};
		});
		const updates: SSHToolDetails[] = [];

		const result = await createTool().execute(
			"call-1",
			{ host: "remote", command: "Get-Process" },
			undefined,
			update => {
				updates.push(update.details ?? {});
			},
		);

		expect(updates.length).toBeGreaterThanOrEqual(2);
		expect(updates.every(details => details.commandLanguage === "powershell")).toBe(true);
		expect(result.details?.commandLanguage).toBe("powershell");
	});

	it("renders detected Bash and PowerShell commands with the shared syntax highlighter", async () => {
		const uiTheme = await darkTheme();
		const cases = [
			{ commandLanguage: "bash" as const, command: 'if true; then echo "ok"; fi' },
			{ commandLanguage: "powershell" as const, command: "$items = Get-Process | Where-Object { $_.CPU -gt 1 }" },
		];

		for (const { commandLanguage, command } of cases) {
			const expected = highlightCode(command, commandLanguage, uiTheme)[0];
			for (const isPartial of [true, false]) {
				const component = sshToolRenderer.renderResult(
					{
						content: [{ type: "text", text: isPartial ? "running" : "complete" }],
						details: { commandLanguage },
					},
					{ expanded: true, isPartial },
					uiTheme,
					{ host: "remote", command },
				);
				const commandLine = component.render(200).find(line => Bun.stripANSI(line).includes(command));
				expect(commandLine).toBeDefined();
				expect(commandLine).toContain(expected);
			}
		}
	});

	it("highlights partially streamed command arguments from the cached host shell", async () => {
		vi.spyOn(connectionManager, "getCachedHostInfoSync").mockReturnValue({
			version: 5,
			os: "windows",
			shell: "powershell",
			compatEnabled: false,
		});
		const uiTheme = await darkTheme();
		const tool = createTool();
		const command = "$items = Get-Process | Where-Object {";
		const partialJson = `{"host":"remote","command":"${command}`;
		const args = { __partialJson: partialJson };
		const expected = highlightCode(command, "powershell", uiTheme)[0];

		expect(tool.renderCall).toBeDefined();
		const direct = tool.renderCall!(args as never, { expanded: true, isPartial: true }, uiTheme) as {
			render(width: number): readonly string[];
		};
		const directLine = direct.render(200).find(line => Bun.stripANSI(line).includes(command));
		expect(directLine).toContain(expected);

		const mounted = renderXdevCall("ssh", partialJson, { expanded: true, isPartial: true }, uiTheme, () => tool);
		const mountedLine = mounted?.render(200).find(line => Bun.stripANSI(line).includes(command));
		expect(mountedLine).toContain(expected);
	});

	it("highlights the first streamed command before any host shell is cached", async () => {
		vi.spyOn(connectionManager, "getCachedHostInfoSync").mockReturnValue(undefined);
		const uiTheme = await darkTheme();
		const tool = createTool();
		const cases = [
			{ language: "bash" as const, command: "if true; then echo first; fi" },
			{ language: "powershell" as const, command: "$items = Get-Process | Where-Object {" },
		];

		for (const { language, command } of cases) {
			const partialJson = `{"host":"remote","command":"${command}`;
			const expected = highlightCode(command, language, uiTheme)[0];
			const mounted = renderXdevCall("ssh", partialJson, { expanded: true, isPartial: true }, uiTheme, () => tool);
			const commandLine = mounted?.render(200).find(line => Bun.stripANSI(line).includes(command));
			expect(commandLine).toContain(expected);
		}
	});

	it("allows streaming tail updates to retain caller-supplied details", () => {
		const updates: SSHToolDetails[] = [];
		const tail = new TailBuffer(1024);
		const onChunk = streamTailUpdates<SSHToolDetails>(tail, update => updates.push(update.details ?? {}), {
			commandLanguage: "bash",
		});

		onChunk("hello");

		expect(updates).toEqual([{ commandLanguage: "bash" }]);
	});
});
