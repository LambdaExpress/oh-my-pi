# Repository Guidelines

## Project Overview

Oh My Pi is a Bun-first monorepo for the `omp` coding-agent CLI. It combines TypeScript packages, Rust/N-API native helpers (built with Bazel), and a smaller Python/Robomp area.

Default focus: `packages/coding-agent/`. When a user says "agent" in this repo, they mean the coding-agent implementation (the CLI), not the assistant operating on the repo.

|Package|Purpose|
|---|---|
|`packages/coding-agent`|`omp` CLI: sessions, tools, terminal UI modes, MCP, extensions, prompts.|
|`packages/agent`|Provider-agnostic agent loop, state, tool-call execution.|
|`packages/ai`|LLM provider clients, streaming, auth retry, provider registry.|
|`packages/catalog`|Bundled and discovered model/provider metadata.|
|`packages/tui`|Differential terminal renderer and UI primitives.|
|`packages/natives` + `crates/pi-natives`|Bazel-built Rust N-API addon for shell, pty, grep/glob, summaries, text utilities.|
|`packages/utils`|Shared logging, prompt, env, fs/process, stream, path helpers.|
|`packages/stats`, `packages/collab-web`|Local stats dashboard and collaboration web UI.|
|`python/omp-rpc`, `python/robomp`|Typed Python RPC client and the Robomp service (src, web, tests).|
|`packages/omptype`|ArkType-compatible schema validation with a lazy JIT runtime.|

**Catalog import convention**: import catalog values from `@oh-my-pi/pi-catalog/<module>` (`identity`, `models`, `build`, `model-thinking`, `model-manager`, `model-cache`, `provider-models`, `variant-collapse`, `effort`, …) — never from `@oh-my-pi/pi-ai`. `@oh-my-pi/pi-ai` is the provider/AI runtime barrel: it value-exports `stream.ts` (`stream`/`complete`/`streamSimple`/`completeSimple`), auth-retry, auth-storage, registry, usage, and provider clients, plus the model/effort types (`Model`, `Api`, `ThinkingConfig`, `Effort`). Type-only imports of those types from pi-ai are fine.

## Architecture & Data Flow

Runtime flow (verified against source):

1. `packages/coding-agent/src/cli.ts` is the process entry (bin `omp`): Bun >=1.3.14 guard → hidden `__omp_worker_*` argv dispatch → `--smoke-test` probe → loads the subcommand table from `cli-commands.ts` and runs it via `@oh-my-pi/pi-utils/cli`.
2. The default `launch` subcommand (`commands/launch.ts`) calls `runRootCommand()` in `src/main.ts`: theme init, startup watchdog, auth storage, ModelRegistry, `Settings.init` (config.yml + overlays + CLI overrides), session resume/fork state, `SYSTEM.md`/`APPEND_SYSTEM.md` discovery, then mode selection (acp / rpc / core / interactive / print).
3. `src/sdk.ts#createAgentSession()` wires ModelRegistry, SessionManager, ToolSession, tools, MCPManager, extensions/skills, secrets, system prompt, and the core `Agent`.
4. Every mode calls `AgentSession.prompt()` (`session/agent-session.ts`), which expands extension → custom → slash commands, prompt templates, magic keywords, todo/plan preludes, then `#promptWithMessage` → `agent.prompt()` (or `continue` for retries).
5. `packages/agent/src/agent.ts` runs `agentLoop`/`agentLoopContinue` (`packages/agent/src/agent-loop.ts`): context normalization, native vs in-band tool calling, `EventStream` events, tool execution, and steering/follow-up handling (queued via `steer()`/`followUp()`).
6. Streaming goes through `streamSimple`/`stream` in `packages/ai/src/stream.ts` (dialect dispatch, credential retry, error mapping).
7. `AgentSession` subscribes to agent events, persists JSONL entries via SessionManager, emits display events (including streamed tool-arg previews), and schedules retry/compaction/continuation.
8. `InteractiveMode` maps events to component trees; `packages/tui` diffs immutable rows and commits scrollback. Print/RPC/ACP/core modes serialize events to their own protocols.

Key boundaries:

- `packages/agent` must stay provider- and app-agnostic; it depends on pi-ai, pi-catalog, pi-natives, pi-utils, pi-wire, snapcompact — never on coding-agent.
- Sessions are JSONL journals (`<timestamp>_<id>.jsonl`) with a header (id, title, cwd, parentSession, providerPromptCacheKey), fork/breadcrumbs, and a sibling artifacts directory.
- Workers re-enter `cli.ts` through hidden `__omp_worker_*` argv selectors: `tiny_inference`, `stats_sync`, `tab`, `js_eval`, `js_eval_process`, `stt`, `tts`, `mnemopi_embed`, `computer`, `terminal_output`, `daemon_broker`, `lsp_mux`. Spawn sites use the `workerHostEntry()` ternary (`@oh-my-pi/pi-utils`) with a direct-module fallback for non-CLI hosts (tests, SDK, standalone tools). New worker kinds MUST add a selector in `cli.ts` and keep the fallback; the `omp --smoke-test` probe validates them.

## Key Directories

