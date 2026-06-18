// F2 — headless agentic 搜索引擎（一次性 search agent）。
//
// 复用 chat harness 跑 tool_use 多轮 loop，但**不进 chat 会话、不落 chat 库**：
// 工具集只 [email_search_fulltext, present_results]；agent 检索后末步调
// present_results 声明命中 + 摘要；wrapper 从 tool_use 事件直接读 present_results
// 的 input（不依赖其 handler），用「候选池 ∩ matched_internal_ids」得到真实
// SearchHit（防幻觉编造 id），随即 abort harness 结束。
//
// 设计 SSoT：.trellis/tasks/06-17-dsl-parse-warnings/agentic-search-impl-plan.md
//   §2.1（harness）/§2.2（工具）/§3.1（present_results 契约）/§3.2（runSearchAgent 接口）/§3.3（prompt）。
//
// 🔴 不变式 1：本文件零 Electron/Node-only 依赖（只引 shared/chat + shared/api 类型 +
//    浏览器全局）。pnpm build:web 验证。harness 主体不改（只注入 no-op persist platform）。

import type { MailApi, SearchHit, SearchAgentInput, SearchAgentResult } from '../api/types'
import { runHarness, type HarnessSink } from './harness'
import { HttpChatPlatform } from './http_platform'
import { createCustomApiBackend } from './backends/custom_api'
import { createToolRegistry } from './tools/registry'
import { createEmailTools } from './tools/builtin/email'
import type { ChatInfraPlatform, ChatRuntimeConfig } from './platform'
import type { ChatMessage } from './model'
import type { ToolDef, ToolResult } from './tools/registry'

// ── 公共契约（§3.2）：SearchAgentInput / SearchAgentResult / SearchAgentPhase 单一真源
//    在 shared/api/types.ts（ChatApi 的契约面），此处 import 复用、不重复声明（防漂移）。

/** runSearchAgent 依赖（reads = 工具读委托 + nlToDsl fallback；baseUrl = serve-api 基址）。 */
export interface SearchAgentDeps {
  reads: MailApi
  baseUrl: string
  /** HttpChatPlatform 运行配置快照（同 chat runtime 预取的 /chat/config）。 */
  config?: Partial<ConstructorParameters<typeof HttpChatPlatform>[2]>
}

// ── 内置默认搜索 prompt（§3.3 末，prompt=NULL 时用；{today}/{me} 由 wrapper 填）──

export const DEFAULT_SEARCH_AGENT_PROMPT =
  '你是邮件搜索助手。用户给自然语言，你用 email_search_fulltext（支持 ' +
  'from:/to:/subject:/in:/is:/has:/after:/before: + 引号短语 + -否定 + 大写 OR + ' +
  '中文子串）检索。\n' +
  '- 渐进式精读：snippet 不足以判断时，用 email_body 读「最相关的前 2-3 封」正文确认' +
  '（不要逐封全读，省预算）；需要元数据/附件名用 email_get，需要看整条会话用 ' +
  'email_list_thread。\n' +
  '- 自我收敛：看工具结果的 has_more / hint —— 命中太多就加 from:/after:/subject: 等 ' +
  'filter 缩小；0 命中就放宽关键词或去掉一个 filter 重试一次；仍空则如实说没找到，不要编造。\n' +
  '- 最后必须且仅一次调用 present_results：matched_internal_ids 只填真实命中的 ' +
  'internal_id（来自工具返回，严禁编造），summary 一句话说明找到了什么。\n' +
  '今天是 {today}，用户邮箱 {me}。'

// ── G-A5：搜索 agent 预算（独立于 chat，调紧）─────────────────────────────────
//
// 搜索 agent 典型流程 = 检索 → 读 top 2-3 封正文 → present_results（≤ ~5 轮），比通用
// chat 短得多。接入 read 工具后必须防「逐封超读」爆预算。这两个上限以 min 与 chat 运行配置
// 取交（chat 配置更小则保留更小），在 createHeadlessInfraPlatform.resolveConfig 套用。
const SEARCH_AGENT_MAX_ITER = 6
const SEARCH_AGENT_MAX_COST_USD = 0.3

