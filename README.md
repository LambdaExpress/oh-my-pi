<p align="center">
  <img src="assets/hero.png" alt="Oh My Pi">
</p>

<h1 align="center">Oh My Pi · LambdaExpress Fork</h1>

<p align="center">
  面向真实开发工作的终端编码代理，强化中文体验、Windows 支持、长会话稳定性与本地工作流。
</p>

<p align="center">
  <a href="https://github.com/LambdaExpress/oh-my-pi/releases"><img src="https://img.shields.io/github/v/release/LambdaExpress/oh-my-pi?display_name=tag&style=flat&colorA=222222&colorB=3FB950" alt="Fork release"></a>
  <a href="https://github.com/LambdaExpress/oh-my-pi/actions/workflows/release-code.yml"><img src="https://github.com/LambdaExpress/oh-my-pi/actions/workflows/release-code.yml/badge.svg?branch=release" alt="Release build"></a>
  <a href="packages/coding-agent/CHANGELOG.md"><img src="https://img.shields.io/badge/changelog-view-E05735?style=flat&colorA=222222" alt="Changelog"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/LambdaExpress/oh-my-pi?style=flat&colorA=222222&colorB=58A6FF" alt="License"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
</p>

> [!IMPORTANT]
> 这是 [LambdaExpress/oh-my-pi](https://github.com/LambdaExpress/oh-my-pi) 维护的 fork。它持续同步
> [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)，并通过独立的 `code-N` GitHub Release
> 发布 fork 构建。上游 npm 包和 Homebrew tap 不包含本 fork 的专有改动。

## 这个 fork 解决什么问题

本 fork 保留 OMP 完整的编码代理能力，并重点维护以下方向：

- **简体中文界面**：终端界面、设置、命令帮助和主要交互支持 `zh-CN`，默认可跟随系统语言。
- **Windows 与 PowerShell**：提供原生 Windows 二进制、`pwsh` 工具、PowerShell SSH 主机支持，并持续修复 ConPTY、路径、进程清理和终端重绘问题。
- **长会话稳定性**：强化流式文本和工具预览、原生滚动历史、上下文压缩、会话恢复以及已完成运行的折叠与重放。
- **工作区与子代理**：维护 `omp worktree`、隔离工作区、后台任务中心、可恢复子代理和项目级 managed skills。
- **开发工具链**：集成 Language Server Protocol（LSP）、Debug Adapter Protocol（DAP）、浏览器、SSH、结构化编辑和持久化 Python/JavaScript 执行环境。
- **独立发布**：为 Linux、macOS 和 Windows 构建自包含二进制，并支持基于 `code-N` 发布序列的原地更新。

完整改动记录见 [packages/coding-agent/CHANGELOG.md](packages/coding-agent/CHANGELOG.md)。

## 发布模型

| 名称 | 用途 |
| --- | --- |
| `dev` | fork 源码安装器的默认分支，包含当前维护中的集成版本 |
| `release` | 发布分支；推送后构建并发布各平台二进制 |
| `code-N` | 单调递增的 fork 发布标签，例如 `code-4` |

fork 二进制的版本格式为 `omp/X.Y.Z+code.N`：`X.Y.Z` 表示同步到的 OMP 版本，`N` 表示当前 fork 构建序号。

## 安装

### 推荐：fork 预编译二进制

安装脚本默认下载最新的 `code-N` Release，不会回退到上游 npm 包。

**macOS / Linux**

```sh
curl -fsSL https://raw.githubusercontent.com/LambdaExpress/oh-my-pi/release/scripts/install.sh | sh
```

**Windows PowerShell**

```powershell
irm https://raw.githubusercontent.com/LambdaExpress/oh-my-pi/release/scripts/install.ps1 | iex
```

支持的平台：

- Linux x64 / arm64
- Linux musl x64 / arm64
- macOS Intel / Apple Silicon
- Windows x64

> [!NOTE]
> Alpine Linux 需要先安装动态运行库：`apk add libstdc++ libgcc`。

安装完成后可直接更新到最新 fork 构建：

```sh
omp update
```

### 固定 fork 发布版本

以下命令以 `code-4` 为例；可在 [Releases](https://github.com/LambdaExpress/oh-my-pi/releases) 中选择其他 `code-N` 标签。

**macOS / Linux**

```sh
curl -fsSL https://raw.githubusercontent.com/LambdaExpress/oh-my-pi/release/scripts/install.sh \
  | sh -s -- --binary --ref code-4
```

**Windows PowerShell**

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/LambdaExpress/oh-my-pi/release/scripts/install.ps1))) -Binary -Ref code-4
```

### 从 fork 源码安装

源码模式要求 Bun 1.3.14 或更高版本，并默认安装 `dev` 分支。

**macOS / Linux**

```sh
curl -fsSL https://raw.githubusercontent.com/LambdaExpress/oh-my-pi/release/scripts/install.sh \
  | sh -s -- --source
```

**Windows PowerShell**

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/LambdaExpress/oh-my-pi/release/scripts/install.ps1))) -Source
```

指定源码分支或提交时，传入 `--ref <ref>`；PowerShell 使用 `-Ref <ref>`。

### Nix

