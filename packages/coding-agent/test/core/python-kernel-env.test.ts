import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	enumeratePythonRuntimes,
	filterEnv,
	resolveExplicitPythonRuntime,
	resolvePythonRuntime,
} from "@oh-my-pi/pi-coding-agent/eval/py/runtime";
import * as piUtils from "@oh-my-pi/pi-utils";

describe("Python gateway environment filtering", () => {
	it("filters sensitive and unknown variables from shell env", () => {
		const env: Record<string, string | undefined> = {
			PATH: "/bin",
			HOME: "/home/test",
			OPENAI_API_KEY: "secret",
			ANTHROPIC_API_KEY: "also-secret",
			UNSAFE_TOKEN: "nope",
			PI_CUSTOM: "1",
			LC_ALL: "en_US.UTF-8",
			LD_LIBRARY_PATH: "/opt/conda/lib",
		};

		const filtered = filterEnv(env);

		expect(filtered.PATH).toBe("/bin");
		expect(filtered.HOME).toBe("/home/test");
		expect(filtered.PI_CUSTOM).toBe("1");
		expect(filtered.LC_ALL).toBe("en_US.UTF-8");
		expect(filtered.LD_LIBRARY_PATH).toBe("/opt/conda/lib");
		expect(filtered.OPENAI_API_KEY).toBeUndefined();
		expect(filtered.ANTHROPIC_API_KEY).toBeUndefined();
		expect(filtered.UNSAFE_TOKEN).toBeUndefined();
	});

	it("preserves XDG and LC prefixed variables", () => {
		const env: Record<string, string | undefined> = {
			XDG_CONFIG_HOME: "/home/test/.config",
			XDG_RUNTIME_DIR: "/run/user/1000",
			LC_CTYPE: "UTF-8",
			LC_MESSAGES: "en_US.UTF-8",
		};

		const filtered = filterEnv(env);

		expect(filtered.XDG_CONFIG_HOME).toBe("/home/test/.config");
		expect(filtered.XDG_RUNTIME_DIR).toBe("/run/user/1000");
		expect(filtered.LC_CTYPE).toBe("UTF-8");
		expect(filtered.LC_MESSAGES).toBe("en_US.UTF-8");
	});
});

