// V2.1 阶段 3 — 3c-2：ChatRuntime —— chat 引擎的「完整 ChatApi」组装层。
//
// B-pure-unified cutover：chat dispatcher + HttpChatPlatform 在 UI 进程跑，本文件把它们
// + 进程内 emitter sink 封装成完整 ChatApi（读 + 跑单一真源）。electron / web 唯一差异 =
// baseUrl + reads（工具读委托）+ 鉴权（main webRequest 注 token / CF cookie），全对 runtime
// 透明。组件只 useMailApi().chat，换实现零 diff（transport 铁律 ARCHITECTURE §2.2）。
//
// 接线（设计 §6.6.2）：
//   web      = HttpApi 构造 this.chat = createChatRuntime({ reads: this, baseUrl })
//   electron = ElectronApi 构造 this.chat = createChatRuntime({ reads: new HttpApi(LOOPBACK),
//              baseUrl: LOOPBACK })（3c-3 切；openPopout 由 ElectronApi override 回 IPC）
//
// engine（dispatcher + platform）lazy 构造：需 await GET /chat/config 预取配置快照（同步
// 方法无法 fetch），首次跑写方法前由 ensureEngine() 建并缓存。读 / deleteSession /
// confirmTool / abort 不触发构造（直接 fetch / module map / 已建 engine）。
//
// 🔴 不变式 1：零 Electron import（pnpm build:web 验）。只引 shared/chat + shared/api。

import { request } from '../api/http_client'
import type {
  ChatAnchorType,
  ChatApi,
  ChatBackendKind,
  ChatEditOpts,
  ChatMessage,
  ChatSession,
  ChatSessionListItem,
  ChatStartOpts,
  ChatStartResult,
  ChatToolCall,
  MailApi
} from '../api/types'
import { createCustomApiBackend } from './backends/custom_api'
import { createHttpNotionAgentBackend } from './backends/notion_agent_http'
import {
  createChatDispatcher,
  type ChatDispatcher,
  type EditChatInput,
  type StartChatInput,
  type StreamSink
} from './dispatcher'
import { ChatStreamEmitter } from './emitter'
import { HttpChatPlatform, type HttpPlatformConfig } from './http_platform'
import { runSearchAgent } from './search_agent'
import { createBuiltinTools } from './tools/builtin'
import { resolveConfirmation } from './tools/confirmation'
import { createToolRegistry, type ToolDef } from './tools/registry'
import { replaceWithManifestReadTools, type SkillToolInvoker } from './tools/manifest'
import type { SkillManifest } from './tools/manifest'
import { fetchSkillManifest } from './tools/manifest_client'
import {
  computeActiveSkillsHash,
  computeSkillEnablement,
  readSkillOverrides
} from './skill_enablement'
import type { ChatBackend } from './types'
import type {
  AgentMemoryEntry,
  SearchAgentInput,
  SearchAgentResult,
  SkillSummary,
  WriteMemoryInput
} from '../api/types'

export interface ChatRuntimeDeps {
  /** HttpChatPlatform 工具读委托（reads.email / reads.attachment）。web = HttpApi 自身；
   *  electron = new HttpApi(loopback)。**不**用 reads.chat（避免与本 runtime 循环 —— 见
   *  HttpApi.chat lazy getter 破循环注释）。 */
  reads: MailApi
  /** persist / llm-proxy / notion-agent / kos / chat 读 fetch 基址（同 HttpApi baseUrl）。 */
  baseUrl: string
  /** F2 — 是否启用 headless agentic 搜索（runSearchAgent）。桌面（ElectronApi）= true；
   *  远程 web（HttpApi）= false（默认）→ runSearchAgent 直接返 E_UNSUPPORTED（LLM key
   *  在桌面，远程 scope 外）。 */
  searchAgent?: boolean
}

/** lazy 构造的 chat 引擎。需 await GET /chat/config 预取快照 → 首次跑写方法前由
 *  ensureEngine() 构造并缓存（并发首跑去重）。 */
interface ChatEngine {
  dispatcher: ChatDispatcher
  platform: HttpChatPlatform
}

