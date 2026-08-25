# Repository Guidelines

## Project Overview

Oh My Pi is a Bun-first monorepo for the `omp` coding-agent CLI. It combines a TypeScript command-line application and agent runtime, a provider/model layer, a differential terminal UI, Rust N-API native helpers, and smaller Python services.

Default to `packages/coding-agent/` when a request says “agent.” Keep lower-level packages reusable: CLI, session persistence, extensions, and UI policy belong in `coding-agent`, not in the provider-agnostic runtime or shared utilities.

## Architecture & Data Flow

1. `packages/coding-agent/src/cli.ts` is the `omp` process entry. It handles hidden worker dispatch, then loads `cli-commands.ts`; unknown non-subcommand arguments route to `commands/launch.ts`.
2. `packages/coding-agent/src/main.ts#runRootCommand()` initializes configuration, authentication, model discovery, session resume/fork state, project prompt files, and the selected output mode.
3. `packages/coding-agent/src/sdk.ts#createAgentSession()` is the composition root. It injects settings, `ModelRegistry`, `AuthStorage`, `SessionManager`, tools, extensions, prompts, and event infrastructure into `AgentSession`.
4. `AgentSession.prompt()` expands extension/custom/slash commands and prompt templates, then calls the core `Agent` in `packages/agent`.
5. `packages/agent/src/agent-loop.ts` builds provider context, streams model output, validates tool calls, runs approved tools, and emits lifecycle events. Provider traffic must pass through `packages/ai/src/stream.ts`.
6. `AgentSession` converts core events into append-only session JSONL and display events. Completed `message_end` records are persisted; streamed `message_update` fragments are display-only.
7. Interactive, print/JSON, RPC, ACP, and core modes consume the same session events. Interactive mode maps them into immutable TUI component rows and commits terminal diffs.

Dependency direction is deliberate:

- `packages/coding-agent` may depend on `agent`, `ai`, `catalog`, `tui`, `utils`, and `natives`.
- `packages/agent` stays provider- and application-agnostic; it must not import `coding-agent`.
- `packages/ai` owns provider clients, auth retry, usage, and stream dispatch; model catalog metadata and discovery policy live in `packages/catalog`.
- `packages/tui` owns terminal rendering primitives. Shared utilities and native bindings must not acquire CLI/session/UI policy.
- TypeScript reaches Rust through `packages/natives`; Python eval uses the NDJSON protocol implemented by `packages/coding-agent/src/eval/py/kernel.ts` and its bundled runner.

## Key Directories

| Path | Purpose |
|---|---|
| `packages/coding-agent/src/` | CLI boot, session orchestration, tools, modes, configuration, prompts, workers, and extensibility. |
| `packages/coding-agent/src/session/` | `AgentSession`, append-only session journals, history trees, artifacts, and compaction integration. |
| `packages/coding-agent/src/modes/` | Interactive TUI plus print, JSON, RPC, ACP, and core protocol adapters. |
| `packages/coding-agent/src/tools/` | Built-in tool registry, schemas, execution wrappers, and terminal renderers. |
| `packages/agent/src/` | Provider-neutral agent state machine, event stream, tool loop, and context normalization. |
| `packages/ai/src/` | Provider clients, streaming dispatch, authentication retry/storage, and error mapping. |
| `packages/catalog/src/` | Model descriptors, discovery/resolution policy, identity classification, and generated catalog data. |
| `packages/tui/src/` | Differential renderer, components, terminal capabilities, text width, and sanitization helpers. |
| `packages/utils/src/` | Shared logging, CLI, environment, stream, filesystem, worker-host, and prompt utilities. |
| `packages/natives/`, `crates/` | TypeScript native loader and Rust N-API/workspace implementations. |
| `python/` | Python RPC client and Robomp service/web application. |
| `scripts/`, `docs/` | CI/release/generation tooling and the maintainer documentation corpus indexed by `omp://`. |

For a detailed subsystem map, start with `packages/coding-agent/DEVELOPMENT.md`; do not infer ownership from directory names alone.

## Development Commands

Run commands from the repository root unless `--cwd` is shown.

| Task | Command |
|---|---|
| Install pinned dependencies | `bun install` |
| Full local setup | `bun run setup` |
| Run the source CLI | `bun run dev` |
| Run the coding-agent entry directly | `bun --cwd=packages/coding-agent src/cli.ts` |
| Build all workspaces | `bun run build` |
| Build the host native addon | `bun run build:native` |
| Run all static checks | `bun run check` |
| Run TypeScript checks | `bun run check:ts` |
| Lint / format / autofix | `bun run lint` / `bun run fmt` / `bun run fix` |
| Check coding-agent only | `bun --cwd=packages/coding-agent run check` |
| Run one coding-agent test | `bun --cwd=packages/coding-agent test test/<file>.test.ts` |
| Run TypeScript / Rust / Python tests | `bun run test:ts` / `bun run test:rs` / `bun run test:py` |
| Run repository-script tests | `bun run test:scripts` |
| Exercise CLI workers and dashboard | `bun run ci:test:smoke` |
| Exercise binary/source/tarball installs | `bun run ci:test:install-methods` |
| Regenerate model catalog | `bun run gen:models` |
| Bundle the CLI and docs index | `bun run gen:bundle` |
| Regenerate collaboration tool views | `bun run gen:tool-views` |
| Format prompt assets | `bun --cwd=packages/coding-agent run format-prompts` |