|Path|Purpose|
|---|---|
|`packages/coding-agent/src/cli.ts`, `cli-commands.ts`, `main.ts`, `sdk.ts`|Process entry + worker host, subcommand registry, root orchestration, session factory.|
|`packages/coding-agent/src/session/`|`AgentSession`, `SessionManager`, JSONL storage, history, artifacts, compaction hooks.|
|`packages/coding-agent/src/tools/`|Built-in tool implementations, schemas, renderers; `render-utils.ts` (PREVIEW_LIMITS, TRUNCATE_LENGTHS, shortenPath).|
|`packages/coding-agent/src/edit/`, `lsp/`, `dap/`|Hashline/patch/replace/apply-patch engine + LSP writethrough; DAP support.|
|`packages/coding-agent/src/modes/`|Interactive TUI, print, RPC, ACP, core modes; controllers/ (event, input, tool-args-reveal), components/, theme/.|
|`packages/coding-agent/src/config/`|Settings (config.yml), model resolver/registry, keybindings, models config.|
|`packages/coding-agent/src/prompts/`|Static Markdown prompt assets (system/, tools/, skills/, steering/, security/, memories/, goals/).|
|`packages/coding-agent/src/mcp/`, `extensibility/`, `slash-commands/`|MCP runtime; plugins/extensions/hooks/custom tools/skills; builtin slash-command registry.|
|`packages/coding-agent/src/task/`, `launch/`, `internal-urls/`, `security/`, `secrets/`, `memories/`+`mnemopi/`, `hindsight/`, `advisor/`, `autolearn/`, `autoresearch/`, `capability/`, `discovery/`, `registry/`, `tiny/`, `tts/`, `stt/`, `collab/`, `export/`, `eval/`, `ssh/`, `web/`, `irc/`, `vibe/`, `worktree/`, `goals/`, `plan-mode/`, `async/`, `compress/`, `i18n/`|Subsystem implementations; see `packages/coding-agent/DEVELOPMENT.md` for the full src/ layout map.|
|`packages/agent/src/`|Core agent state machine, loop, tool execution, compaction utilities.|
|`packages/ai/src/`|Provider clients, stream dispatch, auth storage, error mapping, usage helpers.|
|`packages/catalog/src/`|Model catalog, provider descriptors/resolvers, identity, thinking policy.|
|`packages/tui/src/`|Terminal renderer, layout components, input/image/markdown utilities.|
|`packages/utils/src/`|logger, dirs, stream (readLines/readJsonl/readSse*), prompt (Handlebars), worker-host, cli, env.|
|`packages/natives/`, `crates/pi-natives/`|Native addon loader, Bazel build scripts, Rust N-API implementation.|
|`scripts/`|Repo-wide CI, release, install, benchmark, changelog, prompt, stats tooling.|
|`docs/`|Maintainer architecture/ops docs (`docs/tools`, `docs/toolconv`, `docs/skills`), indexed for `omp://`.|

## Development Commands

Use Bun from the repo root unless a command is explicitly package-scoped.

|Task|Command|
|---|---|
|Install dependencies|`bun install`|
|Full local setup|`bun run setup` (= install + `build:native` + `bun --cwd=packages/coding-agent link` + `sh scripts/link-omp.sh`)|
|Run source CLI|`bun run dev`|
|Run coding-agent CLI directly|`bun --cwd=packages/coding-agent src/cli.ts`|
|Build all workspaces|`bun run build`|
|Build native addon|`bun run build:native` (Bazel via `scripts/bazel-natives.ts`)|
|Root check (all)|`bun run check` (= `check:ts` + `check:rs`)|
|TypeScript check|`bun run check:ts` (= `check:tools` biome + per-workspace biome + `tsgo`)|
|Biome check only|`bun run check:tools`|
|Rust check only|`bun run check:rs` (cargo fmt --check + clippy -D warnings, via `scripts/run-rs-task.ts`)|
|Lint / Format / Autofix|`bun run lint` / `bun run fmt` / `bun run fix`|
|Coding-agent check|`bun --cwd=packages/coding-agent run check`|
|Coding-agent type check|`bun --cwd=packages/coding-agent run check:types`|
|Coding-agent heavy tests|`bun --cwd=packages/coding-agent run test`|
|Single test file|`bun --cwd=packages/coding-agent test test/<file>.test.ts`|
|Root local tests|`bun run test` (TS buckets + Rust nextest; Rust self-skips without Rust changes)|
|TS-only tests|`bun run test:ts`|
|Rust tests|`bun run test:rs` (cargo nextest)|
|Repo-script tests|`bun run test:scripts` (`scripts/*.test.ts`, release/CI scripts)|
|Python tests/lint|`bun run test:py` / `bun run lint:py`|
|CI TS buckets|`bun run ci:test:ts:workspace` / `ci:test:ts:native` / `ci:test:coding-agent:{singleton,ui,runtime,native,heavy}`|
|CLI smoke|`bun run ci:test:smoke` (`--version`, `--help`, `stats --help`, `--smoke-test`)|
|Install-method smoke|`bun run ci:test:install-methods` (`scripts/install-tests/run-ci.sh`)|
|Build collab web|`bun run collab:web:build` / `collab:web:dev`|
|Generate model catalog|`bun run gen:models`|
|Regenerate docs index|`bun run gen:bundle` (embeds `docs/**/*.md` payload; there is NO `gen:docs` script)|
|Other generated assets|`bun run gen:tool-views` (after `collab-web/src/tool-render/` changes), `gen:mupdf`, `gen:native`, `gen:stats`, `gen:nix`|
|Format prompt assets|`bun --cwd=packages/coding-agent run format-prompts`|
|Release|`bun run release <version\|major\|minor\|patch>` (version arg mandatory)|

Never run `tsc` or `npx tsc` — the TypeScript gate is `tsgo` through package scripts (`bun run check:types` etc.). Never commit unless explicitly asked.

## Code Conventions & Common Patterns

### TypeScript

- ESM, top-level imports only. No inline `await import()` or `import("pkg").Type` type references — except the sanctioned lazy-load pattern (`load: () => import()` in `cli-commands.ts`, worker dispatch, mode runners).
- No `any` unless there is no sound alternative; NEVER use `ReturnType<>` — use the actual type name.
- Class privacy via `#private` fields; no `private`/`protected`/`public` modifiers except constructor parameter properties for dependency injection.
- Use `Promise.withResolvers()` instead of `new Promise((resolve, reject) => ...)`.
- Star re-exports in barrel `index.ts` files: `export * from "./module"`.
- Node builtins use namespace imports: `import * as fs from "node:fs/promises"`.

### Bun-first runtime

