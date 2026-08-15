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

async function collectTSources(): Promise<Set<string>> {
	const keys = new Set<string>();
	const glob = new Glob("**/*.ts");
	for await (const rel of glob.scan(SRC_DIR)) {
		const text = await Bun.file(`${SRC_DIR}${rel}`).text();
		for (const match of text.matchAll(T_CALL_RE)) keys.add(parseStringLiteral(match[1]));
	}
	return keys;
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
	const [tsKeys, schemaKeys, commandKeys, tipKeys, catalogKeys] = await Promise.all([
		collectTSources(),
		collectSchemaKeys(),
		collectCommandKeys(),
		collectTipKeys(),
		readCatalogKeys(),
	]);

	const all = [...new Set([...tsKeys, ...schemaKeys, ...commandKeys, ...tipKeys, ...EXTRA_KEYS])].sort();
	const missing = all.filter(key => !catalogKeys.has(key));
	const orphans = [...catalogKeys].filter(key => !all.includes(key) && !isKnownDynamicKey(key)).sort();

	const json = process.argv.includes("--json");
	if (json) {
		console.log(JSON.stringify({ all, missing, orphans }, null, 2));
		return;
	}

	console.log(`t() call keys (A):       ${tsKeys.size}`);
	console.log(`schema label/desc (B):   ${schemaKeys.size}`);
	console.log(`command descriptions (C): ${commandKeys.size}`);
	console.log(`tips.txt lines (D):      ${tipKeys.size}`);
	console.log(`catalog keys:            ${catalogKeys.size}`);
	console.log(`\nAll keys (deduped):      ${all.length}`);
	console.log(`Missing from zh-CN:      ${missing.length}`);
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
