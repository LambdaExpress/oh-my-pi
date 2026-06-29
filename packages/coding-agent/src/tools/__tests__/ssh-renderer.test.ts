import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { getThemeByName, setThemeInstance, type Theme } from "../../modes/theme/theme";
import type { SSHHostInfo } from "../../ssh/connection-manager";
import * as connectionManager from "../../ssh/connection-manager";
import { formatSshCommandLines } from "../ssh";

const BASE_HOST_INFO = {
	version: 4,
	os: "linux",
	shell: "bash",
	compatEnabled: false,
} satisfies SSHHostInfo;

describe("formatSshCommandLines", () => {
	let uiTheme: Theme;

	beforeAll(async () => {
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		uiTheme = loaded;
		setThemeInstance(loaded);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders POSIX cwd as the Bash command that SSH executes", () => {
		vi.spyOn(connectionManager, "getCachedHostInfoSync").mockReturnValue({
			...BASE_HOST_INFO,
			os: "macos",
			shell: "zsh",
		});

		const rendered = formatSshCommandLines(
			{ host: "macmini", cwd: "/srv/app", command: 'echo "$HOME"' },
			uiTheme,
		).join("\n");

		expect(Bun.stripANSI(rendered)).toBe("$ cd -- '/srv/app' && echo \"$HOME\"");
		expect(rendered.match(/\x1b\[/g)?.length ?? 0).toBeGreaterThan(2);
	});

	it("renders native Windows PowerShell cwd and uses PowerShell highlighting", () => {
		vi.spyOn(connectionManager, "getCachedHostInfoSync").mockReturnValue({
			...BASE_HOST_INFO,
			os: "windows",
			shell: "powershell",
		});

		const rendered = formatSshCommandLines(
			{ host: "winps", cwd: "C:\\srv", command: "Write-Host $env:USERPROFILE" },
			uiTheme,
		).join("\n");

		expect(Bun.stripANSI(rendered)).toBe("$ Set-Location -Path 'C:\\srv'; Write-Host $env:USERPROFILE");
		expect(rendered.match(/\x1b\[/g)?.length ?? 0).toBeGreaterThan(2);
	});

	it("renders native Windows cmd cwd without shell syntax highlighting", () => {
		vi.spyOn(connectionManager, "getCachedHostInfoSync").mockReturnValue({
			...BASE_HOST_INFO,
			os: "windows",
			shell: "cmd",
		});

		const rendered = formatSshCommandLines({ host: "wincmd", cwd: "C:\\srv", command: "dir" }, uiTheme).join("\n");

		expect(Bun.stripANSI(rendered)).toBe('$ cd /d "C:\\srv" && dir');
		expect(rendered.match(/\x1b\[/g)?.length ?? 0).toBe(2);
	});
});
