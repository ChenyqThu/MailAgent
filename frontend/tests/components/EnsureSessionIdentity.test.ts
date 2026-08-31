// 0812 codex #1 —— 懒建会话（onEnsureSession）的**线程身份**闸。
//
// 建会话是异步的，其间用户完全可能已经点到**另一件事**或换了会话。旧实现的去重只有一个「有没有
// 在途」的 ref，于是事项 A 的在途创建会被事项 B 的调用复用，产出三种全都很坏的结局：
//   ① `recordChatScope(B, …, sessionA.id)` —— B 的检索范围审计写进 A 的会话（该调用方已随 0812
//      检索范围开关的移除一并退役；现在只剩 transport 的首次发送这一条路，但闸保留）；
//   ② transport 拿 A 的 session 去持久化带 B 上下文的消息；
//   ③ 最刺眼的一种：A 的 `.then(adopt)` 最后落地时把界面**从 B 强行切回 A**。
//
// 本用例逐条钉住修复后的不变量。

import { describe, expect, test, vi } from 'vitest'

import { createEnsureSession, E_CHAT_THREAD_CHANGED } from '@shared/components/agents/ensureSession'
import type { ChatSession } from '@shared/api/types'

function fakeSession(id: number): ChatSession {
  return {
    id,
    email_id: null,
    anchor_type: 'general',
    anchor_id: null,
    backend_kind: 'ai-sdk',
    backend_model: null,
    backend_agent_page_id: null,
    title: null,
    archived: false,
    created_at: 0,
    updated_at: 0
  }
}

/** 可控的建会话：`resolve(id)` 由用例决定何时落地（模拟"在途"那段窗口）。 */
function deferredCreator(): {
  create: (identity: {
    navEpoch: number
    anchorId: number | null
    agentId: string | null
  }) => Promise<ChatSession>
  calls: { navEpoch: number; anchorId: number | null; agentId: string | null }[]
  resolveAll: (id: number) => void
} {
  const calls: { navEpoch: number; anchorId: number | null; agentId: string | null }[] = []
  const resolvers: ((session: ChatSession) => void)[] = []
  return {
    calls,
    create: (identity) => {
      calls.push(identity)
      return new Promise<ChatSession>((resolve) => resolvers.push(resolve))
    },
    resolveAll: (id: number) => resolvers.splice(0).forEach((resolve) => resolve(fakeSession(id)))
  }
}

