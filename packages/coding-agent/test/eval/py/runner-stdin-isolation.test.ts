import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";

/**
 * Regression tests for the Python runner's stdin isolation (tool-issue reports
 * 2026-08-07): user `subprocess.run([...], capture_output=True)` with default
 * stdin inherited the runner's fd 0 — the host's NDJSON control channel. On
 * Windows a child inheriting that pipe hung in the OS loader before its first
 * instruction whenever the stdin reader thread had a pending read on it
 * (observed with git.exe and python.exe; the eval cell timed out at ~30s and
 * the kernel was killed). The runner now keeps the control channel on a
 * private non-inheritable dup and repoints fd 0 at DEVNULL, so children see
 * EOF instead of the pipe.
 */
interface RunnerFrame {
	type?: string;
	id?: string;
	data?: string;
	status?: string;
	ename?: string;
	evalue?: string;
}

const pythonPath = Bun.env.PYTHON ?? ($which("python3") ? "python3" : "python");
const gitPath = $which("git");
const runnerPath = path.resolve(import.meta.dir, "../../../src/eval/py/runner.py");
const encoder = new TextEncoder();

async function runCell(code: string, cwd?: string): Promise<{ frames: RunnerFrame[]; elapsedMs: number }> {
	const proc = Bun.spawn([pythonPath, "-u", runnerPath], {
		cwd: cwd ?? path.resolve(import.meta.dir, "../../.."),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			PYTHONUNBUFFERED: "1",
			PYTHONIOENCODING: "utf-8",
		},
	});
	const stderr = new Response(proc.stderr).text();
	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	const frames: RunnerFrame[] = [];

	async function readFrame(): Promise<RunnerFrame> {
		while (true) {
			const newline = pending.indexOf("\n");
			if (newline >= 0) {
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				const frame = JSON.parse(line) as RunnerFrame;
				if (typeof frame.data === "string") frame.data = frame.data.replaceAll("\r\n", "\n");
				return frame;
			}
			const { value, done } = await reader.read();
			if (done) {
				throw new Error(`Python runner exited before done frame: ${await stderr}`);
			}
			pending += decoder.decode(value, { stream: true });
		}
	}

	const startedAt = Date.now();
	try {
		proc.stdin.write(encoder.encode(`${JSON.stringify({ id: "r1", code })}\n`));
		proc.stdin.flush();
		while (true) {
			const frame = await readFrame();
			frames.push(frame);
			if (frame.type === "done") break;
		}
		const elapsedMs = Date.now() - startedAt;
		proc.stdin.write(encoder.encode(`${JSON.stringify({ type: "exit" })}\n`));
		proc.stdin.end();
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			throw new Error(`Python runner exited ${exitCode}: ${await stderr}`);
		}
		return { frames, elapsedMs };
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// Reader may already be released by stream closure.
		}
		try {
			proc.kill("SIGKILL");
		} catch {
			// Process already exited.
		}
	}
}

function cellStdout(frames: RunnerFrame[]): string {
	return frames
		.filter(frame => frame.type === "stdout" || frame.type === "stderr")
		.map(frame => frame.data ?? "")
		.join("");
}

function makeGitRepo(): { dir: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-runner-git-"));
	const git = (args: string[]) => {
		const result = Bun.spawnSync({ cmd: [gitPath!, "-C", dir, ...args], stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) {
			throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`);
		}
	};
	git(["init", "-q"]);
	git(["config", "user.email", "test@example.com"]);
	git(["config", "user.name", "test"]);
	fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
	git(["add", "a.txt"]);
	git(["commit", "-qm", "init"]);
	return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe.skipIf(!pythonPath)("Python runner stdin isolation", () => {
	it("runs a subprocess with default stdin (capture_output) without hanging", async () => {
		// The exact repro from the tool-issue reports: subprocess.run inherits
		// fd 0, and pre-fix the child hung in the loader on Windows until the
		// host escalated and killed the kernel (~30s).
		const code = [
			"import subprocess, time",
			"t0 = time.monotonic()",
			"p = subprocess.run([sys.executable, '-c', 'print(123)'], text=True, encoding='utf-8', errors='replace', capture_output=True)",
			"print('ELAPSED', round(time.monotonic() - t0, 2), 'rc', p.returncode, 'out', repr(p.stdout.strip()))",
		].join("\n");
		const { frames, elapsedMs } = await runCell(`import sys\n${code}`);
		const stdout = cellStdout(frames);

		expect(stdout).toContain("rc 0");
		expect(stdout).toContain("out '123'");
		// Pre-fix the cell never completed (kernel killed at ~30s); anything
		// under 5s proves the child no longer blocks in the loader.
		expect(elapsedMs).toBeLessThan(5_000);
	});

	it.skipIf(!gitPath)("runs a git subprocess against a real repository (report repro)", async () => {
		const repo = makeGitRepo();
		try {
			const code = [
				"import subprocess, time",
				`repo = ${JSON.stringify(repo.dir)}`,
				"t0 = time.monotonic()",
				"p = subprocess.run(['git', 'rev-parse', '--show-toplevel'], cwd=repo, text=True, encoding='utf-8', errors='replace', capture_output=True)",
				"print('ELAPSED', round(time.monotonic() - t0, 2), 'rc', p.returncode, 'out', repr(p.stdout.strip()))",
			].join("\n");
			const { frames, elapsedMs } = await runCell(code);
			const stdout = cellStdout(frames);

			expect(stdout).toContain("rc 0");
			// git prints POSIX separators even on Windows.
			expect(stdout).toContain(repo.dir.replaceAll("\\", "/"));
			expect(elapsedMs).toBeLessThan(5_000);
		} finally {
			repo.cleanup();
		}
	});

	it("gives a stdin-reading child immediate EOF instead of the control channel", async () => {
		const code = [
			"import subprocess",
			"p = subprocess.run([sys.executable, '-c', 'import sys; d = sys.stdin.read(); print(repr(d))'], text=True, encoding='utf-8', errors='replace', capture_output=True)",
			"print('rc', p.returncode, 'out', repr(p.stdout.strip()))",
		].join("\n");
		const { frames } = await runCell(`import sys\n${code}`);
		const stdout = cellStdout(frames);

		expect(stdout).toContain("rc 0");
		// The child must see EOF (devnull), not the NDJSON request channel.
		expect(stdout).toContain("''");
	});

	it("keeps the NDJSON protocol alive after the fd 0 repoint", async () => {
		const { frames, elapsedMs } = await runCell("print('protocol-ok')");
		const stdout = cellStdout(frames);

		expect(frames.some(frame => frame.type === "started")).toBe(true);
		expect(stdout).toContain("protocol-ok");
		expect(elapsedMs).toBeLessThan(5_000);
	});
});