/** dispatcher 失败 → 归一化 Error&{code}，守 ChatApi「throw Error&{code}」契约。cutover 后无
 *  main IPC handler 兜底（旧路径 handlers/chat.ts 把 dispatcher reject 包成 envelope
 *  {ok:false,code} 再由 ElectronChatApi 解回 Error&{code}），runtime 同进程直 throw，故在此补
 *  同一映射：已有 err.code（dispatcher editChatMessage 设的 E_NOT_FOUND/E_INVALID_ARG）原样保留；
 *  "No chat backend registered" → E_BACKEND_UNAVAILABLE；其余 → E_DISPATCH。 */
function normalizeDispatchError(err: unknown): Error & { code: string } {
  if (err instanceof Error && typeof (err as Error & { code?: unknown }).code === 'string') {
    return err as Error & { code: string }
  }
  const message = err instanceof Error ? err.message : String(err)
  const code = message.includes('No chat backend registered')
    ? 'E_BACKEND_UNAVAILABLE'
    : 'E_DISPATCH'
  const normalized = new Error(message) as Error & { code: string }
  normalized.code = code
  return normalized
}

function invalidArg(message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string }
  err.code = 'E_INVALID_ARG'
  return err
}

/** start/editMessage 入口参数校验（抛 Error&{code:'E_INVALID_ARG'}），复刻 main
 *  handlers/chat.ts 的 validateStartOpts/validateEditOpts —— cutover 后无 IPC handler 前置
 *  拦截，runtime 承接，守 ChatApi「bad args → E_INVALID_ARG」契约。dispatcher 内部亦校验同类
 *  入参但抛无 code Error（会被 normalizeDispatchError 归成 E_DISPATCH）；前置校验确保 bad-args
 *  精确映射 E_INVALID_ARG（codex 3c-2 复审 LOW，parity 对齐 electron）。 */
function validateStartOpts(opts: ChatStartOpts): void {
  // P2d — anchor-aware: email (default) requires a non-negative emailId; general
  // ignores emailId (no sentinel). Anything else is E_INVALID_ARG.
  const anchorType = opts.anchorType ?? 'email'
  if (anchorType === 'email') {
    if (!Number.isInteger(opts.emailId) || (opts.emailId as number) < 0) {
      throw invalidArg('email anchor requires a non-negative integer emailId')
    }
  } else if (anchorType === 'general') {
    // codex review HIGH — a general anchor must NOT carry an emailId (incl. 0).
    if (opts.emailId != null) {
      throw invalidArg('general anchor must not carry an emailId')
    }
  } else {
    throw invalidArg(`anchorType must be 'email' or 'general', got ${String(anchorType)}`)
  }
  if (typeof opts.message !== 'string' || opts.message.length === 0) {
    throw invalidArg('message must be a non-empty string')
  }
  if (opts.backendKind !== 'notion-agent' && opts.backendKind !== 'custom-api') {
    throw invalidArg(`backendKind must be 'notion-agent' or 'custom-api', got ${opts.backendKind}`)
  }
}

function validateEditOpts(opts: ChatEditOpts): void {
  if (!Number.isInteger(opts.sessionId) || opts.sessionId < 0) {
    throw invalidArg('sessionId must be a non-negative integer')
  }
  if (!Number.isInteger(opts.editingMessageId) || opts.editingMessageId < 0) {
    throw invalidArg('editingMessageId must be a non-negative integer')
  }
  if (typeof opts.newContent !== 'string' || opts.newContent.length === 0) {
    throw invalidArg('newContent must be a non-empty string')
  }
  if (opts.backendKind !== 'notion-agent' && opts.backendKind !== 'custom-api') {
    throw invalidArg(`backendKind must be 'notion-agent' or 'custom-api', got ${opts.backendKind}`)
  }
}

