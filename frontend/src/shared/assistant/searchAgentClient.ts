// S3 W1 — renderer client for the gateway headless agentic search (⌘K "AI 理解").
//
// Replaces the legacy `mailApi.chat.runSearchAgent` path (shared/chat/search_agent.ts
// runHarness + HttpChatPlatform — dead code once CommandPalette switches here; W3
// deletes it) with a thin client of the embedded AI SDK Gateway's
// POST /api/ai/search-agent. The split of responsibilities mirrors the legacy layout:
//   - THIS side (renderer, has MailApi reads): read the search-agent config row
//     (model/prompt), fill the {today}/{me} placeholders, append the mailbox hint,
//     consume the SSE phase/result stream, and run the nlToDsl fallback when the
//     agent comes back empty-handed.
//   - GATEWAY side (searchAgentRun.ts): the generateText read-tool loop, candidate
//     pool ∩ present_results (anti-hallucination), mailbox hard filter, best-effort.
// The public contract is UNCHANGED: SearchAgentInput → Promise<SearchAgentResult>,
// never throws, same error codes (palette formatAiError needs no change).
//
// Remote web stays E_UNSUPPORTED this round (the serve-api ai_gateway_proxy does not
// forward /api/ai/search-agent; CommandPalette's IS_WEB gate hides the entry anyway) —
// recorded as an S3 followup.

import type { MailApi, SearchAgentInput, SearchAgentResult, SearchHit } from '../api/types'
import { resolveAiGatewayBaseUrl } from './runtime/flags'
import { errorMessage } from '@shared/lib/ipcErrors'

// ── 内置默认搜索 prompt（legacy §3.3 同文；prompt=NULL 时用，{today}/{me} 由本客户端填）──
// SSoT 迁址：legacy shared/chat/search_agent.ts 的同名常量随 W3 删除，AgentsTab 届时改
// import 这里。
export const DEFAULT_SEARCH_AGENT_PROMPT =
  '你是邮件搜索助手。用户给自然语言，你用 email_search_fulltext（支持 ' +
  'from:/to:/subject:/in:/is:/has:/after:/before: + 引号短语 + -否定 + 大写 OR + ' +
  '中文子串）检索。\n' +
  '- 渐进式精读：snippet 不足以判断时，用 email_body 读「最相关的前 2-3 封」正文确认' +
  '（不要逐封全读，省预算）；需要元数据/附件名用 email_get，需要看整条会话用 ' +
  'email_list_thread。\n' +
  '- 用户意图涉及附件内容（如"合同里写了什么""PPT 里的数据"）时用 email_search_attachments ' +
  '检索附件提取正文与文件名（含中文子串）；命中后同样按需用 ' +
  'email_attachment_text(attachment_id) 读完整提取文本确认（对应 email_body 之于正文的确认步）。\n' +
  '- 自我收敛：看工具结果的 has_more / hint —— 命中太多就加 from:/after:/subject: 等 ' +
  'filter 缩小；0 命中就放宽关键词或去掉一个 filter 重试一次；仍空则如实说没找到，不要编造。\n' +
  '- 最后必须且仅一次调用 present_results：matched_internal_ids 只填真实命中的 ' +
  'internal_id（来自工具返回，严禁编造），summary 一句话说明找到了什么。\n' +
  '今天是 {today}，用户邮箱 {me}。'

/** Gateway 终局事件里的 result 形状（= SearchAgentResult 减 fallbackDsl —— nlToDsl
 *  兜底留在本侧，serve-api reads 在这）。 */
interface GatewayAgentResult {
  ok: boolean
  hits: SearchHit[]
  summary: string | null
  error?: { code: string; message: string }
}

/** 永不 throw：全程 catch 成 error（legacy runSearchAgent 同契约）。 */
export async function runGatewaySearchAgent(
  reads: MailApi,
  input: SearchAgentInput
): Promise<SearchAgentResult> {
  try {
    return await runGatewaySearchAgentInner(reads, input)
  } catch (err) {
    const message = errorMessage(err)
    return { ok: false, hits: [], summary: null, error: { code: 'E_AGENT', message } }
  }
}

