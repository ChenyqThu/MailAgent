// @vitest-environment node
//
// task 06-08-chat 第二波 — 远程 config P0+P1：HttpApi 只读配置端点 mock-fetch 单测。
//
// 覆盖 6 个去 notImplemented 的读方法 → 正确的 serve-api 路径 + 解包 envelope 返回形状：
//   settings.secretsStatus / settings.get / notionAgent.getConfig /
//   notionAgent.listModels / notionAgent.listAgents / prompts.list / prompts.read
// + 确认写方法（setSecret/set/setAgent/setModel/prompts.write/...）仍 reject notImplemented。
//
// fetch 全 mock：envelope 端点用真 Response（http_client.request 调 .text() 解析）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { HttpApi } from '@shared/api/HttpApi'

let fetchMock: ReturnType<typeof vi.fn>
let origFetch: typeof globalThis.fetch

/** 成功 envelope 真 Response（http_client.request 解析 {status,data}）。 */
function envelopeResponse(data: unknown): Response {
  return new Response(JSON.stringify({ status: 'success', schema_version: 1, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

beforeEach(() => {
  origFetch = globalThis.fetch
  fetchMock = vi.fn()
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = origFetch
  vi.restoreAllMocks()
})

/** fetch 调用 URL（第一个参数）。 */
function calledUrl(): string {
  return String(fetchMock.mock.calls[0][0])
}

/** fetch 调用 method。 */
function calledMethod(): string {
  const init = fetchMock.mock.calls[0][1] as RequestInit | undefined
  return String(init?.method ?? 'GET')
}

describe('HttpApi — 远程 config 只读端点', () => {
  const api = new HttpApi('/api')

  test('settings.secretsStatus → GET /settings/secrets-status，解包 SecretsStatus', async () => {
    const status = {
      cliApiKey: true,
      llmApiKey: false,
      llmTranslateApiKey: true,
      customApiKey: false
    }
    fetchMock.mockResolvedValue(envelopeResponse(status))
    const out = await api.settings.secretsStatus()
    expect(calledMethod()).toBe('GET')
    expect(calledUrl()).toContain('/api/settings/secrets-status')
    expect(out).toEqual(status)
  })

  test('settings.get → GET /settings，解包 PersistentSettings', async () => {
    const settings = {
      dbPath: null,
      attachmentDir: null,
      pollIntervalSec: 5,
      notionAgentPageId: null,
      notionAgentName: null,
      customApiEndpoint: 'https://crs.example',
      autoDownloadUpdates: true,
      userEmail: 'owner@example.com'
    }
    fetchMock.mockResolvedValue(envelopeResponse(settings))
    const out = await api.settings.get()
    expect(calledUrl()).toContain('/api/settings')
    expect(out.userEmail).toBe('owner@example.com')
    expect(out.pollIntervalSec).toBe(5)
  })

  test('notionAgent.getConfig → GET /notion-agent/config，解包 NotionAgentConfig', async () => {
    const config = {
      accountPath: '/home/u/.notionagents/notion_account.json',
      cliPath: '/usr/bin/notion-agent',
      cliFound: true,
      configured: true,
      tokenPresent: true,
      userName: 'Lucien',
      userEmail: 'lucien@example.com',
      spaceName: 'ENBU',
      spaceId: 'sp-1',
      agentName: 'Mail Agent',
      agentPageId: 'page-abc',
      agentAccessory: null,
      defaultModel: 'opus-4.8',
      timezone: 'Asia/Shanghai'
    }
    fetchMock.mockResolvedValue(envelopeResponse(config))
    const out = await api.notionAgent.getConfig()
    expect(calledUrl()).toContain('/api/notion-agent/config')
    expect(out.configured).toBe(true)
    expect(out.agentPageId).toBe('page-abc')
    expect(out.tokenPresent).toBe(true)
  })

  test('notionAgent.listModels → GET /notion-agent/models，解包 string[]', async () => {
    fetchMock.mockResolvedValue(envelopeResponse(['opus-4.8', 'sonnet-4.6']))
    const out = await api.notionAgent.listModels()
    expect(calledUrl()).toContain('/api/notion-agent/models')
    expect(out).toEqual(['opus-4.8', 'sonnet-4.6'])
  })

  test('notionAgent.listAgents → GET /notion-agent/agents，解包 NotionAgentListItem[]', async () => {
    const agents = [
      {
        agent_id: 'a1',
        name: 'Mail Agent',
        agent_page_id: 'pg1',
        description: 'desc',
        icon: '📧'
      }
    ]
    fetchMock.mockResolvedValue(envelopeResponse(agents))
    const out = await api.notionAgent.listAgents()
    expect(calledUrl()).toContain('/api/notion-agent/agents')
    expect(out).toHaveLength(1)
    expect(out[0].agent_id).toBe('a1')
  })

  test('notionAgent.listAgents → CLI 失败 error envelope → throw err.code', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'error',
          schema_version: 1,
          data: null,
          error: { code: 'E_NOTION_AGENT_NOT_INSTALLED', message: 'not found' }
        }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      )
    )
    await expect(api.notionAgent.listAgents()).rejects.toMatchObject({
      code: 'E_NOTION_AGENT_NOT_INSTALLED'
    })
  })

  test('prompts.list → GET /prompts，解包 {inbox, sent}', async () => {
    const payload = {
      inbox: { slot: 'inbox', path: '/root/prompts/email_inbox.md', exists: true },
      sent: { slot: 'sent', path: '/root/prompts/email_sent.md', exists: false }
    }
    fetchMock.mockResolvedValue(envelopeResponse(payload))
    const out = await api.prompts.list()
    expect(calledUrl()).toContain('/api/prompts')
    expect(out.inbox.exists).toBe(true)
    expect(out.sent.exists).toBe(false)
  })

  test('prompts.read → GET /prompts/{slot}，解包 PromptContent', async () => {
    const payload = {
      slot: 'inbox',
      path: '/root/prompts/email_inbox.md',
      exists: true,
      content: 'prompt body'
    }
    fetchMock.mockResolvedValue(envelopeResponse(payload))
    const out = await api.prompts.read('inbox')
    expect(calledUrl()).toContain('/api/prompts/inbox')
    expect(out.content).toBe('prompt body')
  })

  test('env.get → GET /env，解包 EnvSnapshot（Bug 6 — 远程 Settings 读 .env 快照）', async () => {
    const snapshot = {
      path: '/root/.env',
      exists: true,
      values: { USER_EMAIL: 'owner@example.com', NOTION_TOKEN: '***' },
      managedKeys: ['USER_EMAIL', 'NOTION_TOKEN'],
      secretKeys: ['NOTION_TOKEN']
    }
    fetchMock.mockResolvedValue(envelopeResponse(snapshot))
    const out = await api.env.get()
    expect(calledMethod()).toBe('GET')
    expect(calledUrl()).toContain('/api/env')
    expect(out.exists).toBe(true)
    expect(out.values.USER_EMAIL).toBe('owner@example.com')
    expect(out.values.NOTION_TOKEN).toBe('***')
    expect(out.secretKeys).toContain('NOTION_TOKEN')
  })
})

