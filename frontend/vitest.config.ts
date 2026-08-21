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
    // 默认 5000ms 对本仓的重计算用例太紧：bot-avatar/shapes 的取景窗上界那几条要把
    // 全部形状 × 全表情 × gaze 四角都 renderAvatar 一遍（单文件跑就近 5s），
    // CustomAgentTab 的 findByRole 等待型用例同理。528 个测试文件在 forks 池里互抢 CPU 时
    // 它们会零星越线 —— 单跑恒绿、全量随机红，典型的资源饥饿而非断言失效。
    // 抬阈值不掩盖回归：真回归是断言失败，超时只反映机器有多忙（CI runner 比本机更慢）。
    testTimeout: 20_000,
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
