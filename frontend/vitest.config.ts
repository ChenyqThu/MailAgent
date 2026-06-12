// Vitest config — node env (no jsdom). Handler tests build an in-memory
// sqlite fixture against the real cli-schema JSON files; cli_runner tests
// mock execa; ESLint rule tests run RuleTester against the local plugin.

import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx,cjs}'],
    environment: 'node',
    pool: 'forks', // better-sqlite3 + native bindings prefer process isolation
    // 全局 setup：在 happy-dom 组件测试里强制 reduced-motion，让 GSAP 动画
    // no-op（详见 tests/setup.ts）。node 环境测试自动跳过。
    setupFiles: ['./tests/setup.ts'],
    // 固定时区：EmailRow 等渲染 snapshot 含本地化时间字符串（row-time），
    // 写入时机器时区为 America/Los_Angeles；不钉死的话换时区的机器上
    // snapshot 全挂（曾在 Asia/Shanghai 下 8 个全红）。选钉 LA 而非 UTC
    // 重录 = 零 snapshot churn。
    env: { TZ: 'America/Los_Angeles' }
  },
  // React 19 automatic JSX runtime so .tsx test files don't need an explicit
  // `import React from 'react'`. Matches the tsconfig.web.json `jsx:react-jsx`
  // setting electron-vite already runs through esbuild for the renderer.
  esbuild: {
    jsx: 'automatic'
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  }
})
