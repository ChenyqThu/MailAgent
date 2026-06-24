// chat-panel P4 Phase 03a — shared test helpers for the gateway read-tool tests.
//
// Builds a MailAgentDomainClient backed by a canned mock fetch, and invokes an AI SDK
// tool's `execute` the way streamText would (parsed input + ToolExecutionOptions with
// an experimental_context audit collector).

import type { Tool } from 'ai'

import { MailAgentDomainClient } from '../../../src/ai-gateway/python/domainClient'

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
