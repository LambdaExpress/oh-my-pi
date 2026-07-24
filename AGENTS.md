# Repository Guidelines

## Project Overview

Oh My Pi is a Bun-first monorepo for the `omp` coding-agent CLI. It combines TypeScript packages, Rust/N-API native helpers, and a smaller Python/Robomp area.

Default focus: `packages/coding-agent/`. When a user says "agent" in this repo, they usually mean the coding-agent implementation, not the assistant operating on the repo.

Main package roles:

| Package | Purpose |
| --- | --- |
| `packages/coding-agent` | `omp` CLI, sessions, tools, terminal UI modes, MCP, extensions, prompts. |
| `packages/agent` | Provider-agnostic agent loop, state, tool-call execution. |
| `packages/ai` | LLM provider clients, streaming, auth retry, provider registry. |
| `packages/catalog` | Bundled and discovered model/provider metadata. |
| `packages/tui` | Differential terminal renderer and UI primitives. |
| `packages/natives` + `crates/pi-natives` | Rust-backed native addon for shell, pty, grep/glob, summaries, text utilities. |
| `packages/utils` | Shared logging, prompt, env, fs/process, stream, path helpers. |
| `packages/stats`, `packages/collab-web` | Local stats dashboard and collaboration web UI. |
| `python/omp-rpc`, `python/robomp` | Python RPC and Robomp components. |

## Architecture & Data Flow

High-level runtime flow:

1. `packages/coding-agent/src/cli.ts` starts the process, checks Bun version, dispatches hidden worker selectors, handles `--smoke-test`, then loads CLI commands.
2. `packages/coding-agent/src/main.ts` resolves arguments, settings, cwd, session resume/fork state, model registry, auth storage, telemetry, and mode selection.
3. `packages/coding-agent/src/sdk.ts#createAgentSession()` builds `ModelRegistry`, `SessionManager`, `ToolSession`, tools, MCP/custom/extension tools, system prompt, and the core `Agent`.
4. UI, print, RPC, or ACP modes submit user input to `AgentSession.prompt()`.
5. `AgentSession` expands slash commands, prompt templates, file mentions, context, todo/plan/goal messages, compaction, auto-thinking, and provider auth checks.
6. `packages/agent/src/agent-loop.ts` converts session messages to provider context, chooses native or in-band tool calling, calls `packages/ai/src/stream.ts`, streams assistant events, executes tools, and handles steering/follow-ups.
7. `AgentSession` emits display events, persists JSONL entries through `SessionManager`, and schedules retry/compaction/continuation work.
8. `InteractiveMode` maps session events to component trees; `packages/tui` diffs immutable rows and commits terminal scrollback.

Key data boundaries:

- `packages/coding-agent` owns application behavior, settings, sessions, tools, prompts, and UI modes.
- `packages/agent` must stay provider- and app-agnostic; it depends on `pi-ai`, `pi-catalog`, and `pi-utils`, not `coding-agent`.
- `packages/ai` handles provider routing, stream normalization, credential retry, and provider-specific transports.
- `packages/catalog` is the source of model identity/classification, provider descriptors, bundled models, and discovery metadata.
- Native helpers flow from Rust crates to `packages/natives/native/*.node`, then through `@oh-my-pi/pi-natives` imports.
- Sessions are JSONL journals with branch/tree metadata; `Agent` in-memory state and persisted session state are synchronized by `AgentSession`.

## Central Utilities

Before writing a helper, check whether one already exists — `packages/coding-agent/src/utils/`, `@oh-my-pi/pi-utils`, `@oh-my-pi/pi-tui`, and the domain modules next to your callsite. This applies to **everything**: VCS wrappers, formatting/truncation/path-display helpers, image handling, clipboard, streams, temp files, caching. The central versions carry hardening a fresh copy always loses (timeouts, output caps, non-interactive env, lock avoidance, caching, TUI sanitization).

- Search first: `grep` for the operation before implementing it. Two implementations of the same thing is a bug even when both work.
- Examples of the pattern: `src/utils/git.ts` and `src/utils/jj.ts` are the only sanctioned way to run git/jj (`import * as git from "../utils/git"` — never hand-spawn via `$`/`Bun.spawn`); rendering goes through the helpers in TUI Sanitization below (`replaceTabs`, `truncateToWidth`, `shortenPath`, `PREVIEW_LIMITS`) rather than ad-hoc string math.
- Missing capability? Extend the central helper (new option, new sub-function on the namespace) and call it — don't fork its logic locally.

## Key Directories

