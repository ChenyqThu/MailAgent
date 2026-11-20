# AGENTS.md — site/（公开官网：Landing + 101）

> 单一真相在 [`site/CLAUDE.md`](./CLAUDE.md)。改动 `site/` 下文件时请先读取 [`site/CLAUDE.md`](./CLAUDE.md)。

## 速查约束

- 独立 pnpm 项目（Astro 6 + Starlight + Tailwind v3 PostCSS），**勿引入 `@astrojs/tailwind`**。
- 设计 token 位于 `site/src/styles/tokens.css`（派生自 `frontend/src/electron/renderer/index.css`），改后运行 `cd site && pnpm check:tokens`。
- 类型检查：`cd site && pnpm astro check`；构建：`cd site && pnpm build`。
