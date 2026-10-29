import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hasTerminalMultiplexerSession } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import { quotePosixArgument, quotePosixArgv } from "../../utils/shell-quote";
import { commandWithEnvironment, launchError, nestedString, parseJson, runStep } from "./shared";
import type {
	SupportedMultiplexerCapabilities,
	TerminalLaunchBackend,
	TerminalLaunchCliRunner,
	TerminalLaunchProvider,
	TerminalLaunchRequest,
} from "./types";

const capabilities = {
	displayName: "Herdr",
	supported: true,
	pane: {
		displayName: "pane",
		execution: ["shell-input"],
		target: "pane",
		direction: ["right", "down"],
		focus: true,
	},
	window: {
		displayName: "tab",
		execution: ["shell-input"],
		target: "workspace",
		focus: true,
		label: true,
	},
} as const satisfies SupportedMultiplexerCapabilities;

const shellNeutralWord = /^[A-Za-z0-9_./-]+$/;

/** Quote native Windows argv without PowerShell's legacy native-argument conversion. */
function quoteWindowsArgument(value: string): string {
	const escaped = value
		.replace(/(\\*)"/g, (_match, slashes: string) => `${slashes}${slashes}\\"`)
		.replace(/\\+$/u, slashes => `${slashes}${slashes}`);
	return `"${escaped}"`;
}

async function prepareWindowsLaunchScript(request: TerminalLaunchRequest, directory: string): Promise<string> {
	const script = path.join(directory, "launch.ps1");
	const payload = Buffer.from(
		JSON.stringify({
			executable: request.command[0],
			arguments: request.command.slice(1).map(quoteWindowsArgument).join(" "),
			cwd: request.cwd,
			env: Object.entries(request.env ?? {}).map(([name, value]) => ({ name, value: value || null })),
		}),
		"utf8",
	).toString("base64");
	// ASCII source also works with Windows PowerShell 5.1's legacy script-file encoding.
	await Bun.write(
		script,
		`$ErrorActionPreference = 'Stop'
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
Remove-Item -LiteralPath $PSScriptRoot -Recurse -Force
foreach ($entry in $payload.env) {
	[Environment]::SetEnvironmentVariable($entry.name, $entry.value, 'Process')
}
$startOptions = @{
	FilePath = $payload.executable
	WorkingDirectory = [Management.Automation.WildcardPattern]::Escape($payload.cwd)
	NoNewWindow = $true
	Wait = $true
	PassThru = $true
}
if ($payload.arguments.Length -gt 0) {
	$startOptions.ArgumentList = $payload.arguments
}
$child = Start-Process @startOptions
exit $child.ExitCode
`,
	);
	// Keep the interactive shell's input ASCII-only and independent of its quoting grammar.
	const encoded = Buffer.from(
		`$ErrorActionPreference = 'Stop'; & '${script.replaceAll("'", "''")}'; exit $LASTEXITCODE`,
		"utf16le",
	).toString("base64");
	return `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}

/**
 * `herdr pane run` types text into the pane's interactive shell, whose grammar is unknown.
 * Use an encoded PowerShell bootstrap on Windows, or `/bin/sh` and a shell-neutral script path
 * on POSIX. Prepare the self-deleting script before creating the surface so a local failure
 * leaves no orphaned pane or tab.
 */
async function prepareLaunchScript(
	request: TerminalLaunchRequest,
	platform: NodeJS.Platform,
): Promise<{ directory: string; typed: string }> {
	const directory = await fs.mkdtemp(path.join(path.resolve(os.tmpdir()), "omp-herdr-"));
	try {
		if (platform === "win32") {
			return { directory, typed: await prepareWindowsLaunchScript(request, directory) };
		}
		const script = path.join(directory, "launch");
		if (!shellNeutralWord.test(script)) {
			throw launchError(
				request,
				"launch script",
				"Herdr launch needs a temporary directory path made of letters, digits, and ./_- only.",
			);
		}
		// No `exec`: it would parse a command name starting with `-` as an option.
		await Bun.write(
			script,
			`rm -rf -- ${quotePosixArgument(directory)}\n${quotePosixArgv(commandWithEnvironment(request))}\n`,
		);
		return { directory, typed: `/bin/sh ${script}` };
	} catch (error) {
		await fs.rm(directory, { recursive: true, force: true });
		throw error;
	}
}

/** Creates the Herdr surface, then types the prepared launch line into its pane; returns the surface ID. */
async function launchInNewSurface(
	request: TerminalLaunchRequest,
	runCli: TerminalLaunchCliRunner,
	platform: NodeJS.Platform,
	createSurface: () => Promise<{ id: string; paneId: string }>,
): Promise<string> {
	const { directory, typed } = await prepareLaunchScript(request, platform);
	try {
		const { id, paneId } = await createSurface();
		await runStep(request, "pane run", ["herdr", "pane", "run", paneId, typed], request.cwd, runCli);
		return id;
	} catch (error) {
		await fs.rm(directory, { recursive: true, force: true });
		throw error;
	}
}

const launchHerdr: TerminalLaunchBackend<"herdr", typeof capabilities> = async (
	request,
	{ environment: env, platform, runCli },
) => {
	if (!hasTerminalMultiplexerSession("herdr", env)) {
		throw launchError(request, "capability", "Herdr launch requires an active Herdr pane or workspace.");
	}
	const focusArgs = request.focus === undefined ? [] : [request.focus ? "--focus" : "--no-focus"];
	if (request.placement === "pane") {
		const target = request.target ?? env.HERDR_PANE_ID;
		if (!target) throw launchError(request, "target", "Herdr pane launch requires a pane ID.");
		const createArgv = [
			"herdr",
			"pane",
			"split",
			target,
			"--direction",
			request.direction ?? "right",
			"--cwd",
			request.cwd,
			...focusArgs,
		];
		const id = await launchInNewSurface(request, runCli, platform, async () => {
			const created = parseJson(
				request,
				"pane split",
				await runStep(request, "pane split", createArgv, request.cwd, runCli),
			);
			const paneId = nestedString(created, "result", "pane", "pane_id");
			if (!paneId) throw launchError(request, "pane split", "Herdr pane split returned no pane ID.");
			return { id: paneId, paneId };
		});
		return { multiplexer: "herdr", placement: "pane", id };
	}

	const workspace = request.target ?? env.HERDR_WORKSPACE_ID;
	if (!workspace) throw launchError(request, "target", "Herdr tab launch requires a workspace ID.");
	const createArgv = ["herdr", "tab", "create", "--workspace", workspace, "--cwd", request.cwd];
	if (request.label) createArgv.push("--label", request.label);
	createArgv.push(...focusArgs);
	const id = await launchInNewSurface(request, runCli, platform, async () => {
		const created = parseJson(
			request,
			"tab create",
			await runStep(request, "tab create", createArgv, request.cwd, runCli),
		);
		const tabId = nestedString(created, "result", "tab", "tab_id");
		const paneId = nestedString(created, "result", "root_pane", "pane_id");
		if (!tabId || !paneId) throw launchError(request, "tab create", "Herdr tab create returned incomplete IDs.");
		return { id: tabId, paneId };
	});
	return { multiplexer: "herdr", placement: "window", id };
};

export const herdrLaunchProvider: TerminalLaunchProvider<"herdr", typeof capabilities> = {
	capabilities,
	launch: launchHerdr,
};
