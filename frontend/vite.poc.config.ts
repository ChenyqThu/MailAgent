// chat-panel P4 Phase 00 spike — assistant-ui parity 截图 harness 的独立 vite config。
//
// 用法（从 frontend/ 下跑，不碰 electron-vite / vite.web 任一默认产物）：
//   node_modules/.bin/vite --config vite.poc.config.ts            # dev server (port 5199)
//   然后 Playwright 截 http://127.0.0.1:5199/?theme=dark&accent=teal 等组合。
//
// postcss.config.cjs（frontend 根）自动生效 → tailwind 处理 index.css；tailwind.config.ts
// 的 content globs 覆盖 src/electron/renderer/**，故 PoC 组件里的 ink-*/c-accent class 都会
// 被 JIT 生成。此 config 不被 build/test/typecheck 引用，纯 spike 取证工具。

import { resolve } from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: resolve(import.meta.dirname, 'poc/assistant-ui'),
  plugins: [react()],
  server: { port: 5199, strictPort: true, host: '127.0.0.1' },
  cacheDir: resolve(import.meta.dirname, 'node_modules/.vite-poc')
})
