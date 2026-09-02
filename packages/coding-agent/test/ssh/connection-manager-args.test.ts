import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getRemoteHostDir } from "@oh-my-pi/pi-utils";
import {
	buildPowerShellCommand,
	buildRemoteCommand,
	encodePowerShellScript,
	extractProbePayload,
	findProbeMarker,
	getHostInfo,
	getSshHostInfoKey,
	HOST_PROBE_MARKER,
	osFromTransferProbe,
	osFromUname,
	parseHostInfo,
	type SSHConnectionTarget,
	type SSHHostShell,
	TRANSFER_PROBE_MARKER,
} from "../../src/ssh/connection-manager";
import { buildSshTarget } from "../../src/ssh/utils";

const TARGET: SSHConnectionTarget = { name: "h", host: "h" };

describe("buildRemoteCommand stdin handling", () => {
	it("includes -n by default so ssh reads stdin from /dev/null", async () => {
		const args = await buildRemoteCommand(TARGET, "cat");
		expect(args).toContain("-n");
	});

	it("omits -n when allowStdin is set so the remote command reads piped stdin", async () => {
		const args = await buildRemoteCommand(TARGET, "cat", { allowStdin: true });
		expect(args).not.toContain("-n");
	});
});

describe("buildSshTarget argument-injection guard", () => {
	it("rejects a host that begins with '-' (ssh would parse it as an option)", () => {
		expect(() => buildSshTarget(undefined, "-oProxyCommand=touch /tmp/pwned")).toThrow(/must not begin with/);
	});

	it("rejects a username that begins with '-'", () => {
		expect(() => buildSshTarget("-oProxyCommand=x", "host")).toThrow(/must not begin with/);
	});

	it("renders a normal destination unchanged", () => {
		expect(buildSshTarget("user", "host")).toBe("user@host");
		expect(buildSshTarget(undefined, "host")).toBe("host");
	});

	it("rejects a dash-leading host through the real buildRemoteCommand path", async () => {
		await expect(buildRemoteCommand({ name: "x", host: "-oProxyCommand=x" }, "cat")).rejects.toThrow(
			/must not begin with/,
		);
	});
});

describe("ssh host shell classification", () => {
	it("treats fish/csh/tcsh as non-POSIX (unknown) and keeps real sh-family as sh", async () => {
		// parseHostInfo re-runs parseShell on the stored shell field, so getHostInfo
		// exercises the classifier through a public seam. The ensurePosixRemote
		// whitelist then refuses anything that isn't sh/bash/zsh.
		const cases: Array<[string, SSHHostShell]> = [
			["/usr/bin/fish", "unknown"],
			["/bin/csh", "unknown"],
			["/bin/tcsh", "unknown"],
			["/bin/dash", "sh"],
			["/bin/sh", "sh"],
			["/usr/bin/bash", "bash"],
			["/usr/bin/zsh", "zsh"],
		];
		for (const [shellValue, expected] of cases) {
			const target: SSHConnectionTarget = {
				name: `alias-${crypto.randomUUID()}`,
				host: `omp-shellclf-${crypto.randomUUID()}`,
			};
			const file = path.join(getRemoteHostDir(), `${getSshHostInfoKey(target)}.json`);
			await Bun.write(file, JSON.stringify({ version: 3, os: "linux", shell: shellValue, compatEnabled: false }));
			try {
				const info = await getHostInfo(target);
				expect(info?.shell).toBe(expected);
			} finally {
				await fs.promises.rm(file, { force: true });
			}
		}
	});
});

describe("extractProbePayload (host probe framing)", () => {
	it("returns the text after the first marker line, ignoring login banners", async () => {
		// Real-world failure shape: noisy dotfiles print a banner before the
		// echo we asked for, so the legacy first-line parser would have read
		// `Last login: ...` and classified the host as unknown (#3719).
		const stdout = [
			"Last login: Wed Mar 19 09:14:22 2025 from 10.0.0.1",
			"Welcome to fancybox 1.0",
			`${HOST_PROBE_MARKER}linux-gnu|/bin/bash|5.2.21`,
		].join("\n");
		expect(extractProbePayload(stdout, "")).toBe("linux-gnu|/bin/bash|5.2.21");
	});

	it("falls back to stderr when the payload only shows up there", async () => {
		// Some shells redirect every echo to stderr after a dotfile error; the
		// parser needs to recover the marker line from either stream.
		const stderr = `noise\n${HOST_PROBE_MARKER}darwin|/bin/zsh|\n`;
		expect(extractProbePayload("", stderr)).toBe("darwin|/bin/zsh|");
	});

	it("returns null when no marker line is present", async () => {
		expect(extractProbePayload("just login banner\n", "and stderr noise\n")).toBeNull();
	});
});

