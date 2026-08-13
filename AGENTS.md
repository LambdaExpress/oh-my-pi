# Repository Guidelines

## Project Overview

Oh My Pi is a Bun-first monorepo for the `omp` coding-agent CLI. It combines TypeScript packages, Rust/N-API native helpers, and a smaller Python/Robomp area.

Default focus: `packages/coding-agent/`. When a user says "agent" in this repo, they usually mean the coding-agent implementation, not the assistant operating on the repo.

This repo contains multiple packages, but **`packages/coding-agent/`** is the primary focus. Unless otherwise specified, assume work refers to this package.

**Terminology**: When the user says "agent" or asks "why is agent doing X", they mean the **coding-agent package implementation**, not you (the assistant). The coding-agent is a CLI tool — questions about its behavior refer to code in `packages/coding-agent/`, not your current session.

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
| `packages/omptype` | ArkType-compatible schema validation with a lazy JIT runtime. |

**Catalog import convention**: code in this repo imports catalog _values_ (bundled models, model-thinking helpers, identity, descriptors, model manager/cache) from `@oh-my-pi/pi-catalog/<module>` — never via `@oh-my-pi/pi-ai`. The pi-ai barrel re-exports only the model/effort _types_ its own signatures use (`Model`, `Api`, `ThinkingConfig`, `Effort`, …); type-only imports of those from `@oh-my-pi/pi-ai` are fine.

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

## GitHub

Unless user tells you exactly what to write:

- **Never comment on GitHub** (issues, PRs, discussions).
- **Never create issues on GitHub**.

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
- Merge commits (maintainer merges of PRs) follow: `Merge PR #<number>: <conventional PR subject> (@<author>)` — e.g. `Merge PR #6386: feat(catalog): add native Meta Model API provider (@eggpeat)`.

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

## Testing

Test observable contracts, not implementation text.

Test the contract the system exposes — not the easiest internal detail to assert.

Preferred test practices:

- Use `bun:test` imports: `describe`, `it`/`test`, `expect`, `beforeEach`, `afterEach`, `vi`, `mock`.
- Prefer `vi.spyOn()` and dependency injection. Do not use `mock.module()`.
- **Never use `mock.module()`**. Bun's `mock.module()` mutates the global module registry and leaks across files ([oven-sh/bun#12823](https://github.com/oven-sh/bun/issues/12823)). Use `spyOn` on the imported module object instead. For pass deps, import the pass and spy on `.run`. For package deps, namespace-import and spy on the exported function.
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
- Do not add placeholder, tautological, or source-grep tests. Tests must assert observable behavior, emitted events, persisted files, rendered output, request bodies, public state transitions, or typed/linted structural constraints.
- Keep tests full-suite safe: avoid long-lived mutations of `Bun.*`, `process.platform`, `process.env`, `Bun.env`, module registries, timers, settings, and other globals unless each test restores them explicitly.
- Use `Settings.isolated(...)`, temp dirs, fake models/transports, and explicit cleanup for session/tool tests.
- Restore timers, mocks, env, settings, and global state in `afterEach`.
- Gate real-provider tests with env checks such as `describe.skipIf(!e2eApiKey("ANTHROPIC_API_KEY"))`.
- Use `Promise.withResolvers()`, event gates, and bounded waits for async races; avoid fixed sleeps unless a nearby test uses that race pattern intentionally.
- UI tests usually initialize theme, render at fixed widths, strip ANSI with `Bun.stripANSI`, and assert visible output or fast-path equivalence.
- Do not source-grep implementation files in tests. Assert behavior, emitted events, persisted JSONL/files, rendered output, request bodies, or public state transitions.
- Tests **must be full-suite safe**, not just file-local safe. No long-lived file-wide mutations of `Bun.*`, `process.platform`, `process.env`, or `Bun.env` when a narrower seam exists. Prefer per-test `vi.spyOn(...)` with `vi.restoreAllMocks()` in `afterEach`. A test that passes alone but poisons later files is broken.
- For lifecycle/stateful code, prefer one test per invariant or transition over several tiny tests asserting one field each from the same transition.
- For error handling, trigger the real failure path and assert the surfaced contract — don't instantiate error classes directly or inspect internal metadata.
- Smoke tests are acceptable only when they catch a failure mode narrower tests would miss. "Package boots" or "command starts" alone is not enough.
- Assert exact strings, ordering, and formatting only when downstream code parses or depends on the exact bytes. Otherwise assert semantic content.
- Compile-time guarantees → type checks/type tests, not runtime placeholders.
- **Never source-grep.** A test that reads an implementation file (`.ts`/`.rs`/build script) and asserts on its _text_ — `expect(src).toContain("someCall()")`, `.toMatch(/import .../)`, `.not.toContain("oldName")`, or "comment must say X" — is banned. It tests how code _looks_, not what it _does_: it breaks on harmless refactors (comment reflow, rename, import reorder) and passes while the behavior is broken. Assert the observable contract instead (run the code, check output/state/error), use the runtime smoke probe for wiring you cannot exercise in-process, and enforce structural invariants (no value-import of X, no self-import) with a type test or a lint/biome rule — never a string scan of the source. (Reading a file your code _wrote_ — apply-patch result, generated bundle, temp fixture — and asserting on that output is fine; that is behavior, not a source grep.)
- Don't add tests for tiny low-risk changes unless they protect a real contract or fix a regression-prone edge case.
- Prefer focused package-local verification for the changed area.

CI-quality gates:

- `.github/workflows/ci.yml` runs `bun run ci:check:full`, `bun run collab:web:build`, native Linux builds/checks, TypeScript test buckets, CLI smoke, and install-method smoke.
- Release runs additionally build cross-platform native artifacts, binaries, GitHub Release, npm packages, and Homebrew updates.
- `scripts/ci-test-ts.ts` chunks memory-heavy coding-agent tests, scrubs credential/cloud env vars, clears `GITHUB_ACTIONS`, and sets Bun/JSC stability knobs.
- Locally, build natives with `bun run build:native` before tests that import native-backed packages if artifacts are missing.
- For worker/binary packaging changes, run `bun run ci:test:smoke` at minimum; install or packaging changes may require `bun run ci:test:install-methods`.

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
- Never modify already-released sections (e.g., `## [0.12.2]`) — they are immutable.
- Don't flag changelog section order or formatting in reviews or PRs — `bun run release` runs `fix-changelogs` which normalizes everything automatically.

**Attribution:**

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/can1357/oh-my-pi/issues/123))`.
- External contributions: `Added feature X ([#456](https://github.com/can1357/oh-my-pi/pull/456) by [@username](https://github.com/username))`.

## Releasing

1. Ensure all changes since last release are in each affected package's `[Unreleased]` section.
2. Run `bun run release`.

The script handles version bump, CHANGELOG finalization, commit, tag, publish, and adding new `[Unreleased]` sections.