// ── G-A3：非顺从模型从候选池回 best-effort 命中的上限 ─────────────────────────
const SEARCH_BESTEFFORT_MAX = 20

// ── G-A1：搜索 agent 工具集（渐进式精读）──────────────────────────────────────
// 检索 + 按需读正文/元数据/整条会话。createEmailTools 返 6 个，这里只取 4 个读工具。
const SEARCH_AGENT_TOOL_NAMES = new Set<string>([
  'email_search_fulltext',
  'email_body',
  'email_get',
  'email_list_thread'
])

// ── present_results ToolDef（§3.1，silent/meta/ipc）───────────────────────
//
// handler 仅回 ok({}) 占位 —— 真实取值由 wrapper 从 tool_use 事件的 input 读
// （白名单交集在 wrapper 层做，见 runSearchAgent 的 sink）。

export const presentResultsTool: ToolDef = {
  name: 'present_results',
  description:
    '必须且仅一次在最后调用；声明命中的邮件 + 摘要。matched_internal_ids 只能来自' +
    '此前 email_search_fulltext 返回的 internal_id，严禁编造。',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['matched_internal_ids', 'summary'],
    properties: {
      matched_internal_ids: {
        type: 'array',
        items: { type: 'integer' },
        maxItems: 50
      },
      summary: { type: 'string', maxLength: 500 },
      query_interpretation: { type: 'string', maxLength: 200 }
    }
  },
  confirmationTier: 'silent',
  category: 'meta',
  surface: 'ipc',
  handler: async (): Promise<ToolResult> => {
    // 占位：真实取值在 wrapper 从 tool_use 事件读（见 runSearchAgent sink）。
    return { ok: true, output: {}, durationMs: 0 }
  }
}

// ── headless platform：no-op persist + 其余委托/默认 ───────────────────────
//
// harness 只依赖注入的 ChatInfraPlatform（persist / loadEmailContext /
// resolveConfig / prefetchSenderDigest）。headless 不落 chat 库 → persist 全 no-op；
// loadEmailContext 返 null（搜索 agent 无单封邮件上下文）；resolveConfig 委托 base
// （拿到正确的 maxIter/maxCostUsd/harnessEnabled）；prefetchSenderDigest no-op。

function createHeadlessInfraPlatform(base: HttpChatPlatform): ChatInfraPlatform {
  return {
    persist: {
      getOrCreateSession: () =>
        Promise.reject(new Error('headless search agent does not persist sessions')),
      createNewSession: () =>
        Promise.reject(new Error('headless search agent does not persist sessions')),
      getSession: () => Promise.resolve(null),
      getMessage: () => Promise.resolve(null),
      listLastNMessages: () => Promise.resolve([]),
      appendMessage: () =>
        Promise.reject(new Error('headless search agent does not persist messages')),
      // fire-and-forget void → no-op（不落库）。
      streamContent: () => {},
      finalizeMessage: () => Promise.resolve(),
      deleteMessagesFromId: () => Promise.resolve(0),
      abortStreamingMessages: () => Promise.resolve(0),
      appendToolCall: () => Promise.resolve({ id: 0 }),
      updateToolCall: () => Promise.resolve(),
      // harness `if (row)` 守卫：返 null → 跳过 updateToolCall 路径（无审计行）。
      getToolCallByUseId: () => Promise.resolve(null)
    },
    // 搜索 agent 不锚定单封邮件 → 无 email context（裸 query 驱动）。
    // (runHarness 不调用，仅为接口完整性)
    loadEmailContext: () => Promise.resolve(null),
    // 委托 base 拿真实运行配置（harnessEnabled/kosL1），但 G-A5 把 maxIter/maxCostUsd
    // 独立于 chat 调紧（取 min —— chat 配置更小则保留更小），防接入 read 工具后逐封超读爆预算。
    resolveConfig: async (): Promise<ChatRuntimeConfig> => {
      const cfg = await base.resolveConfig()
      return {
        ...cfg,
        maxIter: Math.min(cfg.maxIter, SEARCH_AGENT_MAX_ITER),
        maxCostUsd: Math.min(cfg.maxCostUsd, SEARCH_AGENT_MAX_COST_USD)
      }
    },
    // L1 hot block 默认 OFF + 无单封邮件上下文 → no-op。
    prefetchSenderDigest: () => {}
  }
}

