// 08-12 win-port — Python 子进程 stdio 编码 env 的单源 + 两侧一致性闸。
//
// 病根 (Windows CI 实测): python.exe 的 stdout 默认跟随控制台 code page (cp1252),
// 本仓 CLI 帮助文本 / 后端日志大量中文 → 一输出就 UnicodeEncodeError 把进程打崩。
// 本文件钉三件事:
//   (a) win32 注入 PYTHONUTF8 + PYTHONIOENCODING;
//   (b) 🔴 非 win32 一个键都不注入 (macOS 零回归红线, 靠断言不靠注释);
//   (c) ps1 打包脚本里的手抄镜像与 TS 常量不漂 (ps1 不能 import TS)。
// spawn 落点侧的注入断言在 backend_lifecycle.test.ts / cli_runner.test.ts (各自复用
// 已有的 spawn/execa mock 骨架), 不在这里重搭一套。

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

import { PYTHON_UTF8_ENV, pythonStdioEnv } from '../../src/electron/main/python_stdio_env'

describe('pythonStdioEnv — 平台分支', () => {
  test('win32: 注入 PYTHONUTF8=1 + PYTHONIOENCODING=utf-8', () => {
    expect(pythonStdioEnv('win32')).toEqual({
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8'
    })
  })

  test('🔴 darwin: 空对象 — 展开进 env 后与改动前逐字节一致 (零回归红线)', () => {
    const injected = pythonStdioEnv('darwin')
    expect(Object.keys(injected)).toHaveLength(0)
    // 展开语义等价断言: 老 env 对象 spread 新注入后必须完全不变。
    const before = { PATH: '/usr/bin', MAILAGENT_DATA_ROOT: '/x' }
    expect({ ...before, ...injected }).toEqual(before)
  })

  test('linux 同样不注入 (门是 === win32 白名单, 不是 !== darwin 黑名单)', () => {
    expect(Object.keys(pythonStdioEnv('linux'))).toHaveLength(0)
  })

  test('默认参数取 process.platform (调用点不传值也能跟随真实平台)', () => {
    const orig = Object.getOwnPropertyDescriptor(process, 'platform')!
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      expect(pythonStdioEnv()).toEqual({ PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' })
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      expect(pythonStdioEnv()).toEqual({})
    } finally {
      Object.defineProperty(process, 'platform', orig)
    }
  })

  test('返回的是新对象 — 调用方改它不污染常量表', () => {
    const a = pythonStdioEnv('win32')
    a.PYTHONUTF8 = 'tampered'
    expect(pythonStdioEnv('win32').PYTHONUTF8).toBe('1')
    expect(PYTHON_UTF8_ENV.PYTHONUTF8).toBe('1')
  })
})

describe('PYTHON_UTF8_ENV ↔ build-python-venv.ps1 手抄镜像一致性', () => {
  // ps1 是 PowerShell, 不能 import TS 常量 → 只能镜像 + 建闸 (同 STALE_CMD_MARKER 先例)。
  // 少了这个闸: 改了 TS 侧键名/值而 ps1 没跟, Windows 构建自检会在下次 CI 才炸。
  const ps1 = readFileSync(
    fileURLToPath(new URL('../../scripts/build-python-venv.ps1', import.meta.url)),
    'utf8'
  )

  for (const [key, value] of Object.entries(PYTHON_UTF8_ENV)) {
    test(`ps1 顶部设了 $env:${key} = '${value}' (自检跑 python.exe 打中文不炸)`, () => {
      expect(ps1).toContain(`$env:${key} = '${value}'`)
    })

    test(`ps1 生成的 mailagent.cmd wrapper 里也 set ${key} (手动调试同款场景)`, () => {
      expect(ps1).toContain(`set ${key}=${value}`)
    })
  }
})
