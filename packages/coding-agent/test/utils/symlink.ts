import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function isSymlinkCapabilityError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "EPERM" || code === "EACCES" || code === "ENOTSUP";
}

function tryCreateSymlinkForTest(target: string, destination: string, type: "dir" | "file" | "junction"): boolean {
	try {
		fs.symlinkSync(target, destination, type);
		return true;
	} catch (error) {
		if (isSymlinkCapabilityError(error)) return false;
		throw error;
	}
}

export function createDirectorySymlinkForTest(target: string, destination: string): boolean {
	return tryCreateSymlinkForTest(target, destination, process.platform === "win32" ? "junction" : "dir");
}

export function createFileSymlinkForTest(target: string, destination: string): boolean {
	return tryCreateSymlinkForTest(target, destination, "file");
}

let canCreateFileSymlink: boolean | undefined;

export function canCreateFileSymlinkForTest(): boolean {
	if (canCreateFileSymlink !== undefined) return canCreateFileSymlink;
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-file-symlink-probe-"));
	try {
		const target = path.join(tempDir, "target.ts");
		const destination = path.join(tempDir, "link.ts");
		fs.writeFileSync(target, "");
		canCreateFileSymlink = createFileSymlinkForTest(target, destination);
		return canCreateFileSymlink;
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}
