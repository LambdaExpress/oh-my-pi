/**
 * SSH JSON Provider
 *
 * Discovers SSH hosts from managed omp config paths and legacy root ssh.json files.
 * Priority: 5 (low, project/user config discovery)
 */
import * as path from "node:path";
import { getSSHConfigPath, tryParseJson } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { readFile } from "../capability/fs";
import { type SSHHost, sshCapability } from "../capability/ssh";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";
import { assertProxyJumpPasswordCompatible, normalizeProxyJump } from "../ssh/utils";
import { expandTilde } from "../tools/path-utils";
import { createSourceMeta, expandEnvVarsDeep } from "./helpers";

const PROVIDER_ID = "ssh-json";
const DISPLAY_NAME = "SSH Config";
const OPENSSH_PROVIDER_ID = "ssh-openssh";
const OPENSSH_DISPLAY_NAME = "OpenSSH Config";

interface SSHConfigFile {
	hosts?: Record<
		string,
		{
			host?: string;
			username?: string;
			port?: number | string;
			compat?: boolean | string;
			key?: string;
			keyPath?: string;
			password?: string;
			proxyJump?: unknown;
			description?: string;
		}
	>;
}

interface OpenSshBlock {
	patterns: string[];
	options: Map<string, string>;
}

function stripOpenSshComment(line: string): string {
	let quote: '"' | "'" | undefined;
	for (let index = 0; index < line.length; index++) {
		const char = line[index];
		if (char === '"' || char === "'") {
			quote = quote === char ? undefined : quote || char;
		} else if (char === "#" && quote === undefined) {
			return line.slice(0, index);
		}
	}
	return line;
}

