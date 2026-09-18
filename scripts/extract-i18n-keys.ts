#!/usr/bin/env bun
/**
 * Extract i18n keys referenced across the coding-agent source.
 *
 * Key sources (union, sorted, deduped):
 *   A. `t("...")` static double-quoted string literals in packages/coding-agent/src
 *   B. `label:` / `description:` literals in settings-schema.ts (ui metadata)
 *   C. `description:` literals in commands/*.ts and cli/*-cli.ts (help rendering)
 *   D. Non-empty lines of src/modes/components/tips.txt (welcome screen tips)
 *
 * Usage:
 *   bun scripts/extract-i18n-keys.ts          # human-readable report
 *   bun scripts/extract-i18n-keys.ts --json   # { all, missing, orphans }
 */
import { Glob } from "bun";

const SRC_DIR = `${import.meta.dir}/../packages/coding-agent/src/`;
const ZH_CN_PATH = `${SRC_DIR}i18n/locales/zh-CN.ts`;

// Keys may use single quotes when the literal embeds double quotes; both
// forms are extractable static string literals.
const T_CALL_RE = /\bt\(\s*((?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))/g;
const SCHEMA_LITERAL_RE = /\b(label|description):\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gm;
const CMD_DESCRIPTION_RE = /\bdescription:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gm;
// Command `examples: [...]` entries render through the same translate hook as
// descriptions (see renderCommandBody in packages/utils/src/cli.ts), so each
// resolved block is a catalog key. `${APP_NAME}` is the only interpolation the
// examples use; it resolves to the bin name.
const EXAMPLES_BLOCK_RE = /\bexamples\s*[:=]\s*\[/g;
const EXAMPLE_LITERAL_RE = /`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/gs;
/** Bin name the example templates interpolate; must match APP_NAME in coding-agent. */
const EXAMPLE_APP_NAME = "omp";
// Catalog keys may be quoted ("..." / '...') or bare identifiers (Yes:, Ask:);
// the bare branch excludes quote chars so quoted keys always parse whole.
const ZH_CN_KEY_RE = /^(\t| )*((?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|[^\s"']+):(?=\s|$)/;

/**
 * Dynamic keys that cannot be statically extracted from `t("...")` calls
 * (they are built at runtime in packages/utils or via variable keys).
 * Each entry is the exact runtime key shape; `{bin}`/`{cmd}` placeholders are
 * substituted by the caller before the key is looked up.
 */
const EXTRA_KEYS: string[] = [
	"USAGE",
	"COMMANDS",
	"FLAGS",
	"ARGUMENTS",
	"EXAMPLES",
	" [FLAGS]",
	"Unknown command: ",
	"error: ",
	"Error: command {cmd} not found",
	"Run `{bin} {cmd} --help` for details.",
];

/**
 * Dynamic whole-block keys (t(USAGE_TEXT), t(extra)) whose runtime text is the
 * key. The catalog is the authority for their exact key text, so they are
 * exempted from the orphan check instead of being duplicated here.
 */
function isKnownDynamicKey(key: string): boolean {
	return key.startsWith("Usage: /todo <verb>") || key.startsWith("Environment Variables:");
}

/**
 * Evaluate a JS string literal (with quotes) from static source.
 * Resolves \\n, \\u001b, \\" etc. exactly like the runtime does.
 */
function parseStringLiteral(literal: string): string {
	return Function(`"use strict"; return (${literal});`)() as string;
}

async function collectTSources(): Promise<{ keys: Set<string>; texts: string[] }> {
	const keys = new Set<string>();
	const texts: string[] = [];
	const glob = new Glob("**/*.ts");
	for await (const rel of glob.scan(SRC_DIR)) {
		const text = await Bun.file(`${SRC_DIR}${rel}`).text();
		texts.push(text);
		for (const match of text.matchAll(T_CALL_RE)) keys.add(parseStringLiteral(match[1]));
	}
	return { keys, texts };
}

async function collectSchemaKeys(): Promise<Set<string>> {
	const keys = new Set<string>();
	const text = await Bun.file(`${SRC_DIR}config/settings-schema.ts`).text();
	for (const match of text.matchAll(SCHEMA_LITERAL_RE)) keys.add(parseStringLiteral(match[2]));
	return keys;
}

async function collectCommandKeys(): Promise<Set<string>> {
	const keys = new Set<string>();
	const glob = new Glob("*.ts");
	for (const dir of ["commands", "cli"]) {
		for await (const rel of glob.scan(`${SRC_DIR}${dir}/`)) {
			const text = await Bun.file(`${SRC_DIR}${dir}/${rel}`).text();
			for (const match of text.matchAll(CMD_DESCRIPTION_RE)) keys.add(parseStringLiteral(match[1]));
		}
	}
	return keys;
}

/** Keys produced by `examples: [...]` blocks, resolved as the renderer sees them. */

/**
 * Slash-command and bundled-command definitions keep their English
 * `description` / `acpDescription` as the catalog key — the registry
 * (`builtin-registry.ts`, `available-commands.ts`) calls `t()` on them at
 * materialization time. Only unwrapped literals are collected here; already
 * wrapped ones are covered by the `t()` scan.
 */
async function collectSlashCommandKeys(): Promise<Set<string>> {
	const keys = new Set<string>();
	const glob = new Glob("**/*.ts");
	for (const root of ["slash-commands/", "extensibility/custom-commands/bundled/"]) {
		for await (const rel of glob.scan(`${SRC_DIR}${root}`)) {
			const lines = (await Bun.file(`${SRC_DIR}${root}${rel}`).text()).split("\n");
			for (let i = 0; i < lines.length; i++) {
				const match = lines[i].match(
					/\b(?:acpDescription|description)\s*[:=]\s*(\"(?:[^\"\\]|\\.)*\"|'(?:[^'\\]|\\.)*')/,
				);
				if (!match) continue;
				// A command entry pairs `name:` with `description:`; ignore object
				// literals that never carry a name (options, payload shapes, …).
				const context = lines.slice(Math.max(0, i - 6), i + 1).join("\n");
				if (!/\bname\s*[:=]\s*[\"'`]/.test(context)) continue;
				keys.add(parseStringLiteral(match[1]));
			}
		}
	}
	return keys;
}

