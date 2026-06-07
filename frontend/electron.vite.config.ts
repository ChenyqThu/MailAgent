import { execSync } from 'child_process'
import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Build-time 构建标识注入（renderer）：解决「未 bump version / ad-hoc 重 build 时光看
// 版本号无法区分新旧构建」。git short hash + ISO build time 作为编译常量，StatusBar
// 显示在版本号旁（v0.4.0 · a1b2c3d）。取不到 git（tarball 构建等）退化 'unknown'，不让
// build 失败。web build（vite.web.config）不注入 → StatusBar 用 typeof guard 退化。
const GIT_HASH = ((): string => {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return 'unknown'
  }
})()
const BUILD_TIME = new Date().toISOString()

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/electron/main/index.ts') }
      }
    }
  },
  preload: {
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/electron/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/electron/renderer'),
    define: {
      __GIT_HASH__: JSON.stringify(GIT_HASH),
      __BUILD_TIME__: JSON.stringify(BUILD_TIME)
    },
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/electron/renderer'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/electron/renderer/index.html') }
      }
    }
  }
})
