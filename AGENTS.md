# Repository Guidelines

## Project Overview

Oh My Pi（`omp`）是基于 Bun、TypeScript 与 Rust 的终端编码代理。本 fork 重点维护中文体验、Windows 支持、长会话稳定性、工作区和子代理工作流，同时提供 SDK、RPC 与桌面/协作界面。

默认工作范围是 `packages/coding-agent/`。用户提到“agent 的行为”时，指该产品实现。MUST 优先复用现有模块，保持改动局部；NEVER 未经请求提交代码或发布。本文 MUST 表示必须，NEVER 表示禁止，SHOULD 表示默认建议。

## Architecture & Data Flow

```text
cli.ts → cli-commands.ts / commands/ → main.ts::runRootCommand
       → sdk.ts::createAgentSession → AgentSession → Agent / agentLoop
       → pi-ai 流式请求 → provider transport
       ← assistant/tool 事件 → 会话持久化与 TUI / print / RPC / core 展示
```

以上入口文件位于 `packages/coding-agent/src/`；循环位于 `packages/agent/src/`，传输位于 `packages/ai/src/`。

- `Agent.state` 持有活动消息、流式消息和待执行工具；`AgentSession` 协调输入队列、工具、模型和生命周期。`SessionManager` 管理追加式会话日志及 `(id, parentId)` 分支树，默认存储为 JSONL；SDK 可注入其他存储后端。
- 会话显示投影与 provider 上下文分离。MUST 通过既有 transcript/context 构建入口处理回放；NEVER 为折叠或隐藏 UI 改写模型历史。
- 请求处理顺序为 `transformContext` → `convertToLlm` → provider 消息规范化 → `transformProviderContext` → `streamFn`。SHOULD 在对应扩展点处理宿主策略，避免在 transport 重建会话规则。
- `createAgentSession` 装配配置、认证、模型注册表、工具和扩展；TUI、print、RPC/ACP、core 共享会话引擎。`packages/tui/` 负责共享呈现，coding-agent 的 controllers 负责宿主事件和会话语义。
- 原生调用经过 `packages/natives/` 的 loader、`crates/pi-natives/` 的 N-API 适配层，再进入专门的 Rust engine。MUST 将算法改动放入所属 engine，将 JS 互操作留在适配层。

## Key Directories

| 路径 | 修改职责 |
| --- | --- |
| `packages/coding-agent/src/` | `session/` 会话；`modes/` 交互与协议宿主；`tools/` 工具；`task/` 子代理；`config/` 设置；`lsp/`、`mcp/`、`extensibility/` 集成 |
| `packages/agent/src/` | 通用 agent loop、工具调度、steering/follow-up、上下文压缩 |
| `packages/ai/src/` | provider 请求、流式事件、认证及错误映射 |
| `packages/catalog/src/` | 模型发现、身份、能力、限额、定价与声明式策略 |
| `packages/tui/src/` | 终端输入与差分渲染，以及共享 chat、tool cards、overlays、theme |
| `packages/utils/src/` | 日志、路径、进程、取消、流和 worker 公共能力 |
| `packages/natives/`、`crates/` | 原生绑定；编辑、AST、遍历、VFS、shell、VCS 等 Rust engines |
| `packages/collab-web/`、`packages/wire/`、`packages/tauri-shell/` | 协作网页、共享 JSON-safe 协议、桌面宿主；浏览器 SHOULD 依赖 wire，避免引入 coding-agent runtime |
| `packages/omptype/`、`packages/mnemopi/`、`packages/snapcompact/`、`packages/stats/` | 运行时 schema、记忆引擎、位图上下文压缩、统计面板 |
| `scripts/`、`docs/`、`python/` | 开发/生成/发布编排、子系统设计文档、Python RPC 客户端与 RoboOMP |

## Development Commands

以下命令从仓库根目录运行；显式 `--cwd` 表示单包操作。命令定义以根及对应包的 `package.json` 为准。

