// task 08-20 Notion OAuth —— main 写的 env 键集 ↔ renderer 用的 NOTION_OAUTH_ENV_KEYS
// 一致性闸（Lane 3）。
//
// 为什么需要它：授权成功 / 移除连接后，renderer 拿 NOTION_OAUTH_ENV_KEYS 去
// `markRestartRequired(...)`（重启横幅列出哪些键变了）并刷新 env 快照。main 那边
// 加一个键（实际发生过：Lane 5 追加 EMAIL_DATA_SOURCE_ID / CALENDAR_DATA_SOURCE_ID）
// 而这边不跟，两侧类型都是绿的、UI 也不报错，只是横幅少列一项 —— 典型的
// 「改一处漏一处、测试全绿运行时静默错」。
//
// canonical 源 = notion_oauth.ts 的实际 patch（removeConnection 一次性写全集，且
// 每个值都是 null=清除，正好可以当探针）；本闸拿它对 renderer 侧常量。

import { afterEach, beforeEach, expect, test } from 'vitest'

import { __test__, removeConnection } from '../../src/electron/main/notion_oauth'
import { NOTION_OAUTH_ENV_KEYS } from '../../src/shared/lib/notionOauthContract'
import { MANAGED_ENV_KEY_SET } from '../../src/electron/main/lib/env-keys'

let patches: Array<Record<string, string | null>> = []

beforeEach(() => {
  __test__.reset()
  patches = []
  __test__.setDeps({
    writeEnvPatch: (patch) => {
      patches.push(patch)
      return { ok: true, path: '/tmp/.env', changedKeys: Object.keys(patch), restartRequired: true }
    }
  })
})

afterEach(() => {
  __test__.reset()
})

test('removeConnection 的 patch 键集 == NOTION_OAUTH_ENV_KEYS（renderer 重启清单单源）', () => {
  const res = removeConnection()
  expect(res).toEqual({ ok: true })
  expect(patches.length).toBe(1)
  // canary：探针抽空则下面的相等断言会变成「空 == 空」的假绿。
  expect(Object.keys(patches[0]).length).toBeGreaterThan(4)
  expect(Object.keys(patches[0]).sort()).toEqual([...NOTION_OAUTH_ENV_KEYS].sort())
})

test('移除连接是全清（每个键都写 null，没有「保留 token」的半态）', () => {
  removeConnection()
  expect(Object.values(patches[0]).every((v) => v === null)).toBe(true)
})

test('清单里的键全部在 MANAGED_ENV_KEYS 白名单里（否则 env:set 直接 E_INVALID_KEY）', () => {
  for (const key of NOTION_OAUTH_ENV_KEYS) {
    expect(MANAGED_ENV_KEY_SET.has(key), `${key} 不在 MANAGED_ENV_KEYS`).toBe(true)
  }
})
