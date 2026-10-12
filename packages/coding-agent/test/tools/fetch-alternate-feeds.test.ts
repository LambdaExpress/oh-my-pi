import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { fetchReadUrl } from "@oh-my-pi/pi-coding-agent/tools/fetch";

const ARTICLE_PATH = "/archives/59785";
const ARTICLE_TITLE = "DEADLIGHT world listing";
const ARTICLE_BODY =
	"DEADLIGHT is an atmospheric exploration world. Visitors walk through an abandoned city, follow its illuminated corridors, and discover the story hidden within its quiet rooms.";
const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Unrelated site discussions</title>
<item><title>Comment on another world</title><link>https://example.com/another-world</link>
<description>A discussion about an entirely different world, unrelated to the requested DEADLIGHT listing or its original article content.</description></item>
</channel></rss>`;
const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>World catalog &amp; updates</title>
<entry><title>New gateway</title><link href="https://example.com/gateway?source=feed&amp;view=full"/>
<updated>2026-10-12T00:00:00Z</updated><summary type="html">&lt;p&gt;A passage into the city.&lt;/p&gt;</summary></entry>
<entry><title>Hidden room</title><link href="https://example.com/hidden-room"/>
<content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">Another <strong>room</strong> nearby.</div></content></entry>
</feed>`;

function makeSession(): ToolSession {
	return {
		cwd: import.meta.dir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "fetch.enabled": true, "providers.fetch": "native" }),
	};
}

function serveArticle(feedPaths: string[], feed = RSS, contentType = "application/rss+xml") {
	const html = `<!doctype html><html><head><title>${ARTICLE_TITLE}</title>
		${feedPaths.map(href => `<link rel="alternate" type="application/rss+xml" href="${href}">`).join("\n")}
		</head><body><article><h1>${ARTICLE_TITLE}</h1><p>${ARTICLE_BODY}</p></article></body></html>`;
	return Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const pathname = new URL(request.url).pathname;
			if (pathname === ARTICLE_PATH) {
				return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
			}
			if (pathname === "/feed" || feedPaths.includes(pathname)) {
				return new Response(feed, { headers: { "Content-Type": contentType } });
			}
			return new Response("Not found", { status: 404 });
		},
	});
}

describe("URL article/feed source equivalence", () => {
	for (const { name, feedPaths } of [
		{ name: "site-wide and comment feeds", feedPaths: ["/feed", "/comments/feed", `${ARTICLE_PATH}/feed`] },
		{ name: "an article-specific comment feed", feedPaths: [`${ARTICLE_PATH}/feed`] },
	]) {
		it(`keeps the requested article when its head advertises ${name}`, async () => {
			const server = serveArticle(feedPaths);
			try {
				const result = await fetchReadUrl(makeSession(), { path: new URL(ARTICLE_PATH, server.url).href });

				expect(result.content).toContain(ARTICLE_TITLE);
				expect(result.content).toContain(ARTICLE_BODY);
				expect(result.content).not.toContain("Unrelated site discussions");
				expect(result.content).not.toContain("Comment on another world");
			} finally {
				await server.stop(true);
			}
		});
	}

	it("renders feed entries when the feed itself is requested", async () => {
		const server = serveArticle(["/feed", "/comments/feed"]);
		try {
			const result = await fetchReadUrl(makeSession(), { path: new URL("/comments/feed", server.url).href });

			expect(result.details.method).toBe("feed");
			expect(result.content).toContain("# Unrelated site discussions");
			expect(result.content).toContain("## Comment on another world");
			expect(result.content).toContain("[Read more](https://example.com/another-world)");
			expect(result.content).toContain("A discussion about an entirely different world");
			expect(result.content).not.toContain(ARTICLE_BODY);
		} finally {
			await server.stop(true);
		}
	});

	it("retains XML text, entities, and CDATA in a directly requested RSS feed", async () => {
		const rss = `<rss version="2.0"><channel><title>City &#38; archives</title>
<item><title>0007</title><link>https://example.com/station?floor=1&amp;room=2</link>
<description><![CDATA[<p>Two <em>stations</em> &amp; quiet halls.</p>]]></description></item>
</channel></rss>`;
		const server = serveArticle(["/feed"], rss);
		try {
			const result = await fetchReadUrl(makeSession(), { path: new URL("/feed", server.url).href });

			expect(result.content).toContain("# City & archives");
			expect(result.content).toContain("## 0007");
			expect(result.content).toContain("Two stations & quiet halls.");
			expect(result.content).toContain("[Read more](https://example.com/station?floor=1&room=2)");
		} finally {
			await server.stop(true);
		}
	});

	it("renders Atom entry links, summaries, and ordered XHTML content", async () => {
		const server = serveArticle(["/atom"], ATOM, "application/atom+xml");
		try {
			const result = await fetchReadUrl(makeSession(), { path: new URL("/atom", server.url).href });

			expect(result.details.method).toBe("feed");
			expect(result.content).toContain("# World catalog & updates");
			expect(result.content).toContain("## New gateway");
			expect(result.content).toContain("2026-10-12T00:00:00Z");
			expect(result.content).toContain("A passage into the city.");
			expect(result.content).toContain("[Read more](https://example.com/gateway?source=feed&view=full)");
			expect(result.content).toContain("## Hidden room");
			expect(result.content).toContain("Another room nearby.");
			expect(result.content).toContain("[Read more](https://example.com/hidden-room)");
		} finally {
			await server.stop(true);
		}
	});

	for (const { name, xml, diagnosticSource } of [
		{
			name: "mismatched closing tags",
			xml: "<rss><channel><item></channel></rss>",
			diagnosticSource: "channel",
		},
		{
			name: "an unclosed root",
			xml: "<rss><channel><title>Broken feed</title></channel>",
			diagnosticSource: "rss",
		},
		{
			name: "unterminated CDATA",
			xml: "<rss><channel><description><![CDATA[unfinished",
			diagnosticSource: "CDATA",
		},
	]) {
		it(`returns the original XML instead of fabricated entries for ${name}`, async () => {
			const server = serveArticle(["/feed"], xml);
			try {
				const result = await fetchReadUrl(makeSession(), { path: new URL("/feed", server.url).href });

				expect(result.details.method).toBe("raw");
				expect(result.content).toBe(xml);
				expect(result.details.notes?.join("\n")).toContain(diagnosticSource);
			} finally {
				await server.stop(true);
			}
		});
	}
});
