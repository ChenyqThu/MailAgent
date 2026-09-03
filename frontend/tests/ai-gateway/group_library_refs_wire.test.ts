// P2-L13 群聊 @ 资料 —— 🔴 跨进程键名闸（renderer → gateway）。
//
// 单独成文件的理由：它测的是**两条接缝**（`shared/assistant/groupChatClient.ts` 的 POST body 与
// `ai-gateway/server.ts` 读它用的校验器），而不是载体本身的行为。两端都用真实现，中间只把 fetch
// 换成捕获器：任一侧把 `libraryRefs` 写成别的拼写，这一节就红（09-02 话题批 groupId / sessionId
// 两侧不一致 → 三绿静默失效的同一类坑）。

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  libraryRefsBodyPatch,
  readLibraryRefsInput,
  type GroupLibraryRef
} from '../../src/ai-gateway/groupLibraryRefs'

const ref = (fileId: number, path: string): GroupLibraryRef => ({
  fileId,
  path,
  name: path.split('/').pop() ?? path
})

// ── ③ 跨进程键名闸 ──────────────────────────────────────────────────────────────────────
// renderer（shared/assistant/groupChatClient.ts）→ gateway（ai-gateway/server.ts）。两端都用
// 真实现，中间只把 fetch 换成捕获器：任一侧把 `libraryRefs` 写成别的拼写，这一节就红。
describe('群资料引用 — 跨进程键名单源', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('../../src/shared/assistant/runtime/flags')
    vi.resetModules()
  })

  async function capturePostBody(
    refs: readonly GroupLibraryRef[] | undefined
  ): Promise<Record<string, unknown>> {
    // 端口探测（window.location / sessionStorage）在纯 Node lane 里拿不到 —— 只替这一个函数，
    // 被测的 body 构造与两侧的键名读写全是真实现。
    vi.doMock('../../src/shared/assistant/runtime/flags', () => ({
      resolveAiGatewayBaseUrl: () => 'http://127.0.0.1:8123'
    }))
    let captured: Record<string, unknown> | null = null
    vi.stubGlobal('fetch', (_url: string, init: { body: string }) => {
      captured = JSON.parse(init.body) as Record<string, unknown>
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ messageId: 1 })
      } as unknown as Response)
    })
    const { appendGroupUserMessage } = await import('../../src/shared/assistant/groupChatClient')
    await appendGroupUserMessage(3, 'hi', undefined, refs)
    expect(captured).not.toBeNull()
    return captured as unknown as Record<string, unknown>
  }

  it('renderer 发出的键名，gateway 侧读得出来', async () => {
    const refs = [ref(11, 'my-docs/契约.md')]
    const body = await capturePostBody(refs)
    // 🔴 两侧唯一的会合点：真 body → 真校验器。
    expect(readLibraryRefsInput(body)).toEqual({ ok: true, items: refs })
  })

  it('不传引用时 body 逐字节与改动前一致（不多一个键）', async () => {
    const body = await capturePostBody(undefined)
    expect(Object.keys(body).sort()).toEqual(['sessionId', 'userText'])
    expect(JSON.stringify(body)).toBe(JSON.stringify({ sessionId: 3, userText: 'hi' }))
  })

  it('body patch 与校验器共用同一个键名', () => {
    const patch = libraryRefsBodyPatch([ref(2, 'agent-docs/z.md')])
    expect(Object.keys(patch)).toHaveLength(1)
    expect(readLibraryRefsInput(patch).ok).toBe(true)
    expect(libraryRefsBodyPatch([])).toEqual({})
  })
})