| 任务 | 命令 |
| --- | --- |
| 首次源码环境初始化 | `bun run setup` |
| 启动源码 CLI | `bun run dev` |
| 重建本机原生 addon 与绑定 | `bun run build:native` |
| 构建独立 CLI 二进制 | `bun --cwd=packages/coding-agent run build` |
| coding-agent 类型、lint、格式检查 | `bun --cwd=packages/coding-agent run check` |
| coding-agent 仅类型检查 | `bun --cwd=packages/coding-agent run check:types` |
| 根级 TS / Rust 检查 | `bun check` |
| 仅 TS 检查 / 根级 lint | `bun run check:ts` / `bun run lint` |
| 单文件测试示例 | `bun --cwd=packages/coding-agent test test/edit-blackbox.test.ts` |
| coding-agent 分桶测试 | `bun --cwd=packages/coding-agent run test` |
| 本地 TS 聚合测试 | `bun run test:ts` |
| 本地 TS 与 Rust 聚合测试 | `bun run test` |
| Rust nextest 与 doctest | `bun run test:rs` |
| 脚本回归测试子集 | `bun run test:scripts` |
| CLI、worker 与统计面板 smoke | `bun run ci:test:smoke` |
| 自动格式化 / 修复 | `bun run fmt` / `bun run fix` |

- `setup` 会安装依赖、构建原生 addon 并修改全局 `omp` 链接；`bun install` 也会通过 prepare 生成 tool views。SHOULD 仅在环境需要时执行。
- `check`/`lint` 不自动修复源码；`fmt`/`fix` 会修改文件，`fix:all` 还会修改 changelog。根 `build` 聚合所有 workspace，包括网页和独立 Tauri 构建。SHOULD 选最小相关命令。
- 本地 Rust wrapper 在非 CI 且没有相关未提交变更时会跳过。MUST 检查输出，NEVER 将跳过当作 Rust 验证通过。NEVER 直接运行 `cargo test`；使用 `bun run test:rs` 保留 nextest 与 doctest 两阶段。
- NEVER 直接调用 `tsc`/`npx tsc`；使用上述检查入口，由包脚本选择编译器。

## Code Conventions & Common Patterns

### TypeScript 与模块

- 格式由 `.oxfmtrc.json` 控制：Tab 缩进、宽度 3、120 列、双引号、分号、尾逗号。MUST 沿用相邻代码命名；未使用参数按 lint 约定使用 `_` 前缀。
- MUST 优先明确类型；仅在确有必要时使用 `any`。NEVER 使用 `ReturnType<>`，直接引用实际类型。外部 API 类型 MUST 查依赖声明，避免猜测。
- MUST 使用顶层导入；NEVER 新增 inline/dynamic imports，包括 `import("pkg").Type`。`node:fs`、`node:path`、`node:os` MUST 使用 namespace imports。
- 类内部状态 MUST 使用 `#private`；外部成员省略访问修饰符。`private`/`protected`/`public` 仅可用于需要它们的构造器参数属性。
- 纯 barrel 的 `index.ts` MUST 使用 `export * from "./module"`；冲突时删除冗余导出路径，避免重复出口。
- catalog 的值 MUST 从 `@oh-my-pi/pi-catalog/<module>` 导入；`@oh-my-pi/pi-ai` 仅可提供其签名使用的模型/effort 类型，不能作为 catalog 值的转出口。

### 依赖注入、状态与共享能力

