import { describe, expect, it } from "bun:test";
import { splitInternalUrlSel } from "@oh-my-pi/pi-tui/tools/read";
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
