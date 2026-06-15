/**
 * Tailwind v3 preset — mirrors frontend/tailwind.config.ts so Astro/Tailwind
 * utilities and the React islands share ONE token system. Every color maps to
 * a channels-only CSS var via `rgb(var(--x) / <alpha-value>)`, so `bg-ink-2/15`,
 * `text-coral`, `border-ink-border` etc. retint automatically on theme/accent
 * swap. Tokens live in src/styles/tokens.css (the SSoT, derived from the
 * product index.css).
 *
 * Run via PostCSS (postcss.config.mjs) — see that file for why not @astrojs/tailwind.
 */
import type { Config } from 'tailwindcss'

export default {
  // darkMode by attribute — we toggle data-theme on <html> (not a `.dark` class).
  darkMode: ['class', '[data-theme="dark"]'],
  content: [
    './src/**/*.{astro,html,js,jsx,ts,tsx,vue,svelte,md,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Surface / foreground — resolve to CSS vars in tokens.css.
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
          'fg-3': 'rgb(var(--ink-fg-3) / <alpha-value>)',
        },
        // Accent (coral by default) — swaps by data-accent.
        coral: 'rgb(var(--c-accent) / <alpha-value>)',
        'coral-hover': 'rgb(var(--c-accent-hi) / <alpha-value>)',
        'coral-dim': 'rgb(var(--c-accent-dim) / <alpha-value>)',
        'coral-fg': 'rgb(var(--c-accent-fg) / <alpha-value>)',
        // Semantic / chip palette — per product index.css naming.
        crit: 'rgb(var(--c-crit) / <alpha-value>)',
        urg: 'rgb(var(--c-urg) / <alpha-value>)',
        impt: 'rgb(var(--c-impt) / <alpha-value>)',
        norm: 'rgb(var(--c-norm) / <alpha-value>)',
        low: 'rgb(var(--c-low) / <alpha-value>)',
        ok: 'rgb(var(--c-ok) / <alpha-value>)',
        warn: 'rgb(var(--c-warn) / <alpha-value>)',
        fail: 'rgb(var(--c-fail) / <alpha-value>)',
        info: 'rgb(var(--c-info) / <alpha-value>)',
        ai: 'rgb(var(--c-ai) / <alpha-value>)',
      },
      fontFamily: {
        // Match the landing token families (tokens.css --font-*).
        display: ['Instrument Serif', 'Noto Sans SC', 'Georgia', 'serif'],
        sans: ['Space Grotesk', 'Noto Sans SC', '-apple-system', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SF Mono', 'monospace'],
      },
      maxWidth: {
        wrap: 'var(--maxw)',
      },
      transitionTimingFunction: {
        standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
        out: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
      borderRadius: {
        sm: 'var(--r-sm)',
        md: 'var(--r-md)',
        lg: 'var(--r-lg)',
        xl: 'var(--r-xl)',
        '2xl': 'var(--r-2xl)',
      },
    },
  },
  plugins: [],
} satisfies Config
