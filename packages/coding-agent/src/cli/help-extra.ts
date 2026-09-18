import "@oh-my-pi/pi-utils/env";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { APP_NAME, CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils/dirs";
import { t } from "../i18n";

export function getExtraHelpText(): string {
	return `${chalk.bold(t("Environment Variables:"))}
  ${chalk.dim(t("# Core Providers"))}
  ANTHROPIC_API_KEY          - ${t("Anthropic Claude models")}
  ANTHROPIC_OAUTH_TOKEN      - ${t("Anthropic OAuth (takes precedence over API key)")}
  CLAUDE_CODE_USE_FOUNDRY    - ${t("Enable Anthropic Foundry mode (uses Foundry endpoint + mTLS)")}
  FOUNDRY_BASE_URL           - ${t("Anthropic Foundry base URL (e.g., https://<foundry-host>)")}
  ANTHROPIC_FOUNDRY_API_KEY  - ${t("Anthropic token used as Authorization: Bearer <token> in Foundry mode")}
  ANTHROPIC_CUSTOM_HEADERS   - ${t('Extra headers for Foundry or any custom ANTHROPIC_BASE_URL gateway (e.g., "user-id: USERNAME")')}
  CLAUDE_CODE_CLIENT_CERT    - ${t("Client certificate (PEM path or inline PEM) for mTLS")}
  CLAUDE_CODE_CLIENT_KEY     - ${t("Client private key (PEM path or inline PEM) for mTLS")}
  NODE_EXTRA_CA_CERTS        - ${t("CA bundle path (or inline PEM) for server certificate validation")}
  OPENAI_API_KEY             - ${t("OpenAI GPT models")}
  GEMINI_API_KEY             - ${t("Google Gemini models")}
  COPILOT_GITHUB_TOKEN      - ${t("GitHub Copilot")}

  ${chalk.dim(t("# Additional LLM Providers"))}
  AZURE_OPENAI_API_KEY       - ${t("Azure OpenAI models")}
  GROQ_API_KEY               - ${t("Groq models")}
  CEREBRAS_API_KEY           - ${t("Cerebras models")}
  XAI_API_KEY                - ${t("xAI Grok models")}
  OPENROUTER_API_KEY         - ${t("OpenRouter aggregated models")}
  KILO_API_KEY               - ${t("Kilo Gateway models")}
  MISTRAL_API_KEY            - ${t("Mistral models")}
  ZAI_API_KEY                - ${t("z.ai models (ZhipuAI/GLM)")}
  UMANS_AI_CODING_PLAN_API_KEY - ${t("Umans AI Coding Plan models")}
  ABLITERATION_API_KEY       - ${t("Abliteration uncensored GLM models")}
  UMANS_WEBSEARCH_PROVIDER    - ${t("Umans gateway web search backend (native or exa)")}
  MINIMAX_API_KEY            - ${t("MiniMax models")}
  OPENCODE_API_KEY           - ${t("OpenCode Zen/OpenCode Go models")}
  CURSOR_ACCESS_TOKEN        - ${t("Cursor AI models")}
  CLINE_API_KEY              - ${t("ClinePass subscription models")}
  COMMAND_CODE_API_KEY       - ${t("Command Code Provider API models")}
  CHARM_HYPER_API_KEY        - ${t("Charm Hyper inference gateway models")}
  AI_GATEWAY_API_KEY         - ${t("Vercel AI Gateway")}
  WAFER_SERVERLESS_API_KEY   - ${t("Wafer Serverless (pay-as-you-go)")}
  YOLO_AUTO_API_KEY          - ${t("Yolo-Auto flat-rate Qwen models")}

  ${chalk.dim(t("# Cloud Providers"))}
  AWS_PROFILE                - ${t("AWS Bedrock (or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY)")}
  GOOGLE_CLOUD_PROJECT       - ${t("Google Vertex AI (requires GOOGLE_CLOUD_LOCATION)")}
  GOOGLE_APPLICATION_CREDENTIALS - ${t("Service account for Vertex AI")}

  ${chalk.dim(t("# Search & Tools"))}
  EXA_API_KEY                - ${t("Exa web search")}
  BRAVE_API_KEY              - ${t("Brave web search")}
  PERPLEXITY_API_KEY         - ${t("Perplexity web search API key (optional; anonymous fallback)")}
  PERPLEXITY_COOKIES         - ${t("Perplexity web search (session cookie)")}
  TAVILY_API_KEY             - ${t("Tavily web search")}
  TINYFISH_API_KEY           - ${t("TinyFish web search")}
  FIRECRAWL_API_KEY          - ${t("Firecrawl web search + fetch reader backend")}
  ANTHROPIC_SEARCH_API_KEY   - ${t("Anthropic web search (override; isolates search from main ANTHROPIC_API_KEY)")}
  ANTHROPIC_SEARCH_BASE_URL  - ${t("Anthropic web search base URL (override; pairs with ANTHROPIC_SEARCH_API_KEY)")}

  ${chalk.dim(t("# Configuration"))}
  OMP_PROFILE                 - ${t("Named profile for isolated agent state (same as --profile)")}
  ${t("Use `omp --profile <name> --alias <command>` to create a shell shortcut for a profile")}
  PI_CODING_AGENT_DIR        - ${t("Session storage directory (default: ~/{dir}/agent)", { dir: CONFIG_DIR_NAME })}
  PI_PACKAGE_DIR             - ${t("Override package directory (for Nix/Guix store paths)")}
  PI_SMOL_MODEL              - ${t("Override smol/fast model (see --smol)")}
  PI_SLOW_MODEL              - ${t("Override slow/reasoning model (see --slow)")}
  PI_PLAN_MODEL              - ${t("Override planning model (see --plan)")}
  PI_NO_PTY                  - ${t("Disable PTY-based interactive bash execution")}
  ${t("For complete environment variable reference, see:")}
  ${chalk.dim("docs/environment-variables.md")}
${chalk.bold(t("Available Tools (default-enabled unless noted):"))}
  read          - ${t("Read file contents")}
  bash          - ${t("Execute bash commands")}
  edit          - ${t("Edit files with find/replace")}
  write         - ${t("Write files (creates/overwrites)")}
  grep          - ${t("Search file contents")}
  glob          - ${t("Find files by glob pattern")}
  lsp           - ${t("Language server protocol (code intelligence)")}
  python        - ${t("Execute Python code (requires: {app} setup python)", { app: APP_NAME })}
  notebook      - ${t("Edit Jupyter notebooks")}
  browser       - ${t("Browser automation (Puppeteer)")}
  computer      - ${t("Native host desktop capture and input (disabled by default)")}
  task          - ${t("Launch sub-agents for parallel tasks")}
  todo          - ${t("Manage todo/task lists")}
  web_search    - ${t("Search the web")}
  ask           - ${t("Ask user questions (interactive mode only)")}

${chalk.bold(t("Plugin Options:"))}
  --plugin-dir <path>        ${t("Load plugin from directory (repeatable)")}

${chalk.bold(t("Useful Commands:"))}
  omp agents unpack           - ${t("Export bundled subagents to ~/.omp/agent/agents (default)")}
  omp agents unpack --project - ${t("Export bundled subagents to ./.omp/agents")}`;
}