|Operation|Use|Not|
|---|---|---|
|File read/write|`Bun.file()`, `Bun.write()`|`readFileSync`, `writeFileSync`|
|Spawn process|`` $`cmd` `` (Bun Shell), `Bun.spawn()` for long-running/streaming|`child_process`|
|Sleep|`Bun.sleep(ms)`|`setTimeout` promise|
|Binary lookup|`$which("git")` from `@oh-my-pi/pi-utils`|`spawnSync(["which", "git"])`|
|SQLite|`bun:sqlite`|`better-sqlite3`|
|JSON5 / JSONL|`Bun.JSON5`, `Bun.JSONL.parseChunk()`|manual parsing|
|String width / wrap|`Bun.stringWidth()`, `Bun.wrapAnsi()`|custom helpers|

Anti-patterns: `existsSync`/`readFileSync`/`writeFileSync` in async code; existence check + try-catch around the same read (use try-catch with `isEnoent` from `@oh-my-pi/pi-utils`); `mkdir(dirname(path))` before `Bun.write` (it auto-creates parents); `Buffer.from(await Bun.file(x).arrayBuffer())` (use `fs.readFile`).

Streams: helpers live in `@oh-my-pi/pi-utils` (`packages/utils/src/stream.ts`) — `readLines`, `readJsonl`, `readSseEvents`, `readSseJson`, `parseJsonlLenient`. (There is no `src/utils/stream.ts` in coding-agent and no `readStream` symbol; do not re-create one.)

### Central utilities

Before writing a helper, check `packages/coding-agent/src/utils/`, `@oh-my-pi/pi-utils`, `@oh-my-pi/pi-tui`, and domain modules next to the callsite. Two implementations of the same thing is a bug even when both work. Missing capability → extend the central helper, don't fork it.

- `src/utils/git.ts` and `src/utils/jj.ts` are the only sanctioned way to run git/jj — never hand-spawn via `$`/`Bun.spawn`.
- Rendering uses the TUI helpers below, not ad-hoc string math.

### Logging and terminal output

- Shared code MUST NOT use `console.log`/`warn`/`error` (corrupts TUI/RPC/worker output); use `logger` from `@oh-my-pi/pi-utils` (logs to `~/.omp/logs/omp.YYYY-MM-DD.log`, rotated).
- Standalone CLI commands that exit without entering the TUI MAY use `console.*` for intentional user-facing output. This exception is semantic, not filename-based.
- User-facing strings go through `t()` (`./i18n`), not hardcoded literals.

### TUI sanitization

All tool-renderer text must be sanitized — raw content (file contents, errors, diff lines) breaks terminal rendering. Apply to every render path, including error messages and streaming previews:

- Tabs → spaces via `replaceTabs()` (`@oh-my-pi/pi-tui`); truncate with `truncateToWidth()`; shorten paths with `shortenPath()`; preview limits from `PREVIEW_LIMITS` / `TRUNCATE_LENGTHS` (no ad-hoc numbers).

