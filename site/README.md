# MailAgent 官网（site/）

MailAgent 的**公开官网** —— 营销 Landing + 双语「101」使用指南。独立的 Astro 6 + Starlight 项目，与 `frontend/`（electron app）、Python 后端并列，同在 `main`。**与 `mail.chenge.ink/app`（CF Access 鉴权后的产品 app）是两套独立部署**：本站**已上线**为**不在 Access 后**的公开 Cloudflare Pages 项目 `mailagent-site` —— **[mailagent.chenge.ink](https://mailagent.chenge.ink)**。

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

✅ **已上线**：**[mailagent.chenge.ink](https://mailagent.chenge.ink)**（亦可 `mailagent-site.pages.dev`）。

静态输出（`output: 'static'`）。CF Pages 项目 **`mailagent-site`**（生产分支 `main`，公开、不在 CF Access 后）。发布 = 重建 dist 后直传：

```bash
cd site && pnpm build
npx wrangler pages deploy site/dist --project-name=mailagent-site
```

- 🔴 `wrangler pages deploy` 在无 TTY 的 shell 里**拒用 OAuth**（报 non-interactive）—— 需交互终端跑，或设 `CLOUDFLARE_API_TOKEN`。
- CF 部署/域名 token 存 `~/.config/cloudflare/mailagent-site.env`（**repo 外，勿入库**）。
- 自定义域 = proxied CNAME `mailagent.chenge.ink → mailagent-site.pages.dev`；DNS/域名操作走 custom API token（`Account·Pages:Edit` + `Zone·DNS:Edit` + `Zone:Read`，CF 的 OAuth token 不被 REST API 接受）。

## 设计与规划

PRD / 架构 / 101 内容规格 → [`../.trellis/tasks/06-15-landing-page-101-redesign/`](../.trellis/tasks/06-15-landing-page-101-redesign/)。设计参考稿 → [`../frontend/docs/landing/`](../frontend/docs/landing/)。
