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
      // 🔴 08-02 review F9 — 本地遗留的构建产物（`frontend/index.js` / `index-<hash>.js`，实测
      // 6.9MB minified bundle）。.gitignore 已排它们，但 eslint flat config **不读 .gitignore**，
      // 于是本地每次 `pnpm lint` 都去解析这坨 —— 它一个人就贡献 2121 个 error，也是
      // `pnpm lint` 4GB/8GB 两次 OOM 的主因。CI 上没有这些文件（未跟踪），所以这条只影响本地，
      // 但没有它「本地跑不完 lint」会一直是「没人看得见 lint」的根因。
      'index.js',
      'index-*.js',
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
      // 🔴 存量债的临时降级（08-02 review F9）。这三条规则本身是对的，降级**只是**为了让
      // `eslint --quiet` 能作为 CI 闸立刻立起来防住新增 error —— 存量 21 处的修复各自需要真实
      // 渲染验证，混进一批会让「验证」失焦：
      //   * react-refresh/only-export-components（9 处）：组件与 helper 混放。正确修法是拆文件，
      //     但 _cardShell / custom-agent shared 各有 16 个 import 点，diff 规模够独立成批。
      //   * react-hooks/refs + set-state-in-effect（12 处）：要改 render/effect 时机，有行为风险。
      // 降级为 warn 后它们仍在本地 lint 里可见，且新增的**其它** error 照常拦。
      // 🔴 修完存量后把这三行删掉（改回 recommended 的 error），否则闸会永久缺一块。
      'react-refresh/only-export-components': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
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