| Path | Purpose |
| --- | --- |
| `packages/coding-agent/src/cli.ts`, `main.ts`, `sdk.ts` | CLI boot, root launch orchestration, session factory. |
| `packages/coding-agent/src/session/` | `AgentSession`, `SessionManager`, JSONL storage, history, artifacts, compaction hooks. |
| `packages/coding-agent/src/tools/` | Built-in tool implementations, schemas, renderers, approval/metadata helpers. |
| `packages/coding-agent/src/edit/` | Hashline/patch/replace/apply-patch edit engine and LSP writethrough. |
| `packages/coding-agent/src/modes/` | Interactive TUI, print mode, RPC mode, ACP mode, controllers/components. |
| `packages/coding-agent/src/config/` | Settings, model resolver/registry, prompt templates, provider discovery. |
| `packages/coding-agent/src/prompts/` | Static Markdown prompt assets for system, tools, subagents, skills, goals, advisor. |
| `packages/coding-agent/src/mcp/`, `extensibility/`, `slash-commands/` | MCP runtime, plugins/extensions/hooks/custom tools, slash commands, skills. |
| `packages/agent/src/` | Core agent state machine, loop, tool execution, compaction utilities. |
| `packages/ai/src/` | Provider clients, stream dispatch, auth storage, error mapping, usage helpers. |
| `packages/catalog/src/` | Model catalog, provider descriptors/resolvers, identity, thinking policy. |
| `packages/tui/src/` | Terminal renderer, layout components, input/image/markdown utilities. |
| `packages/natives/`, `crates/pi-natives/` | Native loader, build scripts, Rust N-API implementation. |
| `scripts/` | Repo-wide CI, release, install, benchmark, changelog, prompt, stats tooling. |
| `scripts/install-tests/` | Binary/source/tarball install smoke tests and container fixtures. |
| `.github/workflows/ci.yml`, `.github/actions/` | CI jobs and reusable setup/native build actions. |
| `docs/` | Maintainer architecture and operational docs indexed for `omp://`. |

## Development Commands

Use Bun from the repo root unless a command is explicitly package-scoped.

| Task | Command |
| --- | --- |
| Install dependencies | `bun install` |
| Full local setup | `bun run setup` |
| Run source CLI | `bun run dev` |
| Run coding-agent CLI directly | `bun --cwd=packages/coding-agent src/cli.ts` |
| Build all workspaces | `bun run build` |
| Build native addon | `bun run build:native` |
| Root check | `bun run check` |
| TypeScript check only | `bun run check:ts` |
| Tooling/Biome check only | `bun run check:tools` |
| Rust check only | `bun run check:rs` |
| Root lint | `bun run lint` |
| Format | `bun run fmt` |
| Autofix | `bun run fix` |
| Coding-agent check | `bun --cwd=packages/coding-agent run check` |
| Coding-agent type check | `bun --cwd=packages/coding-agent run check:types` |
| Coding-agent heavy tests | `bun --cwd=packages/coding-agent run test` |
| Root local tests | `bun run test` |
| TypeScript local tests | `bun run test:ts` |
| Rust tests | `bun run test:rs` |
| Repo script tests | `bun run test:scripts` |
| CLI smoke | `bun run ci:test:smoke` |
| Install-method smoke | `bun run ci:test:install-methods` |
| Build collab web | `bun run collab:web:build` |
| Generate model catalog | `bun run gen:models` |
| Generate/reset docs index | `bun run gen:docs` / `bun run gen:docs:reset` |
| Format prompt assets | `bun --cwd=packages/coding-agent run format-prompts` |
| Release | `bun scripts/release.ts <version|major|minor|patch>` |

Never run `tsc` or `npx tsc` for this repo. The TypeScript gate is `tsgo` through package scripts such as `bun run check:types`.

Prefer targeted verification. For a single coding-agent test file, use:

```sh
bun --cwd=packages/coding-agent test test/<file>.test.ts
```

For CI-like TypeScript buckets, use:

```sh
bun scripts/ci-test-ts.ts workspace
bun scripts/ci-test-ts.ts coding-agent-runtime
bun scripts/ci-test-ts.ts coding-agent-ui
bun scripts/ci-test-ts.ts coding-agent-native
bun scripts/ci-test-ts.ts coding-agent-heavy
```

## Code Conventions & Common Patterns

### TypeScript and imports

- Use ESM and top-level imports.
- Do not add inline imports, `await import()`, or `import("pkg").Type` type references.
- Use actual type names; do not use `ReturnType<>`.
- Avoid `any` unless there is no sound alternative.
- Use `#private` fields for class privacy. Do not add `private`, `protected`, or `public` modifiers except constructor parameter properties.
- Use `Promise.withResolvers()` instead of `new Promise((resolve, reject) => ...)`.
- Use star re-exports in barrel `index.ts` files: `export * from "./module"`.
- Import catalog values from `@oh-my-pi/pi-catalog/<module>`, not from `@oh-my-pi/pi-ai`. Type-only imports for `Model`, `Api`, `ThinkingConfig`, `Effort`, and related AI signature types may come from `@oh-my-pi/pi-ai`.
- Node builtins, when needed, use namespace imports such as `import * as fs from "node:fs/promises"`.

