import { describe, expect, it } from "bun:test";
import { parseTailCount } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { splitInternalUrlSel } from "@oh-my-pi/pi-tui/tools/read";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { InternalUrlSchemeSpec } from "@oh-my-pi/pi-tui/tools/url-scheme-host";

function sshSpec(scheme: string): InternalUrlSchemeSpec | undefined {
	return scheme === "ssh" ? { selectors: "lines", portAuthority: true } : undefined;
}

describe("splitInternalUrlSel ssh selector boundaries", () => {
	it("keeps an encoded Windows drive colon inside the ssh path", () => {
		expect(splitInternalUrlSel("ssh://win/C%3A/Users/a.txt", sshSpec)).toEqual({
			path: "ssh://win/C%3A/Users/a.txt",
		});
	});

	it("peels a trailing selector after an ssh path", () => {
		expect(splitInternalUrlSel("ssh://win/C%3A/Users/a.txt:1-2", sshSpec)).toEqual({
			path: "ssh://win/C%3A/Users/a.txt",
			sel: "1-2",
		});
	});

	it("keeps a bare ssh authority port rather than treating it as a selector", () => {
		expect(splitInternalUrlSel("ssh://host:2222", sshSpec)).toEqual({ path: "ssh://host:2222" });
	});
});

describe("parseTailCount public selector boundaries", () => {
	it("returns a count only for a standalone tail selector", () => {
		expect(parseTailCount("-38")).toBe(38);
		for (const selection of ["1-105,-38", "1-2", "0", "-N", "-2-3"]) {
			expect(parseTailCount(selection)).toBeNull();
		}
	});

	it("rejects a zero-length tail with the tool's selector error", () => {
		expect(() => parseTailCount("-0")).toThrow(ToolError);
	});
});