- 工具 MUST 通过 `ToolSession` 获取资源与动态 cwd/model/settings，并使用其 `asyncJobManager`；NEVER 绕过注入读取全局任务管理器。SDK 同时注入 `AuthStorage` 与 `ModelRegistry` 时，两者 MUST 共用同一个 auth 实例。
- 并发 SDK 会话 SHOULD 使用独立 `AgentRegistry`、`Settings.isolated`/`loadIsolated`；子会话的实时设置继承使用 `overlay`。MUST 释放自己持有的资源，NEVER 处置父会话资源。
- 设置 MUST 在所属领域的 `settings.ts` 用 `register` 声明，通过配置句柄与 `SettingsScope` 读取/监听；派生值复用 `map`/`combine`，进程副作用复用 `effect`/`bindEffects`。
- 工具启用、权限和深度筛选 MUST 复用 `BUILTIN_TOOLS` → `resolveBuiltinToolPlan` → `createTools`，覆盖初次构造和实时重配置。
- 新增 helper 前 MUST 查 `packages/coding-agent/src/utils/`、`packages/utils/src/`、`packages/tui/src/` 和领域邻近模块；能力不足时扩展现有 helper。Git/Jujutsu MUST 使用 `@oh-my-pi/pi-natives/vcs` 与 `packages/coding-agent/src/utils/active-repo-context.ts`，NEVER 手工 spawn。
- 消息内容和渲染结果存在 identity cache。MUST 在原地修改已完成消息后调用 `invalidateMessageCache`，原地重排时处理 conversion array cache；组件返回的 rows 不可被调用者修改，内容变化 MUST 返回新数组。

### 模型策略与生成物

- 模型/供应商条件策略 MUST 写入 `packages/catalog/src/compat/rules/` 的 KDL；NEVER 在 TS 中用模型名匹配或查表硬编码能力、定价、effort、路由或 quirks。必须在 TS 分支时，仅使用 `classifyModel()` 的结构化事实，并优先扩展 KDL axis。
- 规则分层与选择器见 `packages/catalog/src/compat/rules/README.md`。无法归类的精确 ID MUST 使用带注释的 residue rule；`AmbiguousOverlapError` MUST 通过显式 `priority=` 解决。
- discovery MUST 保留权威上游字段；仅对上游缺失/误报且由 KDL correction axis 接管的字段填中性值。MUST 经 `buildModel` 验证策略修正；解析契约在原始 mapper 层验证。
- NEVER 手改 `packages/catalog/src/models.json` 或 `packages/catalog/src/compat/rules.json`。模型条目修改 `provider-models/descriptors.ts`、`provider-models/openai-compat.ts` 或 `packages/catalog/scripts/generate-models.ts`；运行 `bun run gen:compat` / `bun run gen:models`，保留源与受版本管理的生成物同步。
- 原生绑定声明与 export 生成区块 MUST 通过 `bun run build:native` 更新。修改 `packages/collab-web/src/tool-render/` 后 MUST 运行 `bun run gen:tool-views`；Cargo 依赖或 workspace lint 变化按需运行 `bun run gen:bazel-lock`、`bun run gen:clippy`。NEVER 一概提交或忽略所有 generated 文件。

### Prompts 与 Worker scripts

- Prompts MUST 位于静态 `.md` 文件，动态内容使用 Handlebars，以 `import content from "./prompt.md" with { type: "text" }` 导入；NEVER 在代码中拼接 prompt 或运行时读取文件代替导入。
- CLI worker MUST 经 `workerHostEntry()` 重新进入 `cli.ts`，使用 `__omp_worker_*` selector；SDK、测试和独立包入口 MUST 保留 direct-module fallback。新增 worker MUST 更新 CLI dispatcher，并在异步导入前同步安装 inbox，避免丢失首条消息。

```ts
const hostEntry = workerHostEntry();
const worker = hostEntry
	? new Worker(hostEntry, { type: "module", argv: ["__omp_worker_<name>"] })
	: new Worker(new URL("./<worker>.ts", import.meta.url).href, { type: "module" });
```

### 日志与终端呈现

- 可能运行于 TUI、RPC、SDK、worker 或后台的代码 MUST 使用 `logger`（`@oh-my-pi/pi-utils`）或显式输出 sink；NEVER 使用 `console.*` 污染协议/终端。独立退出型 CLI 可输出用户结果，结构化 stdout MUST 保持纯净。
- 所有工具渲染路径，包括错误、diff 和流式预览，MUST 使用 `replaceTabs`、`truncateToWidth`/`ui.truncate`、`shortenPath`，并复用 `PREVIEW_LIMITS`、`TRUNCATE_LENGTHS`。
- 流式工具参数 MUST 经 `decodeStreamedToolArgs` / `ToolArgsRevealController` 解码；NEVER 将滞后的 provider-parsed arguments 与原始 `__partialJson` 直接拼接。MUST 在实时事件、历史重建和 call/result 合并中保留预览字段，并支持工具尚无结果的状态。
- `AgentSession` 的异步 listener 不构成 await pipeline。MUST 保留 `EventController` 的事件串行化和 update flush；NEVER 将一次 `agent_end` 或 `isStreaming=false` 当作整个会话完成。
- 重建 transcript MUST 保留仍活动的流式组件、pending tools 与 optimistic user row，已终结结果由 replay 接管。自动刷新 SHOULD 使用 `refreshDisplay`/`requestRender`；`resetDisplay` 会清除原生 scrollback，仅用于显式破坏性操作。

