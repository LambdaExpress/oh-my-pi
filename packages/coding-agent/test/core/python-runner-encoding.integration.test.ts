import { describe, expect, it } from "bun:test";
import { executePythonWithKernel } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { PythonKernel } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { TempDir } from "@oh-my-pi/pi-utils";

const SHOULD_RUN = Bun.env.PI_PYTHON_INTEGRATION === "1";

describe.skipIf(!SHOULD_RUN)("Python runner subprocess encoding", () => {
	it("starts in UTF-8 mode and captures Unicode and ASCII Bun output", async () => {
		using tempDir = TempDir.createSync("@python-runner-encoding-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path(), env: { PYTHONUTF8: "0" } });
		try {
			const result = await executePythonWithKernel(
				kernel,
				[
					"import json, locale, subprocess, sys",
					`unicode_capture = subprocess.run([${JSON.stringify(process.execPath)}, '-e', "console.log('训练种类'); console.error('训练种类')"], capture_output=True, text=True, check=True)`,
					`ascii_capture = subprocess.run([${JSON.stringify(process.execPath)}, '-e', "console.log('capture-probe')"], capture_output=True, text=True, check=True)`,
					"print(json.dumps({'utf8_mode': sys.flags.utf8_mode, 'encoding': locale.getpreferredencoding(False), 'stdout_encoding': sys.stdout.encoding, 'returncode': unicode_capture.returncode, 'stdout': unicode_capture.stdout, 'stderr': unicode_capture.stderr, 'ascii': ascii_capture.stdout}))",
				].join("\n"),
			);
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.output)).toEqual({
				utf8_mode: 1,
				encoding: "utf-8",
				stdout_encoding: null,
				returncode: 0,
				stdout: "训练种类\n",
				stderr: "训练种类\n",
				ascii: "capture-probe\n",
			});
		} finally {
			await kernel.shutdown();
		}
	}, 30_000);

	it("preserves explicit text encodings and binary capture", async () => {
		using tempDir = TempDir.createSync("@python-runner-explicit-encoding-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const result = await executePythonWithKernel(
				kernel,
				[
					"import json, subprocess, sys",
					`child = [sys.executable, '-c', "import os; os.write(1, '训练种类'.encode('cp936'))"]`,
					"text_capture = subprocess.run(child, capture_output=True, text=True, encoding='cp936', check=True)",
					"binary_capture = subprocess.run(child, capture_output=True, check=True)",
					"print(json.dumps({'text': text_capture.stdout, 'binary_matches': binary_capture.stdout == '训练种类'.encode('cp936')}))",
				].join("\n"),
			);
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.output)).toEqual({ text: "训练种类", binary_matches: true });
		} finally {
			await kernel.shutdown();
		}
	}, 30_000);

	it("surfaces standard decoding exceptions without replacing subprocess behavior", async () => {
		using tempDir = TempDir.createSync("@python-runner-decoding-error-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const result = await executePythonWithKernel(
				kernel,
				[
					"import subprocess, sys",
					`capture = subprocess.run([sys.executable, '-c', "import os; os.write(1, bytes([255]))"], capture_output=True, text=True, encoding='utf-8', check=True)`,
					"print('CAPTURE', capture.returncode, repr(capture.stdout))",
				].join("\n"),
			);
			expect(result.output).toContain("UnicodeDecodeError");
			if (process.platform === "win32") {
				// CPython's Windows reader thread reports the exception instead of
				// raising it from communicate(). Keep that API behavior visible.
				expect(result.exitCode).toBe(0);
				expect(result.output).toContain("CAPTURE 0 None");
				expect(result.output).toContain("_readerthread");
			} else {
				expect(result.exitCode).toBe(1);
				expect(result.output).not.toContain("CAPTURE");
			}
		} finally {
			await kernel.shutdown();
		}
	}, 30_000);
});