export function createChatRuntime(deps: ChatRuntimeDeps): ChatApi {
  const { reads, baseUrl } = deps
  const searchAgentEnabled = deps.searchAgent ?? false

  // 构造期即建 emitter + sink：onStream 在首次 start 前就被 useEmailChat effect 订阅，
  // dispatcher 的 StreamSink.send → emitter.emit → React 同步收到（无 IPC、无序列化）。
  const emitter = new ChatStreamEmitter()
  const sink: StreamSink = {
    send: (envelope) => emitter.emit(envelope)
  }

  // engine lazy + promise 缓存（并发首跑去重）。失败清缓存让下次重试（config 端点暂时
  // 不可达 → 不永久 wedge）。
  let enginePromise: Promise<ChatEngine> | null = null

  // /chat/config 快照 memoize（runtime 作用域单例）：buildEngine（chat 引擎）与
  // runSearchAgent（F2）共用同一 promise，整 runtime 生命周期只拉一次（不再每次搜索重 fetch）。
  // 失败不缓存 → 下次重取（同 enginePromise 的重试语义）。
  let snapshotPromise: Promise<Partial<HttpPlatformConfig>> | null = null

  /** 预取 serve-api chat 运行配置快照（D-3c-3：配置以 serve-api 为准，避免本地改过的 env
   *  被 DEFAULT_HTTP_CONFIG 硬编码默认覆盖漂移）。端点 data 形状 = HttpPlatformConfig
   *  （camelCase 全字段，恒等覆盖）。预取失败（端点不可达 / 鉴权失败 / 10s 超时）→ {}
   *  （HttpChatPlatform 用 DEFAULT_HTTP_CONFIG 补全：harness ON / sonnet / KOS·L1 OFF）。
   *  F2：runSearchAgent 复用同一快照（同构造的 platform 运行配置一致）。 */
  async function fetchConfigSnapshotOnce(): Promise<Partial<HttpPlatformConfig>> {
    // 10s abort 兜底 (dogfood round 3): /chat/config 背后的 Notion context 加载
    // 慢时 (冷缓存/网络差) 此 await 是 chat panel 整体卡死点 — 后端已限 8s,
    // 这里再兜一层防旧版后端/远程链路慢, 超时同失败路径落 DEFAULT 继续构造。
    const ctrl = new AbortController()
    const prefetchTimer = setTimeout(() => ctrl.abort(), 10_000)
    try {
      return await request<HttpPlatformConfig>(baseUrl, 'GET', '/chat/config', {
        signal: ctrl.signal
      })
    } catch (err) {
      console.warn('[chat] runtime config prefetch failed, using DEFAULT_HTTP_CONFIG', err)
      return {}
    } finally {
      clearTimeout(prefetchTimer)
    }
  }

  /** memoize 包装：首次 await 后缓存 promise；失败不缓存（清掉让下次重取）。 */
  function fetchConfigSnapshot(): Promise<Partial<HttpPlatformConfig>> {
    if (!snapshotPromise) {
      snapshotPromise = fetchConfigSnapshotOnce().catch((err) => {
        snapshotPromise = null // 预取失败不缓存 → 下次重取。
        throw err
      })
    }
    return snapshotPromise
  }

  // P2b — read tools we cut over to the Skill manifest (generic invoke) when
  // MAILAGENT_CHAT_MANIFEST_MODE is on. Scoped to report_list/report_get — the only
  // tools whose builtin and manifest definitions are byte-identical (same name,
  // schema, semantics). email_search is deliberately EXCLUDED: the builtin is a
  // metadata filter while the manifest `email_search` is FTS body search (a different
  // tool under the same name — codex/workflow review HIGH); email_get's manifest
  // schema is a superset, not identical. replaceWithManifestReadTools additionally
  // schema-guards every swap, so a future drift in report_* is also kept builtin.
  const CUTOVER_READ_TOOLS = new Set(['report_list', 'report_get'])

  /** Build the harness tool catalog. Default = the builtin catalog (zero
   *  regression). manifestMode on: replace the cutover read tools with
   *  manifest-driven generic-invoke versions, keeping every other builtin tool.
   *  Manifest unreachable (null) → full builtin (fallback, architecture §3.2).
   *  P3 — the manifest is fetched ONCE in buildEngine (shared with skill
   *  enablement) and passed in here, not re-fetched. */
  function buildToolDefs(
    platform: HttpChatPlatform,
    snapshot: Partial<HttpPlatformConfig>,
    manifest: SkillManifest | null
  ): ToolDef[] {
    const builtin = createBuiltinTools(platform)
    if (!snapshot.manifestMode) return builtin
    if (!manifest) {
      console.warn('[chat] manifest mode on but manifest unreachable — using builtin catalog')
      return builtin
    }
    const invoke: SkillToolInvoker = async (skill, tool, input) => {
      const start = Date.now()
      try {
        const output = await platform.invokeSkillTool(skill, tool, input)
        return { ok: true, output, durationMs: Date.now() - start }
      } catch (e) {
        return {
          ok: false,
          code: (e as { code?: string }).code ?? 'E_SKILL_INVOKE',
          message: e instanceof Error ? e.message : String(e),
          durationMs: Date.now() - start
        }
      }
    }
    const { tools, skipped } = replaceWithManifestReadTools(
      builtin,
      manifest,
      invoke,
      CUTOVER_READ_TOOLS
    )
    if (skipped.length > 0) {
      // non-silent: a cutover tool the manifest didn't expose (disabled/unavailable)
      // or whose schema diverged is kept builtin — surface it (review MEDIUM).
      console.warn(
        `[chat] manifest mode kept builtin for ${skipped.join(', ')} (manifest missing or schema diverged)`
      )
    }
    return tools
  }

  async function buildEngine(): Promise<ChatEngine> {
    const snapshot = await fetchConfigSnapshot()

    // P3 — fetch the Skill manifest ONCE (graceful null on failure) and derive the
    // skill enablement from it + the user's per-skill overrides. Two effects, both
    // from the same (manifest, overrides) pair: (a) skillFragments injected into the
    // stable system prompt, (b) disabled/unavailable skills' tools filtered from the
    // catalog. Manifest unreachable → empty enablement (no filtering, no fragments =
    // today's behaviour) AND buildToolDefs falls back to builtin (zero regression).
    const manifest = await fetchSkillManifest(baseUrl)
    // PR5 — override source: the backend agent_config.db (snapshot.skillOverrides) is
    // the SSoT and WINS; the localStorage store is a TRANSITIONAL fallback so an
    // un-migrated user's prior per-surface toggles still apply until the Settings panel
    // pushes them to the backend + clears localStorage. computeSkillEnablement's
    // signature is unchanged (still (manifest, overrides)) — only the override source
    // moved. COLLISION_EXEMPT_TOOL_NAMES stays inside computeSkillEnablement (client-side).
    const overrides = { ...readSkillOverrides(), ...(snapshot.skillOverrides ?? {}) }
    const enablement = manifest
      ? computeSkillEnablement(manifest, overrides)
      : { disabledToolNames: new Set<string>(), skillFragments: '' }
    // PR5 — activeSkillsHash for Phase 0 eval trace (client-side: depends on the
    // advertised gate + collision-exempt logic here). Logged for observability; a
    // formal runtime accessor lands when Phase 0 wires the trace recorder.
    if (manifest) {
      console.debug('[chat] active_skills_hash', computeActiveSkillsHash(manifest, overrides))
    }

    // skillFragments rides in the platform config override (a client-side derivation,
    // NOT from the serve-api /chat/config snapshot) → modelConfig() surfaces it to
    // custom_api.buildStableSystemPrompt.
    const platform = new HttpChatPlatform(reads, baseUrl, {
      ...snapshot,
      skillFragments: enablement.skillFragments
    })

    // 工具 registry 注入式（取代 module-global）：createBuiltinTools(platform) 据
    // platform.kosConfig().configured（= 预取的 kosConfigured）gate 9 个 KOS 工具注册；
    // P2b：manifestMode on 时 buildToolDefs 把 cutover read 工具换成 manifest generic-invoke。
    // P3：再按 skill enablement 过滤掉禁用/不可用 skill 拥有的工具（按工具名，manifest 为
    // 归属权威；不属于任何 manifest skill 的工具[memory_*/kos_*]永不被过滤 = 核心工具安全）。
    const registry = createToolRegistry()
    for (const tool of buildToolDefs(platform, snapshot, manifest)) {
      if (enablement.disabledToolNames.has(tool.name)) continue
      registry.register(tool)
    }

    // backend factory 注入 platform：custom-api 复用既有 factory；notion-agent = http backend
    // 薄包 platform.notionAgentStream（与 electron execa 同形供 harness 消费）。
    const backends: Record<ChatBackendKind, ChatBackend> = {
      'custom-api': createCustomApiBackend(platform),
      'notion-agent': createHttpNotionAgentBackend(platform)
    }

    const dispatcher = createChatDispatcher({
      platform,
      getBackend: (kind) => {
        const backend = backends[kind]
        if (!backend) {
          throw new Error(`No chat backend registered for kind="${kind}".`)
        }
        return backend
      },
      toolRegistry: registry
    })
    return { dispatcher, platform }
  }

  function ensureEngine(): Promise<ChatEngine> {
    if (!enginePromise) {
      enginePromise = buildEngine().catch((err) => {
        enginePromise = null // 构造失败不缓存 → 下次 start 重试。
        throw err
      })
    }
    return enginePromise
  }

  function mapStart(opts: ChatStartOpts): StartChatInput {
    return {
      anchorType: opts.anchorType ?? 'email',
      emailId: opts.emailId ?? null,
      userMessage: opts.message,
      backendKind: opts.backendKind,
      backendModel: opts.backendModel ?? null,
      backendAgentPageId: opts.backendAgentPageId ?? null,
      sessionId: opts.sessionId ?? null,
      // task 06-08-chat 需求 5 — public boolean toggle → internal ThinkingOptions
      // (only carry an object when on; off/undefined → undefined = thinking off).
      thinking: opts.thinking ? { enabled: true } : undefined
    }
  }

  function mapEdit(opts: ChatEditOpts): EditChatInput {
    return {
      sessionId: opts.sessionId,
      editingMessageId: opts.editingMessageId,
      newContent: opts.newContent,
      backendKind: opts.backendKind,
      backendModel: opts.backendModel ?? null,
      backendAgentPageId: opts.backendAgentPageId ?? null,
      // task 06-08-chat 需求 5 — same boolean → ThinkingOptions mapping as mapStart.
      thinking: opts.thinking ? { enabled: true } : undefined
    }
  }

  return {
    async start(opts: ChatStartOpts): Promise<ChatStartResult> {
      // 归一化 dispatcher reject 为 Error&{code}（cutover 后无 main IPC handler 兜底，对齐
      // handlers/chat.ts chat:start 的 envelope code 映射：backend-missing→E_BACKEND_UNAVAILABLE）。
      try {
        validateStartOpts(opts)
        const engine = await ensureEngine()
        return await engine.dispatcher.startChat(mapStart(opts), sink)
      } catch (err) {
        throw normalizeDispatchError(err)
      }
    },

    async editMessage(opts: ChatEditOpts): Promise<ChatStartResult> {
      // 同 start：dispatcher editChatMessage 设的 E_NOT_FOUND/E_INVALID_ARG 原样保留，
      // backend-missing→E_BACKEND_UNAVAILABLE，其余→E_DISPATCH（对齐 chat:editMessage）。
      try {
        validateEditOpts(opts)
        const engine = await ensureEngine()
        return await engine.dispatcher.editChatMessage(mapEdit(opts), sink)
      } catch (err) {
        throw normalizeDispatchError(err)
      }
    },

    abort(sessionId: number): void {
      // fire-and-forget（ChatApi.abort 返 void）。非法 id 直接 return（对齐 handlers/chat.ts
      // chat:abort 的 Number.isInteger gate + deleteSession）。engine 未建 = 从未 start = 无
      // in-flight → return（不触发 engine 构造）。已建则 abort（abortChatSession 现 async →
      // .catch 收口未捕获 rejection）。
      if (!Number.isInteger(sessionId) || sessionId < 0) return
      if (!enginePromise) return
      void enginePromise
        .then((engine) => engine.dispatcher.abortChatSession(sessionId))
        .catch((err) => console.warn('[chat] runtime abort failed', err))
    },

    async confirmTool(
      toolUseId: string,
      approved: boolean,
      editedInput?: unknown
    ): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
      // 同进程 resolveConfirmation（无 IPC 往返）：跑中 harness 在 _pending module map
      // （confirmation.ts）注册的等待由此直接 resolve。无需 ensureEngine —— map 是
      // module-global；engine 未建 = 无 pending → E_NOT_PENDING。验 toolUseId 对齐
      // ElectronChatApi.confirmTool（空 → E_INVALID_ARG）。
      if (typeof toolUseId !== 'string' || toolUseId.length === 0) {
        return { ok: false, code: 'E_INVALID_ARG', message: 'toolUseId required' }
      }
      const accepted = resolveConfirmation(toolUseId, {
        approved: !!approved,
        editedInput: approved ? editedInput : undefined
      })
      if (!accepted) {
        return {
          ok: false,
          code: 'E_NOT_PENDING',
          message: `no confirmation pending for toolUseId="${toolUseId}"`
        }
      }
      return { ok: true }
    },

    async newSession(input: {
      anchorType?: ChatAnchorType
      emailId?: number | null
      backendKind: ChatBackendKind
      backendModel?: string | null
      backendAgentPageId?: string | null
    }): Promise<ChatSession> {
      // 走 platform.persist（单一真源，POST /chat/sessions/new）。用户点「+ 新建会话」后紧接
      // start → engine 构造可接受。throw Error&{code} 由 request() 透传（E_INVALID_ARG / E_DISPATCH）。
      // P3 — email 路径**逐字节零回归**：不带 anchorType（serve-api 默认 'email'），body 形状
      // 与既有完全一致；仅 'general' 显式带 anchorType:'general' + emailId:null（serve-api
      // _validate_session_opts 拒 general 携 emailId），createNewSession 无条件 INSERT 新 general 行。
      const engine = await ensureEngine()
      const base = {
        backendKind: input.backendKind,
        backendModel: input.backendModel ?? null,
        backendAgentPageId: input.backendAgentPageId ?? null
      }
      return engine.platform.persist.createNewSession(
        input.anchorType === 'general'
          ? { anchorType: 'general', emailId: null, ...base }
          : { emailId: input.emailId ?? null, ...base }
      )
    },

    async saveToKos(input: {
      messageId: number
      slug?: string
      title?: string
    }): Promise<{ slug: string; status: string; contentBytes: number }> {
      // 走 platform.saveToKos（POST /chat/save-to-kos）。throw Error&{code} 由 request() 透传
      // （E_NOT_FOUND / E_INVALID_ARG / E_KOS_*），renderer toast 兜底。
      const engine = await ensureEngine()
      return engine.platform.saveToKos(input)
    },

    deleteSession(sessionId: number): void {
      // fire-and-forget（ChatApi.deleteSession 返 void）。DELETE /chat/sessions/{id}（其消息 +
      // 工具调用经 FK CASCADE 连带删）。renderer 已乐观移除该行；失败 warn 不回滚（mirror
      // ElectronChatApi fire-and-forget）。直接 fetch（不经 engine —— 删会话无需 dispatcher）。
      if (!Number.isInteger(sessionId) || sessionId < 0) return
      void request(baseUrl, 'DELETE', `/chat/sessions/${sessionId}`).catch((err) =>
        console.warn('[chat] runtime deleteSession failed', err)
      )
    },

    openPopout(_emailId: number): void {
      // Electron BrowserWindow 能力（开独立 chat 窗口）—— shared runtime 无第二窗口（web 无此
      // 场景）→ no-op。3c-3 electron 切 runtime 时由 ElectronApi override 注入真实
      // window:openChatPopout IPC（不进 shared）。
    },

    // ── 读（直接 fetch baseUrl/chat/*，graceful 返 []/false；不触发 engine 构造）──────────
    async listMessages(sessionId: number): Promise<ChatMessage[]> {
      try {
        return await request<ChatMessage[]>(baseUrl, 'GET', `/chat/sessions/${sessionId}/messages`)
      } catch {
        return []
      }
    },

    async listSessions(emailId: number): Promise<ChatSession[]> {
      try {
        return await request<ChatSession[]>(baseUrl, 'GET', '/chat/sessions', {
          query: { emailId }
        })
      } catch {
        return []
      }
    },

    async listAllSessions(): Promise<ChatSessionListItem[]> {
      try {
        return await request<ChatSessionListItem[]>(baseUrl, 'GET', '/chat/sessions/all')
      } catch {
        return []
      }
    },

    async listGeneralSessions(): Promise<ChatSession[]> {
      // P2d — general (context-free) sessions for the Cmd+O surface (P3). Direct
      // fetch, graceful [] (no engine construction needed).
      try {
        return await request<ChatSession[]>(baseUrl, 'GET', '/chat/sessions/general')
      } catch {
        return []
      }
    },

    async listToolCalls(messageId: number): Promise<ChatToolCall[]> {
      try {
        return await request<ChatToolCall[]>(
          baseUrl,
          'GET',
          `/chat/messages/${messageId}/tool-calls`
        )
      } catch {
        return []
      }
    },

    async kosAvailable(): Promise<boolean> {
      try {
        return await request<boolean>(baseUrl, 'GET', '/chat/kos-available')
      } catch {
        return false
      }
    },

    onStream(handler) {
      // emitter 用 chat/types.ChatStreamEnvelope，ChatApi.onStream 用 api/types 同形 envelope
      // （结构等价，仅 interface 名不同）→ 结构化兼容，直接订阅。
      return emitter.subscribe(handler)
    },

    async runSearchAgent(input: SearchAgentInput): Promise<SearchAgentResult> {
      // 能力 gate：远程 web（HttpApi 不传 searchAgent）= false → E_UNSUPPORTED（LLM key
      // 在桌面，远程 scope 外）。桌面（ElectronApi）传 searchAgent:true 启用。
      if (!searchAgentEnabled) {
        return {
          ok: false,
          hits: [],
          summary: null,
          error: {
            code: 'E_UNSUPPORTED',
            message: 'agentic search is desktop-only (LLM key lives on the host)'
          }
        }
      }
      // 复用 chat 引擎的同一份 /chat/config 快照（运行配置一致）。预取失败 → {} →
      // search_agent 内 HttpChatPlatform 补 DEFAULT_HTTP_CONFIG。runSearchAgent 永不 throw。
      const config = await fetchConfigSnapshot()
      return runSearchAgent({ reads, baseUrl, config }, input)
    },

    invalidateConfig(): void {
      // P3 — drop the cached engine + config snapshot so the NEXT start() rebuilds
      // with a fresh /chat/config (memorySummary) + manifest + skill enablement.
      // In-flight streams kept their own engine reference, so they're unaffected.
      // Idempotent: nulling already-null promises is a no-op.
      enginePromise = null
      snapshotPromise = null
    },

    async listSkills(): Promise<SkillSummary[]> {
      // PR5 — read the RESOLVED list from the backend (GET /agent/skills): manifest
      // skills (builtin + installed) ⋈ agent_config.db enable overrides + source_type.
      // Replaces the old manifest-flatten + localStorage overlay. Graceful [] when
      // unreachable (the Settings section shows an empty state, never throws).
      try {
        const data = await request<{ skills: SkillSummary[] }>(baseUrl, 'GET', '/agent/skills')
        return data.skills ?? []
      } catch {
        return []
      }
    },

    async setSkillEnabled(name: string, enabled: boolean): Promise<void> {
      // PR5 — persist the toggle to the backend (POST /agent/skills/{name}/enabled).
      // Throws Error&{code} on failure (request() 透传 E_NOT_FOUND / E_INVALID_ARG).
      // Caller invalidateConfig() so the next start() rebuilds with the new enablement.
      await request(baseUrl, 'POST', `/agent/skills/${encodeURIComponent(name)}/enabled`, {
        body: { enabled }
      })
    },

    async listMemory(scope?: string): Promise<AgentMemoryEntry[]> {
      // P3 — direct fetch (no engine needed), graceful [] (same pattern as the
      // read methods above). GET /chat/memory[?scope=].
      try {
        return await request<AgentMemoryEntry[]>(baseUrl, 'GET', '/chat/memory', {
          query: scope ? { scope } : undefined
        })
      } catch {
        return []
      }
    },

    async writeMemory(input: WriteMemoryInput): Promise<AgentMemoryEntry> {
      // P3 — upsert; throw Error&{code}透传（E_INVALID_ARG）。caller invalidateConfig()
      // 让下一轮 memory summary 生效。
      return request<AgentMemoryEntry>(baseUrl, 'POST', '/chat/memory', { body: input })
    },

    async deleteMemory(scope: string, key: string): Promise<number> {
      // P3 — DELETE /chat/memory?scope=&key= → {deleted}. caller invalidateConfig().
      const data = await request<{ deleted: number }>(baseUrl, 'DELETE', '/chat/memory', {
        query: { scope, key }
      })
      return data.deleted
    }
  }
}
