// chat-panel P4 Phase 03a — shared test helpers for the gateway read-tool tests.
//
// Builds a MailAgentDomainClient backed by a canned mock fetch, and invokes an AI SDK
// tool's `execute` the way streamText would (parsed input + ToolExecutionOptions with
// an experimental_context audit collector).

import type { Tool } from 'ai'

import { MailAgentDomainClient } from '../../../src/ai-gateway/python/domainClient'
import type { GroupToolHooks } from '../../../src/ai-gateway/tools/groups'

/** A MailAgentDomainClient whose fetch is the supplied responder (url, body → envelope). */
export function mockDomain(
  responder: (url: string, body?: string) => { status?: number; json: unknown }
): MailAgentDomainClient {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const r = responder(String(input), init?.body as string | undefined)
    return new Response(JSON.stringify(r.json), {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }) as unknown as typeof fetch
  return new MailAgentDomainClient({
    baseUrl: 'http://127.0.0.1:8200/api',
    localToken: 't',
    fetchImpl
  })
}

/** Invoke a tool's execute like streamText does (audit collector is closure-bound at
 *  tool creation, so it is not passed here). Returns the tool output (or throws). */
export async function runTool(
  tool: Tool,
  input: unknown,
  opts?: { signal?: AbortSignal }
): Promise<unknown> {
  const exec = tool.execute as (i: unknown, o: unknown) => Promise<unknown>
  return exec(input, { toolCallId: 'tc-1', messages: [], abortSignal: opts?.signal })
}

/** L4 群聊 g2 — 一组惰性的假群 hooks，给「只关心 ToolSet 形状」的装配面测试用
 *  （policy / skill_gating 的 FULL set）。每个 hook 都是「群不存在 / 没历史 / 没调度器」的
 *  最空形状：这些测试从不 execute 群工具，任何一个被调到都说明装配面走错了路。
 *  🔴 行为面的假 hooks 在 groups.test.ts 自带（那里要 spy 调用次数与入参），别把这个拿去当那个用。 */
export function fakeGroupHooks(): GroupToolHooks {
  return {
    resolveGroupSession: () => null,
    listGroupHistory: () => [],
    appendGroupMessage: () => 0,
    groupUsage: () => ({ turns: 0, tokens: 0, costUsd: null }),
    deliverGroupMessage: () => undefined,
    getSessionTitle: () => null,
    lastHumanMessageText: () => null,
    createGroupSession: async (input) => ({
      sessionId: 0,
      title: input.title,
      members: input.memberAgentIds,
      parentSessionId: input.parentSessionId
    }),
    setGroupConfig: async () => undefined
  }
}

export const okEnvelope = (data: unknown): { json: unknown } => ({
  json: { status: 'success', data }
})
export const errEnvelope = (
  code: string,
  message = 'boom',
  status = 500
): { status: number; json: unknown } => ({
  status,
  json: { status: 'error', error: { code, message } }
})