Streaming tool-call previews: partially streamed args are first-class input. Live rendering, transcript rebuilds, and merged call/result rendering MUST share the same decode path (`decodeStreamedToolArgs` / `ToolArgsRevealController` in `modes/controllers/tool-args-reveal.ts`, used by `event-controller.ts` and `modes/utils/ui-helpers.ts`). Preserve preview-only fields (e.g. bash's `__partialJson`) through all paths; verify both live and rebuilt transcript rendering after any change.

### Prompts and generated text

- Prompt prose lives in static `.md` assets, imported with `import content from "./prompt.md" with { type: "text" }`, rendered with Handlebars via `prompt.render` (`@oh-my-pi/pi-utils`). Never build prompts in code.
- `SYSTEM.md` / `APPEND_SYSTEM.md` (project `.omp/` first, then user dir) are user-side plain-text overrides; `TITLE_SYSTEM.md` for auto-titles.
- Skills live at `skills/<name>/SKILL.md`, one level deep; `RULES.md` is sticky always-apply guidance.
- Run `bun --cwd=packages/coding-agent run format-prompts` after prompt edits.

### Generated files

- NEVER edit `packages/catalog/src/models.json` directly — regenerate with `bun run gen:models`. Fix the source instead: `provider-models/descriptors.ts` (CATALOG_PROVIDERS), `provider-models/openai-compat.ts` (resolution/id overrides), `scripts/generate-models.ts` (generator fixups), `scripts/generated-policies.ts`, `model-thinking.ts`, `identity/classify.ts`. Test resolver/descriptor behavior, not the bundled JSON.
- Docs index (`dist/docs-index.generated.txt`, inlined via `PI_DOCS_EMBED`) is produced by `bun run gen:bundle` → `packages/coding-agent/scripts/bundle-dist.ts` / `generate-docs-index.ts`; runtime fallback chain: embed → dist file → repo `docs/`.
- `tool-views.generated.js` (React tool views + `<omp-tool-view>`) comes from `bun run gen:tool-views` after touching `collab-web/src/tool-render/`; also runs in coding-agent `prepack` and `fix`.
- mupdf/native/stats embeds use `gen:mupdf`, `gen:native`, `gen:stats` with matching `:reset` pairs. Do not edit generated forms; commit them alongside the source change.

## Important Files

|File|Why it matters|
|---|---|
|`package.json`|Workspaces + version catalog (`workspaces.catalog`), pinned Bun 1.3.14, all root scripts, patched deps (`@ark/schema`, `puppeteer-core`), lint-staged.|
|`bunfig.toml`|Install policy (3-day min release age, hoisted, exact, text lockfile), `.md`/`.py`/`.lark` text loaders, `bun test` path ignores.|
|`biome.json`|The only formatter/linter: tabs (indentWidth 3), LF, 120 columns, semicolons, double quotes, trailing commas; `noUnusedImports: error`.|
|`tsconfig.base.json`, `packages/tsconfig.workspace.json`, `tsconfig.tools.json`|Shared strict options (ES2024, Bundler resolution, noEmit, verbatimModuleSyntax, bun+assets types); workspace includes; tools composite.|
|`Cargo.toml`, `rust-toolchain.toml`, `rustfmt.toml`|Rust workspace (edition 2024), nightly-2026-07-28 pin, clippy lint policy, format rules (hard tabs, width 100, grouped imports).|
|`.github/workflows/ci.yml`, `.github/actions/*`|CI gates and reusable actions (bun-install, bazel-cache, bazel-natives, native-artifacts, setup-system-deps).|
|`scripts/ci-test-ts.ts`|TS test bucket/chunk runner (modes, env scrubbing, GC knobs, crash retries, watchdog).|
|`scripts/run-rs-task.ts`|Rust task dispatcher (fmt/clippy/nextest; self-skips without Rust changes; excludes vendored brush-core).|
|`scripts/release.ts`, `scripts/fix-changelogs.ts`|Release driver and changelog normalizer.|
|`scripts/bazel-natives.ts`|Native addon build orchestrator (host + cross targets).|
|`packages/coding-agent/src/cli.ts`|Process entry and worker host (12 `__omp_worker_*` selectors, `--smoke-test`).|
|`packages/coding-agent/src/main.ts`|Root command orchestration and mode selection.|
|`packages/coding-agent/src/sdk.ts`|`createAgentSession()` factory and dependency wiring.|
|`packages/coding-agent/src/session/agent-session.ts`|Prompt pipeline, event handling, persistence adapter.|
|`packages/coding-agent/src/utils/git.ts`|Central git wrapper (the only sanctioned git entry).|
|`packages/agent/src/agent-loop.ts`|Provider context assembly, streaming, tool-call loop.|
|`packages/ai/src/stream.ts`|Provider dispatch, streaming, credential retry.|
|`packages/coding-agent/DEVELOPMENT.md`|Maintainer map: boot flow, src/ layout, subsystem → docs/ pointers.|

## Runtime/Tooling Preferences

- JavaScript runtime: Bun 1.3.14 or newer, pinned at root (`packageManager: bun@1.3.14`, `engines.bun: ">=1.3.14"`). No npm/yarn/pnpm workflows for development (npm only in release publishing).
- TypeScript: `tsgo` through package scripts; direct `tsc`/`npx tsc` is banned.
- Formatting/lint: Biome only (`biome.json` above); `lint-staged` runs `biome check --write` on commit.
- Rust: `nightly-2026-07-28`, edition 2024, `rustfmt`/`clippy`/`cargo nextest` via `scripts/run-rs-task.ts`; vendored `crates/vendor/brush-core` excluded from lint/test gates.
- Natives: built with Bazel (`scripts/bazel-natives.ts`) into `packages/natives/native/*.node`, loaded via `@oh-my-pi/pi-natives` imports. Build before tests that import native-backed packages if artifacts are missing.
- Python packages require Python 3.11+; pytest/ruff where configured.
- Settings live globally in `~/.omp/agent/config.yml` and project-locally in `<cwd>/.omp/config.yml`.
- `.omp/AGENTS.md` is the preferred native context format; standalone `AGENTS.md` files are also discovered. Windows installs configure a Bash shell path when possible; OMP requires Bash on Windows.

## Testing & QA

Runner is Bun's built-in `bun:test` only (no Vitest/Jest). Tests are contract-level: assert observable behavior (emitted events, persisted JSONL/SQL rows, rendered output, request bodies, state transitions) — never implementation text, and never source-grep implementation files.

Key rules:

- **Never use `mock.module()`** (mutates the global module registry, leaks across files — oven-sh/bun#12823). Use `vi.spyOn()` on imported module objects/prototypes, or real in-process fakes (e.g. `test/fixtures/fake-lsp-server.ts` wired through `ptree.spawn`).
- Name the failure mode: every test must state what a consumer observes if it regresses. No placeholder/tautology tests (`expect(true).toBe(true)`, bare `not.toThrow()`, non-empty string checks).
- Isolation per test: `Settings.isolated(overrides)` (in-memory, detached from the global singleton), temp dirs (`mkdtemp` `omp-...`), in-memory SQLite (`AuthStorage.create(":memory:")`, `SessionManager.inMemory()`); restore in `afterEach` with `vi.restoreAllMocks()`, `resetSettingsForTest()`, env snapshot/restore, temp-dir removal. Helpers: `test/helpers/settings-test-state.ts`, `temp-home-cleanup.ts`.
- Real-provider suites gate with `describe.skipIf(!e2eApiKey("KEY"))` — `e2eApiKey` lives in `packages/ai/test/oauth.ts` and only resolves when `E2E=1` is set, so no accidental API calls. Platform/availability skips: `process.platform === "win32"`, `!$which("npm")`, etc.
- Fakes: `createMockModel` (`@oh-my-pi/pi-ai/providers/mock`) for deterministic scripted LLM responses; `createTestSession` (`packages/coding-agent/test/utilities.ts`) for real-LLM session tests.
- Async races: `Promise.withResolvers()` + event gates, bounded waits; long integration tests pass explicit timeouts (`it(name, fn, 120_000)`).
- Naming: `*.integration.test.ts` (real external seams), `repro-issue-NNNN-*.test.ts` (regressions), `.test.tsx` (DOM/React suites).

Running tests:

- Single file: `bun --cwd=packages/coding-agent test test/<file>.test.ts` (add `--timeout=30000` for heavy files; bun's default per-test timeout is 5s).
- Buckets: `bun scripts/ci-test-ts.ts <mode>` with modes `workspace | native | coding-agent-singleton | coding-agent-ui | coding-agent-runtime | coding-agent-native | coding-agent-heavy | all | local-ts | local` (shorthands `ci:test:ts:*`). `--dry-run` prints chunks; `--full` streams output (default quiet with failure replay); env overrides `OMP_TEST_CONCURRENCY`, `OMP_TEST_TIMEOUT`, `OMP_TEST_CHUNK_TIMEOUT`.
- Bucket semantics: `workspace` = fast packages (hashline, wire, omptype, utils, catalog, ai, snapcompact, agent, mnemopi); `native` = natives, tui, collab-web, typescript-edit-benchmark; coding-agent files are classified by path patterns + content markers into singleton (serial — process-wide state), ui (chunk of 5), runtime (10), native (10). Chunks run in fresh `bun test` children to cap RSS (bun 1.3.14 GC aborts) — that's why suites must not be rewritten into one giant invocation. CI runs chunks sequentially; locally they fan out.
- `scripts/ci-test-ts.ts` scrubs credential env vars (`*_API_KEY`, `*_OAUTH_TOKEN`, `AWS_*`, `GOOGLE_CLOUD_*`, `GITHUB_TOKEN`, …), clears `GITHUB_ACTIONS`, sets `PI_TEST_RUNTIME=1` and JSC GC knobs; bun-crash exits 132–139 (except 137 OOM) retry up to 3× in fresh processes; a 600s watchdog kills wedged chunks.
- `scripts/*.test.ts` (release/CI tooling) run via `bun run test:scripts`, not through ci-test-ts.ts.
- Smoke: `bun run ci:test:smoke` exercises the worker-host contract — `--smoke-test` spawns and pings all 12 worker entrypoints (stats sync, tiny, STT, TTS, JS eval, computer, mnemopi embed, daemon broker, LSP mux, terminal output) plus a live stats-dashboard HTTP fetch. `bun run ci:test:install-methods` (run-ci.sh) re-runs the same smoke across binary, source-link, and tarball installs.
- No coverage enforcement anywhere.
- CI gates (`.github/workflows/ci.yml`): `check` job (biome + tsgo + `collab:web:build`); `rust_validate` (Bazel clippy/rustfmt, non-PR only); `native_addons` (Bazel builds on main, release-addon smoke on PRs); eight test jobs (workspace, singleton, native, ui, runtime, native coding-agent, smoke, install-methods), each installing prebuilt native artifacts.

## Git, GitHub & Changelog

## GitHub

Unless user tells you exactly what to write:

- **Never comment on GitHub** (issues, PRs, discussions).
- **Never create issues on GitHub**.

## Code Quality

- No `any` unless absolutely necessary.
- **NEVER use `ReturnType<>`** — use the actual type name.
- **NEVER use inline imports** — no `await import()`, no `import("pkg").Type` in type positions, no dynamic type imports. Always top-level.
- Check `node_modules` for external API types instead of guessing.
- **Barrel exports**: prefer `export * from "./module"` over named re-exports, including `export type { ... } from`. In pure `index.ts` barrels, use star re-exports even for single-specifier cases. If stars create ambiguity, remove the redundant export path; do not keep duplicates.
- **Class privacy**: use ES `#private` fields; leave externally accessible members bare. **No `private`/`protected`/`public` keyword on fields or methods**, except on **constructor parameter properties** where TypeScript requires it (e.g. `constructor(private readonly session: ToolSession)`).
- **Promises**: use `Promise.withResolvers()` instead of `new Promise((resolve, reject) => ...)`.
- **Prompts**: never build prompts in code (no inline strings, template literals, or concatenation). Prompts live in static `.md` files; use Handlebars for dynamic content. Import them via `import content from "./prompt.md" with { type: "text" }` — not `readFile`.
- **Worker scripts**: workers re-enter the CLI entrypoint; never spawn separate worker entry modules. `cli.ts` declares itself as the worker host at startup (`declareWorkerHostEntry()` from `@oh-my-pi/pi-utils/env`) and dispatches hidden argv selectors (`__omp_worker_stats_sync`, `__omp_worker_tab`, `__omp_worker_js_eval`, `__omp_worker_tiny_inference`) before loading the command registry. Spawn sites use:
  ```ts
  import { workerHostEntry } from "@oh-my-pi/pi-utils";
  const hostEntry = workerHostEntry();
  const worker = hostEntry
  	? new Worker(hostEntry, { type: "module", argv: ["__omp_worker_<name>"] })
  	: new Worker(new URL("./<worker>.ts", import.meta.url).href, { type: "module" });
  ```
  When the process was started from the omp CLI — source `cli.ts`, npm-bundle `dist/cli.js`, or compiled binary — `workerHostEntry()` is `Bun.main` and the worker re-enters the single entry module, so no per-worker `--compile` entrypoints or bundle entries exist. Outside a CLI host (`bun test`, SDK embedding, standalone `omp-stats`) it returns `null` and the direct-module fallback loads the worker source. New worker kinds MUST add their selector to the dispatch table in `cli.ts` and keep the fallback branch.
  History: `with { type: "file" }` only copied the entry as a raw asset (workers crashed silently in compiled binaries — issues #1011, #1027), and the later literal-path + extra-entrypoint pattern required keeping spawn literals and two build scripts in sync (issue #1150). The smoke probe below is the live validation of this contract.
  Validate any new worker with the dedicated smoke probe: `omp --smoke-test` spawns the stats sync worker and the tiny-model subprocess, pings them, and exits — it's wired into `ci:test:smoke` and `scripts/install-tests/run-ci.sh` so binary, source-link, and tarball installs all exercise it. Add a sibling smoke if the new worker is on a different module graph.

## Central Utilities

Before writing a helper, check whether one already exists — `packages/coding-agent/src/utils/`, `@oh-my-pi/pi-utils`, `@oh-my-pi/pi-tui`, and the domain modules next to your callsite. This applies to **everything**: VCS wrappers, formatting/truncation/path-display helpers, image handling, clipboard, streams, temp files, caching. The central versions carry hardening a fresh copy always loses (timeouts, output caps, non-interactive env, lock avoidance, caching, TUI sanitization).

- Search first: `grep` for the operation before implementing it. Two implementations of the same thing is a bug even when both work.
- Examples of the pattern: `src/utils/git.ts` and `src/utils/jj.ts` are the only sanctioned way to run git/jj (`import * as git from "../utils/git"` — never hand-spawn via `$`/`Bun.spawn`); rendering goes through the helpers in TUI Sanitization below (`replaceTabs`, `truncateToWidth`, `shortenPath`, `PREVIEW_LIMITS`) rather than ad-hoc string math.
- Missing capability? Extend the central helper (new option, new sub-function on the namespace) and call it — don't fork its logic locally.

## Bun Over Node

Use Bun APIs where they provide a cleaner alternative; fall back to `node:*` only for what Bun doesn't cover. **Never spawn shell commands for operations with proper APIs** (e.g., don't `Bun.spawnSync(["mkdir", "-p", dir])` — use `mkdirSync`).

### Quick reference

| Operation       | Use                                       | Not                                |
| --------------- | ----------------------------------------- | ---------------------------------- |
| File read/write | `Bun.file()`, `Bun.write()`               | `readFileSync`, `writeFileSync`    |
| Spawn process   | `` $`cmd` ``, `Bun.spawn()`               | `child_process`                    |
| Sleep           | `Bun.sleep(ms)`                           | `setTimeout` promise               |
| Binary lookup   | `$which("git")` from `@oh-my-pi/pi-utils` | `spawnSync(["which", "git"])`      |
| HTTP server     | `Bun.serve()`                             | `http.createServer()`              |
| SQLite          | `bun:sqlite`                              | `better-sqlite3`                   |
| Hashing         | `Bun.hash()`, `Bun.password.*`, WebCrypto | `node:crypto`                      |
| Path resolution | `import.meta.dir`, `import.meta.path`     | `fileURLToPath` dance              |
| JSON5           | `Bun.JSON5.parse()` / `.stringify()`      | `json5` package                    |
| JSONL           | `Bun.JSONL.parse()` / `.parseChunk()`     | `text.split("\n").map(JSON.parse)` |
| String width    | `Bun.stringWidth()`                       | `get-east-asian-width`, custom     |
| Text wrapping   | `Bun.wrapAnsi()`                          | custom ANSI-aware wrappers         |

### Process execution

Prefer Bun Shell (`` $`cmd` ``) for simple commands:

```typescript
import { $ } from "bun";

const result = await $`git status`.cwd(dir).quiet().nothrow();
if (result.exitCode === 0) {
	const text = result.text();
}

$`do-stuff ${tmpFile}`.quiet().nothrow(); // fire and forget
```

Methods: `.quiet()`, `.nothrow()`, `.text()`, `.cwd(path)`.

Use `Bun.spawn`/`Bun.spawnSync` only for: long-running processes (LSP, kernels), streaming stdin/stdout/stderr (SSE, JSON-RPC), or process control (signals, kill, complex lifecycle).

When using `pipe` mode, cast the stream:

```typescript
const child = Bun.spawn(["cmd"], { stdout: "pipe", stderr: "pipe" });
const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
```

### Node module imports

Always use **namespace imports** for `node:fs`, `node:path`, `node:os`:

```typescript
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
```

- Async-only file → `node:fs/promises`.
- Needs both sync and async → `node:fs`, then `fs.promises.xxx` for async.

### File I/O

Prefer Bun:

```typescript
const text = await Bun.file(path).text();
const data = await Bun.file(path).json();
await Bun.write(path, data); // auto-creates parent dirs
```

Use `node:fs/promises` for directory ops (`fs.mkdir`, `fs.rm`, `fs.readdir`) — Bun has no native directory APIs. Avoid sync APIs in async flows; use sync only when forced by a synchronous interface.

**Anti-patterns:**

- `existsSync`/`readFileSync`/`writeFileSync` in async code → `Bun.file()` APIs.
- `mkdir(dirname(path), …)` before `Bun.write(path, …)` → redundant; `Bun.write` handles it.
- `if (await file.exists()) { await file.json() }` → two syscalls plus race. Use try-catch with `isEnoent`:
  ```typescript
  import { isEnoent } from "@oh-my-pi/pi-utils";
  try {
  	return await Bun.file(path).json();
  } catch (err) {
  	if (isEnoent(err)) return null;
  	throw err;
  }
  ```
- Multiple `Bun.file(path)` handles for the same path (including across `checkX`/`loadX` helpers).
- `Buffer.from(await Bun.file(x).arrayBuffer())` → `await fs.readFile(path)`.
- Existence check + try-catch around the same read → drop the existence check.

### Streams

Prefer centralized helpers:

```typescript
import { readStream, readLines } from "./utils/stream";
const text = await readStream(child.stdout);
for await (const line of readLines(stream)) {
	/* ... */
}
```

Manual reader loops only when the protocol requires it (SSE, streaming JSON-RPC).

### Misc

- **Sleep**: `await Bun.sleep(ms)`, never `new Promise(r => setTimeout(r, ms))`.
- **Password hashing**: `Bun.password.hash(pw, "bcrypt")` / `Bun.password.verify(pw, hash)`.
- **String width**: `Bun.stringWidth(text, { countAnsiEscapeCodes?: false })`.
- **Wrapping**: `Bun.wrapAnsi(text, width, { wordWrap, hard, trim })`.

## Generated Files

**NEVER edit `packages/catalog/src/models.json` directly.** It is generated from upstream sources (stencil.so, provider catalog discovery, OpenCode docs) by `packages/catalog/scripts/generate-models.ts` and the descriptors/resolvers in `packages/catalog/src/provider-models/`. Hand-edits get overwritten on the next regen.

To change an entry, fix the source:

- **Resolution rules / per-id overrides** → relevant resolver in `packages/catalog/src/provider-models/openai-compat.ts` (e.g. `createOpenCodeApiResolution`'s id-override map).
- **Provider catalog entries** (default model, discovery factory/flags) → the `CATALOG_PROVIDERS` table in `packages/catalog/src/provider-models/descriptors.ts`.
- **Generator-level fixups** (premium multipliers, codex pricing fallback, fallback models, post-processing) → `packages/catalog/scripts/generate-models.ts`.
- **Thinking metadata / generated policies** → `packages/catalog/src/model-thinking.ts` (`applyGeneratedModelPolicies`); model-id classification (family/version parsing) lives in `packages/catalog/src/identity/classify.ts`.

Regenerate with `bun run gen:models` and commit `models.json` alongside the source change. Add a regression test against the **resolver/descriptor**, not the bundled JSON, so it survives upstream metadata shifts.

## Logging and CLI Output

Code that may run while the TUI, RPC, SDK, workers, or background runtimes are active MUST NOT use `console.log`/`error`/`warn`; it corrupts rendering or protocols. Use the centralized logger:

```typescript
import { logger } from "@oh-my-pi/pi-utils";

logger.error("MCP request failed", { url, method });
logger.warn("Theme file invalid, using fallback", { path });
logger.debug("LSP fallback triggered", { reason });
```

Logs go to `~/.omp/logs/omp.YYYY-MM-DD.log` with automatic rotation. Standalone CLI commands that exit without entering the TUI MAY use `console.*` or process streams for intentional user-facing output. Keep structured stdout clean. This exception is semantic, not filename-based; shared code must use `logger` or an explicit output sink.

## TUI Sanitization

All text displayed in tool renderers must be sanitized. Raw content (file contents, error messages, tool output) breaks terminal rendering: tabs → visual holes, long lines → overflow, paths → leak home directory.

**Rules:**

- **Tabs → spaces** via `replaceTabs()` (from `@oh-my-pi/pi-tui` or `../tools/render-utils`).
- **Truncate** lines with `truncateToWidth()` / `ui.truncate()`. Use `TRUNCATE_LENGTHS` constants.
- **Shorten paths** with `shortenPath()` (replaces home with `~`).
- **Preview limits** from `PREVIEW_LIMITS`. No ad-hoc numbers.

**Apply to every render path**, not just the happy one:

- Success output (file previews, command output, search results).
- **Error messages** — these often embed file content (e.g., patch failure messages include unmatched lines). If a message contains file content, it needs `replaceTabs()`.
- Diff content (added and removed).
- Streaming previews.

### Streaming tool previews

Tool-call previews can have **multiple render paths**. If you add preview-only fields or depend on partially streamed args, update every path — not only the final renderer. Streamed argument buffers decode into display args via `decodeStreamedToolArgs` / `ToolArgsRevealController` (`modes/controllers/tool-args-reveal.ts`); both the live event path and transcript rebuilds must go through them — never spread provider-parsed `arguments` next to a raw `__partialJson` (parsed args lag the stream by a throttled parse window).

For the bash tool specifically:

- The pending preview may need raw `partialJson`, not just parsed `arguments`. Parsed args lag until a JSON object closes, which makes inline env assignments appear only at the end.
- Preserve preview-only fields (e.g. `__partialJson`) through `event-controller.ts`, transcript rebuilds in `ui-helpers.ts`, and merged call/result rendering in `tool-execution.ts`. Missing one path causes inconsistent previews.
- `ToolExecutionComponent.#buildRenderContext()` for bash must work even before a result exists — the renderer uses call args plus render context to show the command preview while streaming.
- Verify both live streaming and rebuilt transcript paths after any bash preview change. A fix in one path does not fix the other.

## Commands

- NEVER commit unless asked.
- Never use `tsc`/`npx tsc` — always `bun check`.
- Never run `cargo test` directly for Rust tests — use `bun run test:rs`. It runs `cargo nextest run` (config: `.config/nextest.toml`) followed by a `cargo test --doc` pass, because nextest does not execute doctests. The doctest pass currently executes nothing (pi-natives is a `cdylib`, which rustdoc skips; pi-builtins' examples are `ignore`d vendored uutils docs) and exists so the first runnable doctest added to a lib crate is actually run.
- Merge commits (maintainer merges of PRs) follow: `Merge PR #<number>: <conventional PR subject> (@<author>)` — e.g. `Merge PR #6386: feat(catalog): add native Meta Model API provider (@eggpeat)`.
## Rust Build Profiles

Profiles live in the root `Cargo.toml`; `.cargo/config.toml` carries the settings Cargo.toml cannot express. Both are committed, so no local `~/.cargo/config.toml` is required.

| Profile | Use |
| --- | --- |
| `dev` | Default. Line tables for our crates, no debuginfo for deps, deps at `opt-level = 2`. |
| `release` | Shipping build: fat LTO, 1 codegen unit, stripped. |
| `local` | Fast local release iteration: thin LTO, 16 codegen units, incremental. |
| `profiling` | `release` codegen with symbols kept, for `perf`/`samply`/Instruments. |
| `ci` | Thin LTO, no debuginfo, stripped. |

**Never set `split-debuginfo = "off"` on a profile that has debuginfo.** On Mach-O the linker never merges DWARF into the executable — it writes a debug map (`N_OSO`) pointing at the `.o` files, and `"unpacked"` is what keeps those files. With `"off"` every backtrace frame in our own crates silently loses `file:line`; the `panicked at foo.rs:3` header still prints (that is `#[track_caller]`, not debuginfo), which makes the loss easy to miss. `ci` may use `"off"` only because it sets `debug = false`.

`embed-metadata = false` (in `.cargo/config.toml`) keeps crate metadata in `.rmeta` instead of duplicating it into every rlib — measured 196 MB → 130 MB on a reqwest-sized graph at identical build times. Its accepted spelling is toolchain-coupled; keep it in sync with `rust-toolchain.toml`.

Rejected, with measurements, so nobody re-litigates them: **sccache** (cannot cache incremental, bin, or proc-macro crates — measured slower than not using it), **mold** (ELF-only; no Mach-O support), and **`panic = "abort"` on `dev`** (Cargo ignores `panic` for the test profile, so the whole dep graph builds twice — 131 MB → 214 MB).

## Testing Guidance

Test the contract the system exposes — not the easiest internal detail to assert.

- Every new test must defend one **concrete, externally observable contract**: behavior, output shape, state transition, error mapping, or a regression-prone parsing boundary. If you cannot name the contract, do not add the test.

### Good vs. bad test filter

- **Name the failure mode.** Every test MUST state what a consumer observes if it regresses. Cannot name one? NEVER add it.
- **Good: transformation.** One fixture MAY prove parse/render/normalize/encode/resolve behavior when output is computed, not echoed.
- **Good: branch or boundary.** Distinct inputs, empty values, malformed input, version/provider routing, and state transitions MUST prove distinct outcomes.
- **Good: external contract.** Exact bytes/shape MAY be asserted when a provider, parser, protocol, or persisted consumer reads them.
- **Good: precedence or negative contract.** Keep explicit `false`/override-wins assertions and required absence only when they prevent a documented leak, downgrade, 400, or incompatible wire field.
- **Good: regression.** A repro MUST trigger the prior real failure path and assert the corrected observable result.
- **Bad: static echo.** NEVER test a constructor/builder merely copied a fixture or baked constant into an in-memory config/metadata field.
- **Bad: success passthrough.** NEVER assert `fn(x) === x` when `x` was already supplied/declared valid; assert a transform, rejection, or downstream effect instead.
- **Bad: wording/defaults.** NEVER assert prompt/UI boilerplate, a default literal, object existence, non-empty output, or length growth without a consumer contract.
- **Bad: duplicate rows.** Parameterized/loop rows MUST each cover a distinct branch, provider/model path, or consumer contract; delete same-path duplicates.
- **Metadata exception.** Exact metadata, identity, ordering, or `undefined` MAY remain only when a downstream consumer depends on it and the test establishes branch, precedence, negative-contract, wire, or regression evidence.
- **Termination exception.** For cyclic/large inputs, assert a bounded output, surfaced error, or state change; bare `not.toThrow()` is insufficient.
- No placeholder tests, tautologies, or "the code ran" assertions (`expect(true).toBe(true)`, bare `not.toThrow()`, non-empty string checks, length-grew checks, "prompt exists" checks without semantic assertion).
- Prefer contract-level tests over implementation details. Avoid asserting internal helper wiring, field assignment, singleton identity, incidental ordering, prompt boilerplate, or passthrough option forwarding unless another component depends on that exact detail.
- Don't duplicate coverage across abstraction levels. If an integration test already proves the behavior, drop the narrower unit test that restates it through mocks.
- Tests **must be full-suite safe**, not just file-local safe. No long-lived file-wide mutations of `Bun.*`, `process.platform`, `process.env`, or `Bun.env` when a narrower seam exists. Prefer per-test `vi.spyOn(...)` with `vi.restoreAllMocks()` in `afterEach`. A test that passes alone but poisons later files is broken.
- **Never use `mock.module()`**. Bun's `mock.module()` mutates the global module registry and leaks across files ([oven-sh/bun#12823](https://github.com/oven-sh/bun/issues/12823)). Use `spyOn` on the imported module object instead. For pass deps, import the pass and spy on `.run`. For package deps, namespace-import and spy on the exported function.
- For lifecycle/stateful code, prefer one test per invariant or transition over several tiny tests asserting one field each from the same transition.
- For error handling, trigger the real failure path and assert the surfaced contract — don't instantiate error classes directly or inspect internal metadata.
- Smoke tests are acceptable only when they catch a failure mode narrower tests would miss. "Package boots" or "command starts" alone is not enough.
- Assert exact strings, ordering, and formatting only when downstream code parses or depends on the exact bytes. Otherwise assert semantic content.
- Compile-time guarantees → type checks/type tests, not runtime placeholders.
- **Never source-grep.** A test that reads an implementation file (`.ts`/`.rs`/build script) and asserts on its _text_ — `expect(src).toContain("someCall()")`, `.toMatch(/import .../)`, `.not.toContain("oldName")`, or "comment must say X" — is banned. It tests how code _looks_, not what it _does_: it breaks on harmless refactors (comment reflow, rename, import reorder) and passes while the behavior is broken. Assert the observable contract instead (run the code, check output/state/error), use the runtime smoke probe for wiring you cannot exercise in-process, and enforce structural invariants (no value-import of X, no self-import) with a type test or a lint/biome rule — never a string scan of the source. (Reading a file your code _wrote_ — apply-patch result, generated bundle, temp fixture — and asserting on that output is fine; that is behavior, not a source grep.)
- Don't add tests for tiny low-risk changes unless they protect a real contract or fix a regression-prone edge case.
- Prefer focused package-local verification for the changed area.

## Changelog

Location: `packages/*/CHANGELOG.md` (per package).

**Format** — sections under `## [Unreleased]`:

- `### Breaking Changes` (first if present)
- `### Added`
- `### Changed`
- `### Fixed`
- `### Removed`

**Rules:**

- New entries always go under `## [Unreleased]`.
- Entries are one line, brief, and user-facing: lead with what the user will see or can now do. Root-cause narration and implementation detail belong in the commit/PR, not the changelog.
- Never modify already-released sections (e.g., `## [0.12.2]`) — they are immutable.
- Don't flag changelog section order or formatting in reviews or PRs — `bun run release` runs `fix-changelogs` which normalizes everything automatically.

**Attribution:**

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/can1357/oh-my-pi/issues/123))`.
- External contributions: `Added feature X ([#456](https://github.com/can1357/oh-my-pi/pull/456) by [@username](https://github.com/username))`.

## Releasing

`bun run release <version|major|minor|patch>` (arg is mandatory; prereleases are rejected — CI publishes without a dist-tag). Preflight: on `main`, clean working tree, version > latest `v*` tag. The script bumps versions (public package.json + root catalog entries + Cargo.toml + `__piNativesV` sentinel), regenerates lockfiles (bun, cargo, nix), finalizes changelogs, runs `bun run check`, commits `chore: bump version to <version>` (the subject form is load-bearing for CI release detection), tags `v<version>`, pushes atomically, and watches CI via `gh`. It does NOT publish: npm packages, native leaf packages, GitHub Release, and the Homebrew tap are published by CI jobs gated on `release_gate` after all validation passes.
