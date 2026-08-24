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

## 自定义模型供应商

在 `~/.omp/agent/models.yml` 中声明兼容供应商：

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

### 初始化

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

1. [pi-mono](https://github.com/badlogic/pi-mono)，由 Mario Zechner 创建。
2. [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)，将 Pi 扩展为完整的 coding-agent harness。
3. [LambdaExpress/oh-my-pi](https://github.com/LambdaExpress/oh-my-pi)，维护本 README 所述的本地化、平台适配、稳定性改进与独立发布链路。

适用于所有 OMP 用户的通用修复，建议同时评估是否向上游提交。fork 专有问题与发布问题请在
[LambdaExpress/oh-my-pi/issues](https://github.com/LambdaExpress/oh-my-pi/issues) 反馈。

## License

OMP 使用 [MIT License](LICENSE)。第三方与 vendored 代码继续遵循各自许可证；完整归属见
[THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt) 及组件目录内的许可证文件。

- © 2025 Mario Zechner
- © 2025-2026 Can Bölük
- © 2026 Stencil Labs, Inc.
