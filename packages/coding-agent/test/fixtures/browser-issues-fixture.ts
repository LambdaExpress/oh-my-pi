import type { ServerWebSocket } from "bun";

/** Only loopback documents are served; no credentials or application services are needed. */
export function createBrowserIssueSite() {
	const headers = { "content-type": "text/html; charset=utf-8" };
	const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		fetch(request) {
			const url = new URL(request.url);
			if (url.pathname.startsWith("/api/")) return Response.json({ fixture: true });
			if (url.pathname === "/pending") {
				let responseController: ReadableStreamDefaultController<Uint8Array> | undefined;
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							responseController = controller;
							streams.add(controller);
							controller.enqueue(
								new TextEncoder().encode(
									"<!doctype html><title>Pending navigation</title><button>Diagnostic control</button>",
								),
							);
						},
						cancel() {
							if (responseController) streams.delete(responseController);
						},
					}),
					{ headers },
				);
			}
			if (url.pathname === "/delayed") {
				const delay = Math.max(0, Number(url.searchParams.get("delay")) || 0);
				return new Response(
					`<!doctype html><title>Delayed input</title><p>Waiting for input</p><script>
setTimeout(() => { const input = document.createElement('input'); input.id = 'late'; document.body.append(input); }, ${delay});
</script>`,
					{ headers },
				);
			}
			if (url.pathname === "/chosen") {
				return new Response("<!doctype html><title>Chosen once</title><p>Navigation completed</p>", { headers });
			}
			if (url.pathname === "/blank")
				return new Response("<!doctype html><title>Blank application</title><body></body>", { headers });
			return new Response(
				`<!doctype html><title>Browser issue fixture</title><style>
button, .action { display:inline-block; margin:8px; padding:12px; }
.caret::before { content:'\\f0da'; }
</style><input id="selected" value="3785"><button id="clear">Clear selected</button>
<button id="remove">Remove on click</button><div class="action" id="activity">Activity</div>
<button id="login">Login<i class="caret"></i></button>
<button id="hidden-icon">Hidden icon<i class="caret" aria-hidden="true"></i></button>
<a id="navigate" href="/chosen">Navigate once</a><output id="count">0</output>
<iframe id="child" srcdoc="<button id='child-action'>Child action</button>"></iframe><script>
window.fixtureCounts = { clear:0, remove:0, activity:0, login:0 };
sessionStorage.setItem('fixtureNavigationClicks', '0');
document.querySelector('#clear').addEventListener('mousedown', event => {
  event.preventDefault();
  if (!event.isTrusted) throw new Error('Expected trusted input');
  window.fixtureCounts.clear++;
  document.querySelector('#selected').value = '';
  event.currentTarget.remove();
});
document.querySelector('#remove').addEventListener('click', event => {
  if (!event.isTrusted) throw new Error('Expected trusted input');
  window.fixtureCounts.remove++;
  event.currentTarget.remove();
});
document.querySelector('#activity').addEventListener('click', event => {
  if (!event.isTrusted) throw new Error('Expected trusted input');
  window.fixtureCounts.activity++;
  document.querySelector('#count').textContent = 'Activity selected';
  event.currentTarget.remove();
});
document.querySelector('#login').addEventListener('click', () => window.fixtureCounts.login++);
document.querySelector('#navigate').addEventListener('click', event => {
  if (!event.isTrusted) throw new Error('Expected trusted input');
  sessionStorage.setItem('fixtureNavigationClicks', String(Number(sessionStorage.getItem('fixtureNavigationClicks')) + 1));
});
</script>`,
				{ headers },
			);
		},
	});
	return {
		url: server.url.href,
		close() {
			for (const controller of streams) {
				try {
					controller.close();
				} catch {
					/* Chromium may already have stopped the response. */
				}
			}
			streams.clear();
			server.stop(true);
		},
	};
}

interface ProxySocketData {
	upstream?: WebSocket;
	pending: string[];
	methods: Map<number, string>;
}

type ProxySocket = ServerWebSocket<ProxySocketData>;

export interface BrowserIssueCdpProxy {
	url: string;
	hold(method: string): void;
	release(method: string): void;
	close(): void;
}

/** Forward real Chromium CDP, optionally holding selected responses to exercise transport boundaries. */
export function createBrowserIssueCdpProxy(endpoint: string): BrowserIssueCdpProxy {
	const heldMethods = new Set<string>();
	const held = new Map<string, Array<{ socket: ProxySocket; message: string }>>();
	const sockets = new Set<ProxySocket>();
	const upstreamHttp = new URL(endpoint);
	upstreamHttp.protocol = upstreamHttp.protocol === "wss:" ? "https:" : "http:";
	const server = Bun.serve<ProxySocketData>({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request, host) {
			const url = new URL(request.url);
			if (url.pathname === "/cdp") {
				return host.upgrade(request, { data: { pending: [], methods: new Map() } })
					? undefined
					: new Response("WebSocket upgrade required", { status: 400 });
			}
			if (url.pathname === "/json/version") {
				const response = await fetch(new URL("/json/version", upstreamHttp));
				const version = (await response.json()) as Record<string, unknown>;
				return Response.json({ ...version, webSocketDebuggerUrl: `ws://${url.host}/cdp` });
			}
			return new Response("Unknown fixture endpoint", { status: 404 });
		},
		websocket: {
			open(socket) {
				sockets.add(socket);
				const upstream = new WebSocket(endpoint);
				socket.data.upstream = upstream;
				upstream.onopen = () => {
					for (const message of socket.data.pending) upstream.send(message);
					socket.data.pending.length = 0;
				};
				upstream.onmessage = event => {
					const message = String(event.data);
					const response = JSON.parse(message) as { id?: number };
					const method = response.id === undefined ? undefined : socket.data.methods.get(response.id);
					if (response.id !== undefined) socket.data.methods.delete(response.id);
					if (method && heldMethods.has(method)) {
						const pending = held.get(method) ?? [];
						pending.push({ socket, message });
						held.set(method, pending);
					} else if (socket.readyState === WebSocket.OPEN) socket.send(message);
				};
				upstream.onclose = () => socket.close();
				upstream.onerror = () => socket.close();
			},
			message(socket, data) {
				const message = typeof data === "string" ? data : data.toString();
				const request = JSON.parse(message) as { id?: number; method?: string };
				if (request.id !== undefined && request.method) socket.data.methods.set(request.id, request.method);
				if (socket.data.upstream?.readyState === WebSocket.OPEN) socket.data.upstream.send(message);
				else socket.data.pending.push(message);
			},
			close(socket) {
				sockets.delete(socket);
				socket.data.upstream?.close();
			},
		},
	});
	return {
		url: server.url.href,
		hold(method: string) {
			heldMethods.add(method);
		},
		release(method: string) {
			heldMethods.delete(method);
			for (const { socket, message } of held.get(method) ?? []) {
				if (socket.readyState === WebSocket.OPEN) socket.send(message);
			}
			held.delete(method);
		},
		close() {
			for (const socket of sockets) {
				socket.data.upstream?.close();
				socket.close();
			}
			held.clear();
			server.stop(true);
		},
	};
}
