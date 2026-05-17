// Sprint 1.7 fixtures — each non-negotiable lint rule gets one valid + one
// invalid example. ESLint's RuleTester throws on missing reports / spurious
// reports, so the assertions are implicit: if `ruleTester.run` completes,
// the rule's selector + report() match the expected outputs.

import { createRequire } from 'node:module'
import { RuleTester } from 'eslint'
import { describe, test } from 'vitest'

const require = createRequire(import.meta.url)
const plugin = require('../eslint-rules/index.cjs') as {
  rules: Record<string, RuleTester.LintRuleDefinition>
}

const baseTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module'
  }
})

const jsxTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } }
  }
})

interface Case {
  rule: string
  tester: RuleTester
  valid: RuleTester.ValidTestCase[]
  invalid: RuleTester.InvalidTestCase[]
}

const cases: Case[] = [
  {
    rule: 'no-raw-hex',
    tester: baseTester,
    valid: [
      { code: "const c = 'bg-coral'", filename: 'src/foo.ts' },
      { code: "const c = '#0E1013'", filename: 'tailwind.config.ts' },
      { code: "const c = '#1A1E24'", filename: 'src/electron/main/index.ts' }
    ],
    invalid: [
      {
        code: "const c = '#E5654B'",
        filename: 'src/shared/components/foo.tsx',
        errors: [{ messageId: 'noHex' }]
      }
    ]
  },
  {
    rule: 'no-banned-colors',
    tester: baseTester,
    valid: [{ code: "const c = 'bg-coral/15 text-ink-fg'" }],
    invalid: [
      {
        code: "const c = 'bg-blue-500 text-purple-300'",
        errors: [{ messageId: 'banned' }, { messageId: 'banned' }]
      }
    ]
  },
  {
    rule: 'no-large-radius',
    tester: baseTester,
    valid: [
      { code: "const c = 'rounded-lg rounded-full'" },
      { code: "const c = 'rounded-[16px]'" }
    ],
    invalid: [
      { code: "const c = 'rounded-3xl'", errors: [{ messageId: 'named' }] },
      { code: "const c = 'rounded-[24px]'", errors: [{ messageId: 'arbitrary' }] }
    ]
  },
  {
    rule: 'no-gradient-bg',
    tester: baseTester,
    valid: [{ code: "const c = 'bg-ink-2 border-coral/30'" }],
    invalid: [
      {
        code: "const c = 'bg-gradient-to-tr from-blue-500 to-purple-600'",
        // gradient starter triggers first; the embedded blue/purple from-/to-
        // tokens are caught by no-banned-colors in production, but here the
        // rule under test reports the starter only.
        errors: [{ messageId: 'gradient' }]
      }
    ]
  },
  {
    rule: 'no-heavy-shadow',
    tester: baseTester,
    valid: [
      { code: "const c = 'shadow-sm'" },
      // Allowlist by path: components under /Toast or /island/ may use heavy shadows.
      {
        code: "const c = 'shadow-2xl'",
        filename: 'src/components/island/IslandFloat.tsx'
      }
    ],
    invalid: [
      {
        code: "const c = 'shadow-2xl'",
        filename: 'src/shared/components/layout/Sidebar.tsx',
        errors: [{ messageId: 'heavy' }]
      }
    ]
  },
  {
    rule: 'no-grayscale-surface',
    tester: baseTester,
    valid: [{ code: "const c = 'bg-ink-2 text-ink-fg border-ink-border'" }],
    invalid: [
      { code: "const c = 'bg-slate-800'", errors: [{ messageId: 'gray' }] },
      { code: "const c = 'text-zinc-300'", errors: [{ messageId: 'gray' }] }
    ]
  },
  {
    rule: 'no-coral-flood',
    tester: baseTester,
    valid: [
      { code: "const c = 'bg-coral/15'" },
      { code: "const c = 'bg-coral/100'" },
      { code: "const c = 'bg-coral-hover'" }
    ],
    invalid: [
      { code: "const c = 'bg-coral text-white'", errors: [{ messageId: 'bare' }] }
    ]
  },
  {
    rule: 'no-cjk-in-mono-size',
    tester: jsxTester,
    valid: [
      { code: 'const x = <span className="text-aux">未读</span>' },
      { code: 'const x = <span className="text-meta font-mono">2 min ago</span>' }
    ],
    invalid: [
      {
        code: 'const x = <span className="text-micro">未读</span>',
        errors: [{ messageId: 'cjk' }]
      },
      {
        code: 'const x = <span className="text-meta font-mono">收件箱</span>',
        errors: [{ messageId: 'cjk' }]
      }
    ]
  },
  {
    rule: 'no-prefers-color-scheme',
    tester: baseTester,
    valid: [
      {
        code: "const s = '[data-theme=\\\"dark\\\"] { color: white }'"
      }
    ],
    invalid: [
      {
        code: "const s = '@media (prefers-color-scheme: dark) { color: white }'",
        errors: [{ messageId: 'media' }]
      }
    ]
  }
]

for (const c of cases) {
  describe(c.rule, () => {
    test('valid + invalid fixtures', () => {
      const def = plugin.rules[c.rule]
      if (!def) throw new Error(`rule not registered: ${c.rule}`)
      c.tester.run(c.rule, def, { valid: c.valid, invalid: c.invalid })
    })
  })
}