```sh
# 临时运行
nix run github:LambdaExpress/oh-my-pi/release

# 安装到当前 profile
nix profile install github:LambdaExpress/oh-my-pi/release
```

Flake 使用者可引用 `packages.<system>.omp`、`overlays.default`、`nixosModules.default` 或
`homeManagerModules.default`：

```nix
{
  inputs.omp.url = "github:LambdaExpress/oh-my-pi/release";

  imports = [ inputs.omp.homeManagerModules.default ];
  programs.omp = {
    enable = true;
    settings.startup.quiet = true;
  };
}
```

## 快速开始

首次运行时配置供应商、凭据和默认模型：

```sh
omp setup
omp
```

常用入口：

```sh
# 单次非交互请求
omp -p "检查当前项目并指出最需要修复的问题"

# 恢复已有会话
omp --resume

# 查看命令与参数
omp --help
```

在交互界面中打开 `/settings` 可切换显示语言。`display.language` 支持：

- `auto`：跟随系统语言
- `en`：English
- `zh-CN`：简体中文

全局配置位于 `~/.omp/agent/config.yml`，项目配置位于 `<project>/.omp/config.yml`。

### Shell 补全

```sh
# zsh
eval "$(omp completions zsh)"

# bash
eval "$(omp completions bash)"

# fish
omp completions fish > ~/.config/fish/completions/omp.fish
```

## 核心能力

### 终端编码代理

- 交互式 TUI、单次打印模式、RPC、ACP 和可嵌入 TypeScript SDK。
- 会话持久化、恢复、分支、上下文压缩、运行折叠和原生滚动历史。
- 多模型角色、凭据轮换、fallback chain、自定义 OpenAI/Anthropic 兼容供应商。
- 规则、skills、扩展、slash commands、MCP 和项目级配置发现。

### 文件、代码与运行时

- `read`：读取文件、目录、压缩包、SQLite、PDF、Notebook、URL、`ssh://` 与内部 URI。
- `edit` / `write`：Hashline 增量编辑、文件写入、远程 SSH 目标与冲突解决。
- `grep` / `glob` / `ast_grep` / `ast_edit`：文本、路径和语法结构搜索与改写。
- `lsp`：定义、引用、类型、诊断、重命名、文件重命名和 code actions。
- `debug`：断点、单步、线程、调用栈、变量、内存和 DAP 自定义请求。
- `bash` / `pwsh` / `eval`：持久 shell、PowerShell，以及可回调工具的 Python 和 JavaScript 内核。

### 协作与自动化

- `task`：并行子代理、结构化结果和隔离工作区。
- `hub`：Agent Hub、后台任务、进程监督和代理间通信。
- `todo` / `ask`：阶段任务跟踪与结构化交互确认。
- `browser` / `computer`：真实 Chromium、Browser Relay 和桌面自动化。
- `web_search` / `github` / `ssh`：联网检索、GitHub 操作和远程主机执行。
- `retain` / `recall` / `reflect` / `learn`：可选的长期记忆与 managed skills。

## 官方 18.0.9 架构

当前 fork 采用官方 18.0.9 / `main` 的分层架构，同时在这些边界上保留 fork 扩展：

- **入口层**：同一 Agent/Session 引擎服务交互式 TUI、`omp -p`、TypeScript SDK、NDJSON RPC 与 ACP；编辑器能力通过 ACP 的文件、终端和权限接口接入。
- **代理层**：`packages/agent` 维护模型无关的循环和工具执行，`packages/coding-agent` 负责会话、转录、工具编排与产品界面；`task`、`hub`、advisor 和隔离工作区共享统一的代理生命周期。
- **终端层**：`packages/tui` 只负责终端生命周期、输入和差分绘制，coding-agent 负责语义转录。活动、已稳定和已提交块按显式生命周期进入原生 scrollback；fork 继续维护 completed-run collapse、全局转录重放和 resize rebuild。
- **原生层**：`packages/natives` 通过 N-API 聚合 `pi-natives`、`pi-shell`、`pi-ast`、`pi-iso`、`pi-voice` 与 `pi-walker`。搜索、AST、语法高亮、PTY、嵌入式 shell 和工作区扫描在进程内运行；Windows 继续提供 PowerShell 语法高亮及原生路径、进程和终端适配。
- **工具层**：常用文件、搜索、运行时和代码智能工具直接暴露；低频能力通过 `xd://` 按需发现。fork 保留 SSH 会话与传输、GitHub Actions run-watch、安全扫描，以及 xdev 中止后原调用形态和输出卡片的恢复。

架构细节见 [coding-agent 开发指南](packages/coding-agent/DEVELOPMENT.md)、[TUI runtime internals](docs/tui-runtime-internals.md) 和 [TUI core renderer](docs/tui-core-renderer.md)。

## 自定义模型供应商

![omp TUI with TypeScript and Biome language servers active.](assets/lspv.webp)

_[Read the LSP config docs](docs/lsp-config.md)_

### 03 · Drives a real debugger

A C binary segfaults: the agent attaches lldb, steps to the bad pointer, reads the frame. A Go service hangs: it attaches dlv and walks the goroutines. A Python process is wedged: debugpy, pause, inspect, evaluate. Most agents are still sprinkling print statements.