// ── 候选池 / 终局检测（核心，§3.2）─────────────────────────────────────────
//
// sink.send 内维护：toolUseId→name map（看 tool_use 事件）；email_search_fulltext
// 的 tool_result.output.items 按 internal_id 并入 pool（保序、首到优先）；一旦看到
// present_results 的 tool_use → 直接从其 input 读 {matched_internal_ids, summary,
// query_interpretation?}（不依赖 handler）→ 记录 → abort 结束 harness。

interface PresentResultsPayload {
  matchedIds: number[]
  summary: string
}

/** 从 present_results tool_use 的 input 提取 payload（容错：非法字段降级）。
 *  summary 按 schema maxLength:500 截断（schema 只是建议，LLM 可能超）。 */
function extractPresentResults(input: unknown): PresentResultsPayload {
  const i = (input ?? {}) as Record<string, unknown>
  const rawIds = Array.isArray(i.matched_internal_ids) ? i.matched_internal_ids : []
  const matchedIds = rawIds.filter((x): x is number => Number.isInteger(x))
  const summary = String(i.summary ?? '').slice(0, 500)
  return { matchedIds, summary }
}

/** 把一次 email_search_fulltext 的 tool_result.output.items 并入候选池（保序、首到优先）。 */
function mergeSearchHits(pool: Map<number, SearchHit>, output: unknown): void {
  const items = (output as { items?: unknown } | undefined)?.items
  if (!Array.isArray(items)) return
  for (const raw of items) {
    const hit = raw as SearchHit
    if (hit && Number.isInteger(hit.internal_id) && !pool.has(hit.internal_id)) {
      pool.set(hit.internal_id, hit)
    }
  }
}

// ── runSearchAgent（§3.2）─────────────────────────────────────────────────

export async function runSearchAgent(
  deps: SearchAgentDeps,
  input: SearchAgentInput
): Promise<SearchAgentResult> {
  // 永不 throw：全程 catch 成 error。
  try {
    return await runSearchAgentInner(deps, input)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, hits: [], summary: null, error: { code: 'E_AGENT', message } }
  }
}

