// V2.1 阶段 3c-4 — notion-agent binary 解析（resolveNotionAgentBin）单测。
//
// 从删除的 tests/main/notion_agent_backend.test.ts 的 'binary resolution' describe 迁入：
// cutover 删了 chat/backends/notion_agent.ts（main execa NotionAgentBackend），其中的 bin
// 解析（活跃配置探测，非 chat 执行）搬到 notion_agent/config.ts，测试随之迁此。NotionAgentBackend
// 的 stream / extractTurn / classifyExit / thread 探测 / gate 测试不迁 —— serve-api Python
// 复刻（src/chat/notion_agent.py，3b-2 的 35 个 pytest）覆盖等价语义。

import { afterEach, describe, expect, test, vi } from 'vitest'

// execa 仅被 config.ts 的账户读写路径用；本测试只碰 resolveNotionAgentBin，mock 成空 fn 即可
// （避免 ESM execa 在 import 期的副作用）。
vi.mock('execa', () => ({ execa: vi.fn() }))
vi.mock('../../../src/electron/main/bin_resolver', () => ({
  whichSync: () => '/usr/local/bin/notion-agent'
}))
vi.mock('fs', async (orig) => ({
  ...(await orig<typeof import('fs')>()),
  existsSync: () => true
}))

import {
  resolveNotionAgentBin,
  __resetNotionAgentBinCache
} from '../../../src/electron/main/notion_agent/config'

afterEach(() => {
  __resetNotionAgentBinCache()
})

describe('resolveNotionAgentBin — notion-agent binary resolution', () => {
  test('returns the `which` hit', () => {
    expect(resolveNotionAgentBin()).toBe('/usr/local/bin/notion-agent')
  })

  test('caches across calls', () => {
    expect(resolveNotionAgentBin()).toBe(resolveNotionAgentBin())
  })

  test('honours $NOTION_AGENT_BIN when present', () => {
    process.env['NOTION_AGENT_BIN'] = '/usr/local/bin/notion-agent'
    __resetNotionAgentBinCache()
    try {
      expect(resolveNotionAgentBin()).toBe('/usr/local/bin/notion-agent')
    } finally {
      delete process.env['NOTION_AGENT_BIN']
      __resetNotionAgentBinCache()
    }
  })
})
