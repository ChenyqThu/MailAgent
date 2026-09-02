// L4 群聊 — renderer 直驱 gateway POST /api/ai/group-chat 的轻量客户端（searchAgentClient
// 同款形态：不经 assistant-ui runtime，fetch + SSE 逐帧消费）。
//
// 两个动作：
//   • appendGroupUserMessage — 把用户消息写进共享 transcript（JSON 应答）。
//   • runGroupSpeaker — 驱动一个成员的发言 run：text-delta 帧回调流式渲染，终局 done 帧
//     带 messageId（已持久化）；error 帧 / 传输失败 → throw Error&{code}，调用方把该气泡
//     标失败后**继续下一个成员**（成本护栏：服务端无级联，串行循环在前端）。
//   • retryGroupTurn — labs on 的失败 turn 重试（gateway `retry` 分支 → 调度器 requeue）。
//   • probeGroupRun — `/api/ai/run/active` 三态探针（active / idle / unreachable）。
//
// 🔴 这两个新动作为什么不放 groupSettings.ts：那边的 request() 强制 serve-api 信封，gateway 的
//    裸 JSON（2xx 无 status 键 / 409 / 403）会被折成 E_SCHEMA_MISMATCH / E_PM2_RUNNING /
//    E_AUTH_FAILED，`err.code` 就透不出 E_RUN_STOPPED 这类真码。
//
// 桌面-only（与 ⌘K agentic search 同边界）：gateway 未注入（web / 未启动）→ E_UNSUPPORTED。

import { resolveAiGatewayBaseUrl } from './runtime/flags'

function gatewayBaseUrlOrThrow(): string {
  const baseUrl = resolveAiGatewayBaseUrl()
  if (!baseUrl) {
    const err = new Error('group chat requires the local AI gateway (desktop-only)') as Error & {
      code: string
    }
    err.code = 'E_UNSUPPORTED'
    throw err
  }
  return baseUrl
}

async function throwHttpError(res: Response): Promise<never> {
  let code = 'E_AGENT'
  let hint = `group-chat HTTP ${res.status}`
  try {
    const body = (await res.json()) as { error?: unknown; hint?: unknown }
    if (typeof body.error === 'string' && body.error.length > 0) code = body.error
    if (typeof body.hint === 'string' && body.hint.length > 0) hint = body.hint
  } catch {
    // non-JSON error body → keep the status-derived shape.
  }
  const err = new Error(hint) as Error & { code: string }
  err.code = code
  throw err
}

/** 把用户消息落进群聊 transcript（服务端校验 session 是群聊）。返回消息行 id。 */
export async function appendGroupUserMessage(sessionId: number, text: string): Promise<number> {
  const baseUrl = gatewayBaseUrlOrThrow()
  const res = await fetch(`${baseUrl}/api/ai/group-chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, userText: text })
  })
  if (!res.ok) await throwHttpError(res)
  const body = (await res.json()) as { messageId?: unknown }
  return typeof body.messageId === 'number' ? body.messageId : -1
}

export interface GroupSpeakerResult {
  messageId: number | null
  content: string
}

/** 驱动一个成员的发言 run（SSE）。onDelta 逐帧喂增量文本；resolve = done（已持久化）。
 *  error 帧 / 非 200 / 流中断 → throw Error&{code}。 */
export async function runGroupSpeaker(opts: {
  sessionId: number
  speakAsAgentId: string
  signal?: AbortSignal
  onDelta?: (delta: string) => void
}): Promise<GroupSpeakerResult> {
  const baseUrl = gatewayBaseUrlOrThrow()
  const res = await fetch(`${baseUrl}/api/ai/group-chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ sessionId: opts.sessionId, speakAsAgentId: opts.speakAsAgentId }),
    signal: opts.signal
  })
  if (!res.ok || !res.body) await throwHttpError(res)

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const frames = buf.split('\n\n')
    buf = frames.pop() ?? ''
    for (const frame of frames) {
      const line = frame.replace(/^data: /, '').trim()
      if (!line) continue
      let evt: {
        type?: unknown
        delta?: unknown
        messageId?: unknown
        content?: unknown
        errorText?: unknown
      }
      try {
        evt = JSON.parse(line) as typeof evt
      } catch {
        continue // keepalive / non-JSON frame
      }
      if (evt.type === 'text-delta' && typeof evt.delta === 'string') {
        opts.onDelta?.(evt.delta)
      } else if (evt.type === 'done') {
        return {
          messageId: typeof evt.messageId === 'number' ? evt.messageId : null,
          content: typeof evt.content === 'string' ? evt.content : ''
        }
      } else if (evt.type === 'error') {
        const err = new Error(
          typeof evt.errorText === 'string' && evt.errorText.length > 0
            ? evt.errorText
            : 'group speaker run failed'
        ) as Error & { code: string }
        err.code = 'E_AGENT'
        throw err
      }
    }
  }
  const err = new Error('group-chat stream ended without a result') as Error & { code: string }
  err.code = 'E_AGENT'
  throw err
}

/** 失败 turn 的重试：调度器把该成员按原链重新入队。`err.code` 原样透出
 *  E_LABS_ORCHESTRATED（labs off / 调度器缺席）/ E_NOT_GROUP_MEMBER / E_RUN_STOPPED（该链已被
 *  地板或 owner 停掉，重试不复活）。`queued:false` = 已在队里被折叠。 */
export async function retryGroupTurn(
  sessionId: number,
  agentId: string,
  chainId: number
): Promise<{ queued: boolean }> {
  const baseUrl = gatewayBaseUrlOrThrow()
  const res = await fetch(`${baseUrl}/api/ai/group-chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, retry: { agentId, chainId } })
  })
  if (!res.ok) await throwHttpError(res)
  const body = (await res.json()) as { queued?: unknown }
  return { queued: body.queued === true }
}

export type GroupRunProbeState = 'active' | 'idle' | 'unreachable'

export interface GroupRunProbe {
  state: GroupRunProbeState
  /** 200 时调度器的在场三元组（registry 无租约但群里有人排队 / 准备中也算 active）。 */
  group: { inFlight: string | null; preparing: string | null; queued: string[] } | null
}

function narrowProbeGroup(raw: unknown): GroupRunProbe['group'] {
  if (typeof raw !== 'object' || raw === null) return null
  const g = raw as { inFlight?: unknown; preparing?: unknown; queued?: unknown }
  return {
    inFlight: typeof g.inFlight === 'string' ? g.inFlight : null,
    preparing: typeof g.preparing === 'string' ? g.preparing : null,
    queued: Array.isArray(g.queued)
      ? g.queued.filter((id): id is string => typeof id === 'string')
      : []
  }
}

/** 群里此刻有没有 run 存活（gateway 真源）。200 → active；404 → idle；其余 / 抛错 → unreachable
 *  （fail-closed：够不着时说「未连接」，不编一个「没人在发言」）。 */
export async function probeGroupRun(sessionId: number): Promise<GroupRunProbe> {
  try {
    const baseUrl = gatewayBaseUrlOrThrow()
    const res = await fetch(`${baseUrl}/api/ai/run/active?sessionId=${sessionId}`)
    if (res.status === 404) return { state: 'idle', group: null }
    if (!res.ok) return { state: 'unreachable', group: null }
    const body = (await res.json()) as { active?: unknown; group?: unknown }
    if (body.active !== true) return { state: 'idle', group: null }
    return { state: 'active', group: narrowProbeGroup(body.group) }
  } catch {
    return { state: 'unreachable', group: null }
  }
}
