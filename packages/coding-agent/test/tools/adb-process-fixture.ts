import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const args = process.argv.slice(2);
const mode = process.env.OMP_ADB_FIXTURE_MODE ?? "normal";
const root = process.env.OMP_ADB_FIXTURE_ROOT!;
const pngPath = path.join(root, "source.png");

async function waitForMarker(name: string): Promise<void> {
	const deadline = performance.now() + 5_000;
	while (!(await Bun.file(path.join(root, name)).exists())) {
		if (performance.now() >= deadline) throw new Error(`Fixture did not receive ${name}`);
		await Bun.sleep(10);
	}
}

if (args[0] === "--parsed-text") {
	await Bun.write(Bun.stdout, JSON.stringify(args.slice(1)));
	process.exit(0);
}

if (args[0] === "--inherited-stream") {
	const bytes = await Bun.file(pngPath).bytes();
	await Bun.write(Bun.stdout, bytes.subarray(0, 33));
	const readyPath = path.join(root, "inherited-ready");
	await Bun.write(`${readyPath}.tmp`, String(process.pid));
	await fs.rename(`${readyPath}.tmp`, readyPath);
	await waitForMarker("inherited-release");
	await Bun.sleep(450);
	await Bun.write(Bun.stdout, bytes.subarray(33));
	process.exit(0);
}

if (mode === "devices-blocked" && args[0] === "devices") {
	await Bun.write(path.join(root, "devices-ready"), "ready");
	await Bun.sleep(60_000);
}
if (args[0] === "devices") {
	await Bun.write(Bun.stdout, "List of devices attached\nemulator-5554\tdevice model:Fixture\n");
} else if (args.includes("emu")) {
	if (mode === "identity-blocked") {
		await Bun.write(path.join(root, "identity-ready"), "ready");
		await Bun.sleep(60_000);
	}
	await Bun.write(Bun.stdout, "Fixture_AVD\nOK\n");
} else if (args[2] === "push") {
	const bytes = await Bun.file(args[3]!).bytes();
	await Bun.write(Bun.stdout, `1 file pushed, 0 skipped. (${bytes.length} bytes)\n`);
	if (mode === "push-blocked") await Bun.sleep(60_000);
} else if (args[2] === "pull") {
	const destination = args[4]!;
	if (mode === "pull-failed" || mode === "pull-blocked") {
		await Bun.write(destination, "partial replacement");
		if (mode === "pull-blocked") {
			await Bun.write(path.join(root, "pull-ready"), "ready");
			await Bun.sleep(60_000);
		}
		await Bun.write(Bun.stderr, "fixture transfer failed after a partial write\n");
		process.exit(1);
	}
	if (args[3] === "/sdcard/tree") {
		let target = destination;
		try {
			if ((await fs.stat(destination)).isDirectory()) target = path.join(destination, "tree");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await fs.mkdir(target, { recursive: true });
		await Bun.write(path.join(target, "updated.txt"), "complete directory entry");
	} else {
		let target = destination;
		try {
			if ((await fs.stat(destination)).isDirectory()) target = path.join(destination, "log.txt");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await Bun.write(target, await Bun.file(path.join(root, "source.log")).bytes());
	}
	await Bun.write(Bun.stdout, "1 file pulled, 0 skipped.\n");
} else if (args[2] === "exec-out" && args[3] === "screencap") {
	if (mode === "inherited-stream") {
		const child = Bun.spawn([process.execPath, import.meta.path, "--inherited-stream"], {
			stdin: "ignore",
			stdout: "inherit",
			stderr: "inherit",
			env: process.env,
			// unref only releases the event-loop reference. On Windows a
			// non-detached child is killed when its parent's libuv job closes.
			detached: true,
			windowsHide: true,
		});
		try {
			await waitForMarker("inherited-ready");
			// The smoke first takes ownership of the live writer, then asks
			// this root to exit before releasing the writer's remaining bytes.
			await waitForMarker("inherited-root-exit");
		} catch (error) {
			child.kill("SIGKILL");
			throw error;
		}
		child.unref();
		process.exit(0);
	}
	const bytes = await Bun.file(pngPath).bytes();
	if (mode === "binary-blocked") {
		await Bun.write(Bun.stdout, bytes.subarray(0, 33));
		await Bun.write(path.join(root, "binary-ready"), "ready");
		await Bun.sleep(60_000);
	}
	await Bun.write(Bun.stdout, mode === "truncated-png" ? bytes.subarray(0, bytes.length - 8) : bytes);
} else if (args[2] === "exec-out" && args[3] === "sh") {
	await Bun.write(Bun.stdout, await Bun.file(path.join(root, "hierarchy.xml")).bytes());
} else if (args[2] === "exec-out" && args[3] === "dumpsys") {
	await Bun.write(Bun.stdout, await Bun.file(path.join(root, "windows.txt")).bytes());
} else if (args[2] === "shell" && args[3] === "input") {
	await fs.appendFile(path.join(root, "input-attempts.jsonl"), `${JSON.stringify(args.slice(3))}\n`);
	if (mode === "input-denied") {
		await Bun.write(Bun.stderr, "java.lang.Secu");
		await Bun.sleep(20);
		await Bun.write(Bun.stderr, "rityException: Injecting input events requires android.permission.INJECT_EVENTS\n");
		process.exit(0);
	}
	if (mode === "input-denied-log-only") {
		await Bun.write(
			path.join(root, "input-system.log"),
			`InputManager: Input event injection from pid ${process.pid} failed.\n`,
		);
		process.exit(0);
	}
	if (args[4] === "text") {
		// adb shell joins its argv. Parse that fragment through Bun's real
		// shell into another executable's argv, then model Android input's
		// single text argument and %s spaces. No installed host shell is needed.
		const parsed =
			await $`${process.execPath} ${import.meta.path} --parsed-text ${{ raw: args.slice(5).join(" ") }}`.quiet();
		const values = JSON.parse(parsed.stdout.toString()) as string[];
		const input = JSON.stringify({ values, text: values[0]?.replaceAll("%s", " ") });
		await Bun.write(path.join(root, "input-text.json"), input);
		await Bun.write(Bun.stdout, input);
	} else {
		await Bun.write(Bun.stdout, "input dispatched\n");
	}
} else if (args[2] === "shell") {
	if (args[3] === "split-text") {
		const bytes = Buffer.from('发送到"电脑\\共享\n');
		await Bun.write(Bun.stdout, bytes.subarray(0, 2));
		await Bun.sleep(20);
		await Bun.write(Bun.stdout, bytes.subarray(2));
	} else {
		await Bun.write(Bun.stdout, "java.lang.SecurityException in an ordinary shell diagnostic\n");
	}
} else {
	await Bun.write(Bun.stderr, `Unsupported fixture argv: ${JSON.stringify(args)}\n`);
	process.exit(2);
}
