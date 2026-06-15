// @ts-check
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import react from '@astrojs/react'
import sitemap from '@astrojs/sitemap'

// https://astro.build/config
export default defineConfig({
  // Production domain — bound 2026-06-15 via a dedicated cloudflared tunnel
  // (mailagent-site → local static serve of dist). Drives sitemap/canonical/
  // hreflang/OG absolute URLs. If later moved to CF Pages, keep this value.
  site: 'https://mailagent.chenge.ink',
  // SSG: per-locale static HTML, served by any static host (Cloudflare Pages).
  output: 'static',
  integrations: [
    react(),
    sitemap(),
    starlight({
      title: 'MailAgent',
      favicon: '/favicon.svg',
      // Make /docs/* follow the landing's theme, dark-first. The landing owns
      // `data-theme` via the nanostore $theme (localStorage 'ma_theme', default
      // 'dark'); Starlight is otherwise independent (own 'starlight-theme' key,
      // defaults to 'auto' → follows OS). This inline head script runs before
      // paint: it reads ma_theme (unset/anything but 'light' → 'dark'), applies
      // it to <html data-theme>, and seeds Starlight's own key so its theme
      // toggle shows the right state and its ThemeProvider agrees. One-way
      // landing→docs sync (in-docs toggle still works as an override). Placed
      // first in `head` so it precedes Starlight's own ThemeProvider script.
      head: [
        {
          tag: 'script',
          content: `(function(){try{var t=localStorage.getItem('ma_theme');var theme=(t==='light')?'light':'dark';document.documentElement.dataset.theme=theme;localStorage.setItem('starlight-theme',theme);}catch(e){document.documentElement.dataset.theme='dark';}})();`,
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
      // Two guides. Items point at the 101/<slug> and agent/<slug> stubs in the
      // exact content-spec order (§B user 16, §C agent 13). en group labels via
      // `translations`. Docs stubs are created by M0; Lane B/C fill the prose.
      sidebar: [
        {
          label: '用户指南',
          translations: { 'en-US': 'User Guide' },
          items: [
            { slug: '101/overview' },
            { slug: '101/install-backend' },
            { slug: '101/initial-sync' },
            { slug: '101/install-app' },
            { slug: '101/onboarding' },
            { slug: '101/daily-inbox' },
            { slug: '101/search' },
            { slug: '101/ai-chat' },
            { slug: '101/compose-reply' },
            { slug: '101/calendar' },
            { slug: '101/ping-island' },
            { slug: '101/remote-web' },
            { slug: '101/feishu' },
            { slug: '101/reports' },
            { slug: '101/updates' },
            { slug: '101/troubleshooting' },
          ],
        },
        {
          label: 'Agent 指南',
          translations: { 'en-US': 'Agent Guide' },
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
            { slug: 'agent/ops' },
          ],
        },
      ],
    }),
  ],
})