async function runSearchAgentInner(
  deps: SearchAgentDeps,
  input: SearchAgentInput
): Promise<SearchAgentResult> {
  const { reads, baseUrl } = deps
  // G-A4: input.mailbox 归一化一次（trim）—— prompt 注入文案 + 最终硬过滤共用同一值，避免
  // 「prompt 用原值、过滤用 trim 值」漂移（含前后空格时两者不一致）。
  const wantMailbox = input.mailbox?.trim()

  // a. 读 search agent 配置：type==='search' && enabled → model/prompt（tools MVP 固定）。
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
    // 读配置失败（端点不可达 / 无 agent）→ 用内置默认（model=null 回退、内置 prompt）。
  }

  // 内置 prompt 占位填充（自定义 prompt 不强制含占位 → replaceAll 无命中即原样）。
  const today = new Date().toISOString().slice(0, 10)
  const me = (await resolveUserEmail(reads)) ?? '(unknown)'
  let systemPrompt = prompt.replaceAll('{today}', today).replaceAll('{me}', me)

  // wantMailbox 非空 → 追加文件夹限定上下文（让「指定 mailbox 搜索」真正生效）。
  if (wantMailbox) {
    systemPrompt +=
      `\n用户希望限定在「${wantMailbox}」文件夹检索，` +
      `请在 query 里用 in:「${wantMailbox}」或对应字段。`
  }

  // b. 构造：base platform（tools + llmFetch 共用）+ headless infra（no-op persist）+
  //    custom-api backend + mini registry [email_search_fulltext, present_results]。
  const base = new HttpChatPlatform(reads, baseUrl, deps.config ?? {})
  const infra = createHeadlessInfraPlatform(base)
  const backend = createCustomApiBackend(base)

  const registry = createToolRegistry()
  // G-A1 渐进式精读：注册 email_search_fulltext（检索）+ email_body/email_get/
  // email_list_thread（按需读正文/元数据/整条会话确认相关性）。其余 createEmailTools 工具
  // （email_search 元数据搜 / email_get_ai_fields）搜索 agent 不需要，不注册。
  for (const tool of createEmailTools(base)) {
    if (SEARCH_AGENT_TOOL_NAMES.has(tool.name)) registry.register(tool)
  }
  registry.register(presentResultsTool)

  // c. 假 history（system prompt 作首条 user 上下文前缀 + 用户 query）；sessionId/
  //    assistantMessageId = 0（headless）；自建 AbortController 与 input.signal 联动。
  const userContent =
    systemPrompt.length > 0 ? `${systemPrompt}\n\n用户查询：${input.query}` : input.query
  const initialHistory: ChatMessage[] = [
    {
      id: 0,
      session_id: 0,
      role: 'user',
      content: userContent,
      tokens_input: null,
      tokens_output: null,
      cost_usd: null,
      model: null,
      status: 'complete',
      error_message: null,
      metadata: null,
      thinking: null,
      created_at: 0,
      updated_at: 0
    }
  ]

  const ac = new AbortController()
  const onExternalAbort = (): void => ac.abort()
  if (input.signal) {
    if (input.signal.aborted) ac.abort()
    else input.signal.addEventListener('abort', onExternalAbort, { once: true })
  }

  // d. 候选池 + 终局检测（sink）。
  const pool = new Map<number, SearchHit>()
  const toolUseNames = new Map<string, string>()
  let presented: PresentResultsPayload | null = null
  let sawSearchPhase = false
  // harness error 事件（无 key/超时/配额/后端崩）→ 终局 fallback 归一成对应 error code。
  let harnessError: { code: string; message: string } | null = null

  const sink: HarnessSink = {
    send: (envelope) => {
      const evt = envelope.event
      if (evt.type === 'tool_use') {
        toolUseNames.set(evt.toolUseId, evt.name)
        if (evt.name === 'email_search_fulltext' && !sawSearchPhase) {
          sawSearchPhase = true
          input.onPhase?.('searching')
        }
        if (evt.name === 'present_results') {
          input.onPhase?.('summarizing')
          // 直接从 tool_use input 读 present_results（不依赖其 handler 占位）。
          if (!presented) presented = extractPresentResults(evt.input)
          // 终局：立即 abort 结束 harness（无需等其 tool_result 回灌再续轮）。
          ac.abort()
        }
      } else if (evt.type === 'tool_result') {
        const name = toolUseNames.get(evt.toolUseId)
        if (name === 'email_search_fulltext' && evt.status === 'ok') {
          mergeSearchHits(pool, evt.output)
        }
      } else if (evt.type === 'error') {
        // backend/harness 错误（E_NO_LLM_KEY / E_QUOTA / E_UPSTREAM / E_BACKEND_CRASH /
        // E_COST_BUDGET / E_MAX_ITER…）。首个生效；终局无 present_results 时透传给前端。
        if (!harnessError) harnessError = { code: evt.code, message: evt.message }
      }
    }
  }

  // e. 跑 harness（runHarness 永不 throw —— 内部 catch backend 异常 forward error 事件）。
  try {
    await runHarness({
      sessionId: 0,
      assistantMessageId: 0,
      backend,
      initialHistory,
      model,
      agentPageId: null,
      emailContext: null,
      ac,
      sink,
      platform: infra,
      registry
    })
  } finally {
    if (input.signal) input.signal.removeEventListener('abort', onExternalAbort)
  }

  // G-A4 mailbox 硬过滤：wantMailbox（归一化于函数顶部）非空 → 最终命中按文件夹后置硬过滤。
  // prompt 散文只是建议、模型可能忽略；这里保证「指定 mailbox 搜索」真正生效，不跨文件夹漏出。
  const filterByMailbox = (candidates: SearchHit[]): SearchHit[] =>
    wantMailbox ? candidates.filter((h) => h.mailbox === wantMailbox) : candidates

  // f. 终局组装：见到 present_results → 候选池 ∩ matched_internal_ids（保序、防幻觉）→ mailbox 硬过滤。
  if (presented) {
    const p: PresentResultsPayload = presented
    const validIds = p.matchedIds.filter((id) => pool.has(id))
    const hits = filterByMailbox(
      validIds.map((id) => pool.get(id)).filter((h): h is SearchHit => h !== undefined)
    )
    return { ok: true, hits, summary: p.summary }
  }

  // f-bis. 用户主动取消（external signal abort）→ 直接返 E_ABORTED，不落 best-effort /
  //   nlToDsl（用户不想要结果，浪费往返）。注意 present_results 触发的内部 abort 已在 f
  //   处理（presented 非空），故此处 aborted 必是外部取消。
  if (ac.signal.aborted && !presented) {
    return {
      ok: false,
      hits: [],
      summary: null,
      error: { code: 'E_ABORTED', message: 'cancelled' }
    }
  }

  // f-ter. G-A3 非顺从模型兜底：harness 自然结束（end_turn / 无 tool_use / 超预算
  //   E_MAX_ITER / E_COST_BUDGET）却没调 present_results，但候选池里已有真实命中 → 回
  //   best-effort（pool 保序 = 首次检索 rank 序、mailbox 硬过滤、截断 top N），不再把真实
  //   命中丢掉只回空手 nlToDsl。summary 为 null（模型没总结）。
  const bestEffort = filterByMailbox([...pool.values()]).slice(0, SEARCH_BESTEFFORT_MAX)
  if (bestEffort.length > 0) {
    return { ok: true, hits: bestEffort, summary: null }
  }

  // g. fallback：候选池也空（或被 mailbox 滤空）→ nlToDsl 兜底。harness 已 emit 明确错误
  //    （无 key / 配额 / 超时 / 后端崩）→ 优先透传该错误码，但仍尝试 nlToDsl 给 fallbackDsl
  //    （让前端能填回输入框降级搜索）。
  return await fallbackToNlToDsl(reads, input.query, harnessError)
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

/** fallback：调 nlToDsl 翻译成 DSL，前端填回输入框走普通搜索。harness 已 emit 明确
 *  错误（harnessError 非空，如无 key / 配额）→ 透传该错误码；nlToDsl 拿到 dsl 仍附
 *  fallbackDsl 供前端降级。 */
async function fallbackToNlToDsl(
  reads: MailApi,
  query: string,
  harnessError: { code: string; message: string } | null
): Promise<SearchAgentResult> {
  try {
    const res = await reads.email.nlToDsl(query)
    // nlToDsl 永不 reject —— 错误以 {dsl:'', error} 返回。
    const dsl = res.dsl && res.dsl.length > 0 ? res.dsl : undefined
    // error code 优先级：harness 明确错误 > nlToDsl 错误 > 无输出。
    const code = harnessError?.code ?? res.error ?? 'E_NO_OUTPUT'
    const message =
      harnessError?.message ?? res.message ?? res.error ?? 'search agent produced no results'
    const out: SearchAgentResult = { ok: false, hits: [], summary: null, error: { code, message } }
    if (dsl) out.fallbackDsl = dsl
    return out
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      hits: [],
      summary: null,
      error: harnessError ?? { code: 'E_AGENT', message }
    }
  }
}