describe('createEnsureSession — 幂等 + 线程身份', () => {
  test('已有会话 → 直接短路，不建第二条', async () => {
    const creator = deferredCreator()
    const ensure = createEnsureSession({
      getExistingSessionId: () => 77,
      getIdentity: () => ({ navEpoch: 0, anchorId: null, agentId: null }),
      createSession: creator.create,
      adopt: vi.fn()
    })
    await expect(ensure()).resolves.toBe(77)
    expect(creator.calls).toHaveLength(0)
  })

  test('同一条线程上的并发调用共享同一次创建（审计与发送不会各建一条）', async () => {
    const creator = deferredCreator()
    const adopt = vi.fn()
    const ensure = createEnsureSession({
      getExistingSessionId: () => null,
      getIdentity: () => ({ navEpoch: 3, anchorId: 42, agentId: null }),
      createSession: creator.create,
      adopt
    })
    const first = ensure()
    const second = ensure()
    creator.resolveAll(101)
    expect(await first).toBe(101)
    expect(await second).toBe(101)
    expect(creator.calls).toEqual([{ navEpoch: 3, anchorId: 42, agentId: null }])
    expect(adopt).toHaveBeenCalledTimes(1)
  })

  test('🔴 切到另一件事：不复用 A 的在途创建，B 拿到的是 B 自己的会话', async () => {
    const creator = deferredCreator()
    let identity = { navEpoch: 3, anchorId: 42, agentId: null }
    const ensure = createEnsureSession({
      getExistingSessionId: () => null,
      getIdentity: () => identity,
      createSession: creator.create,
      adopt: vi.fn()
    })
    const forA = ensure()
    // A 还没落地，用户点到事项 B。
    identity = { navEpoch: 3, anchorId: 99, agentId: null }
    const forB = ensure()
    expect(creator.calls).toEqual([
      { navEpoch: 3, anchorId: 42, agentId: null },
      // B 必须发起自己的创建，且带的是 B 的 matterId —— 复用 A 的在途 promise 就会把 B 的检索
      // 范围审计记进 A 的会话。
      { navEpoch: 3, anchorId: 99, agentId: null }
    ])
    creator.resolveAll(202)
    await expect(forA).rejects.toMatchObject({ code: E_CHAT_THREAD_CHANGED })
    expect(await forB).toBe(202)
  })

  test('🔴 P4b 同 anchor 不同 agent：不复用别人的在途创建（切成员 = 换线程身份）', async () => {
    const creator = deferredCreator()
    const adopt = vi.fn()
    let identity: { navEpoch: number; anchorId: number | null; agentId: string | null } = {
      navEpoch: 3,
      anchorId: null,
      agentId: 'daily_email_digest'
    }
    const ensure = createEnsureSession({
      getExistingSessionId: () => null,
      getIdentity: () => identity,
      createSession: creator.create,
      adopt
    })
    const forA = ensure()
    // A（日报）还没落地，用户切到成员 B（治理）。anchor 完全相同 —— 只有 agent 维度不同，
    // 去重键漏掉 agentId 时这里会复用 A 的在途创建（B 的消息落进 A 身份的会话）。
    identity = { navEpoch: 3, anchorId: null, agentId: 'contact_governance' }
    const forB = ensure()
    expect(creator.calls).toEqual([
      { navEpoch: 3, anchorId: null, agentId: 'daily_email_digest' },
      { navEpoch: 3, anchorId: null, agentId: 'contact_governance' }
    ])
    creator.resolveAll(707)
    await expect(forA).rejects.toMatchObject({ code: E_CHAT_THREAD_CHANGED })
    expect(await forB).toBe(707)
    expect(adopt).toHaveBeenCalledTimes(1)
  })

  test('🔴 已经切走 → 绝不 adopt（否则界面会被从 B 拽回 A），调用方按失败处理', async () => {
    const creator = deferredCreator()
    const adopt = vi.fn()
    let identity = { navEpoch: 3, anchorId: 42, agentId: null }
    const ensure = createEnsureSession({
      getExistingSessionId: () => null,
      getIdentity: () => identity,
      createSession: creator.create,
      adopt
    })
    const pending = ensure()
    identity = { navEpoch: 4, anchorId: null, agentId: null } // 换会话 / 新对话
    creator.resolveAll(303)
    await expect(pending).rejects.toMatchObject({ code: E_CHAT_THREAD_CHANGED })
    expect(adopt).not.toHaveBeenCalled()
  })

  test('切走那次失败后，回到同一条线程仍能正常再建一次（在途记录已复位）', async () => {
    const creator = deferredCreator()
    const adopt = vi.fn()
    let identity = { navEpoch: 1, anchorId: 7, agentId: null }
    const ensure = createEnsureSession({
      getExistingSessionId: () => null,
      getIdentity: () => identity,
      createSession: creator.create,
      adopt
    })
    const stale = ensure()
    identity = { navEpoch: 2, anchorId: 7, agentId: null }
    creator.resolveAll(404)
    await expect(stale).rejects.toMatchObject({ code: E_CHAT_THREAD_CHANGED })
    const fresh = ensure()
    creator.resolveAll(505)
    expect(await fresh).toBe(505)
    expect(adopt).toHaveBeenCalledTimes(1)
    expect(adopt).toHaveBeenCalledWith(expect.objectContaining({ id: 505 }))
  })

  test('创建本身失败不会把在途记录卡死（下一次照常重试）', async () => {
    const calls: number[] = []
    let attempt = 0
    const ensure = createEnsureSession({
      getExistingSessionId: () => null,
      getIdentity: () => ({ navEpoch: 0, anchorId: null, agentId: null }),
      createSession: async () => {
        attempt += 1
        calls.push(attempt)
        if (attempt === 1) throw new Error('offline')
        return fakeSession(606)
      },
      adopt: vi.fn()
    })
    await expect(ensure()).rejects.toThrow('offline')
    expect(await ensure()).toBe(606)
    expect(calls).toEqual([1, 2])
  })
})
