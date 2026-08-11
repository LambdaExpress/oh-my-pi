/**
 * Headless "core" mode: an always-on session engine that browser and TUI
 * clients connect to as peers. The process owns the AgentSession and a
 * CollabHost; a single loopback server hosts both the collab relay room and
 * the collab web dist. A SessionRegistry manages N concurrent sessions (the
 * initial one plus web-created/resumed ones) behind a ControlHost room. The
 * only stdout output is the control deep link and the session deep link.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger, postmortem } from "@oh-my-pi/pi-utils";
import { ControlHost } from "../collab/control-host";
import { EMBEDDED_COLLAB_WEB_FILES, EMBEDDED_COLLAB_WEB_VERSION } from "../collab/embedded-collab-web.generated";
import { CollabHost } from "../collab/host";
import type { CollabHostContext } from "../collab/host-context";
import { startLocalServer } from "../collab/local-server";
import { parseCollabLink } from "../collab/protocol";
import { SessionRegistry } from "../collab/session-registry";
import type { CreateAgentSessionOptions } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { SessionManager } from "../session/session-manager";
import { EventBus } from "../utils/event-bus";

/** Materialize base64 files into a content-hashed cache dir; returns the dir. */
export async function materializeCollabWebFiles(
	cacheRoot: string,
	files: Record<string, string>,
	version: string,
): Promise<string | null> {
	if (Object.keys(files).length === 0) return null;
	const dir = path.join(cacheRoot, version);
	const marker = path.join(dir, ".complete");
	try {
		await fs.access(marker);
		return dir;
	} catch {
		// Not materialized yet; fall through to extraction.
	}
	await fs.mkdir(dir, { recursive: true });
	for (const [rel, b64] of Object.entries(files)) {
		const target = path.join(dir, rel);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, Buffer.from(b64, "base64"));
	}
	// Marker last: an interrupted extraction must not look complete.
	await fs.writeFile(marker, "");
	return dir;
}

/** Extract the dist embedded at compile time into the temp cache. */
function materializeEmbeddedCollabWeb(): Promise<string | null> {
	return materializeCollabWebFiles(
		path.join(os.tmpdir(), "omp-collab-web"),
		EMBEDDED_COLLAB_WEB_FILES,
		EMBEDDED_COLLAB_WEB_VERSION,
	);
}

/**
 * Resolve the web dist directory: explicit override, embedded assets in
 * compiled binaries, or the source-checkout path.
 */
async function resolveWebDistDir(): Promise<string | null> {
	const override = process.env.OMP_COLLAB_WEB_DIST;
	if (override) return override;
	if (process.env.PI_COMPILED === "true") return materializeEmbeddedCollabWeb();
	return path.resolve(import.meta.dir, "../../../collab-web/dist");
}

/** CollabHost context for a process with no terminal: no-ops for UI calls. */
export function createHeadlessCollabContext(session: AgentSession, eventBus?: EventBus): CollabHostContext {
	return {
		session,
		sessionManager: session.sessionManager,
		settings: session.settings,
		eventBus,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => {
				const usage = session.getContextUsage();
				return { usedTokens: usage?.tokens ?? 0, contextWindow: usage?.contextWindow ?? 0 };
			},
		},
		ui: { requestRender: () => {} },
		showStatus: message => logger.info("core status", { message }),
		updatePendingMessagesDisplay: () => {},
	};
}

/**
 * The two deep-link lines core mode prints on startup: the control link (the
 * management plane for the web sidebar) and the initial session link (the
 * existing `omp join` contract). One function so the CLI and the tests share
 * the exact format.
 */
export function formatCoreStdout(ctrlLink: string, sessionLink: string): string {
	return `ctrl: ${ctrlLink}\nsession: ${sessionLink}\n`;
}

/**
 * Run the session engine in core mode until a signal arrives: start the local
 * server, print the control and session deep links to stdout, and block
 * forever. A SessionRegistry plus ControlHost manage the initial session and
 * any sessions created/resumed through the control room.
 */