![omp TUI: a live lldb-dap session against a native binary at /tmp/omp-native/demo. Adapter=lldb-dap, Status=stopped, Frame=xorshift32, Instruction pointer 0x10000055C, Location demo.c:6:10. Debug scopes and Debug variables cards show locals (x = 57351) and the agent confirms the math: x went from 7 → 57351 (= 7 ^ (7<<13)).](https://omp.sh/clips/dap-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/dap.mp4)_

### 04 · Time-traveling stream rules

Your rules sit dormant until the model goes off-script. A regex match aborts the stream mid-token, injects the rule as a system reminder, and retries from the same point. You get course-correction without paying context tax on every turn. Injections survive compaction, so the fix sticks.

![omp TUI: agent reading src.rs and about to write Box::leak when the request aborts (red `Error: Request was aborted`), an amber `⚠ Injecting rule: box-leak` card injects the rule body `Don't reach for Box::leak in production code paths`, and the agent then course-corrects by proposing `Arc<str>` and asking the user to confirm.](https://omp.sh/clips/ttsr-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/ttsr.mp4)_

### 05 · First-class subagents

Split a job across workers and get typed results back. task fans out into isolated worktrees, each worker runs its own tool surface, and the final yield is a schema-validated object the parent reads directly. No prose to parse, no merge conflicts between siblings, no orphaned edits.

![omp TUI showing `task` spawning two subagents `ComponentsExports` and `RoutesExports`, the constraints block requiring an IRC DM between peers, the per-subagent status cards with cost and duration, and a final Findings section listing both exports plus an honest 'IRC coordination note' about a one-sided handshake.](https://omp.sh/clips/irc-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/irc.mp4)_

Watch the fan-out while it runs: `Alt+A` opens [Agent Hub](docs/agent-hub.md), where the roster shows current activity and usage for every subagent. Open one to read its live transcript, type a steering message, revive a parked worker, or kill a stuck one without aborting the parent session.

### 06 · A second model, watching every turn.

Pair a reviewer model to the 'advisor' role and it reads every turn the main agent takes, injecting notes inline — a quiet aside, a concern, or a hard blocker. It runs on its own context and its own model, so it catches what the doer rushed past. The main agent sees the note and course-corrects, or tells you why it won't.

![omp TUI: /advisor status shows the advisor running on openai-codex/gpt-5.5; after the main agent scopes a catch to ENOENT instead of swallowing every error, an amber 'Advisor 1 note (concern)' card warns the fix no longer matches the user's literal acceptance criterion.](https://omp.sh/clips/advisor-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/advisor.mp4)_

### 07 · Hand someone the link, they're in.

/collab puts your live session on a relay and hands back a link — and a QR. A teammate joins from another terminal with omp join, or just opens it in a browser. Share read-write to pair on the same agent, or /collab view for a read-only link anyone can watch but no one can steer. Frames are sealed client-side; the relay never sees your keys.

![omp TUI: /collab view prints 'Collab session started!' with an omp join command, a my.omp.sh browser link, the note 'Anyone with this link can watch the session but cannot prompt the agent', and a large scannable QR code.](https://omp.sh/clips/collab-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/collab.mp4)_

### 08 · Read a pdf on arxiv, why not?

web_search chains twenty-three ranked providers and hands whatever URLs it finds straight to read. Arxiv PDFs, GitHub pages, Stack Overflow threads come back as structured markdown with anchors intact — the same tool surface you use on local files. Cite, follow, quote, never lose where you came from.

![omp TUI: web_search returns 10 ranked Perplexity sources for inference-time compute scaling, the agent picks an arxiv paper, calls read https://arxiv.org/pdf/2604.10739v1, and summarizes the paper's headline result with real numbers.](https://omp.sh/clips/web-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/web.mp4)_

### 09 · Unapologetically native. Even on Windows.

Other agents shell out to rg, grep, find, and bash. On many machines those binaries don't exist, and on the ones where they do, every call costs a fork-exec round-trip. omp links the real implementations into the process. ripgrep, glob, find: in-process. brush is the bash — with sessions that survive across calls, and 58 command-line utilities (ls, sed, sort, xargs, even jq) ported into the builtins crate and run in-process, zero fork/exec. The same omp binary runs on macOS, Linux, and Windows — no WSL bridge.

### 10 · Code review with priorities and a verdict

Get a clear verdict on whether the change ships, with every issue ranked P0 through P3 and scored for confidence. /review spawns dedicated reviewer subagents that sweep branches, single commits, or uncommitted work in parallel. You tackle what blocks release first; nothing important hides in a wall of prose.

### 11 · Hashline: edit by content hash

Perfect edits, fewer tokens. The model points at anchors instead of retyping the lines it wants to change, so whitespace battles and string-not-found loops just stop happening. Edit a stale file and the anchors diverge — we reject the patch before it corrupts anything. Grok 4 Fast spends 61% fewer output tokens on the same work.

### 12 · GitHub is just another filesystem

Other harnesses bolt on gh_issue_view, gh_pr_view, gh_search — each with its own parameters the agent has to learn and you have to debug. We skipped that. read already handles paths; PRs are paths. One interface to teach the model, one surface to keep correct.

### 13 · Memory the agent curates

The agent remembers your codebase between sessions. It writes facts mid-run with retain, captures reusable lessons with learn, pulls them back with recall, and compresses each session into a mental model that loads on the first turn of the next one. Pick the engine with `memory.backend` — local, Hindsight, or Mnemopi. Project-scoped by default, so what it learns about this repo stays with this repo.

### 14 · ACP: editor-drivable agent

Run omp inside Zed and you get the same agent you drive from the terminal — reading the buffer you're actually looking at, writing through the editor's save path, spawning shells in the editor's terminal. Destructive tools pause for a permission prompt you can answer once and forget. No bridge, no plugin, no second brain to keep in sync.

### 15 · Inherits what your other tools already wrote

Every other agent ships an importer and expects you to convert. omp reads the eight formats already on disk in their native shape — Cursor MDC, Cline .clinerules, Codex AGENTS.md, Copilot applyTo, and the rest. No migration script, no YAML-to-TOML port, no "supported subset" footnotes. The config your team wrote last quarter still works tonight.

### 16 · omp commit: atomic splits, validated messages

omp reads the working tree through git_overview, git_file_diff, and git_hunk, then splits unrelated changes into atomic commits ordered by their dependencies. Cycles are rejected before anything is written. Source files score above tests, docs, and configs, so the headline commit is the one that matters. Lock files are excluded from analysis entirely.

### 17 · Read PRs. _Walk skills._ Pull JSON out of subagents.

Sixteen internal schemes — `pr://`, `issue://`, `agent://`, `skill://`, `ssh://`, and the rest — resolve transparently inside every FS-shaped tool the agent already calls. `read pr://1428` returns the same shape as `read src/foo.ts`. `grep` walks a diff like a directory. `agent://<id>/findings.0.path` pulls a field out of a subagent's output by path.

### 18 · Conflict resolution, made easy.

Each merge conflict becomes one URL. The agent writes `@theirs`, `@ours`, or `@base` to `conflict://N` and the file resolves cleanly. Bulk form: `conflict://*`.

![omp TUI: ✓ Read src/session.ts (⚠ 1 conflict), then ✓ Write conflict://1 · 1 line with content @theirs, then a confirmation 'Resolved.'](https://omp.sh/clips/conflict-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/conflict.mp4)_

### 19 · Preview, then accept.

`ast_edit` returns a _(proposed)_ card with the replacement count. The change is staged. The agent writes a one-line reason to `xd://resolve`; the TUI turns it into an **Accept** card and the disk move happens — atomic, all or nothing.

![omp TUI: ✓ AST Edit: console.log($X) (proposed) 3 replacements · 1 file, then ✓ Accept: 3 replacements in 1 file (AST Edit), followed by 'Applied 3 replacements in src/auth.ts.'](https://omp.sh/clips/codemod-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/codemod.mp4)_

### 20 · Drives a _real browser_. _Or your Slack?_

Eval's `browser.open(...)` returns a tab handle with direct navigation, inspection, interaction, and element helpers; `tab.run(...)` handles custom JavaScript. It drives Chromium or Electron in an isolated tab runtime. Stealth is on by default, while the browser relay can adopt Chrome tabs you already have open without stealing focus.

### 21 · Hands on the desktop itself

Eval's `computer` helpers — `computer.window(...)`, `win.screenshot()`, `win.ax()`, `el.press()`, plus `computer.run(fnOrCode, options)` for multi-step scripts — control the real host: enumerate windows and displays, capture screenshots, send native input, walk the OS accessibility tree, and use the clipboard. It exposes no browser DOM.

## Whatever the task needs, _it's already in the box_.

Core tools live in the same namespace as `read` and `bash`. Pin the active set with `--tools read,edit,bash,…`; rarely used discoverable tools stay behind `xd://` devices. `read xd://` lists them, and `write xd://<tool>` runs one when `tools.xdev` is enabled.

**Files & search**

- `read` — files, dirs, archives, SQLite, PDFs, notebooks, URLs, remote `ssh://` paths, and internal `://` schemes through one path.
- `write` — create or overwrite a file, archive entry, or SQLite row.
- `edit` — hashline patches with content-hash anchors and stale-anchor recovery.
- `ast_edit` — structural rewrites previewed before apply, via ast-grep.
- `ast_grep` — structural code queries over 50+ tree-sitter grammars.
- `grep` — regex over files, globs, and internal URLs.
- `glob` — glob-based path lookup; reach for `grep` when you need content matches.

**Runtime**

- `bash` — workspace shell with 46 in-process coreutils, optional PTY, and background-job dispatch.
- `eval` — persistent Python and JavaScript cells with shared prelude and tool re-entry.

**Code intelligence**

- `lsp` — diagnostics, navigation, symbols, renames, code actions, raw requests.
- `debug` — drive a DAP session — breakpoints, stepping, threads, stack, variables.
- `security_scan` — plan and run native security reviews; drives Codex Security cloud scans.

**Coordination**

- `task` — fan out subagents in parallel, optionally workspace-isolated.
- `hub` — message live agents, wait on or cancel background jobs, and supervise long-running processes.
- `todo` — ordered mutations over the session todo list with phase tracking.
- `ask` — structured follow-up questions for interactive runs.

**Desktop & web**

- `browser` — Puppeteer tabs over headless Chromium, CDP-attached apps, or your own Chrome via the relay.
- `computer` — persistent JS against the host desktop: windows, screenshots, native input, AX tree, clipboard.
- `web_search` — one query across configured providers, returning answer plus citations.
- `github` — GitHub CLI ops — repo, PR, issues, code search, Actions run-watch.
- `generate_image` — generate or edit raster images via Gemini, GPT, or xAI Grok image models.
- `tts` — text-to-speech via xAI Grok Voice — five built-in voices, WAV or MP3.

**Memory & skills**

- `checkpoint` — mark conversation state for a later collapse-and-report.
- `rewind` — prune exploratory context, keep a concise report.
- `retain` — queue durable facts into the active memory bank.
- `recall` — search the memory bank for raw memories.
- `reflect` — synthesize an answer over the bank.
- `memory_edit` — update, forget, or invalidate stored memories by id.
- `learn` — capture a reusable lesson; optionally promote it into a managed skill.
- `manage_skill` — create, update, or delete an isolated managed skill.

Setting-gated, off by default: `github`, `security_scan`, `generate_image`, `tts`, `checkpoint`, `rewind`, and the memory tools (`retain`/`recall`/`reflect`/`memory_edit`, per `memory.backend`).

[Full reference →](https://omp.sh/docs/tools)

### Prompt controls

Three standalone, lowercase words opt a turn into specialized agent behavior:

- `ultrathink` — request careful multi-step reasoning and the highest supported automatic thinking effort.
- `orchestrate` — run substantial independent work through parallel subagents and verify each phase.
- `workflowz` — build a deterministic multi-subagent workflow with the active `task` tool.

They trigger only in prose, not inside code spans, fenced code blocks, XML/HTML sections, identifiers, or paths. See [Magic keywords](docs/magic-keywords.md) for exact matching rules and configuration.

### Session controls

Slash commands shift how a whole session runs:

- `/vibe` — enter [Vibe mode](docs/vibe-mode.md): act as a director driving persistent `fast`/`good` worker sessions with a `read`-only toolset.
- `/fresh` — reset the provider stream state (stale prompt cache, wedged stream) without changing the local transcript. See [Session operations](docs/session-operations-export-share-fork-resume.md#fresh).

## Sixty-plus providers, a thousand models, _one /model away_.

Nine roles route work by intent. `default` for normal turns. `smol` for cheap subagent fan-out. `slow` for deep reasoning. `plan` for plan mode. `commit` for changelogs. Plus `vision`, `task`, `advisor`, and `tiny` for their namesakes. Override at launch with `--smol`, `--slow`, or `--plan`; cycle through the configured models for the active role with `Ctrl+P`. Swap the active model mid-session with the `/model` slash command.

Auth tags below: `oauth` signs in with your provider account, `plan` routes through a coding-plan subscription, `local` runs against a local server with the key optional.

### Frontier APIs

Direct APIs and gateways. Mix providers per role.

Anthropic `oauth` · OpenAI · OpenAI Codex `oauth` · Google Gemini · Google Vertex · Google Antigravity `oauth` · xAI · SuperGrok `oauth` · DeepSeek · Mistral · Groq · Cerebras · Fireworks · Together · Baseten · DeepInfra · Hugging Face · NVIDIA · Meta · Amazon Bedrock · Azure OpenAI · SiliconFlow · GMI Cloud · CoreWeave · Sakana AI · OpenRouter · Synthetic · Vercel AI Gateway · Cloudflare AI Gateway · Wafer Serverless

### Coding plans

Subscription-routed. `/login` attaches the session.

Cursor `oauth` · GitHub Copilot `oauth` · GitLab Duo · Devin `oauth` · Kimi Code `plan` · Moonshot · MiniMax Coding Plan `plan` · MiniMax Coding Plan CN `plan` · Alibaba Coding Plan `plan` · Qwen Portal `oauth` · Z.AI / GLM Coding Plan `plan` · Zhipu Coding Plan `plan` · Xiaomi MiMo · Qianfan · Umans `plan` · NanoGPT · Novita · Venice · Kilo · ZenMux · OpenCode Go · OpenCode Zen

### Run it yourself

OpenAI-compatible `/v1/models`. Local instances skip the key.

Ollama `local` · Ollama Cloud · LM Studio `local` · llama.cpp `local` · vLLM `local` · LiteLLM

### Custom OpenAI-compatible providers

Define custom providers in `~/.omp/agent/models.yml`:

```yaml
providers:
  local:
    baseUrl: http://127.0.0.1:8000/v1
    api: openai-completions
    apiKey: dummy
    models:
      - id: example-model
        name: Example Model
        contextWindow: 100000
        maxTokens: 32000
```

验证发现结果并完成默认模型设置：

```sh
omp models local
omp setup
```

也可以在 `~/.omp/agent/config.yml` 中直接指定角色模型：

```yaml
modelRoles:
  default: local/example-model
```

## 从源码开发

### 环境要求

- Bun 1.3.14 或更高版本
- Git
- 构建本地 Rust/N-API addon 所需的 Rust、Bazel 与平台编译工具链

## Twenty-three backends. _One tool the agent already knows_.

`web_search` is built in, not bolted on. `auto` walks a twenty-three-provider chain; pin one by name if you already pay for it. Behind every hit, site-aware extraction turns GitHub, registries, arXiv, Stack Overflow, and docs into structured markdown — anchors and link targets survive.

### Search providers

Twenty-three backends. Pin one, or let `auto` walk the chain in order.

| provider     | auth                                      |
| ------------ | ----------------------------------------- |
| `auto`       | chain                                     |
| `perplexity` | `PERPLEXITY_API_KEY` (anonymous fallback) |
| `gemini`     | oauth                                     |
| `anthropic`  | oauth                                     |
| `codex`      | oauth                                     |
| `xai`        | oauth or `XAI_API_KEY`                    |
| `zai`        | `ZAI_API_KEY`                             |
| `exa`        | `EXA_API_KEY` (or mcp)                    |
| `tinyfish`   | `TINYFISH_API_KEY`                        |
| `jina`       | `JINA_API_KEY`                            |
| `kagi`       | `KAGI_API_KEY`                            |
| `tavily`     | `TAVILY_API_KEY`                          |
| `firecrawl`  | `FIRECRAWL_API_KEY` (keyless fallback)    |
| `brave`      | `BRAVE_API_KEY`                           |
| `kimi`       | `/login kimi-code` or search key          |
| `parallel`   | `PARALLEL_API_KEY`                        |
| `synthetic`  | `SYNTHETIC_API_KEY`                       |
| `searxng`    | self-hosted                               |
| `duckduckgo` | no key                                    |
| `startpage`  | no key                                    |
| `google`     | no key (browser)                          |
| `ecosia`     | no key (browser)                          |
| `mojeek`     | no key (browser)                          |
| `public`     | no key (all of the above, consolidated)   |

Exa also accepts a stored API key through `/login exa`; explicit keyless selection uses the public MCP fallback.

### Specialised handlers

The agent gets structured content, not stripped HTML.

- **Code hosts** — github, gitlab
- **Package registries** — npm, PyPI, crates.io, Hex, Hackage, NuGet, Maven, RubyGems, Packagist, pub.dev, Go packages
- **Research sources** — arxiv, semantic scholar
- **Forums** — stack overflow, reddit, hn
- **Docs** — mdn, readthedocs, docs.rs

Pages convert to markdown with link structure intact. The agent can cite, follow, and quote without losing anchors.

### Security databases

Vuln lookups answer with vendor data, not blog summaries.

- **NVD** — national vulnerability database
- **OSV** — open source vuln feed
- **CISA KEV** — known exploited vulns

[`web_search` reference ↗](https://omp.sh/docs/tools#web_search)

## Roughly **~80,000** lines of Rust, doing the work other harnesses shell out for.

Six crates, one platform-tagged N-API addon. Search, shell, AST, highlight, PTY, desktop control, image decode, BPE counting — all in-process on the libuv pool. No fork/exec on the hot path. Another ~80k lines ride along vendored: the brush bash fork, plus 58 command-line utilities — coreutils, findutils, sed, jq, ripgrep-backed grep, fd, diff, moreutils — ported into the builtins crate and compiled straight into the shell.

- Crates: `pi-natives`, `pi-shell`, `pi-ast`, `pi-iso`, `pi-voice`, `pi-walker`
- Platforms: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`, `win32-arm64` — x64 ships dual AVX2 and baseline binaries

Per crate, code lines only:

| Crate         | What it does                                                                           |   ~LoC |
| ------------- | -------------------------------------------------------------------------------------- | -----: |
| pi-shell      | Embedded bash engine · persistent sessions · in-process coreutils dispatch · minimizer | 38,000 |
| pi-natives    | The N-API surface — every module in the table below                                    | 25,000 |
| pi-walker     | Parallel ignore-aware walker + scan cache shared by grep · glob · workspace · shell    |  5,200 |
| pi-iso        | Workspace isolation · apfs · btrfs · zfs · reflink · overlayfs · projfs · rcopy        |  3,300 |
| pi-ast        | tree-sitter + ast-grep matching, block resolution, structural summaries                |  2,900 |
| pi-voice      | Audio capture/playback · Opus · live WebRTC                                            |  1,000 |

Inside `pi-natives`, the per-module breakdown (glue and tests omitted):

| Module        | What it does                                                                      | Powered by                                |   ~LoC |
| ------------- | --------------------------------------------------------------------------------- | ----------------------------------------- | -----: |
| desktop       | Window/display enumeration · screenshot · native input · AX tree for `computer`   | xcap · enigo · OS AX FFI                  | 10,600 |
| grep          | Regex search · parallel/sequential · glob & type filters · fuzzy find             | grep-regex · grep-searcher                |  3,280 |
| text          | ANSI-aware width · truncation · column slicing · SGR-preserving wrap              | unicode-width · segmentation              |  2,070 |
| snapcompact   | Bitmap-frame rasterization + PNG encode for context compression                   | image · png                               |  1,760 |
| keys          | Kitty keyboard protocol with xterm fallback · PHF perfect-hash lookup             | phf                                       |  1,740 |
| ast           | ast-grep pattern matching and structural rewrites                                 | ast-grep-core                             |  1,510 |
| diff          | Structured file diffing for tools and previews                                    | in-tree                                   |  1,030 |
| pty           | Native PTY allocation for sudo · ssh interactive prompts                          | portable-pty                              |    630 |
| crash_handler | Native crash capture and reporting                                                | in-tree                                   |    610 |
| highlight     | Syntax highlighting · 11 semantic categories · 30+ aliases                        | syntect                                   |    550 |
| appearance    | Mode 2031 + native macOS dark/light via CoreFoundation FFI                        | core-foundation                           |    450 |
| task          | Blocking work on libuv thread pool · cancellation · timeout · profiling           | tokio · napi                              |    440 |
| glob          | Discovery with glob · type filters · mtime sort · gitignore respect               | ignore · globset                          |    430 |
| fd            | Filesystem walker for find-tool replacement                                       | ignore                                    |    385 |
| clipboard     | Text copy and image read from system clipboard · no xclip/pbcopy                  | arboard                                   |    370 |
| workspace     | Workspace walker with gitignore + AGENTS.md discovery in one pass                 | ignore                                    |    275 |
| power         | macOS power-assertion API for idle/system/display-sleep prevention                | IOKit FFI                                 |    270 |
| prof          | Circular buffer profiler with folded-stack and SVG flamegraph output              | inferno                                   |    240 |
| file_lock     | Cross-process advisory file locking                                               | in-tree                                   |    210 |
| ps            | Cross-platform process-tree kill and descendant listing                           | libc · libproc · CreateToolhelp32Snapshot |    195 |
| tokens        | O200k / Cl100k BPE token counting · both tables embedded                          | tiktoken-rs                               |     70 |
| html          | HTML to Markdown with optional content cleaning                                   | html-to-markdown-rs                       |     60 |
| sixel         | Terminal image rendering · decode PNG · JPEG · WebP · GIF · resize · SIXEL encode | icy_sixel · image                         |     55 |

## Four entry points: _interactive_, _one-shot_, RPC, and ACP.

Same engine, four wrappers. `omp` runs the TUI. `omp -p` answers a single prompt and exits. The Node SDK embeds the session in your process. `omp --mode rpc` and `omp acp` hand the wheel to another program over stdio.

### Interactive — when in doubt, the agent asks

The TUI is the default surface. Tool calls render as cards, edits preview before they land, and ambiguity routes through the `ask` tool — a structured option picker the agent can call mid-turn. The keyboard handles the rest.

The same prompt cards surface over ACP, so editors get the picker without writing one.

![omp TUI showing a multi-select question from the ask tool.](assets/ask.webp)

### SDK — embed in Node

`@oh-my-pi/pi-coding-agent`

Node and TypeScript hosts pull the engine in directly. The package exposes `ModelRegistry`, `SessionManager`, `createAgentSession`, and `discoverAuthStorage`; the session emits typed events you subscribe to.

```ts
import {
  ModelRegistry,
  SessionManager,
  createAgentSession,
  discoverAuthStorage,
} from "@oh-my-pi/pi-coding-agent";

const auth = await discoverAuthStorage();
const models = new ModelRegistry(auth);
await models.refresh();

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage: auth,
  modelRegistry: models,
});
await session.prompt("list .ts files");
```

### RPC — drive over stdio

`omp --mode rpc`

For non-Node embedders, or when you want process isolation. NDJSON commands in, response and event frames out. `--mode rpc-ui` adds tool cards, selectors, and dialogs as `extension_ui_request` frames the host must answer.

```
$ omp --mode rpc --no-session
> {"id":"r1","type":"prompt","message":"list .ts files"}
< {"id":"r1","type":"response", ...}
> {"id":"r2","type":"set_model","provider":"anthropic","modelId":"sonnet-4.5"}
> {"id":"r3","type":"abort"}
```

### ACP — speak to editors

`omp acp`

The [Agent Client Protocol](https://github.com/zed-industries/agent-client-protocol) over JSON-RPC. When the editor advertises capabilities, tool I/O routes through it and writes are gated by `session/request_permission`.

| omp tool     | ACP route                           |
| ------------ | ----------------------------------- |
| `bash`       | `terminal/create + terminal/output` |
| `read`       | `fs/read_text_file`                 |
| `write`      | `fs/write_text_file`                |
| `edit, bash` | `session/request_permission`        |

Full reference: [omp.sh/docs/sdk](https://omp.sh/docs/sdk).

## A harness worth keeping is one you _don't_ outgrow.

Pick it up at **[omp.sh](https://omp.sh)**.

omp is a fork of [Pi](https://github.com/badlogic/pi-mono) by [Mario Zechner](https://github.com/mariozechner), rewritten as a coding-first surface: sessions, subagents, slash commands, extensions — all TypeScript, all MIT, all on [GitHub](https://github.com/can1357/oh-my-pi). Shape it from config, hook it from outside, or read the source when you need to.

### Primitives

An extension is a TypeScript module. Same tool API, same slash-command registry, same hotkey table, same TUI primitives the built-ins use. Nothing is reserved.

### Discovery

On first run omp inherits whatever is already on disk: rules, skills, and MCP servers from `.claude`, `.cursor`, `.windsurf`, `.gemini`, `.codex`, `.cline`, `.github/copilot`, and `.vscode`. No migration script.

### Extensibility

Ask omp to write the piece you're missing, then `/reload-plugins`. Keep it local, ship it in a `marketplace`, or publish it to npm.

## Philosophy

omp is a fork of [pi-mono](https://github.com/badlogic/pi-mono) by [Mario Zechner](https://github.com/mariozechner), extended with a batteries-included coding workflow.

Key ideas:

- Keep interactive terminal-first UX for real coding work
- Include practical built-ins (tools, sessions, branching, subagents, extensibility)
- Make advanced behavior configurable rather than hidden

---

## Development

### Getting started from source

Fresh clones need both workspace dependencies and the local Rust/N-API addon before the source CLI can start.

```sh
git clone --branch dev https://github.com/LambdaExpress/oh-my-pi.git
cd oh-my-pi
bun run setup
bun run dev
```

`bun run setup` 安装 workspace 依赖、构建 native addon，并链接本地 `omp`。修改 Rust crates 或
`packages/natives` 后重新运行：

```sh
bun run build:native
```

### 验证

根据改动范围选择最低成本的检查：

```sh
# TypeScript 与工具配置检查
bun run check:ts

# CLI 入口与 worker host 冒烟测试
bun run ci:test:smoke

# TypeScript 测试桶
bun run test:ts

# 完整检查
bun run check
```

单个 coding-agent 测试文件：

```sh
bun --cwd=packages/coding-agent test test/<file>.test.ts
```

架构、目录地图和贡献约定见
[packages/coding-agent/DEVELOPMENT.md](packages/coding-agent/DEVELOPMENT.md) 与 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 仓库结构

| 路径 | 职责 |
| --- | --- |
| `packages/coding-agent` | `omp` CLI、会话、工具、TUI 模式、MCP、扩展和 prompts |
| `packages/agent` | 与供应商无关的 Agent 循环、状态和工具执行 |
| `packages/ai` | 模型供应商客户端、流式响应、认证与重试 |
| `packages/catalog` | 模型目录、供应商描述和模型能力解析 |
| `packages/tui` | 差分终端渲染器与 UI 组件 |
| `packages/natives` / `crates/*` | Rust/N-API 原生能力、shell、AST、搜索和桌面集成 |
| `packages/collab-web` | 协作会话 Web 客户端与 relay |
| `packages/utils` | 日志、流、路径、进程和环境等共享工具 |
| `python/omp-rpc` / `python/robomp` | Python RPC 客户端与 Robomp 服务 |

## Fork 与上游

本仓库的代码来源关系：

| Package                                                                       | Description                                                                 |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **[@oh-my-pi/collab-web](packages/collab-web)**                               | Browser guest client, mock host, and local relay for collab live sessions   |
| **[@oh-my-pi/pi-ai](packages/ai)**                                            | Multi-provider LLM client with streaming and model/provider integration     |
| **[@oh-my-pi/pi-catalog](packages/catalog)**                                  | Model catalog: bundled model database, provider descriptors, and identity   |
| **[@oh-my-pi/pi-agent-core](packages/agent)**                                 | Agent runtime with tool calling and state management                        |
| **[@oh-my-pi/pi-coding-agent](packages/coding-agent)**                        | Interactive coding agent CLI and SDK                                        |
| **[@oh-my-pi/pi-tui](packages/tui)**                                          | Terminal UI library with differential rendering                             |
| **[@oh-my-pi/pi-natives](packages/natives)**                                  | N-API bindings for grep, shell, image, text, syntax highlighting, and more  |
| **[@oh-my-pi/omp-stats](packages/stats)**                                     | Local observability dashboard for AI usage statistics                       |
| **[@oh-my-pi/omptype](packages/omptype)**                                     | ArkType-compatible schema validation with lazy JIT compilation              |
| **[@oh-my-pi/pi-utils](packages/utils)**                                      | Shared utilities (logging, streams, dirs/env/process helpers)               |
| **[@oh-my-pi/pi-wire](packages/wire)**                                        | Shared collab live-session protocol types and relay constants               |
| **[@oh-my-pi/hashline](packages/hashline)**                                   | Line-anchored patch language and applier behind the `edit` tool             |
| **[@oh-my-pi/pi-mnemopi](packages/mnemopi)**                                  | Local SQLite memory engine for Oh My Pi agents                              |
| **[@oh-my-pi/snapcompact](packages/snapcompact)**                             | Bitmap-frame context compression package and SQuAD eval suite               |
| **[@oh-my-pi/browser-relay](packages/browser-relay)**                         | Chrome extension that lets the Eval browser API drive your existing tabs    |
| **[@oh-my-pi/pi-metaharness](packages/metaharness)**                          | Unified benchmark runners, Harbor run storage, REST/SSE API, live dashboard |
| **[@oh-my-pi/typescript-edit-benchmark](packages/typescript-edit-benchmark)** | Edit benchmark suite built on TypeScript source mutations                   |

适用于所有 OMP 用户的通用修复，建议同时评估是否向上游提交。fork 专有问题与发布问题请在
[LambdaExpress/oh-my-pi/issues](https://github.com/LambdaExpress/oh-my-pi/issues) 反馈。

## License

OMP 使用 [MIT License](LICENSE)。第三方与 vendored 代码继续遵循各自许可证；完整归属见
[THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt) 及组件目录内的许可证文件。

- © 2025 Mario Zechner
- © 2025-2026 Can Bölük
- © 2026 Stencil Labs, Inc.