describe("enumeratePythonRuntimes", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const fixtureRoot = path.join(os.tmpdir(), "omp-python-runtime-fixtures");
	const workDir = path.join(fixtureRoot, "work");
	const systemBin = path.join(fixtureRoot, "system-bin");
	const managedDir = path.join(fixtureRoot, ".omp", "python-env");
	const managedBin = path.join(managedDir, process.platform === "win32" ? "Scripts" : "bin");
	const managedPy = path.join(managedBin, process.platform === "win32" ? "python.exe" : "python");
	const systemPy = path.join(systemBin, process.platform === "win32" ? "python.exe" : "python3");

	it("enumerates the managed env AND the system interpreter so a broken managed env can fall through", () => {
		vi.spyOn(piUtils, "getPythonEnvDir").mockReturnValue(managedDir);
		vi.spyOn(piUtils, "$which").mockImplementation(bin => (bin === "python" ? systemPy : null));
		// Only the managed interpreter physically exists; no project/active venv.
		vi.spyOn(fs, "existsSync").mockImplementation(candidate => candidate === managedPy);

		const runtimes = enumeratePythonRuntimes(workDir, {
			PATH: systemBin,
		});

		expect(runtimes.map(r => r.pythonPath)).toEqual([managedPy, systemPy]);

		const [managed, system] = runtimes;
		expect(managed.venvPath).toBe(managedDir);
		expect(managed.env.VIRTUAL_ENV).toBe(managedDir);
		expect(managed.env.PATH).toBe(`${managedBin}${path.delimiter}${systemBin}`);

		// The system candidate must not inherit the managed env's VIRTUAL_ENV/PATH mutation.
		expect(system.venvPath).toBeUndefined();
		expect(system.env.VIRTUAL_ENV).toBeUndefined();
		expect(system.env.PATH).toBe(systemBin);
	});

	it("falls back to the system interpreter when no managed env or venv exists", () => {
		vi.spyOn(piUtils, "getPythonEnvDir").mockReturnValue(managedDir);
		vi.spyOn(piUtils, "$which").mockImplementation(bin => (bin === "python" ? systemPy : null));
		vi.spyOn(fs, "existsSync").mockReturnValue(false);

		const runtimes = enumeratePythonRuntimes(workDir, {
			PATH: systemBin,
		});

		expect(runtimes.map(r => r.pythonPath)).toEqual([systemPy]);
		expect(resolvePythonRuntime(workDir, {}).pythonPath).toBe(systemPy);
	});

	it("resolves an explicit interpreter without falling through to discovery", () => {
		vi.spyOn(piUtils, "getPythonEnvDir").mockReturnValue(managedDir);
		vi.spyOn(piUtils, "$which").mockImplementation(bin => (bin === "python" ? systemPy : null));
		vi.spyOn(fs, "existsSync").mockReturnValue(false);
		const explicitPy = path.join(fixtureRoot, "custom", process.platform === "win32" ? "python.exe" : "python3.13");

		const runtime = resolveExplicitPythonRuntime(explicitPy, workDir, {
			PATH: systemBin,
		});

		expect(runtime.pythonPath).toBe(explicitPy);
		expect(runtime.venvPath).toBeUndefined();
		expect(runtime.env.PATH).toBe(systemBin);
	});

	it("sets venv env vars for an explicit interpreter inside a virtualenv", () => {
		const venvDir = path.join(workDir, ".venv");
		const binDir = path.join(venvDir, process.platform === "win32" ? "Scripts" : "bin");
		const explicitPy = path.join(binDir, process.platform === "win32" ? "python.exe" : "python");
		vi.spyOn(fs, "existsSync").mockImplementation(candidate => candidate === path.join(venvDir, "pyvenv.cfg"));

		const runtime = resolveExplicitPythonRuntime(explicitPy, workDir, {
			PATH: systemBin,
		});

		expect(runtime.venvPath).toBe(venvDir);
		expect(runtime.env.VIRTUAL_ENV).toBe(venvDir);
		expect(runtime.env.PATH).toBe(`${binDir}${path.delimiter}${systemBin}`);
	});

	it("expands a home-relative explicit interpreter instead of resolving against cwd", () => {
		const home = path.join(fixtureRoot, "home", "tester");
		vi.spyOn(os, "homedir").mockReturnValue(home);
		vi.spyOn(fs, "existsSync").mockReturnValue(false);

		const homeRelative = [
			"~",
			"venvs",
			"py",
			process.platform === "win32" ? "Scripts" : "bin",
			process.platform === "win32" ? "python.exe" : "python",
		].join("/");
		const runtime = resolveExplicitPythonRuntime(homeRelative, workDir, {});

		expect(runtime.pythonPath).toBe(
			path.join(
				home,
				"venvs",
				"py",
				process.platform === "win32" ? "Scripts" : "bin",
				process.platform === "win32" ? "python.exe" : "python",
			),
		);
	});

	it("resolves a relative explicit interpreter against cwd", () => {
		vi.spyOn(fs, "existsSync").mockReturnValue(false);

		const relativeInterpreter = path.join(
			".venv",
			process.platform === "win32" ? "Scripts" : "bin",
			process.platform === "win32" ? "python.exe" : "python",
		);
		const runtime = resolveExplicitPythonRuntime(relativeInterpreter, workDir, {});

		expect(runtime.pythonPath).toBe(path.join(workDir, relativeInterpreter));
	});

	it("throws from resolvePythonRuntime when no interpreter can be found", () => {
		vi.spyOn(piUtils, "getPythonEnvDir").mockReturnValue(managedDir);
		vi.spyOn(piUtils, "$which").mockReturnValue(null);
		vi.spyOn(fs, "existsSync").mockReturnValue(false);

		expect(enumeratePythonRuntimes(workDir, {})).toEqual([]);
		expect(() => resolvePythonRuntime(workDir, {})).toThrow("Python executable not found");
	});
});
