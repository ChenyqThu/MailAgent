// DIRECTORY_SQL (Electron main, compose 补全的通讯录 lane) ↔ _CONTACT_DIRECTORY_SQL
// (Python, 远程 web `GET /api/email/contacts`) 逐字镜像闸（task 08-24 收尾批）。
//
// 背景: 桌面走 IPC 用 `frontend/src/electron/main/handlers/contacts.ts` 的 DIRECTORY_SQL,
// 远程 web 走 `src/repository/email_repository.py` 的 _CONTACT_DIRECTORY_SQL —— 两处文件
// 自己头顶都写着「🔴 与对侧逐字同款，必须同步改」，但此前从没有真正的闸盯着，改一处漏
// 一处 = 桌面与远程 web 的补全候选排除口径（merged_into / hidden_at / is_self 三类静默
// 压下去谁）悄悄劈叉，且没有报错、没有测试红，只是两端行为不一样。
//
// 两侧都用文本抽取（不 import 任一模块）: `handlers/contacts.ts` 顶层依赖 `electron`
// 的 `ipcMain`，在纯 node vitest 里直接 import 会炸（需要 electron mock，为了一条 SQL
// 常量去拉整个 handler 模块没必要）; Python 源码本来就不能被 vitest import。
//
// 比对口径: 抽取时核对过两份现状是**字节级完全一致**，故直接断言字符串相等。若未来
// 只是缩进/换行差异（语义不变）导致本闸报红，再改成「压缩连续空白为单空格后比较」的
// 归一化断言 —— 但那需要先人工确认差异确实是空白，不是列/条件被悄悄改了，不能为了让
// 闸变绿就无脑归一掩盖真的劈叉。
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const HERE = dirname(fileURLToPath(import.meta.url))
// frontend/tests/main → 上溯三级到仓库根。
const REPO_ROOT = resolve(HERE, '../../..')

const HANDLER_TS = resolve(REPO_ROOT, 'frontend/src/electron/main/handlers/contacts.ts')
const REPOSITORY_PY = resolve(REPO_ROOT, 'src/repository/email_repository.py')

function extractTsSql(src: string): string {
  const m = src.match(/const DIRECTORY_SQL = `([\s\S]*?)`/)
  expect(
    m,
    'handlers/contacts.ts 里没找到 `const DIRECTORY_SQL = `...`` —— 声明改形了，本闸抽取器需同步更新'
  ).not.toBeNull()
  return m![1]
}

function extractPySql(src: string): string {
  const m = src.match(/_CONTACT_DIRECTORY_SQL = """([\s\S]*?)"""/)
  expect(
    m,
    'email_repository.py 里没找到 `_CONTACT_DIRECTORY_SQL = """..."""` —— 声明改形了，本闸抽取器需同步更新'
  ).not.toBeNull()
  return m![1]
}

describe('DIRECTORY_SQL (TS) ↔ _CONTACT_DIRECTORY_SQL (Python) 逐字镜像', () => {
  test('两份 SQL 字节级相等', () => {
    const tsSql = extractTsSql(readFileSync(HANDLER_TS, 'utf8'))
    const pySql = extractPySql(readFileSync(REPOSITORY_PY, 'utf8'))
    expect(
      tsSql,
      'handlers/contacts.ts 的 DIRECTORY_SQL 与 email_repository.py 的 ' +
        '_CONTACT_DIRECTORY_SQL 劈叉 —— 桌面 IPC lane 与远程 web GET /api/email/contacts ' +
        '的补全候选排除口径（merged_into / hidden_at / is_self）不一致了，两处文件顶部都' +
        '自标「必须同步改」，请先核对这是笔误还是有意变更，再两侧同步改（不要只改测试）。'
    ).toBe(pySql)
  })
})

describe('抽取器失效必须红，不许平凡通过（canary）', () => {
  test('两侧找不到声明都要抛', () => {
    expect(() => extractTsSql('const X = 1\n')).toThrow()
    expect(() => extractPySql('X = 1\n')).toThrow()
  })
})
