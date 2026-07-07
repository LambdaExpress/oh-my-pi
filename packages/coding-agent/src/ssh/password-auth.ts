import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface SSHPasswordAuthEnv {
	env?: Record<string, string>;
	cleanup?: () => Promise<void>;
}

export async function prepareSshPasswordAuthEnv(
	password: string | undefined,
	platform: NodeJS.Platform = process.platform,
): Promise<SSHPasswordAuthEnv> {
	if (password === undefined) return {};

	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ssh-askpass-"));
	await fs.chmod(dir, 0o700);

	const scriptName = platform === "win32" ? "askpass.cmd" : "askpass.sh";
	const scriptPath = path.join(dir, scriptName);
	const scriptContent =
		platform === "win32"
			? '@echo off\r\npowershell.exe -NoProfile -NonInteractive -Command "[Console]::Out.WriteLine($env:OMP_SSH_PASSWORD)"\r\n'
			: "#!/bin/sh\nprintf '%s\\n' \"$OMP_SSH_PASSWORD\"\n";
	await fs.writeFile(scriptPath, scriptContent, "utf8");
	if (platform !== "win32") {
		await fs.chmod(scriptPath, 0o700);
	}

	const env = Object.fromEntries(
		Object.entries(Bun.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
	env.SSH_ASKPASS = scriptPath;
	env.SSH_ASKPASS_REQUIRE = "force";
	env.DISPLAY = env.DISPLAY || "omp-askpass";
	env.OMP_SSH_PASSWORD = password;

	return {
		env,
		cleanup: async () => {
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}
