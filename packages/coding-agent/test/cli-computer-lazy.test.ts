import { expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";

test("normal CLI startup keeps computer worker modules lazy", async () => {
	using tempDir = TempDir.createSync("@omp-cli-computer-lazy-");
	const cliUrl = new URL("../src/cli.ts", import.meta.url).href;
	const probePath = tempDir.join("probe.ts");
	// A fresh process keeps the import guard local to this probe. Windows CLI
	// startup legitimately loads pi-natives for path expansion, so disabling all
	// native addons cannot distinguish that work from eager computer-worker imports.
	await Bun.write(
		probePath,
		[
			'import { plugin } from "bun";',
			"plugin({",
			'  name: "reject-eager-computer-worker",',
			"  setup(build) {",
			"    build.onLoad({ filter: /[\\\\/]tools[\\\\/]computer[\\\\/]worker(?:-entry)?\\.ts$/ }, () => {",
			'      throw new Error("Computer worker evaluated during ordinary CLI startup");',
			"    });",
			"  },",
			"});",
			`const { runCli } = await import(${JSON.stringify(cliUrl)});`,
			"process.stdout.write = () => true;",
			'await runCli(["--version"]);',
		].join("\n"),
	);

	const child = Bun.spawn([process.execPath, probePath], { stdout: "pipe", stderr: "pipe" });
	const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	expect(exitCode, stderr).toBe(0);
});
