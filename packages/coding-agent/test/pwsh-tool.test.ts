import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { PwshTool, resolvePwshExecutable, shouldHidePwshWindow } from "@oh-my-pi/pi-coding-agent/tools/pwsh";
import { Process } from "@oh-my-pi/pi-natives";

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

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getClientBridge: () => undefined,
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

describe("shouldHidePwshWindow", () => {
	it("hides PowerShell on Windows when the host has no inheritable console", () => {
		expect(shouldHidePwshWindow({ platform: "win32", hostHasInheritableConsole: false })).toBe(true);
	});

	it("inherits an attached Windows console so native grandchildren do not allocate their own", () => {
		expect(shouldHidePwshWindow({ platform: "win32", hostHasInheritableConsole: true })).toBe(false);
	});

	it("never sets the Win32-only hide flag off Windows", () => {
		expect(shouldHidePwshWindow({ platform: "linux", hostHasInheritableConsole: false })).toBe(false);
		expect(shouldHidePwshWindow({ platform: "darwin", hostHasInheritableConsole: false })).toBe(false);
	});
});
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

	itIfWindowsPwsh("does not wait for descendants that inherit output pipes after PowerShell exits", async () => {
		const tool = new PwshTool(makeSession(process.cwd()), pwshPath ?? "pwsh");
		const pidPath = path.join(tempDir, "inherited-pipe.pid");
		const escapedPidPath = pidPath.replace(/'/g, "''");
		const startedAt = performance.now();
		try {
			const result = await tool.execute("call-pwsh-inherited-pipe", {
				script: `$child = Start-Process -FilePath $env:ComSpec -ArgumentList '/d', '/c', 'ping -n 6 127.0.0.1' -NoNewWindow -PassThru\n$child.Id | Set-Content -LiteralPath '${escapedPidPath}'`,
				timeout: 1,
			});

			expect(result.isError).toBeUndefined();
			expect(performance.now() - startedAt).toBeLessThan(3000);
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
