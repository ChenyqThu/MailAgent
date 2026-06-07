import { createRequire } from 'node:module'

import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

// CommonJS interop — the local plugin stays .cjs so ESLint's runtime (also
// CJS) can require it without ESM transformer surprises.
const require = createRequire(import.meta.url)
const localRules = require('./eslint-rules/index.cjs')

export default defineConfig(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      '**/*.gen.ts',
      'archive/**',
      'mockup-*.html',
      // ESLint plugin source uses CommonJS by design (loaded by ESLint runtime,
      // not bundled), and codegen scripts run under tsx — neither should be
      // linted as renderer/main TS.
      'eslint-rules/**',
      'scripts/**',
      // RuleTester fixtures intentionally contain banned tailwind classes /
      // raw hex / `@media (prefers-color-scheme)` as *invalid* examples;
      // linting the test file would re-flag them.
      'tests/**',
      // docs/ 下是一次性审计 / workflow 脚本（如 impeccable-review/*.mjs），与
      // scripts/** 同类——非产品 renderer/main 代码，不参与产品 lint。
      'docs/**'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh,
      mailagent: localRules
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
      // `_` 前缀 = 有意未使用（接口契约要求的位置参数 / 解构出但本实现不取的字段，
      // 如 chat 工具 handler 的 _ctx、http_platform 的 _senderAddr）。tseslint.recommended
      // 默认不豁免 `_`，这里显式开 ignorePattern 对齐业界约定（避免为消 lint 去删签名参数）。
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_'
        }
      ],
      // REVIEW-LOG H-08 / DESIGN.md §14 + §16.6 + §17 non-negotiables.
      'mailagent/no-raw-hex': 'error',
      'mailagent/no-banned-colors': 'error',
      'mailagent/no-large-radius': 'error',
      'mailagent/no-gradient-bg': 'error',
      'mailagent/no-heavy-shadow': 'error',
      'mailagent/no-grayscale-surface': 'error',
      'mailagent/no-coral-flood': 'error',
      'mailagent/no-cjk-in-mono-size': 'error',
      'mailagent/no-prefers-color-scheme': 'error'
    }
  },
  eslintConfigPrettier
)