`bun run setup` performs install, native build, package link, and CLI link. Native host builds use the local Cargo/N-API path by default; explicit cross-platform targets use Bazel. Do not invent direct compiler commands when a repository script owns the workflow.

## Code Conventions & Common Patterns

### TypeScript and naming

- ESM only. Use top-level imports; dynamic imports are reserved for sanctioned lazy command/worker loading.
- Use namespace imports for Node built-ins, for example `import * as fs from "node:fs/promises"`.
- Keep types sound. Avoid `any`; use the declared type instead of `ReturnType<>`.
- Use `#private` class members. Do not add `private`, `protected`, or `public` modifiers except constructor parameter properties used for dependency injection.
- Pure barrel `index.ts` files use `export * from "./module"` unless that creates a real ambiguity.
- Follow nearby kebab-case file naming. Tests use `*.test.ts`, `*.integration.test.ts`, or `repro-issue-NNNN-*.test.ts` when documenting a regression.
- Biome is authoritative: tabs with width 3, LF, double quotes, semicolons, trailing commas, and a 120-column line width.

### Async, errors, and I/O

- Use `Promise.withResolvers()` for externally resolved promises and `Bun.sleep()` for delays. Avoid hand-written promise constructors and timer wrappers.
- Prefer Bun APIs: `Bun.file()`/`Bun.write()`, `Bun.spawn()` for controlled streaming processes, `bun:sqlite`, `Bun.JSON5`, and `Bun.JSONL`.
- Do not perform existence-check-then-read sequences. Read once, catch the error, and use `isEnoent()` from `@oh-my-pi/pi-utils` when absence is expected.
- Reuse centralized stream, path, Git/Jujutsu, terminal, and logging helpers before adding a local helper. Duplicate implementations are defects even when behavior currently matches.
- Shared/runtime code must use `logger` from `@oh-my-pi/pi-utils`; `console.*` can corrupt TUI and protocol output. Standalone commands may write intentional user-facing output before entering a mode.
- Keep RPC, ACP, worker, Python-kernel, and print-mode stdout protocol-clean. Diagnostics belong in logs or explicit error channels.

### Dependency injection and state management

- Treat `sdk.ts#createAgentSession()` as the composition root. Extend its options-bag dependency injection rather than reading global singletons inside subsystems.
- A `ModelRegistry` and session must share the same `AuthStorage`; split storage instances produce inconsistent credentials and model state.
- Keep mutable agent-loop state inside `packages/agent`; expose changes through events. `AgentSession` serializes asynchronous event handling before persistence.
- Session journals are append-only trees keyed by entry IDs and parent IDs. Preserve fork/leaf semantics; never persist throttled streaming fragments as completed history.
- TUI components return cached/immutable line arrays. Do not mutate rendered rows after return or bypass the differential renderer.

### Prompts, tools, and terminal rendering

- Prompts live in static `.md` assets, imported with `with { type: "text" }` and rendered through the shared Handlebars prompt utility. Do not assemble model prompts in TypeScript.
- User-facing strings in coding-agent go through `t()` unless the surrounding subsystem intentionally owns another localization boundary.
- Register built-in tools through `packages/coding-agent/src/tools/index.ts`; retain extension/meta wrappers and the native unwrapped invocation path.
- Tool-renderer content is untrusted terminal input. Apply `replaceTabs()`, width-aware truncation, `shortenPath()`, and shared preview/truncation constants on success, error, diff, and streaming paths.
- Live tool-argument previews and rebuilt transcripts must use the same decode path. Preserve preview-only fields through event, rebuild, and merged call/result rendering.

## Important Files

