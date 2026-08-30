import { logger, ptree } from "@oh-my-pi/pi-utils";
import type { SSHConnectionTarget } from "./connection-manager";

const WSL_DISCOVERY_TIMEOUT_MS = 30_000;

export interface LocalWslConnectionTarget extends SSHConnectionTarget {
	transport: "wsl";
	distribution?: string;
}

export interface DiscoverLocalWslTargetsOptions {
	platform?: NodeJS.Platform;
	runList?: () => Promise<Uint8Array>;
}

function decodeWslListOutput(output: Uint8Array): string {
	const hasUtf16LeBom = output[0] === 0xff && output[1] === 0xfe;
	let sampledOddBytes = 0;
	let sampledOddNulls = 0;
	for (let index = 1; index < Math.min(output.length, 128); index += 2) {
		sampledOddBytes++;
		if (output[index] === 0) sampledOddNulls++;
	}
	const looksUtf16Le = hasUtf16LeBom || (sampledOddBytes >= 2 && sampledOddNulls * 2 >= sampledOddBytes);
	return new TextDecoder(looksUtf16Le ? "utf-16" : "utf-8").decode(output);
}

export function parseWslDistributionList(output: Uint8Array): string[] {
	const distributions: string[] = [];
	const seen = new Set<string>();
	for (const line of decodeWslListOutput(output)
		.replace(/^\uFEFF/, "")
		.replaceAll("\0", "")
		.split(/\r?\n/)) {
		const distribution = line.trim();
		if (!distribution || seen.has(distribution)) continue;
		seen.add(distribution);
		distributions.push(distribution);
	}
	return distributions;
}

export function createLocalWslTargets(distributions: readonly string[]): LocalWslConnectionTarget[] {
	if (distributions.length === 0) return [];
	return [
		{ name: "wsl", host: "default", transport: "wsl" },
		...distributions.map(distribution => ({
			name: `wsl:${distribution}`,
			host: distribution,
			transport: "wsl" as const,
			distribution,
		})),
	];
}

async function readWslDistributionList(): Promise<Uint8Array> {
	using child = ptree.spawn(["wsl.exe", "--list", "--quiet"], {
		signal: ptree.combineSignals(WSL_DISCOVERY_TIMEOUT_MS),
		stderr: "full",
	});
	const output = await child.bytes();
	await child.exitedCleanly;
	return output;
}

export async function discoverLocalWslTargets(
	options: DiscoverLocalWslTargetsOptions = {},
): Promise<LocalWslConnectionTarget[]> {
	if ((options.platform ?? process.platform) !== "win32") return [];
	try {
		const output = await (options.runList ?? readWslDistributionList)();
		return createLocalWslTargets(parseWslDistributionList(output));
	} catch (error) {
		logger.debug("Local WSL discovery failed", { error: String(error) });
		return [];
	}
}