export async function runCoreMode(
	session: AgentSession,
	eventBus?: EventBus,
	options?: { openBrowser?: boolean; sessionOptions?: CreateAgentSessionOptions },
): Promise<never> {
	// Keep stdout free of BEL/OSC sequences: the deep link line is the only
	// output clients parse.
	process.env.PI_NOTIFICATIONS = "off";

	const distDir = await resolveWebDistDir();
	if (!distDir) {
		process.stderr.write(
			"collab-web assets are not available in this build.\n" +
				"Rebuild the binary with a collab-web dist present, or set OMP_COLLAB_WEB_DIST.\n",
		);
		process.exit(1);
	}
	const indexHtml = Bun.file(`${distDir}/index.html`);
	if (!(await indexHtml.exists())) {
		process.stderr.write(
			`collab-web build output not found at ${distDir}\nRun: bun --cwd=packages/collab-web run build\n`,
		);
		process.exit(1);
	}

	const server = startLocalServer({ webDistDir: distDir });

	// The initial session's bus doubles as the registry entry's bus so the
	// CollabHost and the SessionRegistry's streaming tracking observe the same
	// agent_start/agent_end events (registry-created sessions get their own).
	const bus = eventBus ?? new EventBus();

	const ctx = createHeadlessCollabContext(session, bus);
	const host = new CollabHost(ctx);
	try {
		await host.start(server.relayUrl, server.webLinkBase);
	} catch (err) {
		process.stderr.write(`failed to start collab relay: ${String(err)}\n`);
		server.stop();
		process.exit(1);
	}
	ctx.collabHost = host;

	// Internal invariant: host.start just generated `link`, so it must parse.
	const parsedInitialLink = parseCollabLink(host.link);
	if ("error" in parsedInitialLink) {
		process.stderr.write(`failed to parse session link: ${parsedInitialLink.error}\n`);
		server.stop();
		process.exit(1);
	}

	const registry = new SessionRegistry({
		relayUrl: server.relayUrl,
		webLinkBase: server.webLinkBase,
		baseSessionOptions: options?.sessionOptions ?? {},
		sessionDir:
			options?.sessionOptions?.sessionManager?.getSessionDir() ??
			SessionManager.getDefaultSessionDir(session.sessionManager.getCwd(), session.settings.getAgentDir()),
		agentDir: session.settings.getAgentDir(),
	});
	registry.registerInitial({
		id: session.sessionManager.getSessionId(),
		agentId: `session-${session.sessionManager.getSessionId()}`,
		roomId: parsedInitialLink.roomId,
		createdAt: new Date().toISOString(),
		session,
		sessionManager: session.sessionManager,
		eventBus: bus,
		collabHost: host,
		streaming: session.isStreaming,
		state: "running",
	});

	const controlHost = new ControlHost(registry);
	try {
		await controlHost.start(server.relayUrl, server.webLinkBase);
	} catch (err) {
		process.stderr.write(`failed to start control room: ${String(err)}\n`);
		try {
			await registry.stopAll();
		} catch (cleanupErr) {
			logger.warn("core startup: registry cleanup failed", { error: String(cleanupErr) });
		}
		server.stop();
		process.exit(1);
	}

	// The control link is the management plane (session list/create/resume/
	// drop for the web sidebar); the session line is the existing deep link
	// contract — browser clients connect through it, `omp join` TUI clients
	// through its ws:// half.
	process.stdout.write(formatCoreStdout(controlHost.webLink, host.webLink));

	if (options?.openBrowser !== false) openBrowser(controlHost.webLink);

	// The shared postmortem module owns the process-level SIGINT/SIGTERM
	// listeners and hard-exits with 128+signal after its cleanup pass (LSP,
	// MCP, session-exit record). Core mode is a service: Ctrl+C must exit
	// cleanly with code 0, so take over the signal listeners and run the same
	// global cleanup pass ourselves before exiting.
	process.removeAllListeners("SIGINT");
	process.removeAllListeners("SIGTERM");
	const shutdown = async (): Promise<void> => {
		try {
			await postmortem.cleanup();
		} catch (err) {
			logger.warn("core shutdown: global cleanup failed", { error: String(err) });
		}
		try {
			await controlHost.stop("core shutdown");
		} catch (err) {
			logger.warn("core shutdown: control host stop failed", { error: String(err) });
		}
		try {
			await registry.stopAll();
		} catch (err) {
			logger.warn("core shutdown: registry stop failed", { error: String(err) });
		}
		server.stop();
		// registry.stopAll() already disposed every session (this one included);
		// dispose() is idempotent, so keep the call as belt-and-braces.
		try {
			await session.dispose();
		} catch (err) {
			logger.warn("core shutdown: session dispose failed", { error: String(err) });
		}
		process.exit(0);
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	// Belt-and-braces for terminal stacks that never deliver SIGINT on Windows.
	process.once("exit", () => server.stop());

	// Block forever; the server and websockets keep the event loop alive.
	return new Promise<never>(() => {});
}

function openBrowser(url: string): void {
	const [cmd, args] =
		process.platform === "win32"
			? ["cmd", ["/c", "start", "", url]]
			: process.platform === "darwin"
				? ["open", [url]]
				: ["xdg-open", [url]];
	try {
		const proc = Bun.spawn([cmd, ...args], { stdio: ["ignore", "ignore", "ignore"] });
		proc.unref?.();
	} catch {
		// Opening the browser is best-effort: the deep link is already printed.
	}
}