## Important Files

- `packages/coding-agent/DEVELOPMENT.md`：源码导航与子系统文档索引；复杂改动 SHOULD 先查对应设计文档。
- `packages/coding-agent/src/sdk.ts`、`packages/coding-agent/src/session/agent-session.ts`、`packages/coding-agent/src/session/session-manager.ts`：会话装配、运行协调和持久化。
- `package.json`、`bun.lock`、`bunfig.toml`：workspace、依赖版本、命令和运行配置；`tsconfig.base.json`、`.oxlintrc.json`、`.oxfmtrc.json`：TS 与质量规则。
- `docs/session.md`、`docs/tui-runtime-internals.md`、`docs/tui-core-renderer.md`：会话、TUI 生命周期与终端历史边界。
- `docs/adding-a-provider.md`、`docs/natives-build-release-debugging.md`：provider 扩展与原生构建/发布。
- `scripts/ci-test-ts.ts`、`scripts/run-rs-task.ts`、`.github/workflows/ci.yml`：真实测试范围与 CI 条件；NEVER 仅凭脚本名称推断覆盖范围。
- `CONTRIBUTING.md`、`.github/PULL_REQUEST_TEMPLATE.md`：贡献与人工审核要求；`Cargo.toml`、`.cargo/config.toml`、`rust-toolchain.toml`、`MODULE.bazel`：原生依赖和工具链。

## Runtime/Tooling Preferences

- 仓库开发 MUST 使用根 `packageManager` 要求的 Bun，当前为 `bun@>=1.4`；部分包的 `>=1.3.14` 是较低兼容声明。MUST 使用 Bun 与 `bun.lock`，保留 workspace catalog 和 patched dependencies；NEVER 用 npm install 绕过它们。
- 日常 TS 包直接运行 ESM 源码，SHOULD 避免无必要的全仓构建。MUST 优先 Bun API：`Bun.file`/`Bun.write`、Bun Shell、`Bun.sleep`、`bun:sqlite`、`Bun.JSONL`、`Bun.stringWidth`、`Bun.wrapAnsi`。
- 目录操作使用 `node:fs/promises`；异步代码 MUST 避免同步 I/O、先 exists 再读取，以及在 `Bun.write` 前重复 mkdir。MUST 捕获实际 I/O 错误并用 `isEnoent` 判断缺失，NEVER 吞掉其他错误。
- 简单外部命令 SHOULD 使用 Bun Shell；长生命周期、流式 I/O 或信号控制使用 `Bun.spawn`。MUST 复用 stream helpers 与 `$which`；Promise 手动完成器使用 `Promise.withResolvers()`。
- 本机原生构建默认使用 Cargo/N-API；发布/跨平台构建使用 Bazel。本地 Rust 与 Bazel 各有固定工具链，MUST 按配置使用，避免擅自改成 stable。Tauri 是独立 Cargo workspace，不在根 Rust 检查范围内。
- Rust profile 已集中配置：`local` 用于本机优化迭代，`release` 用于发行，`profiling` 保留性能分析符号。NEVER 对有 debuginfo 的 profile 设置 `split-debuginfo = "off"`；MUST 保留 FFI panic 恢复边界，并使 `embed-metadata` 与工具链同步。SHOULD 沿用现有配置，避免重新引入已否决的 sccache、mold 或 dev `panic = "abort"`。

## Testing & QA