| File | Why it matters |
|---|---|
| `package.json` | Workspaces, pinned Bun version, dependency catalog, patches, and root commands. |
| `bunfig.toml` | Install policy, text loaders, test exclusions, and Bun runtime defaults. |
| `biome.json`, `tsconfig.base.json`, `tsconfig.tools.json` | Formatting/lint and strict TypeScript contracts. |
| `Cargo.toml`, `rust-toolchain.toml`, `.bazelversion`, `MODULE.bazel` | Rust workspace, pinned toolchain, Bazel version, and native build graph. |
| `packages/coding-agent/src/cli.ts` | Executable entry and hidden worker host dispatch. |
| `packages/coding-agent/src/main.ts` | Root startup, configuration, session selection, and mode boundary. |
| `packages/coding-agent/src/sdk.ts` | Runtime composition and dependency injection. |
| `packages/coding-agent/src/session/agent-session.ts` | Prompt pipeline, event handling, persistence, retries, and compaction hooks. |
| `packages/agent/src/agent-loop.ts` | Provider context, streaming lifecycle, tool validation/execution, and emitted events. |
| `packages/ai/src/stream.ts` | Single provider-streaming choke point and auth/error behavior. |
| `scripts/ci-test-ts.ts` | TypeScript test classification, chunking, environment scrubbing, retry, and watchdog policy. |
| `.github/workflows/ci.yml` | Actual continuous-integration gates and release prerequisites. |
| `scripts/bazel-natives.ts` | Native host/cross-target orchestration and target constraints. |
| `packages/coding-agent/DEVELOPMENT.md` | Maintainer map for boot flow, subsystems, and supporting docs. |

## Runtime/Tooling Preferences

- Use the repository-pinned Bun 1.4.0 and its text lockfile. Do not use npm, Yarn, or pnpm for development workflows.
- TypeScript targets ES2024 with strict bundler resolution. Run `tsgo` only through repository `check` scripts; do not invoke `tsc` or `npx tsc`.
- Rust uses edition 2024 and `nightly-2026-08-08`; Bazel is pinned to 9.2.0. Run Rust checks/tests through Bun scripts so workspace exclusions, doctests, and CI parity are preserved.
- Python packages require Python 3.11 or newer. Their pytest suites are currently manual gates rather than GitHub Actions jobs, so run them explicitly for Python changes.
- Develop normal changes on `dev`; do not create feature commits on `release`. `scripts/release.ts` implements the upstream `main`/`v*` release flow, while `.github/workflows/release-code.yml` implements this fork's `release`/`code-N` binary flow. Keep the two workflows separate.
- Treat `release` as a transient transport branch: NEVER develop on it or leave the worktree there; switch to `release` only briefly for pull or push operations, then immediately switch back to the corresponding development branch. The current corresponding development branch is `dev`.
- Never commit unless explicitly requested.

Generated files must be changed through their source and generator:

- `packages/catalog/src/models.json` <- descriptors/resolvers/generator via `bun run gen:models`.
- `bazel/clippy.bazelrc` <- Cargo workspace lints via `bun run gen:clippy`.
- `dist/docs-index.generated.txt`/embedded docs <- `docs/**/*.md` via `bun run gen:bundle`; there is no `gen:docs` command.
- Coding-agent tool views <- `packages/collab-web/src/tool-render/` via `bun run gen:tool-views`.
- Native/statistics embed files are packaging intermediates and are reset by build scripts; do not hand-edit or leave temporary embedded payloads behind.

For user-visible package changes, add a concise line under that package's `CHANGELOG.md` `## [Unreleased]` section. Released sections are immutable. Categories are `Breaking Changes`, `Added`, `Changed`, `Fixed`, and `Removed`.

## Testing & QA

- TypeScript tests use Bun's built-in `bun:test`; there is no Vitest or Jest layer. Rust uses cargo-nextest plus doctests through `bun run test:rs`; Robomp uses pytest/pytest-asyncio.
- Test observable contracts: emitted events, persisted rows/JSONL, protocol payloads, rendered terminal behavior, state transitions, precedence, and real failure mapping. Do not assert source text, comments, helper wiring, or tautologies.
- Never use `mock.module()`; Bun's global module registry leaks across files. Prefer `vi.spyOn()` on imported modules/prototypes or real in-process fakes, then restore spies in `afterEach`.
- Isolate every test. Use `Settings.isolated()`, `SessionManager.inMemory()`, in-memory `AuthStorage`, temporary directories, environment snapshots, and the helpers under `packages/coding-agent/test/helpers/`.
- Gate real-provider tests with `E2E=1` and the helpers in `packages/ai/test/oauth.ts`. Use explicit capability/platform skips for interpreters, SSH, permissions, native features, and external services.
- Model asynchronous races with `Promise.withResolvers()` and bounded event gates. Avoid unconditional sleeps; integration tests should declare realistic explicit timeouts.
- `scripts/ci-test-ts.ts` splits tests into fast workspace, native/integration, and coding-agent singleton/UI/runtime/native buckets. Credential variables are scrubbed, chunks are watchdog-bounded, and crash retries run in fresh Bun processes.
- CLI smoke tests exercise hidden workers and the stats dashboard; install smoke tests cover binary, source-link, and packed-tarball topologies. Run the smoke that matches any worker, packaging, or startup change.
- No coverage percentage or reporting threshold is enforced. Coverage absence does not justify low-value tests; add tests only where they defend a concrete regression or changed contract.
