---
name: omp-transcript-display-mode
description: 在 oh-my-pi (omp) 的 coding-agent 里新增或调整「全局转录显示模式」开关（折叠活动行、block 间距、隐藏输出、折叠运行）时的标准接线清单与验证方式
---

## 何时用

给 `packages/coding-agent` 的转录（transcript）加一个**全局显示模式**：一个设置项 + 一个快捷键，切换后每个 block 换一种画法，并且必须重放已经提交到原生滚动历史（native scrollback）的行。

## 标准接线清单

1. **设置项**：`src/config/settings-schema.ts` 加 `display.<name>`；`src/modes/components/settings-selector.ts` 同时补 `switch` 的 label 与 description 分支（两处，约 660 行与 1380 行附近）；`src/i18n/locales/zh-CN.ts` 按 ASCII 键序补键（label、description、状态文案；单词键在文件底部的 lowercase 区块，数字键在 `"0"`/`"1"` 区块，`{placeholder}` 开头的键在文件末尾区块）。
2. **快捷键**：`src/config/keybindings.ts` 的 `AppKeybindings` 并集 + `KEYBINDINGS`（`alt+shift+<letter>` 在 legacy 终端就是 `ESC + 大写字母`）；`src/modes/components/custom-editor.ts` 的 `ConfigurableEditorAction` 并集、`DEFAULT_ACTION_KEYS`、`onXxx?` 回调字段、`handleInput` 里的 `#matchesAction` 分支；`src/modes/controllers/input-controller.ts` 的 `setupKeyHandlers` 里 `setActionKeys` + 回调绑定，以及 toggle 方法本体。
3. **能力接口**：在 `src/modes/components/tool-activity.ts` 加 `setXxx` 接口 + `isXxxComponent` 类型守卫（`ToolActivityContainer` 也转发）。
4. **容器**：`src/modes/components/transcript-container.ts` 存一份标志，`addChild` 时应用于新 block，并提供 `setXxx` 遍历现有 children。
5. **上下文**：`src/modes/types.ts` 的 `InteractiveModeContext` 加字段；`src/modes/interactive-mode.ts` 初始化字段 + 应用到 `chatContainer`。
6. **重建路径**：`src/modes/components/chat-transcript-builder.ts` 构造时从 settings 初始化；`src/modes/utils/ui-helpers.ts` 里 staged 容器要带上标志，并在把 children 交还 visible 容器前把 ctx 状态重新应用一次；`/copy` 之类的“取内容”选择器要在自己的 builder 上显式关掉该模式。
7. **手势语义**：toggle 里先更新所有相关组件，再 `ctx.ui.resetDisplay()`；只 `requestRender(true)` 只会重画视口，已落入原生历史的行不会变（见 skill `global-transcript-display-gestures`）。
8. **文档**：`docs/settings.md` 的外观表、`docs/keybindings.md` 的 Common action IDs 表、`src/modes/utils/hotkeys-markdown.ts`、以及 `packages/coding-agent/CHANGELOG.md` 的 `## [Unreleased]`（段落顺序 Breaking/Added/Changed/Fixed/Removed）。

## 要折叠哪些行

折叠模式要覆盖**所有活动行**，不只是工具卡片：`ToolExecutionComponent`、`ReadToolGroupComponent`、`TtsrNotificationComponent`（`Inject: <rule> — <desc>`）、`TodoReminderComponent`（`Reminder: <task> (+N more)`）、`LateDiagnosticsMessageComponent`（`Late diagnostics: 2 files · <summary>`）。判定方式：凡是实现了 `setToolActivityVisible` 的组件都得考虑给它一个 `setToolRowsFolded`，否则折叠后的记录里会残留大块横幅。

## 单行摘要文案

`src/tools/renderers.ts` 定义 `ToolActivitySummary { label; detail? }` 与 `ToolActivityContext { expanded; isPartial; spinnerFrame?; renderContext?; result?; theme }`；渲染器可选实现 `activitySummary`。detail 允许带主题样式（折叠行不额外包 muted），因此**渲染器自己负责把模型可控值过 `sanitizeDisplayWarning`/`shortenPath`**；组件只对 label 与通用兜底 detail 做净化。约定：文件/URL 目标用 `theme.fg("accent", …)`，模式/命令类细节用 `muted`，编辑增删用 `toolDiffAdded`/`toolDiffRemoved`（`Edit: path +6 -5`、`Write: path +42`）。设备派发（`write xd://<device>`）必须委派给 `xdevActivitySummary`，否则折叠行只会重复 URL：解析内层 JSON 取动词 + 对象（`ADB: shell logcat -d`、`ADB: pull /sdcard/shot.png`、`atlassian/…: CEN21-7022`），`?`/`help` 折叠为 `docs`。折叠行由 `ToolExecutionComponent.render()` 直接短路绘制（不查 display 树），并注意：运行中带 spinner、失败带 error 图标、steering/peer 中断（`#isBenignSkip`）保持中性、超宽用 `truncateToWidth` 截断。

## block 间距（重要）

转录容器在 block 之间插空行，而**空行只能由后一个块在写出时决定**：折叠行的运行是开放的，先写「尾随空行」无法撤回，就会出现「工具行之间偶尔多一行、resize 后消失（replay 重算）」或「快照路径写下的空行连 replays 都带着」。正确模型：

- `TranscriptContainer` 维护 `#tapeTail = { component, separated }`，记录终端里最后一个已写 block 与它后面是否已有空行。
- 任何一批（`#renderSelection`、`renderViewport`、快照分支）在写第一个 block 时，用 `#keepsBlankBetween(前一个块, 这个块)` 决定是否补一行前导空行；同一个块自己续写（`previous === 当前组件`）不补。
- 尾随空行只在「最后一块不是折叠工具行」时才写；折叠行一律留给后继决定。
- 批次创建（commit/append/snapshot/replay，含 `rerenderOfferedBatch`）后都要 `#recordTapeTail(...)`；full replay 先把 `#tapeTail` 清空再渲染。
- 判定函数只有一处：相邻两个折叠工具行 → 不空行；其余（模型文字、用户消息、完整卡片、任一侧未知）→ 保留空行。

回归测试：在 `test/interactive-terminal-e2e.test.ts` 里挂入多个折叠工具卡片、逐张 settle 让它们各自退休到原生历史，扫描滚动缓冲找「上下都是工具行」的空行，并断言 resize 前后都为 0（旧实现会在此报出 2~3 处）。

## 验证

- 单元：新建 `test/<feature>.test.ts`，覆盖“折叠后恰好一行/展开后恢复”“失败与中断的可辨识性”“模型可控参数被净化且不超一行”“容器对后加入 block 也生效”“折叠行之间无空行、与文字之间有空行”“每类活动行（工具/注入/提醒/诊断）的文案与配色”。
- 真实 TUI：`test/interactive-terminal-e2e.test.ts` 用 `VirtualTerminal` + `InteractiveMode` 驱动：把 ToolExecutionComponent 直接 `mode.chatContainer.addChild(...)`（比塞 messages 更可控，手写 messages 在重建路径上会丢第二个工具行），推进帧让它进入原生历史 → `term.sendInput` 发按键（legacy 形态，如 `\x1bo`/`\x1bO`）→ 断言滚动缓冲。该文件有历史遗留失败（例如 `hideToolActivity` 的 alt+o 用例），跑之前先 `git stash` 对照基线。
- 视觉：临时脚本复用 `src/cli/gallery-fixtures` 与 `renderGalleryState` 的思路逐条打印折叠行；跑完删掉脚本。
