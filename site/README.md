# MailAgent 官网（site/）

MailAgent 的**公开官网** —— 营销 Landing + 双语「101」使用指南。独立的 Astro 6 + Starlight 项目，与 `frontend/`（electron app）、Python 后端并列，同在 `main`。**与 `mail.chenge.ink/app`（CF Access 鉴权后的产品 app）是两套独立部署**：本站要部署成**不在 Access 后**的公开 Cloudflare Pages 项目。

## 技术栈

Astro 6 · Starlight 0.40（双语文档：sidebar/搜索 Pagefind/TOC/i18n）· React 19 islands · Tailwind v3（PostCSS）· nanostores（主题/强调色/语言）· 自托管字体（@fontsource）。

> 🔴 **Astro 6 不兼容 `@astrojs/tailwind`** —— Tailwind v3 走 `postcss.config.mjs` + `@tailwind` 指令，**勿重新引入 `@astrojs/tailwind`**。

## 命令

```bash
cd site
pnpm install
pnpm dev            # 本地开发（localhost:4321）
pnpm build          # 构建静态站 → dist/
pnpm astro check    # 类型闸（build 默认不 typecheck，提交前必跑）
pnpm preview        # 预览 dist/
pnpm check:tokens   # 校验 tokens.css 与产品 index.css 是否漂移
```

## 结构

```
src/
├─ styles/tokens.css     # 设计 token SSoT（从产品 frontend/src/electron/renderer/index.css 派生）
├─ styles/global.css     # 复刻参考稿组件层（.window/.aif/.pi-*/.rep-*/.dash/.phone…）
├─ content/
│  ├─ docs/{101,agent}/<slug>.md       # 101 文档（zh root）
│  ├─ docs/en/{101,agent}/<slug>.md    # en（关键页，其余缺译自动 fallback 到 zh）
│  └─ landing/{zh-CN,en}.yaml          # 营销文案（改 yaml 即更新）
├─ components/
│  ├─ landing/*.astro    # 14 营销区块
│  └─ mock/*.tsx         # 真实 React mock 组件（纯展示、假数据、零真实 API）
├─ layouts/Landing.astro # 营销页布局（非 Starlight 主题）
├─ pages/{index,en/index}.astro        # 营销 landing 入口
└─ lib/{theme,i18n}.ts
```

## 内容维护（markdown 驱动）

- **改文档**：编辑 `src/content/docs/...` 的 `.md`，dev 热更新 / build 重渲染。
- **改营销文案**：编辑 `src/content/landing/{zh-CN,en}.yaml`，零碰组件。
- **加语言**：`astro.config.mjs` 加 locale + 建 `docs/<locale>/` 目录 + `landing/<locale>.yaml`。
- **改主题色**：`tokens.css`（保持与产品派生关系，跑 `pnpm check:tokens`）。

## 部署（Cloudflare Pages）

静态输出（`output: 'static'`）。CF Pages 项目：构建命令 `cd site && pnpm install && pnpm build`，输出目录 `site/dist`；或 `wrangler pages deploy site/dist`。域名待定（占位 `mailagent.pages.dev`，见 PRD 开放问题 Q1）。

## 设计与规划

PRD / 架构 / 101 内容规格 → [`../.trellis/tasks/06-15-landing-page-101-redesign/`](../.trellis/tasks/06-15-landing-page-101-redesign/)。设计参考稿 → [`../frontend/docs/landing/`](../frontend/docs/landing/)。
