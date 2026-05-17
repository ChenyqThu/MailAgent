// Paste-ready from DESIGN.md §11. accent reads from CSS variables defined in
// src/electron/renderer/index.css per §2.7 — one --c-accent swap re-skins the UI.
import type { Config } from 'tailwindcss'

export default {
  darkMode: 'class',
  content: [
    './src/electron/renderer/index.html',
    './src/electron/renderer/**/*.{ts,tsx}',
    './src/shared/**/*.{ts,tsx}',
    './src/web/**/*.{ts,tsx}'
  ],
  theme: {
    extend: {
      colors: {
        ink: {
          0: '#0E1013',
          1: '#15181D',
          2: '#1A1E24',
          3: '#1F242B',
          4: '#262C35',
          5: '#2E343E',
          border: '#2C323B',
          'border-soft': '#1F242B',
          fg: '#E8EAEE',
          'fg-1': '#A4A9B3',
          'fg-2': '#6B707A',
          'fg-3': '#454A53'
        },
        coral: 'rgb(var(--c-accent) / <alpha-value>)',
        'coral-hover': 'rgb(var(--c-accent-hi) / <alpha-value>)',
        'coral-dim': 'rgb(var(--c-accent-dim) / <alpha-value>)',
        crit: '#E5634F',
        urg: '#E89B4A',
        impt: '#D4A53D',
        norm: '#7A7F8A',
        low: '#5A5E68',
        ok: '#5DBA8C',
        warn: '#E5B452',
        fail: '#E36262',
        dead: '#6B707A',
        info: '#6FA8DC',
        ai: '#B58CDB'
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
        statusbar: '24px',
        batchbar: '52px'
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
  plugins: []
} satisfies Config
