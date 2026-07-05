export interface ParsedWorktreeAddArgs {
	name?: string;
	recurseSubmodules: boolean;
}

export function parseWorktreeAddArgs(rest: string): ParsedWorktreeAddArgs {
	const tokens = rest.split(/\s+/).filter(token => token.length > 0);
	const nameTokens: string[] = [];
	let recurseSubmodules = false;
	for (const token of tokens) {
		if (token === "--recurse-submodules") {
			recurseSubmodules = true;
			continue;
		}
		nameTokens.push(token);
	}
	const name = nameTokens.join(" ");
	return { name: name.length > 0 ? name : undefined, recurseSubmodules };
}