### Bun-first runtime

- Prefer Bun APIs: `Bun.file()`, `Bun.write()`, `Bun.spawn()`, Bun Shell, `Bun.sleep()`, `Bun.JSON5`, `Bun.JSONL`, `Bun.stringWidth()`, `Bun.wrapAnsi()`.
- Use `node:fs/promises` for directory operations that Bun does not cover.
- Do not shell out for file operations that have proper APIs.
- Use Bun Shell for simple process calls; use `Bun.spawn()` for long-running, streaming, or lifecycle-sensitive processes.
- Do not add npm/yarn/pnpm workflows for development. npm appears in release publishing only.

### Logging and terminal rendering

- In `packages/coding-agent`, do not use `console.log`, `console.warn`, or `console.error`; use `logger` from `@oh-my-pi/pi-utils`.
- TUI-facing text must be sanitized: replace tabs, truncate long lines, shorten home paths, and use existing `TRUNCATE_LENGTHS` / `PREVIEW_LIMITS` constants.
- Update every live and rebuilt transcript render path when changing streamed tool-call previews.
- For streamed tool-call previews, treat partially streamed arguments as first-class input: parsed args can lag raw provider chunks, so live rendering, transcript rebuilds, and merged call/result rendering must share the same decode path.
- Preserve preview-only fields through event controllers, transcript rebuilds, and final render contexts; when preview formatting changes, verify both pending and completed tool-call states.
- Preserve append-only scrollback invariants in `packages/tui`; components should return immutable row arrays and rely on reference equality for unchanged content.

### Prompts and generated text

- Prompt prose lives in static `.md` assets, not inline TypeScript strings.
- Import prompts with `import content from "./prompt.md" with { type: "text" }` and render dynamic fields with Handlebars via `prompt.render`.
- Run `bun --cwd=packages/coding-agent run format-prompts` after prompt edits.
- `SYSTEM.md` replaces the stable default system block; `APPEND_SYSTEM.md` appends to it. These files are plain text, not Handlebars templates.
- Skills live at `skills/<name>/SKILL.md`, one level deep. Use skills for optional capability packs; use `AGENTS.md` or `.omp/AGENTS.md` for persistent repo guidance.

### Generated files

- Do not edit `packages/catalog/src/models.json` directly. Fix descriptors/resolvers/generator policies, then run `bun run gen:models`.
- Catalog fixes usually belong in:
  - `packages/catalog/src/provider-models/descriptors.ts`
  - `packages/catalog/src/provider-models/openai-compat.ts`
  - `packages/catalog/scripts/generate-models.ts`
  - `packages/catalog/src/model-thinking.ts`
  - `packages/catalog/src/identity/classify.ts`
- Test catalog resolver/descriptor behavior, not the bundled JSON snapshot.
- Respect generate/reset scripts for docs, stats, Mupdf, native embeds, collab tool views, and legacy bundled registry. Do not commit generated forms whose scripts mark them as placeholders or transient build output.

### Workers and subprocesses

- Workers re-enter `packages/coding-agent/src/cli.ts` through hidden `__omp_worker_*` argv selectors.
- New worker kinds must add a selector in `cli.ts`, keep the direct-module fallback for non-CLI hosts such as tests, SDK embedding, and standalone tools, and be validated by `omp --smoke-test` or a sibling smoke probe that exercises the affected module graph.
- Do not add separate worker bundle entrypoints for compiled binaries.

### Git, GitHub, changelog

- Do not commit unless explicitly asked.
- Do not create GitHub issues or comments unless the user tells you exactly to do so.
- Changelog entries go under each affected package’s `CHANGELOG.md` `## [Unreleased]` section.
- Do not modify released changelog sections.

## Important Files

