# CLAUDE.md — site/（公开官网：Landing + 101）

> 从根 `CLAUDE.md` 下沉的官网专属指南；动 `site/` 下文件时自动加载。

仓库根 `site/` 是**独立的公开官网**（Astro 6 + Starlight，与 `frontend/` electron app、Python 后端并列，同在 `main`）：营销 landing（复刻 `frontend/docs/landing/` 设计稿，14 区块，暗/亮 + 6 强调色 + 中英双语，**用真实 React mock 组件替代截图**）+ 双语「101」使用指南（用户 16 页 / agent 13 页，zh 全量、en 关键页 + 缺译 fallback）。**与 `mail.chenge.ink/app`（在 CF Access 鉴权墙后的产品 app）是两套独立部署** —— 公开站**已上线**为**不在 Access 后**的独立 Cloudflare Pages 项目（`mailagent-site`），线上 **https://mailagent.chenge.ink**（2026-06-16 上线）。

- **内容 markdown 驱动**：101 文档 = `site/src/content/docs/{101,agent}/<slug>.md`（zh root + `en/`，Starlight 同名文件自动关联 + 缺译 fallback）；营销文案 = `site/src/content/landing/{zh-CN,en}.yaml`（改 yaml 即更新，零碰组件）。加语言 = 加 locale + 目录 + yaml。
- **设计 token** = `site/src/styles/tokens.css`，**从产品 `frontend/src/electron/renderer/index.css` 派生**（用产品 oklch coral `248 138 125`，非参考稿旧 `#E5654B`）；`pnpm check:tokens` 校验漂移。mock 组件在 `site/src/components/mock/`（纯展示、假数据、零真实 API）。
- **命令**：`cd site && pnpm install`（独立 pnpm 项目）；`pnpm dev`（开发）/ `pnpm build`（→ `dist/`，静态）/ `pnpm astro check`（类型闸，build 默认不 typecheck）/ `pnpm preview`。**Astro 6 不兼容 `@astrojs/tailwind`** —— Tailwind v3 走 PostCSS，勿重新引入。
- **规划/设计文档**（PRD/架构/101 内容规格）：`.trellis/tasks/06-15-landing-page-101-redesign/{prd,architecture,content-spec-101}.md`。
- **部署**：✅ 已上线 **Cloudflare Pages**（项目 `mailagent-site`，生产分支 `main`，公开不在 Access 后）→ 自定义域 **https://mailagent.chenge.ink**（proxied CNAME → `mailagent-site.pages.dev`）。发布 = `cd site && pnpm build` 后 `npx wrangler pages deploy site/dist --project-name=mailagent-site`。🔴 `pages deploy` 在无 TTY 的 shell 拒用 OAuth（报 non-interactive），需交互终端跑或设 `CLOUDFLARE_API_TOKEN`；CF 部署/域名 token 存 `~/.config/cloudflare/mailagent-site.env`（**repo 外，勿入库**）。自定义域改指/DNS 操作走 custom API token（`Account·Pages:Edit` + `Zone·DNS:Edit` + `Zone:Read`）—— CF 的 OAuth token 不被 REST API 接受。
