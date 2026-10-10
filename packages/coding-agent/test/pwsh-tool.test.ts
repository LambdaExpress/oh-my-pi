import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { PwshTool, resolvePwshExecutable } from "@oh-my-pi/pi-coding-agent/tools/pwsh";
import { Process, ProcessStatus, PtySession } from "@oh-my-pi/pi-natives";

const pwshPath = resolvePwshExecutable();
const describeIfPwsh = pwshPath ? describe : describe.skip;
const itIfWindowsPwsh = process.platform === "win32" && pwshPath ? it : it.skip;

function textOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(
			(content): content is { type: "text"; text: string } =>
				content.type === "text" && typeof content.text === "string",
		)
		.map(content => content.text)
		.join("\n");
}

function makeSession(
	cwd: string,
	options: Partial<Pick<ToolSession, "allocateOutputArtifact" | "settings">> = {},
): ToolSession {
	return {
		cwd,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getClientBridge: () => undefined,
		...options,
	} as unknown as ToolSession;
}

async function terminateRecordedProcess(pidPath: string): Promise<void> {
	const rawPid = await fs.readFile(pidPath, "utf8").catch(() => undefined);
	const pid = rawPid === undefined ? Number.NaN : Number.parseInt(rawPid, 10);
	if (Number.isInteger(pid)) {
		await Process.fromPid(pid)
			?.terminate({ gracefulMs: -1, timeoutMs: 500 })
			.catch(() => undefined);
	}
	await fs.rm(pidPath, { force: true });
}

