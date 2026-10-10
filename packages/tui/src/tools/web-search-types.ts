/**
 * Web search response types shared by the coding agent's search providers and
 * the transcript renderer in {@link ./web-search}. Render-free, so provider code
 * can import it without loading UI components.
 */

/**
 * Display label for every search implementation: `web/*` engines and the
 * chat-model groundings. Keys are the ids providers report in
 * {@link SearchResponse.provider} and search errors.
 */
export const SEARCH_PROVIDER_LABELS = {
	parallel: "Parallel",
	perplexity: "Perplexity",
	gemini: "Gemini",
	anthropic: "Anthropic",
	codex: "OpenAI Codex",
	openai: "OpenAI API",
	xai: "xAI",
	openrouter: "OpenRouter",
	zai: "Z.AI",
	exa: "Exa",
	tinyfish: "TinyFish",
	jina: "Jina",
	kagi: "Kagi",
	tavily: "Tavily",
	firecrawl: "Firecrawl",
	brave: "Brave",
	kimi: "Kimi",
	synthetic: "Synthetic",
	ollama: "Ollama",
	searxng: "SearXNG",
	startpage: "Startpage",
	duckduckgo: "DuckDuckGo",
	ecosia: "Ecosia",
	google: "Google",
	mojeek: "Mojeek",
	public: "Public Web",
} as const;

/** Id of a search implementation; see {@link SEARCH_PROVIDER_LABELS}. */
export type SearchProviderId = keyof typeof SEARCH_PROVIDER_LABELS;

/** Onboarding choices share the provider labels used by search responses. */
export const SEARCH_PROVIDER_OPTIONS = [
	{ value: "auto", label: "Auto", description: "Automatically uses the first configured web-search provider" },
	{
		value: "parallel",
		label: SEARCH_PROVIDER_LABELS.parallel,
		description: "Uses API auth when configured; otherwise searches through the keyless public MCP",
	},
	{
		value: "perplexity",
		label: SEARCH_PROVIDER_LABELS.perplexity,
		description: "Authenticated search with an anonymous consumer fallback for explicit selection",
	},
	{
		value: "gemini",
		label: SEARCH_PROVIDER_LABELS.gemini,
		description: "Google Search grounding via Gemini (uses google-gemini-cli or google-antigravity OAuth)",
	},
	{
		value: "anthropic",
		label: SEARCH_PROVIDER_LABELS.anthropic,
		description: "Claude's native web_search tool (uses Anthropic OAuth or ANTHROPIC_API_KEY)",
	},
	{
		value: "codex",
		label: SEARCH_PROVIDER_LABELS.codex,
		description: "OpenAI's native web_search (uses ChatGPT OAuth via /login openai-codex)",
	},
	{
		value: "openai",
		label: SEARCH_PROVIDER_LABELS.openai,
		description: "OpenAI Responses API web_search using the selected model's configured API credentials",
	},
	{
		value: "xai",
		label: SEARCH_PROVIDER_LABELS.xai,
		description:
			"Grok web search via xAI Responses API (uses SuperGrok/X Premium+ OAuth via /login xai-oauth, or XAI_API_KEY)",
	},
	{
		value: "openrouter",
		label: SEARCH_PROVIDER_LABELS.openrouter,
		description: "OpenRouter web-plugin grounding using the selected model's configured credentials",
	},
	{ value: "zai", label: SEARCH_PROVIDER_LABELS.zai, description: "Calls Z.AI webSearchPrime MCP" },
	{
		value: "exa",
		label: SEARCH_PROVIDER_LABELS.exa,
		description: "API via /login exa or EXA_API_KEY; explicit keyless fallback via MCP",
	},
	{ value: "tinyfish", label: SEARCH_PROVIDER_LABELS.tinyfish, description: "Requires TINYFISH_API_KEY" },
	{ value: "jina", label: SEARCH_PROVIDER_LABELS.jina, description: "Requires JINA_API_KEY" },
	{
		value: "kagi",
		label: SEARCH_PROVIDER_LABELS.kagi,
		description: "Requires KAGI_API_KEY and Kagi Search API beta access",
	},
	{ value: "tavily", label: SEARCH_PROVIDER_LABELS.tavily, description: "Requires TAVILY_API_KEY" },
	{
		value: "firecrawl",
		label: SEARCH_PROVIDER_LABELS.firecrawl,
		description: "Uses Firecrawl API when FIRECRAWL_API_KEY is set; falls back to keyless mode",
	},
	{ value: "brave", label: SEARCH_PROVIDER_LABELS.brave, description: "Requires BRAVE_API_KEY" },
	{
		value: "kimi",
		label: SEARCH_PROVIDER_LABELS.kimi,
		description:
			"Kimi Code search (requires a Kimi Code Console key via KIMI_SEARCH_API_KEY/MOONSHOT_SEARCH_API_KEY or /login kimi-code; not MOONSHOT_API_KEY)",
	},
	{ value: "synthetic", label: SEARCH_PROVIDER_LABELS.synthetic, description: "Requires SYNTHETIC_API_KEY" },
	{ value: "ollama", label: SEARCH_PROVIDER_LABELS.ollama, description: "Requires OLLAMA_CLOUD_API_KEY" },
	{
		value: "searxng",
		label: SEARCH_PROVIDER_LABELS.searxng,
		description: "Requires SEARXNG_ENDPOINT or searxng.endpoint",
	},
	{
		value: "startpage",
		label: SEARCH_PROVIDER_LABELS.startpage,
		description: "Credential-free scrape of Startpage (Google-backed) results; may be bot-challenged",
	},
	{
		value: "duckduckgo",
		label: SEARCH_PROVIDER_LABELS.duckduckgo,
		description: "Credential-free best-effort fallback; may be bot-challenged on datacenter/shared-egress IPs",
	},
	{
		value: "ecosia",
		label: SEARCH_PROVIDER_LABELS.ecosia,
		description: "Credential-free browser-backed scrape of Ecosia (Google-backed) results",
	},
	{
		value: "google",
		label: SEARCH_PROVIDER_LABELS.google,
		description: "Credential-free browser-backed fallback; slower and may be bot-challenged",
	},
	{
		value: "mojeek",
		label: SEARCH_PROVIDER_LABELS.mojeek,
		description: "Credential-free browser-backed scrape of Mojeek's independent index",
	},
	{
		value: "public",
		label: SEARCH_PROVIDER_LABELS.public,
		description: "Queries every credential-free engine in parallel and consolidates deduplicated results",
	},
] as const satisfies readonly { value: SearchProviderId | "auto"; label: string; description: string }[];

