// chat-panel P4 Phase 04a — A2UI tool-card 截图 harness 的独立 vite config（沿用 Phase 00 模式）。
//
// 用法（从 frontend/ 下跑，不碰 electron-vite / vite.web 任一默认产物）：
//   node_modules/.bin/vite --config vite.poc.config.ts            # dev server (port 5199)
//   然后 Playwright 截 http://127.0.0.1:5199/?theme=dark&accent=coral 等组合。
//
// postcss.config.cjs（frontend 根）自动生效 → tailwind 处理 index.css；tailwind content globs
// 覆盖 src/**，故卡片里的 ink-*/c-accent class 都会被 JIT 生成。@shared alias 对齐 vite.web /
// electron.vite（卡片内部用 @shared/lib/cn）。此 config 不被 build/test/typecheck 引用，纯取证工具。

import { resolve } from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: resolve(import.meta.dirname, 'poc/cards'),
  plugins: [react()],
  resolve: {
    alias: { '@shared': resolve(import.meta.dirname, 'src/shared') }
  },
  // S3 (07-02) — the A2UI/runtime flag defines are gone (GA'd away): the rich cards are
  // always mounted, so the preview harness needs no flag forcing.
  server: { port: 5199, strictPort: true, host: '127.0.0.1' },
  cacheDir: resolve(import.meta.dirname, 'node_modules/.vite-poc')
})