describe("findProbeMarker (transfer-shell probe recovery)", () => {
	it("returns the tail after the marker when it appears in stdout", () => {
		const stdout = `${TRANSFER_PROBE_MARKER}Linux|6.8.0-generic|0|0\n`;
		expect(findProbeMarker(stdout, "", TRANSFER_PROBE_MARKER)).toBe("Linux|6.8.0-generic|0|0\n");
	});

	it("falls back to stderr when a broken dotfile swaps fd 1/2", () => {
		// Some remotes have dotfiles that redirect every shell write to stderr.
		// The transfer probe must still recognize the marker so ssh:// doesn't
		// refuse a POSIX-capable host (#3722 review).
		const stderr = `dotfile noise\n${TRANSFER_PROBE_MARKER}Darwin|24.6.0|0|0\n`;
		expect(findProbeMarker("", stderr, TRANSFER_PROBE_MARKER)).toBe("Darwin|24.6.0|0|0\n");
	});

	it("prefers stdout over stderr when the marker is in both", () => {
		// Order matters: stdout is the canonical path, stderr is the rescue.
		// A reordering bug would silently use stale stderr fragments first.
		const stdout = `${TRANSFER_PROBE_MARKER}Linux|6.8.0-generic|0|0`;
		const stderr = `${TRANSFER_PROBE_MARKER}stale`;
		expect(findProbeMarker(stdout, stderr, TRANSFER_PROBE_MARKER)).toBe("Linux|6.8.0-generic|0|0");
	});

	it("returns null when the marker is in neither stream", () => {
		expect(findProbeMarker("noise", "more noise", TRANSFER_PROBE_MARKER)).toBeNull();
	});
});

describe("osFromTransferProbe (WSL recovery)", () => {
	it("recognizes either WSL environment flag only when its field is exactly 1", () => {
		expect(osFromTransferProbe("Linux|6.8.0-generic|1|0")).toBe("wsl");
		expect(osFromTransferProbe("Linux|6.8.0-generic|0|1")).toBe("wsl");
		expect(osFromTransferProbe("Linux|6.8.0-generic|true|01")).toBe("linux");
		expect(osFromTransferProbe("Linux|6.8.0-generic| 1|1 ")).toBe("linux");
	});

	it("recognizes canonical WSL1 and WSL2 kernel release suffixes", () => {
		expect(osFromTransferProbe("Linux|4.4.0-19041-Microsoft|0|0")).toBe("wsl");
		expect(osFromTransferProbe("Linux|4.19.128-microsoft-standard|0|0")).toBe("wsl");
		expect(osFromTransferProbe("Linux|5.15.153.1-microsoft-standard-WSL2|0|0")).toBe("wsl");
	});

	it("does not mistake Microsoft noise or noncanonical kernels for WSL", () => {
		expect(osFromTransferProbe("Microsoft Linux banner|6.8.0-generic|0|0")).toBe("linux");
		expect(osFromTransferProbe("Linux|6.8.0-microsoft-hardened|0|0")).toBe("linux");
		expect(osFromTransferProbe("GNU/Linux|5.15.153.1-microsoft-standard-WSL2|0|0")).toBe("linux");
		expect(osFromTransferProbe("Linux|6.8.0-generic|0|0\nWelcome to Microsoft WSL\nLinux|x|1|1")).toBe("linux");
	});

	it("keeps ordinary Linux, macOS, and Windows uname classifications", () => {
		expect(osFromTransferProbe("Linux|6.8.0-generic|0|0")).toBe("linux");
		expect(osFromTransferProbe("Darwin|24.6.0|0|0")).toBe("macos");
		expect(osFromTransferProbe("MINGW64_NT-10.0|3.5.4|0|0")).toBe("windows");
	});
});

