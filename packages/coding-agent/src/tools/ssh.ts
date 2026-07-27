import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import type { SSHHost } from "../capability/ssh";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { highlightCode, type Theme } from "../modes/theme/theme";
import sshDescriptionBase from "../prompts/tools/ssh.md" with { type: "text" };
import { DEFAULT_MAX_BYTES, streamTailUpdates, TailBuffer } from "../session/streaming-output";
import type { SSHHostInfo } from "../ssh/connection-manager";
import { ensureHostInfo, getCachedHostInfoSync } from "../ssh/connection-manager";
import { executeSSH } from "../ssh/ssh-executor";
import { renderStatusLine } from "../tui";
import { CachedOutputBlock, markFramedBlockComponent } from "../tui/output-block";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import { formatStyledTruncationWarning, type OutputMeta, stripOutputNotice } from "./output-meta";
import { capPreviewLines, extractPartialJsonString, replaceTabs } from "./render-utils";
import { formatSshHostsDescription, loadSshHosts } from "./ssh-hosts";
import { ToolAbortError, ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

const sshSchema = type({
	host: type("string").describe("configured SSH host name"),
	command: type("string").describe("remote command"),
	"cwd?": type("string").describe("absolute remote working directory; omit unless required"),
	"timeout?": type("number").describe("timeout in seconds; defaults to 60"),
});

type SshToolParams = typeof sshSchema.infer;

export type SshCommandLanguage = "bash" | "powershell";
const POWERSHELL_COMMAND_PATTERN =
	/(?:\$env:|\$PS(?:Home|VersionTable|CommandPath|Culture|UICulture)\b|\$_(?:\W|$)|\$[A-Za-z_]\w*\s*=|@\{|\[[\w.]+\]::|\b(?:Get|Set|New|Remove|Copy|Move|Rename|Test|Resolve|Join|Split|Select|Where|ForEach|Write|Read|Invoke|Start|Stop|Restart|Enable|Disable|Import|Export|ConvertTo|ConvertFrom|Measure|Compare|Format|Out|Add|Clear|Update|Wait)-[A-Z][\w-]*\b)/iu;

export interface SSHToolDetails {
	meta?: OutputMeta;
	commandLanguage?: SshCommandLanguage;
}

function quoteRemotePath(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function quotePowerShellPath(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function quoteCmdPath(value: string): string {
	return `"${value.replace(/"/g, '""')}"`;
}

function getSshCommandLanguage(info: SSHHostInfo): SshCommandLanguage | undefined {
	if (info.compatEnabled) return "bash";
	if (info.shell === "powershell") return "powershell";
	if (info.shell === "bash" || info.shell === "zsh" || info.shell === "sh") return "bash";
	return undefined;
}

function assertValidSshCwd(cwd: string | undefined): void {
	if (!cwd) return;
	if (cwd === "~" || cwd.startsWith("~/")) {
		throw new ToolError("SSH cwd must be an absolute remote path; omit cwd instead of using ~.");
	}
}

function buildRemoteCommand(command: string, cwd: string | undefined, info: SSHHostInfo): string {
	if (!cwd) return command;
	if (info.os === "windows" && !info.compatEnabled) {
		return info.shell === "powershell"
			? `Set-Location -Path ${quotePowerShellPath(cwd)}; ${command}`
			: `cd /d ${quoteCmdPath(cwd)} && ${command}`;
	}
	return `cd -- ${quoteRemotePath(cwd)} && ${command}`;
}

export class SshTool implements AgentTool<typeof sshSchema, SSHToolDetails> {
	readonly name = "ssh";
	readonly approval = "exec" as const;
	readonly summary = "Execute commands on configured SSH hosts";
	readonly loadMode = "discoverable" as const;
	readonly label = "SSH";
	readonly parameters = sshSchema;
	readonly concurrency = "exclusive" as const;
	readonly strict = true;
	readonly mergeCallAndResult = true;
	readonly renderCall = (args: SshRenderArgs, options: RenderResultOptions, renderTheme: unknown): Component => {
		const decoded = decodeSshRenderArgs(args);
		return renderSshCall(
			decoded,
			options,
			renderTheme as Theme,
			this.#commandLanguagesByHost.get(decoded.host ?? ""),
		);
	};
	readonly renderResult = (
		result: AgentToolResult<SSHToolDetails>,
		options: RenderResultOptions & { renderContext?: SshRenderContext },
		renderTheme: unknown,
		args?: SshRenderArgs,
	): Component => sshToolRenderer.renderResult(result, options, renderTheme as Theme, args);
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<SshToolParams>;
		const host = typeof params.host === "string" ? params.host : "(missing)";
		const command = typeof params.command === "string" ? params.command : "(missing)";
		return [`Host: ${truncateForPrompt(host)}`, `Command: ${truncateForPrompt(command)}`];
	};
	readonly examples: readonly ToolExample<SshToolParams>[] = [
		{
			caption: "List files on a Linux host",
			call: { host: "server1", command: "ls -la /home/user" },
		},
		{
			caption: "Show running processes on Windows PowerShell",
			call: { host: "winbox", command: "Get-Process" },
		},
	];
	readonly #allowedHosts: Set<string>;
	readonly #commandLanguagesByHost = new Map<string, SshCommandLanguage>();

	constructor(
		private readonly session: ToolSession,
		private readonly hostNames: string[],
		private readonly hostsByName: Map<string, SSHHost>,
		readonly description: string,
	) {
		this.#allowedHosts = new Set(hostNames);
		for (const [name, host] of hostsByName) {
			const cached = getCachedHostInfoSync(host);
			const commandLanguage = cached ? getSshCommandLanguage(cached) : undefined;
			if (commandLanguage) this.#commandLanguagesByHost.set(name, commandLanguage);
		}
	}

	async execute(
		_toolCallId: string,
		{ host, command, cwd, timeout: rawTimeout }: SshToolParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<SSHToolDetails>,
		_ctx?: AgentToolContext,
	): Promise<AgentToolResult<SSHToolDetails>> {
		if (!this.#allowedHosts.has(host)) {
			throw new ToolError(`Unknown SSH host: ${host}. Available hosts: ${this.hostNames.join(", ")}`);
		}
		const hostConfig = this.hostsByName.get(host);
		if (!hostConfig) throw new ToolError(`SSH host not loaded: ${host}`);
		assertValidSshCwd(cwd);

		const hostInfo = await ensureHostInfo(hostConfig);
		const commandLanguage = getSshCommandLanguage(hostInfo);
		if (commandLanguage) this.#commandLanguagesByHost.set(host, commandLanguage);
		else this.#commandLanguagesByHost.delete(host);
		const commandDetails: SSHToolDetails = { commandLanguage };
		onUpdate?.({ content: [], details: commandDetails });
		const remoteCommand = buildRemoteCommand(command, cwd, hostInfo);
		const timeoutSec = clampTimeout("ssh", rawTimeout, this.session.settings.get("tools.maxTimeout"));
		const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES);
		const { path: artifactPath, id: artifactId } = (await this.session.allocateOutputArtifact?.("ssh")) ?? {};
		const result = await executeSSH(hostConfig, remoteCommand, {
			timeout: timeoutSec * 1000,
			signal,
			compatEnabled: hostInfo.compatEnabled,
			artifactPath,
			artifactId,
			onChunk: streamTailUpdates(tailBuffer, onUpdate, commandDetails),
		});

		if (result.cancelled) {
			const message =
				result.output || (result.timedOut ? `SSH command timed out after ${timeoutSec}s` : "SSH command aborted");
			if (signal?.aborted) throw new ToolAbortError(message);
			throw new ToolError(message);
		}

		const outputText = result.output || "(no output)";
		const resultBuilder = toolResult({ ...commandDetails })
			.text(outputText)
			.truncationFromSummary(result, { direction: "tail" });
		if (result.exitCode !== 0 && result.exitCode !== undefined) {
			throw new ToolError(`${outputText}\n\nCommand exited with code ${result.exitCode}`);
		}
		return resultBuilder.done();
	}
}

export async function loadSshTool(session: ToolSession): Promise<SshTool | null> {
	const { hostNames, hostsByName } = await loadSshHosts(session);
	if (hostNames.length === 0) return null;
	const hosts = hostNames.flatMap(name => {
		const host = hostsByName.get(name);
		return host ? [host] : [];
	});
	return new SshTool(
		session,
		hostNames,
		hostsByName,
		formatSshHostsDescription(prompt.render(sshDescriptionBase), hosts),
	);
}

interface SshRenderArgs {
	host?: string;
	command?: string;
	timeout?: number;
	__partialJson?: string;
}

function hasStreamedRenderArgs(args: unknown): boolean {
	return !!args && typeof args === "object" && "__partialJson" in args && typeof args.__partialJson === "string";
}

interface SshRenderContext {
	visualLines?: string[];
	skippedCount?: number;
	totalVisualLines?: number;
}

interface DecodedSshRenderArgs {
	host?: string;
	command: string;
}

function decodeSshRenderArgs(args: SshRenderArgs): DecodedSshRenderArgs {
	const partialJson = args.__partialJson;
	return {
		host: extractPartialJsonString(partialJson, "host") ?? args.host,
		command: extractPartialJsonString(partialJson, "command") ?? args.command ?? "",
	};
}

function inferSshCommandLanguage(command: string): SshCommandLanguage {
	return POWERSHELL_COMMAND_PATTERN.test(command) ? "powershell" : "bash";
}

function formatSshCommandLines(command: string, uiTheme: Theme, commandLanguage?: SshCommandLanguage): string[] {
	const sanitized = replaceTabs(command);
	const commandLines =
		sanitized.length > 0
			? highlightCode(sanitized, commandLanguage ?? inferSshCommandLanguage(sanitized), uiTheme)
			: ["…"];
	const prefix = uiTheme.fg("dim", "$ ");
	return commandLines.map((line, index) => (index === 0 ? `${prefix}${line}` : line));
}

function renderSshCall(
	args: DecodedSshRenderArgs,
	options: RenderResultOptions,
	uiTheme: Theme,
	commandLanguage?: SshCommandLanguage,
): Component {
	const host = args.host || "…";
	const commandLines = formatSshCommandLines(args.command, uiTheme, commandLanguage);
	const outputBlock = new CachedOutputBlock();
	return markFramedBlockComponent({
		render: (width: number): readonly string[] => {
			const header = renderStatusLine(
				{
					icon: options.spinnerFrame !== undefined ? "running" : "pending",
					spinnerFrame: options.spinnerFrame,
					title: "SSH",
					description: `[${host}]`,
				},
				uiTheme,
			);
			return outputBlock.render(
				{
					header,
					state: options.spinnerFrame !== undefined ? "running" : "pending",
					sections: [{ lines: capPreviewLines(commandLines, uiTheme, { expanded: options.expanded }) }],
					width,
				},
				uiTheme,
			);
		},
		invalidate: () => outputBlock.invalidate(),
	});
}

export const sshToolRenderer = {
	animatedPendingPreview: true,
	renderCall(args: SshRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		return renderSshCall(decodeSshRenderArgs(args), options, uiTheme);
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: SSHToolDetails; isError?: boolean },
		options: RenderResultOptions & { renderContext?: SshRenderContext },
		uiTheme: Theme,
		args?: SshRenderArgs,
	): Component {
		const details = result.details;
		const host = args?.host || "…";
		const commandLines = formatSshCommandLines(args?.command ?? "", uiTheme, details?.commandLanguage);
		const isError = result.isError === true;
		const isPartial = options.isPartial === true;
		const header = renderStatusLine(
			isPartial
				? { icon: "pending", title: "SSH", description: `[${host}]` }
				: isError
					? { icon: "error", title: "SSH", description: `[${host}]` }
					: { iconOverride: uiTheme.styledSymbol("tool.ssh", "accent"), title: "SSH", description: `[${host}]` },
			uiTheme,
		);
		const textContent = result.content.find(content => content.type === "text")?.text ?? "";
		const outputBlock = new CachedOutputBlock();
		return markFramedBlockComponent({
			render: (width: number): readonly string[] => {
				const { expanded, renderContext } = options;
				const output = stripOutputNotice(textContent, details?.meta).trimEnd();
				const outputLines: string[] = [];
				if (output) {
					if (expanded) {
						outputLines.push(...output.split("\n").map(line => uiTheme.fg("toolOutput", line)));
					} else if (renderContext?.visualLines) {
						const { visualLines, skippedCount = 0, totalVisualLines = visualLines.length } = renderContext;
						if (skippedCount > 0) {
							outputLines.push(
								uiTheme.fg(
									"dim",
									`… (${skippedCount} earlier lines, showing ${visualLines.length} of ${totalVisualLines}) (ctrl+o to expand)`,
								),
							);
						}
						outputLines.push(
							...visualLines.map(line => (line.includes("\x1b[") ? line : uiTheme.fg("toolOutput", line))),
						);
					} else {
						const rawLines = output.split("\n");
						outputLines.push(...rawLines.slice(0, 5).map(line => uiTheme.fg("toolOutput", line)));
						if (rawLines.length > 5) {
							outputLines.push(uiTheme.fg("dim", `… (${rawLines.length - 5} more lines) (ctrl+o to expand)`));
						}
					}
				}
				if (details?.meta?.truncation) {
					const warning = formatStyledTruncationWarning(details.meta, uiTheme);
					if (warning) outputLines.push(warning);
				}
				return outputBlock.render(
					{
						header,
						state: isPartial ? "pending" : isError ? "error" : "success",
						sections: [
							{ lines: capPreviewLines(commandLines, uiTheme, { expanded }) },
							{ label: uiTheme.fg("toolTitle", "Output"), lines: outputLines },
						],
						width,
					},
					uiTheme,
				);
			},
			invalidate: () => outputBlock.invalidate(),
		});
	},
	mergeCallAndResult: true,
	forceFirstResultViewportRepaint: hasStreamedRenderArgs,
	forceResultViewportRepaintOnSettle: true,
};
