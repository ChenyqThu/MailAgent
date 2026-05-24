// Paste-ready from DESIGN.md §11. accent reads from CSS variables defined in
// src/electron/renderer/index.css per §2.7 — one --c-accent swap re-skins the UI.
import type { Config } from 'tailwindcss'
// Sprint 18 — Radix data-state animations (open/closed, side, etc.) need the
// tailwindcss-animate plugin. It ships only utility classes (`animate-in`,
// `data-[state=open]:animate-in`, …); no theme additions, no token changes.
import animate from 'tailwindcss-animate'

export default {
  darkMode: 'class',
  content: [
    './src/electron/renderer/index.html',
    './src/electron/renderer/**/*.{ts,tsx}',
    './src/shared/**/*.{ts,tsx}',
    './src/web/**/*.{ts,tsx}',
    // Sprint 19 — Streamdown 用 shadcn-style utility class (bg-muted /
    // border-border / text-card-foreground 等), Tailwind v3 不会自动扫
    // node_modules. 加这条让 Tailwind 看到 streamdown dist 用了哪些
    // class, 才会生成对应 CSS rule. shadcn token 映射见 index.css
    // :root --background / --muted / --card / --border / --primary.
    './node_modules/streamdown/dist/**/*.js'
  ],
  theme: {
    extend: {
      colors: {
        // All `ink-*` tokens resolve to CSS variables defined in index.css.
        // `:root` block holds dark; `:root[data-theme="light"]` block holds
        // light. DESIGN.md §2.1 maps both sides 1:1. The previous Sprint 1
        // wiring hardcoded hex values — Light mode toggle changed
        // data-theme but every `bg-ink-0` stayed dark because Tailwind had
        // baked the hex at build time.
        ink: {
          0: 'rgb(var(--ink-0) / <alpha-value>)',
          1: 'rgb(var(--ink-1) / <alpha-value>)',
          2: 'rgb(var(--ink-2) / <alpha-value>)',
          3: 'rgb(var(--ink-3) / <alpha-value>)',
          4: 'rgb(var(--ink-4) / <alpha-value>)',
          5: 'rgb(var(--ink-5) / <alpha-value>)',
          border: 'rgb(var(--ink-border) / <alpha-value>)',
          'border-soft': 'rgb(var(--ink-border-soft) / <alpha-value>)',
          fg: 'rgb(var(--ink-fg) / <alpha-value>)',
          'fg-1': 'rgb(var(--ink-fg-1) / <alpha-value>)',
          'fg-2': 'rgb(var(--ink-fg-2) / <alpha-value>)',
          'fg-3': 'rgb(var(--ink-fg-3) / <alpha-value>)'
        },
        coral: 'rgb(var(--c-accent) / <alpha-value>)',
        'coral-hover': 'rgb(var(--c-accent-hi) / <alpha-value>)',
        'coral-dim': 'rgb(var(--c-accent-dim) / <alpha-value>)',
        // Sprint 19 — shadcn token 别名, 映射到现有 ink/coral 系统. Streamdown
        // 内部用这些 class 名, 我们走 channels-only CSS var 套 rgb(var()/<alpha>)
        // 跟 ink-* 保持一致风格 + 支持 /15 /50 alpha modifier.
        background: 'rgb(var(--ink-3) / <alpha-value>)',
        foreground: 'rgb(var(--ink-fg) / <alpha-value>)',
        muted: 'rgb(var(--ink-4) / <alpha-value>)',
        'muted-foreground': 'rgb(var(--ink-fg-2) / <alpha-value>)',
        border: 'rgb(var(--ink-border) / <alpha-value>)',
        input: 'rgb(var(--ink-border) / <alpha-value>)',
        card: 'rgb(var(--ink-2) / <alpha-value>)',
        'card-foreground': 'rgb(var(--ink-fg) / <alpha-value>)',
        primary: 'rgb(var(--c-accent) / <alpha-value>)',
        'primary-foreground': 'rgb(var(--c-accent-fg) / <alpha-value>)',
        secondary: 'rgb(var(--ink-4) / <alpha-value>)',
        'secondary-foreground': 'rgb(var(--ink-fg) / <alpha-value>)',
        accent: 'rgb(var(--ink-4) / <alpha-value>)',
        'accent-foreground': 'rgb(var(--ink-fg) / <alpha-value>)',
        destructive: 'rgb(var(--c-fail) / <alpha-value>)',
        'destructive-foreground': 'rgb(var(--c-accent-fg) / <alpha-value>)',
        popover: 'rgb(var(--ink-2) / <alpha-value>)',
        'popover-foreground': 'rgb(var(--ink-fg) / <alpha-value>)',
        ring: 'rgb(var(--c-accent) / <alpha-value>)',
        // Sprint 4 a11y carry-forward (REVIEW-LOG H-01): on-accent CTA
        // foreground. Replaces hardcoded `text-white` on `bg-coral/100`
        // which failed WCAG AA on every accent swatch.
        'accent-fg': 'rgb(var(--c-accent-fg) / <alpha-value>)',
        // Sprint 4 a11y carry-forward (REVIEW-LOG H-01): chip palette
        // moved to CSS variables so dark / light each get a foreground
        // that clears AA over bg-X/15. See index.css :root + :root[data-theme='light']
        // blocks for the per-mode triples.
        crit: 'rgb(var(--c-crit) / <alpha-value>)',
        urg: 'rgb(var(--c-urg) / <alpha-value>)',
        impt: 'rgb(var(--c-impt) / <alpha-value>)',
        norm: 'rgb(var(--c-norm) / <alpha-value>)',
        low: 'rgb(var(--c-low) / <alpha-value>)',
        ok: 'rgb(var(--c-ok) / <alpha-value>)',
        warn: 'rgb(var(--c-warn) / <alpha-value>)',
        fail: 'rgb(var(--c-fail) / <alpha-value>)',
        dead: '#6B707A',
        info: 'rgb(var(--c-info) / <alpha-value>)',
        ai: 'rgb(var(--c-ai) / <alpha-value>)'
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Text"',
          '"PingFang SC"',
          '"Helvetica Neue"',
          'system-ui',
          'sans-serif'
        ],
        display: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Display"',
          '"PingFang SC"',
          'system-ui',
          'sans-serif'
        ],
        mono: ['ui-monospace', '"SF Mono"', '"JetBrains Mono"', 'Menlo', 'monospace']
      },
      fontSize: {
        micro: ['11px', '14px'],
        meta: ['12px', '16px'],
        aux: ['14px', '20px'],
        body: ['14px', '20px'],
        lead: ['15px', '22px'],
        subj: ['22px', '30px']
      },
      spacing: {
        titlebar: '36px',
        statusbar: '24px'
      },
      transitionTimingFunction: {
        standard: 'cubic-bezier(0.4, 0, 0.2, 1)'
      },
      transitionDuration: {
        fast: '120ms',
        base: '220ms',
        slow: '380ms'
      },
      keyframes: {
        'pulse-crit': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(229,99,79,0.7)' },
          '70%': { boxShadow: '0 0 0 8px rgba(229,99,79,0)' }
        }
      },
      animation: {
        'pulse-crit': 'pulse-crit 1.6s infinite'
      }
    }
  },
  plugins: [animate]
} satisfies Config
