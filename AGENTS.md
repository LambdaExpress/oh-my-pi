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

- Never commit unless explicitly asked. Never comment on or create GitHub issues/PRs unless the user tells you exactly to do so.
- Merge commits (maintainer merges) follow: `Merge PR #<number>: <conventional PR subject> (@<author>)`.
- Changelog entries go under each affected package's `CHANGELOG.md` `## [Unreleased]` section — `### Breaking Changes` (first if present), `### Added`, `### Changed`, `### Fixed`, `### Removed`. Never modify released sections.
- Attribution: internal (from issues) `Fixed foo bar ([#123](https://github.com/can1357/oh-my-pi/issues/123))`; external PRs `Added feature X ([#456](https://github.com/can1357/oh-my-pi/pull/456) by [@username](https://github.com/username))`.
- `bun run fix:changelogs` normalizes the changelogs (promotes/dedupes items, removes empty sections) — release runs it automatically.

## Releasing

`bun run release <version|major|minor|patch>` (arg is mandatory; prereleases are rejected — CI publishes without a dist-tag). Preflight: on `main`, clean working tree, version > latest `v*` tag. The script bumps versions (public package.json + root catalog entries + Cargo.toml + `__piNativesV` sentinel), regenerates lockfiles (bun, cargo, nix), finalizes changelogs, runs `bun run check`, commits `chore: bump version to <version>` (the subject form is load-bearing for CI release detection), tags `v<version>`, pushes atomically, and watches CI via `gh`. It does NOT publish: npm packages, native leaf packages, GitHub Release, and the Homebrew tap are published by CI jobs gated on `release_gate` after all validation passes.