/**
 * Slice out a `[...]` literal starting at `open`, ignoring brackets that appear
 * inside string or template literals (examples embed flags like `[features]`).
 */
function sliceArrayLiteral(text: string, open: number): string {
	let depth = 0;
	let quote: string | null = null;
	for (let i = open; i < text.length; i++) {
		const ch = text[i];
		if (quote !== null) {
			if (ch === "\\") i++;
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") quote = ch;
		else if (ch === "[") depth++;
		else if (ch === "]") {
			depth--;
			if (depth === 0) return text.slice(open, i + 1);
		}
	}
	return text.slice(open);
}

async function collectExampleKeys(): Promise<Set<string>> {
	const keys = new Set<string>();
	const glob = new Glob("*.ts");
	for (const dir of ["commands", "cli"]) {
		for await (const rel of glob.scan(`${SRC_DIR}${dir}/`)) {
			const text = await Bun.file(`${SRC_DIR}${dir}/${rel}`).text();
			for (const block of text.matchAll(EXAMPLES_BLOCK_RE)) {
				const open = block.index! + block[0].length - 1;
				for (const entry of sliceArrayLiteral(text, open).matchAll(EXAMPLE_LITERAL_RE)) {
					const literal = entry[0];
					if (literal.includes("${") && !literal.includes("${APP_NAME}")) continue;
					keys.add(parseStringLiteral(literal.replaceAll("${APP_NAME}", EXAMPLE_APP_NAME)));
				}
			}
		}
	}
	return keys;
}

async function collectTipKeys(): Promise<Set<string>> {
	const keys = new Set<string>();
	const text = await Bun.file(`${SRC_DIR}modes/components/tips.txt`).text();
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length > 0) keys.add(trimmed);
	}
	return keys;
}

async function readCatalogKeys(): Promise<Set<string>> {
	const keys = new Set<string>();
	try {
		const text = await Bun.file(ZH_CN_PATH).text();
		for (const line of text.split("\n")) {
			const match = line.match(ZH_CN_KEY_RE);
			if (match) {
				const literal = match[2];
				keys.add(literal[0] === '"' || literal[0] === "'" ? parseStringLiteral(literal) : literal);
			}
		}
	} catch {
		// Catalog missing — treat as empty (all keys missing).
	}
	return keys;
}

async function main() {
	const [sources, schemaKeys, commandKeys, exampleKeys, slashKeys, tipKeys, catalogKeys] = await Promise.all([
		collectTSources(),
		collectSchemaKeys(),
		collectCommandKeys(),
		collectExampleKeys(),
		collectSlashCommandKeys(),
		collectTipKeys(),
		readCatalogKeys(),
	]);

	const tsKeys = sources.keys;
	const all = [
		...new Set([...tsKeys, ...schemaKeys, ...commandKeys, ...exampleKeys, ...slashKeys, ...tipKeys, ...EXTRA_KEYS]),
	].sort();
	const missing = all.filter(key => !catalogKeys.has(key));
	// A key absent from every call site is only an orphan when the text also does not
	// appear in the sources: indirect call sites (`t(CONST[id])`, `.map(t)`, values
	// resolved from template literals) are real usages the extractors cannot see.
	const referenced = new Set(all);
	const indirect: string[] = [];
	const orphans: string[] = [];
	for (const key of [...catalogKeys].sort()) {
		if (referenced.has(key) || isKnownDynamicKey(key)) continue;
		// Multi-line keys reach the catalog from `\n`-escaped source text, so probe
		// both the literal newline form and its escaped spelling.
		const escaped = key.replaceAll("\n", "\\n");
		if (
			key.length > 0 &&
			sources.texts.some(text => text.includes(key) || (escaped !== key && text.includes(escaped)))
		) {
			indirect.push(key);
		} else orphans.push(key);
	}

	const json = process.argv.includes("--json");
	if (json) {
		console.log(JSON.stringify({ all, missing, indirect, orphans }, null, 2));
		return;
	}

	console.log(`t() call keys (A):       ${tsKeys.size}`);
	console.log(`schema label/desc (B):   ${schemaKeys.size}`);
	console.log(`command descriptions (C): ${commandKeys.size}`);
	console.log(`command examples (E):     ${exampleKeys.size}`);
	console.log(`slash-command metadata (F):${String(slashKeys.size).padStart(6)}`);
	console.log(`tips.txt lines (D):      ${tipKeys.size}`);
	console.log(`catalog keys:            ${catalogKeys.size}`);
	console.log(`\nAll keys (deduped):      ${all.length}`);
	console.log(`Missing from zh-CN:      ${missing.length}`);
	console.log(`Indirect/dynamic keys:   ${indirect.length}`);
	console.log(`Orphans in zh-CN:        ${orphans.length}`);
	if (missing.length > 0) {
		console.log(`\nMissing keys:\n${missing.map(key => `  ${JSON.stringify(key)}`).join("\n")}`);
	}
	if (orphans.length > 0) {
		console.log(`\nOrphan keys:\n${orphans.map(key => `  ${JSON.stringify(key)}`).join("\n")}`);
	}
	if (missing.length === 0) {
		console.log("\nAll keys translated.");
	}
	if (orphans.length > 0) {
		process.exitCode = 1;
	}
}

await main();