function splitOpenSshWords(value: string): string[] {
	return [...value.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(match => match[1] ?? match[2] ?? match[3] ?? "");
}

function openSshPatternMatches(pattern: string, host: string): boolean {
	try {
		return new Bun.Glob(pattern.toLowerCase()).match(host.toLowerCase());
	} catch {
		return false;
	}
}

function openSshBlockMatches(patterns: readonly string[], host: string): boolean {
	let positiveMatch = false;
	for (const rawPattern of patterns) {
		const negated = rawPattern.startsWith("!");
		const pattern = negated ? rawPattern.slice(1) : rawPattern;
		if (!pattern || !openSshPatternMatches(pattern, host)) continue;
		if (negated) return false;
		positiveMatch = true;
	}
	return positiveMatch;
}

/** Parse concrete aliases and effective connection fields from an OpenSSH config. */
export function parseOpenSshConfig(content: string, home: string, filePath: string): SSHHost[] {
	const blocks: OpenSshBlock[] = [{ patterns: ["*"], options: new Map() }];
	let current = blocks[0]!;
	for (const rawLine of content.split(/\r?\n/)) {
		const line = stripOpenSshComment(rawLine).trim();
		if (!line) continue;
		const separator = line.search(/[\s=]/);
		const key = (separator < 0 ? line : line.slice(0, separator)).toLowerCase();
		const value = separator < 0 ? "" : line.slice(separator).replace(/^[\s=]+/, "");
		if (key === "host") {
			const patterns = splitOpenSshWords(value);
			current = { patterns, options: new Map() };
			blocks.push(current);
			continue;
		}
		if (key === "match") {
			current = { patterns: [], options: new Map() };
			continue;
		}
		if (value && !current.options.has(key)) current.options.set(key, splitOpenSshWords(value)[0] ?? value);
	}

	const aliases: string[] = [];
	const seen = new Set<string>();
	for (const block of blocks) {
		for (const rawPattern of block.patterns) {
			const alias = rawPattern.startsWith("!") ? rawPattern.slice(1) : rawPattern;
			if (!alias || /[*?[\]]/.test(alias) || alias.startsWith("-") || seen.has(alias.toLowerCase())) continue;
			seen.add(alias.toLowerCase());
			aliases.push(alias);
		}
	}

	const source = createSourceMeta(OPENSSH_PROVIDER_ID, filePath, "user");
	return aliases.map(name => {
		const options = new Map<string, string>();
		for (const block of blocks) {
			if (!openSshBlockMatches(block.patterns, name)) continue;
			for (const [key, value] of block.options) {
				if (!options.has(key)) options.set(key, value);
			}
		}
		const parsedPort = parsePort(options.get("port"));
		let proxyJump: string | undefined;
		const rawProxyJump = options.get("proxyjump");
		if (rawProxyJump && rawProxyJump.toLowerCase() !== "none") {
			try {
				proxyJump = normalizeProxyJump(rawProxyJump);
			} catch {}
		}
		return {
			name,
			host: options.get("hostname") ?? name,
			username: options.get("user"),
			port: parsedPort && parsedPort >= 1 && parsedPort <= 65_535 ? parsedPort : undefined,
			keyPath: options.get("identityfile") ? expandTilde(options.get("identityfile")!, home) : undefined,
			proxyJump,
			description: `OpenSSH alias from ${filePath}`,
			_source: source,
		};
	});
}

async function loadOpenSsh(ctx: LoadContext): Promise<LoadResult<SSHHost>> {
	const filePath = path.join(ctx.home, ".ssh", "config");
	const content = await readFile(filePath);
	return { items: content === null ? [] : parseOpenSshConfig(content, ctx.home, filePath) };
}

function parsePort(value: number | string | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function parseCompat(value: boolean | string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	const normalized = value.trim().toLowerCase();
	if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
	if (normalized === "false" || normalized === "0" || normalized === "no") return false;
	return undefined;
}

function normalizeHost(
	name: string,
	raw: NonNullable<SSHConfigFile["hosts"]>[string],
	source: SourceMeta,
	home: string,
	warnings: string[],
): SSHHost | null {
	if (!raw.host) {
		warnings.push(`Missing host for SSH entry: ${name}`);
		return null;
	}

	const port = parsePort(raw.port);
	if (raw.port !== undefined && port === undefined) {
		warnings.push(`Invalid port for SSH entry ${name}: ${String(raw.port)}`);
	}

	const compat = parseCompat(raw.compat);
	if (raw.compat !== undefined && compat === undefined) {
		warnings.push(`Invalid compat flag for SSH entry ${name}: ${String(raw.compat)}`);
	}

	const keyValue = raw.keyPath ?? raw.key;
	const keyPath = keyValue ? expandTilde(keyValue, home) : undefined;

	const password = typeof raw.password === "string" && raw.password.length > 0 ? raw.password : undefined;
	if (raw.password !== undefined && password === undefined) {
		warnings.push(`Invalid password for SSH entry ${name}: expected non-empty string`);
	}

	let proxyJump: string | undefined;
	if (raw.proxyJump !== undefined) {
		if (typeof raw.proxyJump !== "string") {
			warnings.push(`Invalid proxyJump for SSH entry ${name}: expected a string`);
			return null;
		}
		try {
			proxyJump = normalizeProxyJump(raw.proxyJump);
		} catch {
			warnings.push(`Invalid proxyJump for SSH entry ${name}: expected a valid OpenSSH jump specification`);
			return null;
		}
	}
	try {
		assertProxyJumpPasswordCompatible(proxyJump, password);
	} catch {
		warnings.push(`Invalid SSH entry ${name}: proxyJump cannot be combined with target password authentication`);
		return null;
	}

	return {
		name,
		host: raw.host,
		username: raw.username,
		port,
		keyPath,
		password,
		proxyJump,
		description: raw.description,
		compat,
		_source: source,
	};
}

async function loadSshJsonFile(
	ctx: LoadContext,
	filePath: string,
	level: "user" | "project",
): Promise<LoadResult<SSHHost>> {
	const items: SSHHost[] = [];
	const warnings: string[] = [];
	const content = await readFile(filePath);
	if (content === null) {
		return { items, warnings };
	}
	const parsed = tryParseJson<SSHConfigFile>(content);
	if (!parsed) {
		warnings.push(`Failed to parse JSON in ${filePath}`);
		return { items, warnings };
	}
	const config = expandEnvVarsDeep(parsed);
	if (!config.hosts || typeof config.hosts !== "object") {
		warnings.push(`Missing hosts in ${filePath}`);
		return { items, warnings };
	}

	const source = createSourceMeta(PROVIDER_ID, filePath, level);
	for (const [name, rawHost] of Object.entries(config.hosts)) {
		if (!name.trim()) {
			warnings.push(`Invalid SSH host name in ${filePath}`);
			continue;
		}
		if (!rawHost || typeof rawHost !== "object") {
			warnings.push(`Invalid host entry in ${filePath}: ${name}`);
			continue;
		}
		const host = normalizeHost(name, rawHost, source, ctx.home, warnings);
		if (host) items.push(host);
	}

	return {
		items,
		warnings: warnings.length > 0 ? warnings : undefined,
	};
}
async function load(ctx: LoadContext): Promise<LoadResult<SSHHost>> {
	const candidateSources: Array<{ path: string; level: "user" | "project" }> = [
		{ path: getSSHConfigPath("project", ctx.cwd), level: "project" },
		{ path: getSSHConfigPath("user", ctx.cwd), level: "user" },
		{ path: path.join(ctx.cwd, "ssh.json"), level: "project" },
		{ path: path.join(ctx.cwd, ".ssh.json"), level: "project" },
	];
	const uniqueSources = candidateSources.filter(
		(source, index, arr) => arr.findIndex(candidate => candidate.path === source.path) === index,
	);
	const results = await Promise.all(uniqueSources.map(source => loadSshJsonFile(ctx, source.path, source.level)));
	const allItems = results.flatMap(r => r.items);
	const allWarnings = results.flatMap(r => r.warnings ?? []);
	return {
		items: allItems,
		warnings: allWarnings.length > 0 ? allWarnings : undefined,
	};
}

registerProvider(sshCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load SSH hosts from managed omp paths and legacy ssh.json/.ssh.json files",
	priority: 5,
	load,
});

registerProvider(sshCapability.id, {
	id: OPENSSH_PROVIDER_ID,
	displayName: OPENSSH_DISPLAY_NAME,
	description: "Load concrete aliases from the user's OpenSSH config",
	priority: 10,
	load: loadOpenSsh,
});
