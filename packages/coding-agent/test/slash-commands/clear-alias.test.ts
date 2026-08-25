import { afterEach, describe, expect, it } from "bun:test";
import {
	BUILTIN_SLASH_COMMANDS,
	lookupBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui/autocomplete";
import { setLocale, t } from "../../src/i18n";

afterEach(() => {
	setLocale(null);
});

describe("/clear slash command", () => {
	it("resolves /clear to the context reset command and removed /clear alias from /new", async () => {
		const provider = new CombinedAutocompleteProvider(
			[...BUILTIN_SLASH_COMMANDS, { name: "autoresearch", description: "Clear stale research results" }],
			process.cwd(),
		);

		const suggestions = await provider.getSuggestions(["/clear"], 0, 6);

		expect(suggestions?.items[0]).toMatchObject({
			value: "clear",
			description: t("Clear the conversation context in place, keeping the session"),
		});
		expect(lookupBuiltinSlashCommand("clear")?.name).toBe("clear");
		expect(lookupBuiltinSlashCommand("new")?.aliases).toBeUndefined();
		expect(lookupBuiltinSlashCommand("reset")).toBeUndefined();
	});

	it("localizes static command descriptions after the display language changes", async () => {
		setLocale("en");
		const provider = new CombinedAutocompleteProvider([...BUILTIN_SLASH_COMMANDS], process.cwd());
		setLocale("zh-CN");

		const suggestions = await provider.getSuggestions(["/pin"], 0, 4);

		expect(suggestions?.items[0]).toMatchObject({
			value: "pin",
			description: "将会话固定到恢复列表顶部或取消固定",
		});
	});
});
