// 跨语言常量一致性闸 — 防「开窗就绪门控卡死」回归。
//
// 背景 (真实事故 v0.2.2): 前端 createWindow 前 await backendMgr.waitReady() 等后端 DB
// 迁移完成, 判据曾是 `dbVersion === EXPECTED_DB_VERSION`。EXPECTED_DB_VERSION 是手抄的
// Python `SyncStore.DB_VERSION` (TS 无法 import Python 常量)。某次后端 bump 17→19 时漏改
// 前端常量 → `19 === 17` 恒假 → waitReady 等满 120s 超时才降级开窗 → 用户感知「App 打不开」。
//
// 双重防护:
//   • 运行时: 判据已改 `>=` (backend_lifecycle.ts probeDbReady), 前端常量落后也只是「下限」,
//     不再致命卡死。
//   • dev/CI: 本测试强制两者**恒等**, 谁 bump schema 漏同步前端常量, 这里立刻红 (替代记忆)。
//
// 纯静态读两个源文件 + 正则抽常量, 不 import 运行时模块 (避开 electron mock), 不碰 SQLite。
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const HERE = dirname(fileURLToPath(import.meta.url))
// frontend/tests/main → 上溯三级到仓库根。
const REPO_ROOT = resolve(HERE, '../../..')

describe('DB version 跨语言一致性 (开窗门控防卡死)', () => {
  test('前端 backend_lifecycle.EXPECTED_DB_VERSION === 后端 sync_store.DB_VERSION', () => {
    const pySrc = readFileSync(resolve(REPO_ROOT, 'src/mail/sync_store.py'), 'utf8')
    const tsSrc = readFileSync(
      resolve(REPO_ROOT, 'frontend/src/electron/main/backend_lifecycle.ts'),
      'utf8'
    )
    // 后端: `    DB_VERSION = 19  # ...` (class 属性, 行首仅空白; 排除 self.DB_VERSION / 注释)。
    const pyMatch = pySrc.match(/^\s*DB_VERSION\s*=\s*(\d+)/m)
    // 前端: `export const EXPECTED_DB_VERSION = 19`。
    const tsMatch = tsSrc.match(/export const EXPECTED_DB_VERSION\s*=\s*(\d+)/)

    expect(pyMatch, 'sync_store.py 里没找到 `DB_VERSION = <int>`').not.toBeNull()
    expect(tsMatch, 'backend_lifecycle.ts 里没找到 `export const EXPECTED_DB_VERSION = <int>`').not.toBeNull()

    const backendVersion = Number.parseInt(pyMatch![1], 10)
    const frontendExpected = Number.parseInt(tsMatch![1], 10)

    expect(
      frontendExpected,
      `前端门控 EXPECTED_DB_VERSION=${frontendExpected} 与后端 DB_VERSION=${backendVersion} 不一致。` +
        ` bump 后端 schema 后必须同步 frontend/src/electron/main/backend_lifecycle.ts。`
    ).toBe(backendVersion)
  })
})