/** Label for a provider id; ids from older transcripts fall back to the raw id. */
export function getSearchProviderLabel(id: SearchProviderId): string {
	return SEARCH_PROVIDER_LABELS[id] ?? id;
}

/** Source returned by search (all providers) */
export interface SearchSource {
	title: string;
	url: string;
	snippet?: string;
	/** ISO date string or relative ("2d ago") */
	publishedDate?: string;
	/** Age in seconds for consistent formatting */
	ageSeconds?: number;
	author?: string;
}

/** Citation with text reference (LLM-mediated providers) */
export interface SearchCitation {
	url: string;
	title: string;
	citedText?: string;
}

/** Usage metrics */
export interface SearchUsage {
	inputTokens?: number;
	outputTokens?: number;
	/** Anthropic: number of web search requests made */
	searchRequests?: number;
	/** Perplexity: combined token count */
	totalTokens?: number;
}

/** Unified response across providers */
export interface SearchResponse {
	provider: SearchProviderId | "none";
	/** Synthesized answer text (LLM-mediated providers) */
	answer?: string;
	/** Search result sources */
	sources: SearchSource[];
	/** Text citations with context */
	citations?: SearchCitation[];
	/** Intermediate search queries (anthropic) */
	searchQueries?: string[];
	/** Follow-up question suggestions (provider-dependent) */
	relatedQuestions?: string[];
	/** Token usage metrics */
	usage?: SearchUsage;
	/** Model used */
	model?: string;
	/** Request ID for debugging */
	requestId?: string;
	/** Authentication mode used by the provider (e.g. oauth, api-key) */
	authMode?: string;
}