describe("osFromUname (transfer-shell probe OS recovery)", () => {
	it("classifies common POSIX uname payloads", () => {
		// The markerless host-info fallback uses the transfer-shell probe's
		// uname output to avoid returning a durable `os: "unknown"` when csh/tcsh
		// killed the first marker probe before it could echo anything (#3722 review).
		expect(osFromUname("Linux")).toBe("linux");
		expect(osFromUname("GNU/Linux")).toBe("linux");
		expect(osFromUname("Darwin")).toBe("macos");
	});

	it("classifies Windows compat unames as windows so ssh:// still refuses them", () => {
		expect(osFromUname("MINGW64_NT-10.0")).toBe("windows");
		expect(osFromUname("MSYS_NT-10.0")).toBe("windows");
		expect(osFromUname("CYGWIN_NT-10.0")).toBe("windows");
	});

	it("returns undefined when uname is not recognized", () => {
		expect(osFromUname("")).toBeUndefined();
		expect(osFromUname("SunOS")).toBeUndefined();
	});
});

describe("parseHostInfo transferShell handling", () => {
	it("round-trips WSL host info", () => {
		const parsed = parseHostInfo({
			version: 7,
			os: "wsl",
			shell: "zsh",
			transferShell: "sh",
			compatEnabled: false,
		});
		expect(parsed).toMatchObject({
			version: 7,
			os: "wsl",
			shell: "zsh",
			transferShell: "sh",
			compatEnabled: false,
		});
	});

	it("round-trips a verified transferShell value", () => {
		// Cache writers persist `transferShell` so callers don't re-probe
		// every session; parseHostInfo must thread it back through (#3719).
		const parsed = parseHostInfo({
			version: 5,
			os: "linux",
			shell: "unknown",
			transferShell: "bash",
			compatEnabled: false,
		});
		expect(parsed?.transferShell).toBe("bash");
	});

	it("drops a transferShell value outside the sh/bash/zsh allowlist", () => {
		// Anything we couldn't have probed (fish, csh, garbage) must not slip
		// into the cache and bypass the ssh:// transfer guard.
		const parsed = parseHostInfo({
			version: 5,
			os: "linux",
			shell: "sh",
			transferShell: "fish",
			compatEnabled: false,
		});
		expect(parsed?.transferShell).toBeUndefined();
	});

	it("returns transferShell undefined when the field is missing", () => {
		// A pre-v4 cache file lacks transferShell entirely; the parsed value
		// must be undefined so shouldRefreshHostInfo treats it as stale.
		const parsed = parseHostInfo({ version: 3, os: "linux", shell: "sh", compatEnabled: false });
		expect(parsed?.transferShell).toBeUndefined();
	});
});

describe("parseHostInfo powerShellCommand handling", () => {
	it("round-trips verified Windows PowerShell transfer commands", () => {
		for (const powerShellCommand of ["pwsh", "powershell"] as const) {
			const parsed = parseHostInfo({
				version: 5,
				os: "windows",
				shell: "cmd",
				powerShellCommand,
				compatEnabled: false,
			});
			expect(parsed?.powerShellCommand).toBe(powerShellCommand);
		}
	});

	it("drops PowerShell command values outside the verified executable allowlist", () => {
		for (const powerShellCommand of ["pwsh.exe", "fish", ""]) {
			const parsed = parseHostInfo({
				version: 5,
				os: "windows",
				shell: "cmd",
				powerShellCommand,
				compatEnabled: false,
			});
			expect(parsed?.powerShellCommand).toBeUndefined();
		}
	});
});

describe("PowerShell encoded command helpers", () => {
	it("encodes scripts as UTF-16LE for PowerShell -EncodedCommand", () => {
		const script = "Write-Output 'hello'";
		const encoded = encodePowerShellScript(script);
		expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(script);
	});

	it("builds a non-interactive encoded PowerShell command", () => {
		const script = "$PSVersionTable.PSVersion";
		const command = buildPowerShellCommand("pwsh", script);
		const prefix = "pwsh -NoProfile -NonInteractive -EncodedCommand ";
		expect(command.startsWith(prefix)).toBe(true);
		const encoded = command.slice(prefix.length);
		expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(script);
	});
});
