// @ts-check
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import react from '@astrojs/react'
import sitemap from '@astrojs/sitemap'

// https://astro.build/config
export default defineConfig({
  // Production domain. The site is deployed to Cloudflare Pages (project
  // `mailagent-site`, production branch `main`); mailagent.chenge.ink is a
  // proxied CNAME → mailagent-site.pages.dev (custom domain on the Pages
  // project, NOT behind CF Access). Drives sitemap/canonical/hreflang/OG
  // absolute URLs — keep this value. Publish with:
  //   npx wrangler pages deploy site/dist --project-name=mailagent-site
  site: 'https://mailagent.chenge.ink',
  // SSG: per-locale static HTML, served by any static host (Cloudflare Pages).
  output: 'static',
  integrations: [
    react(),
    sitemap(),
    starlight({
      title: 'MailAgent',
      favicon: '/favicon.svg',
      // Component overrides: only SiteTitle (landing brand → locale-correct link
      // back to the marketing home, / for zh, /en/ for en). The sidebar uses
      // Starlight's DEFAULT render over the single unified `sidebar` tree below.
      // The old starlight-sidebar-topics dropdown + its DocsSidebar override were
      // retired when the 用户指南/Agent 指南 受众二分 was merged into ONE
      // journey-based tree (开始使用 → 日常邮件 → AI 能力 → 自动化与集成 → 运维排障).
      components: {
        SiteTitle: './src/components/docs/DocsSiteTitle.astro',
      },
      // Make /docs/* follow the landing's theme, dark-first, with the SAME
      // light/dark state shared BIDIRECTIONALLY between landing and docs.
      //
      // Two stores exist: the landing owns `data-theme` via the nanostore
      // $theme (localStorage 'ma_theme', default 'dark'); Starlight has its own
      // 'starlight-theme' key. Treating them as ONE source of truth needs sync
      // BOTH ways — a one-way landing→docs seed alone drifts, because the
      // in-docs Starlight theme select writes only 'starlight-theme', so on the
      // next navigation the seed clobbers that choice back to the stale
      // 'ma_theme' (symptom: picker shows one theme while the page renders the
      // other).
      //
      // This inline head script (runs before paint, before Starlight's own
      // ThemeProvider, so its closure + picker reconcile to our value):
      //   1. SEED: read ma_theme (unset/anything but 'light' → 'dark'), apply to
      //      <html data-theme>, mirror into 'starlight-theme' so Starlight agrees.
      //   2. WRITE-BACK: a MutationObserver mirrors any later data-theme change
      //      (i.e. the in-docs theme select) back into 'ma_theme', so the choice
      //      persists across navigation and propagates to the landing. The guard
      //      skips redundant writes; documentElement already exists in <head>.
      head: [
        {
          tag: 'script',
          content: `(function(){try{var K='ma_theme',S='starlight-theme';var t=localStorage.getItem(K);var theme=(t==='light')?'light':'dark';var r=document.documentElement;r.dataset.theme=theme;localStorage.setItem(S,theme);new MutationObserver(function(){var c=r.dataset.theme==='light'?'light':'dark';if(localStorage.getItem(K)!==c)localStorage.setItem(K,c);}).observe(r,{attributes:true,attributeFilter:['data-theme']});}catch(e){document.documentElement.dataset.theme='dark';}})();`,
        },
      ],
      // zh-CN is the default locale (root, no /zh/ prefix); en lives under /en/.
      defaultLocale: 'root',
      locales: {
        root: { label: '简体中文', lang: 'zh-CN' },
        en: { label: 'English', lang: 'en-US' },
      },
      // Token SSoT + ported component layer + minimal theme overrides.
      // Order matters: tokens first, then component layer, then docs overrides.
      customCss: [
        './src/styles/tokens.css',
        './src/styles/global.css',
        './src/styles/docs.css',
      ],
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/ChenyqThu/MailAgent' },
      ],
      // ── Single unified docs tree (one journey, no 用户 vs agent split) ──
      // Group labels are per-locale keyed by the BCP-47 `lang` Astro resolves
      // (zh-CN root / en-US), matching the `locales` lang values above; en pages
      // missing a translation fall back to zh via Starlight's built-in fallback.
      // `slug` items pull their title from each page's frontmatter. The former
      // agent/* CLI reference (15 pages) + the developer-only initial-sync /
      // install-backend live under the nested 「CLI 与自动化」 subgroup so the
      // everyday-user path (开始使用 → 日常邮件 → AI 能力) stays clean.
      sidebar: [
        {
          label: '开始使用',
          translations: { 'en-US': 'Getting Started' },
          items: [
            { slug: '101/overview' },
            { slug: '101/install-app' },
            { slug: '101/davmail-setup' },
            { slug: '101/onboarding' },
          ],
        },
        {
          label: '日常邮件',
          translations: { 'en-US': 'Daily Email' },
          items: [
            { slug: '101/daily-inbox' },
            { slug: '101/search' },
            { slug: '101/compose-reply' },
            { slug: '101/calendar' },
          ],
        },
        {
          label: 'AI 能力',
          translations: { 'en-US': 'AI Features' },
          items: [
            { slug: '101/ai-chat' },
            { slug: '101/reports' },
          ],
        },
        {
          label: '自动化与集成',
          translations: { 'en-US': 'Automation & Integrations' },
          items: [
            { slug: '101/ping-island' },
            { slug: '101/feishu' },
            { slug: '101/remote-web' },
            {
              label: 'CLI 与自动化',
              translations: { 'en-US': 'CLI & Automation' },
              items: [
                { slug: 'agent/overview' },
                { slug: 'agent/setup' },
                { slug: 'agent/output-formats' },
                { slug: 'agent/exit-codes' },
                { slug: 'agent/auth' },
                { slug: 'agent/commands' },
                { slug: 'agent/long-tasks' },
                { slug: 'agent/json-schema' },
                { slug: 'agent/sse' },
                { slug: 'agent/webhook-redis' },
                { slug: 'agent/search-dsl' },
                { slug: 'agent/mcp-harness' },
                { slug: 'agent/mcp-setup' },
                { slug: 'agent/skill-delivery' },
                { slug: 'agent/ops' },
                { slug: '101/initial-sync' },
                { slug: '101/install-backend' },
              ],
            },
          ],
        },
        {
          label: '运维排障',
          translations: { 'en-US': 'Ops & Troubleshooting' },
          items: [
            { slug: '101/updates' },
            { slug: '101/troubleshooting' },
          ],
        },
      ],
    }),
  ],
})