describe('HttpApi — 远程 config 写方法仍 notImplemented (reject, 不 fetch)', () => {
  const api = new HttpApi('/api')

  test('settings.setSecret rejects', async () => {
    await expect(api.settings.setSecret('llmApiKey', 'x')).rejects.toThrow(/not implemented/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('settings.clearSecret rejects', async () => {
    await expect(api.settings.clearSecret('llmApiKey')).rejects.toThrow(/not implemented/)
  })

  test('settings.set rejects', async () => {
    await expect(api.settings.set({ pollIntervalSec: 10 })).rejects.toThrow(/not implemented/)
  })

  test('settings.pickFolder rejects', async () => {
    await expect(api.settings.pickFolder()).rejects.toThrow(/not implemented/)
  })

  test('settings.testLlm rejects', async () => {
    await expect(api.settings.testLlm()).rejects.toThrow(/not implemented/)
  })

  test('settings.testCustomApi rejects', async () => {
    await expect(api.settings.testCustomApi()).rejects.toThrow(/not implemented/)
  })

  test('notionAgent.doctor rejects', async () => {
    await expect(api.notionAgent.doctor()).rejects.toThrow(/not implemented/)
  })

  test('notionAgent.setAgent rejects', async () => {
    await expect(api.notionAgent.setAgent('pg', 'name')).rejects.toThrow(/not implemented/)
  })

  test('notionAgent.setModel rejects', async () => {
    await expect(api.notionAgent.setModel('opus-4.8')).rejects.toThrow(/not implemented/)
  })

  test('prompts.write rejects', async () => {
    await expect(api.prompts.write('inbox', 'x')).rejects.toThrow(/not implemented/)
  })

  test('env.set rejects (远程只读，EnvField 控件 disabled)', async () => {
    await expect(api.env.set({ USER_EMAIL: 'x@y.com' })).rejects.toThrow(/not implemented/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// MED-1: HttpApi.email.search 必须把 SearchOpts.mode 映射成 serve-api 的 raw 参数,
// 否则 mailApi.email.search({mode:'raw'}) 会被当 smart (DSL 解析), 丢失 raw 逃生门。
describe('HttpApi — email.search mode→raw 映射', () => {
  const api = new HttpApi('/api')

  test("mode:'raw' → query 带 raw=true", async () => {
    fetchMock.mockResolvedValue(
      envelopeResponse({ items: [], total_indexed: 0, total_matches: 0, has_more: false })
    )
    await api.email.search({ query: 'redis', mode: 'raw' })
    expect(calledUrl()).toContain('raw=true')
  })

  test("mode:'smart' → 不带 raw 参数 (默认 smart)", async () => {
    fetchMock.mockResolvedValue(
      envelopeResponse({ items: [], total_indexed: 0, total_matches: 0, has_more: false })
    )
    await api.email.search({ query: 'redis', mode: 'smart' })
    expect(calledUrl()).not.toContain('raw=')
  })

  test('未传 mode → 不带 raw 参数', async () => {
    fetchMock.mockResolvedValue(
      envelopeResponse({ items: [], total_indexed: 0, total_matches: 0, has_more: false })
    )
    await api.email.search({ query: 'redis' })
    expect(calledUrl()).not.toContain('raw=')
  })
})
