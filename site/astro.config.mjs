// @ts-check
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import starlightSidebarTopics from 'starlight-sidebar-topics'
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
      // Component overrides:
      //  · SiteTitle → render the landing brand (coral star + wordmark) as a
      //    locale-correct link back to the marketing home (/ for zh, /en/ en).
      //  · Sidebar → render the topic switcher as a DROPDOWN (用户指南 / Agent
      //    指南) instead of two stacked groups. The starlight-sidebar-topics
      //    plugin (in `plugins` below) sets its own Sidebar override but spreads
      //    `...starlightConfig.components` after it, so THIS override wins and
      //    owns the topic-switcher rendering (here: the dropdown).
      components: {
        SiteTitle: './src/components/docs/DocsSiteTitle.astro',
        Sidebar: './src/components/docs/DocsSidebar.astro',
      },
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
      // Two guides as switchable TOPICS (dropdown switcher via DocsSidebar
      // override above). The starlight-sidebar-topics plugin OWNS the sidebar
      // (it errors if a top-level `sidebar:` is also configured), so the two
      // guides move into topics here. Each topic's `label` is per-locale keyed
      // by the BCP-47 `lang` value Astro's currentLocale resolves to — zh-CN
      // (root, also the required default-language key) + en-US (NOT the path
      // key 'en'); the plugin's getTranslation reads translations[currentLocale]
      // where currentLocale === the locale's `lang`. `link` points at the
      // topic's overview page (plugin localizes it to /en/ per route); `items`
      // are the exact content-spec slugs in order (§B user 16, §C agent 13).
      // The dropdown (DocsSidebar.astro) renders the switcher.
      plugins: [
        starlightSidebarTopics([
          {
            label: { 'zh-CN': '用户指南', 'en-US': 'User Guide' },
            link: '/101/overview/',
            icon: 'open-book',
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
            label: { 'zh-CN': 'Agent 指南', 'en-US': 'Agent Guide' },
            link: '/agent/overview/',
            icon: 'forward-slash',
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
        ]),
      ],
    }),
  ],
})