async function runGatewaySearchAgentInner(
  reads: MailApi,
  input: SearchAgentInput
): Promise<SearchAgentResult> {
  // 桌面从 ?aiGatewayPort= 解析 loopback；null（gateway 未注入/未启动）与 ''（web 同源
  // 代理 —— serve-api 不转发本端点，本轮不开通）都按现状语义回 E_UNSUPPORTED。
  const baseUrl = resolveAiGatewayBaseUrl()
  if (!baseUrl) {
    return {
      ok: false,
      hits: [],
      summary: null,
      error: {
        code: 'E_UNSUPPORTED',
        message: 'agentic search requires the local AI gateway (desktop-only)'
      }
    }
  }

  // G-A4 — mailbox 归一化一次：prompt 注入文案 + gateway 最终硬过滤共用同一 trim 值。
  const wantMailbox = input.mailbox?.trim()

  // a. 读 search agent 配置：type==='search' && enabled → model/prompt（legacy 同逻辑，
  //    每次搜索拉一次；失败 → 内置默认 prompt + model=null 回退 gateway 默认）。
  let model: string | null = null
  let prompt = DEFAULT_SEARCH_AGENT_PROMPT
  try {
    const agents = await reads.report.getConfig()
    const searchAgent = agents.find((a) => a.type === 'search' && a.enabled)
    if (searchAgent) {
      if (searchAgent.model && searchAgent.model.length > 0) model = searchAgent.model
      // prompt_is_default=true 表示后端回填了默认（report 默认非搜索默认）→ 用内置搜索默认。
      if (
        !searchAgent.prompt_is_default &&
        typeof searchAgent.prompt === 'string' &&
        searchAgent.prompt.length > 0
      ) {
        prompt = searchAgent.prompt
      }
    }
  } catch {
    // 读配置失败（端点不可达 / 无 agent）→ 用内置默认。
  }

  // 内置 prompt 占位填充（自定义 prompt 不强制含占位 → replaceAll 无命中即原样）。
  const today = new Date().toISOString().slice(0, 10)
  const me = (await resolveUserEmail(reads)) ?? '(unknown)'
  let systemPrompt = prompt.replaceAll('{today}', today).replaceAll('{me}', me)

  if (wantMailbox) {
    systemPrompt +=
      `\n用户希望限定在「${wantMailbox}」文件夹检索，` +
      `请在 query 里用 in:「${wantMailbox}」或对应字段。`
  }

  // b. 组装首条 user 消息（legacy 同构：prompt 作前缀 + 用户 query，不走 system role）。
  const userContent =
    systemPrompt.length > 0 ? `${systemPrompt}\n\n用户查询：${input.query}` : input.query

  // c. 调 gateway + 消费 SSE。任何传输层失败（HTTP 非 200 / fetch 网络错 / 流中断）
  //    归一成 harnessError，与 legacy 的 harness error 同走 nlToDsl fallback（gateway
  //    挂了 serve-api 的 nlToDsl 仍可能可用）。
  let gatewayResult: GatewayAgentResult | null = null
  let harnessError: { code: string; message: string } | null = null
  try {
    gatewayResult = await postSearchAgent(baseUrl, {
      userContent,
      mailbox: wantMailbox || undefined,
      model: model ?? undefined,
      signal: input.signal,
      onPhase: input.onPhase
    })
  } catch (err) {
    // f-bis — 用户主动取消：直接 E_ABORTED，不做 fallback（用户不想要结果）。
    if (input.signal?.aborted) {
      return {
        ok: false,
        hits: [],
        summary: null,
        error: { code: 'E_ABORTED', message: 'cancelled' }
      }
    }
    const code = (err as { code?: unknown }).code
    harnessError = {
      code: typeof code === 'string' ? code : 'E_AGENT',
      message: errorMessage(err)
    }
  }

  if (gatewayResult) {
    if (gatewayResult.ok) {
      return { ok: true, hits: gatewayResult.hits, summary: gatewayResult.summary }
    }
    // 外部取消透传（gateway 侧也可能先观察到 abort）。
    if (gatewayResult.error?.code === 'E_ABORTED' || input.signal?.aborted) {
      return {
        ok: false,
        hits: [],
        summary: null,
        error: { code: 'E_ABORTED', message: 'cancelled' }
      }
    }
    harnessError = gatewayResult.error ?? null
  }

  // g. fallback：agent 空手（或传输失败）→ nlToDsl 兜底给 fallbackDsl（前端填回输入框
  //    走普通搜索）。error code 优先级：gateway/传输错误 > nlToDsl 错误 > 无输出。
  return await fallbackToNlToDsl(reads, input.query, harnessError)
}

