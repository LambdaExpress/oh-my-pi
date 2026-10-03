import { dlopen, FFIType, ptr } from "bun:ffi";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { PwshTool } from "@oh-my-pi/pi-coding-agent/tools/pwsh";

if (process.argv[2] === "child") {
	const kernel = dlopen("kernel32.dll", {
		CreateFileW: {
			args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
			returns: FFIType.ptr,
		},
		WriteConsoleW: {
			args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
			returns: FFIType.i32,
		},
		CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
		GetConsoleWindow: { args: [], returns: FFIType.ptr },
	});
	const user = dlopen("user32.dll", {
		IsWindowVisible: { args: [FFIType.ptr], returns: FFIType.i32 },
	});
	try {
		const device = Buffer.from("CONOUT$\0", "utf16le");
		const handle = kernel.symbols.CreateFileW(ptr(device), 0x40000000, 3, null, 3, 0, null);
		const message = "\r\nBACKGROUND-CONSOLE-LEAK\r\n";
		const bytes = Buffer.from(message, "utf16le");
		const written = new Uint32Array(1);
		try {
			if (!kernel.symbols.WriteConsoleW(handle, ptr(bytes), message.length, ptr(written), null)) {
				throw new Error("Unable to write to the child console");
			}
		} finally {
			kernel.symbols.CloseHandle(handle);
		}
		process.stdout.write(`native-stdout\n子进程标准输出\ndirect-written=${written[0]}\n`);
		const window = kernel.symbols.GetConsoleWindow();
		process.stdout.write(`console-visible=${!!window && !!user.symbols.IsWindowVisible(window)}\n`);
		process.stderr.write("native-stderr\n子进程错误输出\n");
	} finally {
		user.close();
		kernel.close();
	}
} else {
	const session = {
		cwd: process.cwd(),
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
	const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
	const childArgs = quote(`"${import.meta.path}" child`);
	const result = await new PwshTool(session).execute("console-isolation", {
		script: `Write-Output 'captured-before'
$child = Start-Process -FilePath ${quote(process.execPath)} -ArgumentList ${childArgs} -NoNewWindow -PassThru
if (-not $child.WaitForExit(10000)) { $child.Kill(); throw 'Child timed out' }
if ($child.ExitCode -ne 0) { throw "Child exited with $($child.ExitCode)" }
Write-Output 'captured-after'`,
		timeout: 15,
	});
	await Bun.write(process.argv[2], JSON.stringify(result));
	process.stdout.write("PWSH-CONSOLE-FIXTURE-COMPLETE\n");
	process.exit(result.isError ? 1 : 0);
}