describeIfPwsh("PwshTool", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-pwsh-tool-"));
	});

	afterAll(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("executes scripts with cwd and explicit env", async () => {
		const tool = new PwshTool(makeSession(process.cwd()), pwshPath ?? "pwsh");
		const result = await tool.execute("call-pwsh", {
			script: 'Write-Output "cwd=$((Get-Location).Path)"; Write-Output "env=$env:OMP_PWSH_TOOL_TEST"',
			cwd: tempDir,
			env: { OMP_PWSH_TOOL_TEST: "present" },
		});

		expect(result.isError).toBeUndefined();
		expect(result.details?.exitCode).toBeUndefined();
		const text = textOutput(result);
		expect(text).toContain(`cwd=${tempDir}`);
		expect(text).toContain("env=present");
	});

	it("returns non-zero exits as error results with exit details", async () => {
		const tool = new PwshTool(makeSession(process.cwd()), pwshPath ?? "pwsh");
		const result = await tool.execute("call-pwsh-fail", { script: "Write-Output 'before failure'; exit 7" });

		expect(result.isError).toBe(true);
		expect(result.details?.exitCode).toBe(7);
		const text = textOutput(result);
		expect(text).toContain("before failure");
		expect(text).toContain("Command exited with code 7");
	});

	it("captures readable parser diagnostics before executing any user statements", async () => {
		const tool = new PwshTool(makeSession(tempDir), pwshPath ?? "pwsh");
		const markerPath = path.join(tempDir, "parse-error-marker.txt");
		const invalidLine = "Write-Output '中文诊断’s'";
		const result = await tool.execute("call-pwsh-parse-error", {
			script: `Set-Content -LiteralPath 'parse-error-marker.txt' -Value 'executed'\n${invalidLine}`,
		});

		expect(result.isError).toBe(true);
		expect(result.details?.exitCode).toBe(1);
		const text = textOutput(result);
		expect(text).toContain(invalidLine);
		expect(text).not.toContain("\uFFFD");
		expect(await Bun.file(markerPath).exists()).toBe(false);
	});

	it("captures UTF-8 output and diagnostics with explicit environment values", async () => {
		const tool = new PwshTool(makeSession(tempDir), pwshPath ?? "pwsh");
		const result = await tool.execute("call-pwsh-utf8", {
			script: `Write-Output "中文输出：$env:OMP_PWSH_TOOL_TEST"
[Console]::Out.WriteLine('控制台输出：你好')
[Console]::Error.WriteLine('错误诊断：中文')`,
			env: { OMP_PWSH_TOOL_TEST: "环境变量" },
		});

		expect(result.isError).toBeUndefined();
		const text = textOutput(result);
		expect(text).toContain("中文输出：环境变量");
		expect(text).toContain("控制台输出：你好");
		expect(text).toContain("错误诊断：中文");
		expect(text).not.toContain("\uFFFD");
	});

	it("completes past the minimum deadline when timeout is zero", async () => {
		const tool = new PwshTool(makeSession(tempDir), pwshPath ?? "pwsh");
		const checkpointPath = path.join(tempDir, "unlimited-completed.txt");
		const result = await tool.execute("call-pwsh-unlimited", {
			script: `Write-Output 'before unlimited sleep'
Start-Sleep -Milliseconds 1500
Set-Content -LiteralPath 'unlimited-completed.txt' -Value 'completed' -NoNewline -Encoding utf8
Write-Output 'after unlimited sleep'`,
			timeout: 0,
		});

		expect(await Bun.file(checkpointPath).text()).toBe("completed");
		expect(textOutput(result)).toContain("after unlimited sleep");
	}, 10_000);

	it("preserves streamed UTF-8 output when cancelling a script with no deadline", async () => {
		const tool = new PwshTool(makeSession(tempDir), pwshPath ?? "pwsh");
		const controller = new AbortController();
		const pidPath = path.join(tempDir, "cancelled-script.pid");
		let sawOutput = false;
		try {
			const execution = tool.execute(
				"call-pwsh-cancel",
				{
					script: `$PID | Set-Content -LiteralPath 'cancelled-script.pid'
Start-Sleep -Milliseconds 1500
[Console]::Out.WriteLine('取消前的输出')
Start-Sleep -Seconds 30`,
					timeout: 0,
				},
				controller.signal,
				update => {
					if (textOutput(update).includes("取消前的输出")) {
						sawOutput = true;
						controller.abort();
					}
				},
			);

			await expect(execution).rejects.toThrow("取消前的输出\n\n[PowerShell command aborted]");
			expect(sawOutput).toBe(true);
			const pid = Number.parseInt(await fs.readFile(pidPath, "utf8"), 10);
			expect(Process.fromPid(pid)?.status()).not.toBe(ProcessStatus.Running);
		} finally {
			controller.abort();
			await terminateRecordedProcess(pidPath);
		}
	}, 15_000);

	it("links column-capped output to its recoverable session artifact", async () => {
		const wideLine = "x".repeat(2048);
		const artifactPaths = new Map<string, string>();
		const session = makeSession(process.cwd(), {
			settings: Settings.isolated({ "tools.outputMaxColumns": 32 }),
			allocateOutputArtifact: async toolType => {
				const id = "41";
				const artifactPath = path.join(tempDir, `${id}.${toolType}.log`);
				artifactPaths.set(id, artifactPath);
				return { id, path: artifactPath };
			},
		});
		const tool = wrapToolWithMetaNotice(new PwshTool(session, pwshPath ?? "pwsh"));
		const result = await tool.execute("call-pwsh-wide-line", {
			script: `$line = 'x' * ${wideLine.length}; [Console]::Out.WriteLine($line)`,
		});

		expect(result.isError).toBeUndefined();
		expect(result.details?.meta?.truncation).toBeUndefined();
		expect(result.details?.meta?.limits?.columnTruncated).toEqual({
			maxColumn: 32,
			unit: "bytes",
			artifactId: "41",
		});

		const text = textOutput(result);
		expect(text).not.toContain(wideLine);

		const artifactUrl = text.match(/artifact:\/\/[^\s\]]+/u)?.[0];
		expect(artifactUrl).toBe("artifact://41");
		const artifactPath = artifactUrl ? artifactPaths.get(artifactUrl.slice("artifact://".length)) : undefined;
		expect(artifactPath).toBeDefined();
		expect((await fs.readFile(artifactPath!, "utf8")).trimEnd()).toBe(wideLine);
	});

	itIfWindowsPwsh("captures native executable output from PowerShell scripts", async () => {
		const tool = new PwshTool(makeSession(process.cwd()), pwshPath ?? "pwsh");
		const result = await tool.execute("call-pwsh-native", {
			script:
				'Write-Output "ps-before"; cmd.exe /c echo native-out; Write-Output "last=$LASTEXITCODE"; Write-Output "ps-after"',
		});

		expect(result.isError).toBeUndefined();
		const text = textOutput(result);
		expect(text).toContain("ps-before");
		expect(text).toContain("native-out");
		expect(text).toContain("last=0");
		expect(text).toContain("ps-after");
	});

	itIfWindowsPwsh(
		"isolates descendant console writes while capturing standard output",
		async () => {
			const reportPath = path.join(tempDir, "console-isolation.json");
			const terminal = new PtySession();
			let output = "";
			let callbackError: Error | null = null;
			let exited = false;
			try {
				const result = await terminal.startArgv(
					{
						application: process.execPath,
						args: [path.join(import.meta.dir, "fixtures/pwsh-console-isolation.ts"), reportPath],
						cwd: tempDir,
						timeoutMs: 20_000,
						cols: 120,
						rows: 24,
					},
					(error, chunk) => {
						if (error) callbackError = error;
						if (chunk) output += chunk;
					},
				);
				exited = true;

				expect(callbackError).toBeNull();
				expect(result.timedOut).toBeFalse();
				expect(result.exitCode).toBe(0);
				expect(output).toContain("PWSH-CONSOLE-FIXTURE-COMPLETE");
				const captured: { isError?: boolean; content: Array<{ type: string; text?: string }> } =
					await Bun.file(reportPath).json();
				expect(captured.isError).toBeUndefined();
				const text = textOutput(captured);
				expect(text).toContain("captured-before");
				expect(text).toContain("native-stdout");
				expect(text).toContain("native-stderr");
				expect(text).toContain("子进程标准输出");
				expect(text).toContain("子进程错误输出");
				expect(text).toContain("direct-written=27");
				expect(text).toContain("console-visible=false");
				expect(text).toContain("captured-after");
				expect(text).not.toContain("\uFFFD");
				expect(text).not.toContain("BACKGROUND-CONSOLE-LEAK");
				expect(output).not.toContain("BACKGROUND-CONSOLE-LEAK");
			} finally {
				if (!exited) terminal.kill();
			}
		},
		25_000,
	);

	itIfWindowsPwsh("bounds inherited output-pipe draining with no command deadline", async () => {
		const tool = new PwshTool(makeSession(process.cwd()), pwshPath ?? "pwsh");
		const pidPath = path.join(tempDir, "inherited-pipe.pid");
		const escapedPidPath = pidPath.replace(/'/g, "''");
		try {
			const result = await tool.execute("call-pwsh-inherited-pipe", {
				script: `$child = Start-Process -FilePath $env:ComSpec -ArgumentList '/d', '/c', 'ping -n 6 127.0.0.1' -NoNewWindow -PassThru\n$child.Id | Set-Content -LiteralPath '${escapedPidPath}'\nWrite-Output 'root-exited'`,
				timeout: 0,
			});

			expect(result.isError).toBeUndefined();
			expect(textOutput(result)).toContain("root-exited");
			const childPid = Number.parseInt(await fs.readFile(pidPath, "utf8"), 10);
			expect(Process.fromPid(childPid)?.status()).toBe(ProcessStatus.Running);
		} finally {
			await terminateRecordedProcess(pidPath);
		}
	});

	itIfWindowsPwsh("bounds timeout cleanup when descendants inherit output pipes", async () => {
		const tool = new PwshTool(makeSession(process.cwd()), pwshPath ?? "pwsh");
		const pidPath = path.join(tempDir, "timeout-inherited-pipe.pid");
		const escapedPidPath = pidPath.replace(/'/g, "''");
		const startedAt = performance.now();
		try {
			const execution = tool.execute("call-pwsh-timeout-inherited-pipe", {
				script: `$child = Start-Process -FilePath $env:ComSpec -ArgumentList '/d', '/c', 'ping -n 6 127.0.0.1' -NoNewWindow -PassThru\n$child.Id | Set-Content -LiteralPath '${escapedPidPath}'\nStart-Sleep -Seconds 30`,
				timeout: 1,
			});

			await expect(execution).rejects.toThrow("PowerShell timed out after 1 seconds");
			expect(performance.now() - startedAt).toBeLessThan(3000);
		} finally {
			await terminateRecordedProcess(pidPath);
		}
	});
});