- TypeScript 使用 `bun:test`，测试通常位于对应包的 `test/**/*.test.ts`。SHOULD 先运行最小相关测试；聚合测试 MUST 使用分桶 runner，避免在根目录裸跑 `bun test` 扫入临时工作树或 Bazel 链接。
- 每个新增测试 MUST 防守可观察的行为、边界、优先级、不变量、状态转移或错误契约。NEVER 测试构造器复制字段、有效输入原样返回、措辞/默认常量、source-grep、裸 `not.toThrow()` 或仅“非空/长度增长”；同一路径的重复用例和重复层级覆盖 SHOULD 删除。精确字节、顺序或 metadata 断言仅用于下游确实依赖的契约。
- MUST 保证 full-suite isolation。NEVER 使用 `mock.module()` 或长期修改全局 `Bun.*`、环境、平台状态；SHOULD 使用局部 `spyOn` 并在 `afterEach` 恢复。设置测试复用 `packages/coding-agent/test/helpers/settings-test-state.ts`，终端测试可复用 `packages/tui/test/virtual-terminal.ts`；MUST 清理临时目录、会话、数据库和子进程。
- 聚合 runner 会清理真实服务凭据，直接单文件测试会继承宿主环境。provider E2E 需要 `E2E=1` 与独立测试凭据，可能访问计费服务；浏览器和 native suites 还需要相应运行依赖。NEVER 将跳过的测试报告为通过；没有仓库统一覆盖率百分比门槛。
- Rust 改动 MUST 重建并验证实际加载的新 addon。PR CI 可能复用既有 native artifact，且不运行 Rust 验证；绿色 PR CI 无法替代本地验证。nextest 不运行 doctest，MUST 保留 wrapper 的两阶段检查。
- 自动检查通过不等于行为有效。MUST 原样复现 bug 并确认修复；功能改动 MUST 运行实际路径，UI 改动 MUST 交互并观察真实呈现。流式预览同时验证实时和重建路径；新 worker 使用 `omp --smoke-test`，不同模块图 MUST 增补相应 smoke。报告仅包含实际执行的场景、结果和阻碍。

### Changelog

用户可见改动 MUST 更新对应 `packages/*/CHANGELOG.md` 的 `## [Unreleased]`，每项一行描述用户影响。分类为 `Breaking Changes`、`Added`、`Changed`、`Fixed`、`Removed`；NEVER 修改已发布章节，也无需在 review 中争论分类顺序或格式，发布工具负责规范化。内部 issue 修复保留 issue 链接；外部贡献在 PR 编号分配后 MUST 补 PR 链接与作者 credit，推送该条目后才可勾选 changelog 检查项。

### 贡献与发布边界

- 重大功能、架构、大 UI、新依赖或跨包改动 MUST 按 `CONTRIBUTING.md` 在实施前讨论；准备自己提交的工作 NEVER 先新建 issue，避免 RoboOMP 重复接手。
- 创建/修改贡献者 PR 前 MUST 阅读贡献指南与 PR 模板，保留模板章节和 checklist。MUST 取得贡献者亲笔说明“改了什么、为什么”的至少一句话，并由贡献者审核和验证；NEVER 代写该句或自主发布未经批准的 PR。RoboOMP 管理的 PR 遵循 `python/robomp/src/prompts/system_append.md`。
- GitHub 评论或新 issue MUST 先展示目标与拟发布内容并获批准；指定目标和原文的明确发布指令即授权。修复反馈的授权仅允许拟稿。解决 review thread 前 MUST 验证修复、获批事实性回复、在原线程成功发布，然后才能 resolve；读取评论的请求保持只读。
- PR 发布/编辑后 MUST 回读正文，仅勾选已验证项，在 `Testing` 说明跳过或不适用的检查。维护者合并标题遵循 `Merge PR #<number>: <conventional PR subject> (@<author>)`。
- `bun run release`、publish 脚本以及向 `release` 分支推送会触发真实发布；`bun run robomp:reset` 会删除 volumes。NEVER 将这些命令当普通构建或环境修复执行，必须有明确授权。
