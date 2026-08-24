---
name: deepseek-vision-guard-regression
description: "Use when changing DeepSeek image capability, OpenAI completions vision guards, or OpenCode Go visual model discovery."
---

# DeepSeek visual model regression workflow

1. Query the resolved model through `bun --cwd=packages/coding-agent src/cli.ts models find <id> --json`; confirm the selected provider row explicitly advertises `input: ["text", "image"]`.
2. Trace request conversion through `packages/ai/src/providers/vision-guard.ts`. The generic DeepSeek guard can override otherwise-correct catalog metadata.
3. Confirm the provider's official endpoint documentation identifies the exact model as multimodal. Add only the documented exact model family to the visual exceptions; do not disable the generic DeepSeek HTTP 400 protection.
4. Add a request-conversion regression in `packages/ai/test/openai-completions-tool-result-images.test.ts`. Assert the emitted Chat Completions content contains `image_url`, while existing ordinary DeepSeek tests still assert the non-vision placeholder.
5. Run the focused test file and `bun --cwd=packages/ai run check`.