| File | Why it matters |
| --- | --- |
| `AGENTS.md` | Repo-wide assistant rules. This file is the default operating guide. |
| `package.json` | Workspaces, pinned Bun version, root scripts, release/generator entrypoints. |
| `bun.lock` | Locked dependency graph; CI uses `bun install --frozen-lockfile`. |
| `bunfig.toml` | Bun test ignore patterns and text loaders for `.md`, `.py`, `.lark`. |
| `biome.json` | Formatting/lint rules: tabs, LF, 120 columns, semicolons, double quotes, trailing commas. |
| `tsconfig.base.json`, `tsconfig.json`, `packages/tsconfig.workspace.json` | TS compiler settings and project references. |
| `Cargo.toml`, `rust-toolchain.toml`, `rustfmt.toml` | Rust workspace, nightly toolchain, clippy/rustfmt conventions. |
| `.github/workflows/ci.yml` | CI gates for checks, native builds, TS buckets, smoke, install tests, release. |
| `.github/actions/bun-install/action.yml` | Bun 1.3.14 install/cache behavior in CI. |
| `.github/actions/build-native/action.yml` | Native build, clippy/rustfmt, nextest, cross-compile setup. |
| `scripts/ci-test-ts.ts` | Main TypeScript test bucket/chunk runner. |
| `scripts/run-rs-task.ts` | Rust check/lint/fmt/test dispatcher. |
| `scripts/install-tests/run-ci.sh` | Binary/source/tarball install smoke suite. |
| `scripts/release.ts` | Version bump, changelog, lockfile, check, tag, push, CI watch release driver. |
| `packages/coding-agent/DEVELOPMENT.md` | Maintainer map for coding-agent source layout and docs references. |
| `packages/coding-agent/package.json` | Primary CLI package scripts, bin, exports, generated asset flows. |
| `packages/coding-agent/src/cli.ts` | Process entry and worker host. |
| `packages/coding-agent/src/main.ts` | Root command orchestration and mode selection. |
| `packages/coding-agent/src/sdk.ts` | `createAgentSession()` factory and dependency wiring. |
| `packages/coding-agent/src/session/agent-session.ts` | Prompt pipeline, event handling, persistence adapter. |
| `packages/coding-agent/src/tools/index.ts` | Built-in tool registry and gating. |
| `packages/agent/src/agent-loop.ts` | Provider context assembly, streaming, tool-call loop. |
| `packages/ai/src/stream.ts` | Provider dispatch, streaming, credential retry. |
| `packages/catalog/scripts/generate-models.ts` | Model catalog generation source of truth. |

## Runtime/Tooling Preferences

- Required JavaScript runtime/package manager: Bun 1.3.14 or newer, pinned at root as `packageManager: bun@1.3.14`.
- TypeScript packages use `tsgo` through scripts; do not bypass with direct compiler invocations.
- TypeScript tests use Bun’s built-in runner (`bun:test`), not Vitest or Jest.
- Rust uses `nightly-2026-04-29` with `rustfmt`, `clippy`, and `cargo nextest`.
- Python packages require Python 3.11+ and use pytest/ruff where configured.
- Settings live globally in `~/.omp/agent/config.yml` and project-locally in `<cwd>/.omp/config.yml`.
- `.omp/AGENTS.md` is the preferred native context format; nearest non-empty ancestor wins for native provider context. Standalone `AGENTS.md` files are also discovered by `agents-md`.
- `RULES.md` is sticky always-apply guidance; reserve it for short hard requirements.
- Windows installs configure a Bash shell path when possible; OMP requires Bash on Windows.

## Testing & QA

Test observable contracts, not implementation text.

Preferred test practices:

- Use `bun:test` imports: `describe`, `it`/`test`, `expect`, `beforeEach`, `afterEach`, `vi`, `mock`.
- Prefer `vi.spyOn()` and dependency injection. Do not use `mock.module()`.
- Do not add placeholder, tautological, or source-grep tests. Tests must assert observable behavior, emitted events, persisted files, rendered output, request bodies, public state transitions, or typed/linted structural constraints.
- Keep tests full-suite safe: avoid long-lived mutations of `Bun.*`, `process.platform`, `process.env`, `Bun.env`, module registries, timers, settings, and other globals unless each test restores them explicitly.
- Use `Settings.isolated(...)`, temp dirs, fake models/transports, and explicit cleanup for session/tool tests.
- Restore timers, mocks, env, settings, and global state in `afterEach`.
- Gate real-provider tests with env checks such as `describe.skipIf(!e2eApiKey("ANTHROPIC_API_KEY"))`.
- Use `Promise.withResolvers()`, event gates, and bounded waits for async races; avoid fixed sleeps unless a nearby test uses that race pattern intentionally.
- UI tests usually initialize theme, render at fixed widths, strip ANSI with `Bun.stripANSI`, and assert visible output or fast-path equivalence.
- Do not source-grep implementation files in tests. Assert behavior, emitted events, persisted JSONL/files, rendered output, request bodies, or public state transitions.

CI-quality gates:

- `.github/workflows/ci.yml` runs `bun run ci:check:full`, `bun run collab:web:build`, native Linux builds/checks, TypeScript test buckets, CLI smoke, and install-method smoke.
- Release runs additionally build cross-platform native artifacts, binaries, GitHub Release, npm packages, and Homebrew updates.
- `scripts/ci-test-ts.ts` chunks memory-heavy coding-agent tests, scrubs credential/cloud env vars, clears `GITHUB_ACTIONS`, and sets Bun/JSC stability knobs.
- Locally, build natives with `bun run build:native` before tests that import native-backed packages if artifacts are missing.
- For worker/binary packaging changes, run `bun run ci:test:smoke` at minimum; install or packaging changes may require `bun run ci:test:install-methods`.