/** POST /api/ai/search-agent 并逐帧消费 SSE：phase 事件 → onPhase 回调；终局 result
 *  事件 → 返回。非 200 → 抛 Error&{code}（body.error 作 code）；流结束仍无 result →
 *  抛 E_AGENT（传输中断）。 */
async function postSearchAgent(
  baseUrl: string,
  opts: {
    userContent: string
    mailbox?: string
    model?: string
    signal?: AbortSignal
    onPhase?: SearchAgentInput['onPhase']
  }
): Promise<GatewayAgentResult> {
  const res = await fetch(`${baseUrl}/api/ai/search-agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      userContent: opts.userContent,
      ...(opts.mailbox ? { mailbox: opts.mailbox } : {}),
      ...(opts.model ? { model: opts.model } : {})
    }),
    signal: opts.signal
  })
  if (!res.ok || !res.body) {
    let code = res.status === 503 ? 'E_NO_LLM_KEY' : 'E_AGENT'
    try {
      const body = (await res.json()) as { error?: unknown }
      if (typeof body.error === 'string' && body.error.length > 0) code = body.error
    } catch {
      // non-JSON error body → keep the status-derived code.
    }
    const err = new Error(`search-agent HTTP ${res.status}`) as Error & { code: string }
    err.code = code
    throw err
  }

  const reader = res.body.getReader()
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
      let evt: { type?: unknown; phase?: unknown; result?: unknown }
      try {
        evt = JSON.parse(line) as typeof evt
      } catch {
        continue // keepalive / non-JSON frame
      }
      if (evt.type === 'phase' && (evt.phase === 'searching' || evt.phase === 'summarizing')) {
        opts.onPhase?.(evt.phase)
      } else if (evt.type === 'result' && evt.result && typeof evt.result === 'object') {
        return evt.result as GatewayAgentResult
      }
    }
  }
  const err = new Error('search-agent stream ended without a result') as Error & { code: string }
  err.code = 'E_AGENT'
  throw err
}

/** 解析用户邮箱（settings.get().userEmail；失败 → null）。 */
async function resolveUserEmail(reads: MailApi): Promise<string | null> {
  try {
    const settings = await reads.settings.get()
    return settings.userEmail ?? null
  } catch {
    return null
  }
}

/** fallback：调 nlToDsl 翻译成 DSL，前端填回输入框走普通搜索（legacy 同逻辑）。gateway
 *  已给明确错误（harnessError 非空，如无 key / 配额）→ 透传该错误码；nlToDsl 拿到 dsl
 *  仍附 fallbackDsl 供前端降级。 */
async function fallbackToNlToDsl(
  reads: MailApi,
  query: string,
  harnessError: { code: string; message: string } | null
): Promise<SearchAgentResult> {
  try {
    const res = await reads.email.nlToDsl(query)
    // nlToDsl 永不 reject —— 错误以 {dsl:'', error} 返回。
    const dsl = res.dsl && res.dsl.length > 0 ? res.dsl : undefined
    const code = harnessError?.code ?? res.error ?? 'E_NO_OUTPUT'
    const message =
      harnessError?.message ?? res.message ?? res.error ?? 'search agent produced no results'
    const out: SearchAgentResult = { ok: false, hits: [], summary: null, error: { code, message } }
    if (dsl) out.fallbackDsl = dsl
    return out
  } catch (err) {
    const message = errorMessage(err)
    return {
      ok: false,
      hits: [],
      summary: null,
      error: harnessError ?? { code: 'E_AGENT', message }
    }
  }
}
