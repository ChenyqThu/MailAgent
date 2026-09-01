// L4 群聊 — renderer 直驱 gateway POST /api/ai/group-chat 的轻量客户端（searchAgentClient
// 同款形态：不经 assistant-ui runtime，fetch + SSE 逐帧消费）。
//
// 两个动作：
//   • appendGroupUserMessage — 把用户消息写进共享 transcript（JSON 应答）。
//   • runGroupSpeaker — 驱动一个成员的发言 run：text-delta 帧回调流式渲染，终局 done 帧
//     带 messageId（已持久化）；error 帧 / 传输失败 → throw Error&{code}，调用方把该气泡
//     标失败后**继续下一个成员**（成本护栏：服务端无级联，串行循环在前端）。
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
