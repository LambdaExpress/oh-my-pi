import { afterEach, describe, expect, it, vi } from "bun:test";
import { parseInternalUrl } from "../../src/internal-urls/parse";
import { SshProtocolHandler } from "../../src/internal-urls/ssh-protocol";
import * as fileTransfer from "../../src/ssh/file-transfer";

const context = { sshHosts: [] };
const url = parseInternalUrl("ssh://fixture/repo/being-cloned/");

describe("SSH read directory classification", () => {
	afterEach(() => vi.restoreAllMocks());

	it("reports a not-yet-created directory without opening it as a file", async () => {
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("missing");
		const read = vi.spyOn(fileTransfer, "readRemoteFile").mockRejectedValue(new Error("must not read missing path"));
		const list = vi.spyOn(fileTransfer, "listRemoteDir").mockResolvedValue([]);
		await expect(new SshProtocolHandler().resolve(url, context)).rejects.toThrow(/not found|not yet available/i);
		expect(read).not.toHaveBeenCalled();
		expect(list).not.toHaveBeenCalled();
	});

	it("preserves stat transport errors instead of guessing a text file", async () => {
		const error = new Error("SSH classification failed: connection closed");
		vi.spyOn(fileTransfer, "statRemotePath").mockRejectedValue(error);
		const read = vi.spyOn(fileTransfer, "readRemoteFile").mockRejectedValue(new Error("must not read unknown type"));
		await expect(new SshProtocolHandler().resolve(url, context)).rejects.toBe(error);
		expect(read).not.toHaveBeenCalled();
	});

	it("lists a newly created directory on the next read after an earlier missing result", async () => {
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValueOnce("missing").mockResolvedValueOnce("directory");
		const read = vi.spyOn(fileTransfer, "readRemoteFile").mockRejectedValue(new Error("must not open directory"));
		vi.spyOn(fileTransfer, "listRemoteDir").mockResolvedValue([{ name: "node.py", isDirectory: false }]);
		const handler = new SshProtocolHandler();
		await expect(handler.resolve(url, context)).rejects.toThrow(/not found|not yet available/i);
		const result = await handler.resolve(url, context);
		expect(result.isDirectory).toBe(true);
		expect(result.content).toContain("node.py");
		expect(read).not.toHaveBeenCalled();
	});

	it("reclassifies a file replaced by a directory between stat and read", async () => {
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValueOnce("file").mockResolvedValueOnce("directory");
		const read = vi
			.spyOn(fileTransfer, "readRemoteFile")
			.mockRejectedValue(new Error("head: error reading path: Is a directory"));
		vi.spyOn(fileTransfer, "listRemoteDir").mockResolvedValue([{ name: "node.py", isDirectory: false }]);
		const result = await new SshProtocolHandler().resolve(url, context);
		expect(result.isDirectory).toBe(true);
		expect(result.content).toBe("node.py");
		expect(read).toHaveBeenCalledTimes(1);
	});

	it("preserves the original read error when reclassification also fails", async () => {
		const error = new Error("read failed: connection reset");
		vi.spyOn(fileTransfer, "statRemotePath")
			.mockResolvedValueOnce("file")
			.mockRejectedValueOnce(new Error("stat failed"));
		const read = vi.spyOn(fileTransfer, "readRemoteFile").mockRejectedValue(error);
		await expect(new SshProtocolHandler().resolve(url, context)).rejects.toBe(error);
		expect(read).toHaveBeenCalledTimes(1);
	});

	it("does not retry a failed regular-file read", async () => {
		const error = new Error("read failed: permission denied");
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("file");
		const read = vi.spyOn(fileTransfer, "readRemoteFile").mockRejectedValue(error);
		await expect(new SshProtocolHandler().resolve(url, context)).rejects.toBe(error);
		expect(read).toHaveBeenCalledTimes(1);
	});

	it("preserves a directory listing failure instead of returning an empty directory", async () => {
		const error = new Error("ls: cannot open directory: Permission denied");
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("directory");
		vi.spyOn(fileTransfer, "listRemoteDir").mockRejectedValue(error);
		await expect(new SshProtocolHandler().resolve(url, context)).rejects.toBe(error);
	});
});
