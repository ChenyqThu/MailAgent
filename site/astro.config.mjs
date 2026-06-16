// @ts-check
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import starlightSidebarTopics from 'starlight-sidebar-topics'
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
