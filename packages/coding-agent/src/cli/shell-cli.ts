/**
 * Shell CLI command handlers.
 *
 * Handles `omp shell` subcommand for testing the native brush-core shell.
 */
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { Shell } from "@oh-my-pi/pi-natives";
import { APP_NAME, getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Settings } from "../config/settings";
import { buildMinimizerOptions } from "../exec/bash-executor";
import { t } from "../i18n";
import { getOrCreateSnapshot } from "../utils/shell-snapshot";

export interface ShellCommandArgs {
	cwd?: string;
	timeoutMs?: number;
	noSnapshot?: boolean;
}

export function parseShellArgs(args: string[]): ShellCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "shell") {
		return undefined;
	}

	const result: ShellCommandArgs = {};

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--cwd" || arg === "-C") {
			result.cwd = args[++i];
		} else if (arg === "--timeout" || arg === "-t") {
			const parsed = Number.parseInt(args[++i], 10);
			if (Number.isFinite(parsed)) {
				result.timeoutMs = parsed;
			}
		} else if (arg === "--no-snapshot") {
			result.noSnapshot = true;
		}
	}

	return result;
}

export async function runShellCommand(cmd: ShellCommandArgs): Promise<void> {
	if (!process.stdin.isTTY) {
		process.stderr.write(`${t("Error: shell console requires an interactive TTY.")}\n`);
		process.exit(1);
	}

	const cwd = cmd.cwd ? path.resolve(cmd.cwd) : getProjectDir();
	const settings = await Settings.init({ cwd });
	const { shell, env: shellEnv } = settings.getShellConfig();
	const snapshotPath = cmd.noSnapshot || !shell.includes("bash") ? null : await getOrCreateSnapshot(shell, shellEnv);
	const minimizer = buildMinimizerOptions(settings.getGroup("shellMinimizer"));
	const shellSession = new Shell({ sessionEnv: shellEnv, snapshotPath: snapshotPath ?? undefined, minimizer });

	let active = false;
	let lastChar: string | null = null;

	const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
	const prompt = chalk.cyan(`${APP_NAME} shell> `);

	const printHelp = () => {
		process.stdout.write(
			`${chalk.bold(t("Shell Console Commands"))}

` +
				`${chalk.bold(t("Special Commands:"))}
  .help           ${t("Show this help")}
  .exit, exit     ${t("Exit the console")}

` +
				`${chalk.bold(t("Options:"))}
  --cwd, -C <path>     ${t("Set working directory for commands")}
  --timeout, -t <ms>   ${t("Timeout per command in milliseconds")}
  --no-snapshot        ${t("Skip sourcing snapshot from user shell")}

` +
				`${chalk.bold(t("Notes:"))}
  ${t("Runs in a persistent brush-core shell session.")}
  ${t("Variables and functions defined in one command persist for the next.")}

`,
		);
	};

	const interruptHandler = () => {
		if (active) {
			void shellSession.abort();
			return;
		}
		rl.close();
		process.exit(0);
	};

	process.on("SIGINT", interruptHandler);
	process.stdout.write(`${chalk.dim(t("Type .help for commands."))}\n`);

	try {
		while (true) {
			const line = (await rl.question(prompt)).trim();
			if (!line) {
				continue;
			}
			if (line === ".help") {
				printHelp();
				continue;
			}
			if (line === ".exit" || line === "exit" || line === "quit") {
				break;
			}

			active = true;
			lastChar = null;
			try {
				const result = await shellSession.run(
					{
						command: line,
						cwd,
						timeoutMs: cmd.timeoutMs,
					},
					(err, chunk) => {
						if (err) {
							process.stderr.write(`${err.message}\n`);
							return;
						}
						if (chunk.length > 0) {
							lastChar = chunk[chunk.length - 1] ?? null;
						}
						process.stdout.write(chunk);
					},
				);

				if (lastChar && lastChar !== "\n") {
					process.stdout.write("\n");
				}

				if (result.timedOut) {
					process.stderr.write(`${chalk.yellow(t("Command timed out."))}\n`);
				} else if (result.cancelled) {
					process.stderr.write(`${chalk.yellow(t("Command cancelled."))}\n`);
				} else if (result.exitCode !== 0 && result.exitCode !== undefined) {
					process.stderr.write(`${chalk.yellow(t("Exit code: {code}", { code: result.exitCode }))}\n`);
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				process.stderr.write(`${chalk.red(t("Error: {message}", { message }))}\n`);
			} finally {
				active = false;
			}
		}
	} finally {
		process.off("SIGINT", interruptHandler);
		rl.close();
	}
}

export function printShellHelp(): void {
	process.stdout.write(`${chalk.bold(`${APP_NAME} shell`)} - ${t("Interactive shell console for testing")}

${chalk.bold(t("Usage:"))}
  ${APP_NAME} shell [options]

${chalk.bold(t("Options:"))}
  --cwd, -C <path>     ${t("Set working directory for commands")}
  --timeout, -t <ms>   ${t("Timeout per command in milliseconds")}
  --no-snapshot        ${t("Skip sourcing snapshot from user shell")}
  -h, --help           ${t("Show this help")}

${chalk.bold(t("Examples:"))}
  ${APP_NAME} shell
  ${APP_NAME} shell --cwd ./tmp
  ${APP_NAME} shell --timeout 2000
`);
}
