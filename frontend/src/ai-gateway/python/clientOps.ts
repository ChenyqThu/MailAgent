// Sessions, group sessions, profile/memory docs, web, notion, connectors, exec, approval/labs/policy.
import { EmailDomainClient } from './clientEmail'
import type {
  DomainProfileDocResult,
  DomainProfileHistoryEntry,
  DomainResolvedSkill,
  DomainChatSessionSummary,
  DomainChatMessage,
  DomainWebFetchResult,
  DomainWebSearchResult,
  DomainNotionAgentChatResult,
  DomainConnectorList,
  DomainConnectorTools,
  DomainConnectorInvokeResult,
  DomainExecRunResult,
  DomainExecFileReadResult,
  DomainExecFileWriteResult,
  DomainPolicyVerdict,
  DomainGroupSessionCreated,
  DomainPolicyRule,
  DomainSessionSearchHit,
  DomainSessionQuery
} from './domainTypes'
import type { AssistantIdentity } from '@shared/api/types'
import type { GroupConfig } from '@shared/chat_model'

export class OpsDomainClient extends EmailDomainClient {
  // ── session-read primitives (S1 R1) — the chat-session tools read the SAME ai_chat.db the
  //    gateway persists into, but through serve-api /chat/sessions/* (never SQLite directly):
  //    remote parity for free + the gateway core stays chat_db-free (纯核纪律). The tools that
  //    call these are only registered when MAILAGENT_OPENNESS_SESSION_TOOLS is on.

  /** chat_session_list — recent sessions incl. preview + message_count. GET /chat/sessions/all
   *  (fixed server-side cap 300; the tool slices to its own limit). */
  listSessions(
    query?: DomainSessionQuery,
    signal?: AbortSignal,
    scope?: { currentAgentId: string; allowAllHistory: boolean }
  ): Promise<DomainChatSessionSummary[]> {
    return this._req<DomainChatSessionSummary[]>('GET', '/chat/sessions/all', {
      query: query
        ? {
            origin: query.origin,
            agentId: query.agentId,
            agentJobId: query.agentJobId,
            triggerId: query.triggerId,
            triggerKind: query.triggerKind,
            createdAfter: query.createdAfter,
            createdBefore: query.createdBefore,
            archived: query.archived,
            starred: query.starred,
            limit: query.limit
          }
        : undefined,
      headers: scope
        ? {
            'X-MailAgent-Agent-Id': scope.currentAgentId,
            'X-MailAgent-Allow-All-History': scope.allowAllHistory ? '1' : '0'
          }
        : undefined,
      signal
    })
  }

  /** chat_session_search — FTS (trigram) message search aggregated by session. GET
   *  /chat/sessions/search (param is `q`; <3-char queries LIKE-fallback server-side). */
  searchSessions(
    query: string,
    filters?: DomainSessionQuery,
    signal?: AbortSignal,
    scope?: { currentAgentId: string; allowAllHistory: boolean }
  ): Promise<DomainSessionSearchHit[]> {
    return this._req<DomainSessionSearchHit[]>('GET', '/chat/sessions/search', {
      query: { q: query, ...filters },
      headers: scope
        ? {
            'X-MailAgent-Agent-Id': scope.currentAgentId,
            'X-MailAgent-Allow-All-History': scope.allowAllHistory ? '1' : '0'
          }
        : undefined,
      signal
    })
  }

  /** chat_session_get — all messages of one session (chronological). GET
   *  /chat/sessions/{id}/messages. Missing session → [] (the endpoint reads gracefully); an
   *  out-of-scope session under an own-radius `scope` → E_NOT_FOUND (server-enforced, same
   *  headers as list/search). */
  getSessionMessages(
    sessionId: number,
    signal?: AbortSignal,
    scope?: { currentAgentId: string; allowAllHistory: boolean }
  ): Promise<DomainChatMessage[]> {
    return this._req<DomainChatMessage[]>('GET', `/chat/sessions/${sessionId}/messages`, {
      headers: scope
        ? {
            'X-MailAgent-Agent-Id': scope.currentAgentId,
            'X-MailAgent-Allow-All-History': scope.allowAllHistory ? '1' : '0'
          }
        : undefined,
      signal
    })
  }

  // ── group-session write primitives (L4 群聊 g2) — the ONLY serve-api writes of the group tool
  //    family (tools/groups.ts): history / members / deliveries go through the in-process cfg
  //    hooks, building a group and applying its config go here so the authoritative validation
  //    (chat-capable members / MAX_GROUP_MEMBERS / subgroup ⊆ parent / single-level nesting)
  //    stays in routers/chat.py — the gateway never mirrors it (红线 5).

  /** group_create step 1 — POST /chat/sessions/new with groupMembers (恒 general anchor).
   *  parentSessionId (subgroup) / invokedBy ('main_agent' | 'judge') only go on the wire when
   *  present; a 4xx (non-subset / nested / not-a-group parent …) surfaces as DomainError
   *  E_INVALID_ARG + hint for the model to read. */
  createGroupSession(
    input: {
      title: string
      groupMembers: string[]
      parentSessionId?: number | null
      invokedBy?: string
    },
    signal?: AbortSignal
  ): Promise<DomainGroupSessionCreated> {
    const body: Record<string, unknown> = {
      title: input.title,
      groupMembers: input.groupMembers
    }
    if (typeof input.parentSessionId === 'number') body.parentSessionId = input.parentSessionId
    if (typeof input.invokedBy === 'string') body.invokedBy = input.invokedBy
    return this._req<DomainGroupSessionCreated>('POST', '/chat/sessions/new', { body, signal })
  }

  /** group_create step 2 — PUT /chat/sessions/{id}/group-config (judge / modes / caps…; only
   *  the keys passed are written, explicit null clears a key). Server-validated. */
  setGroupConfig(
    sessionId: number,
    patch: Partial<GroupConfig> & { modes?: Record<string, 'realtime' | 'mention'> },
    signal?: AbortSignal
  ): Promise<void> {
    return this._req<void>('PUT', `/chat/sessions/${sessionId}/group-config`, {
      body: patch,
      signal
    })
  }

  /** group_create compensation — DELETE /chat/sessions/{id} (messages + tool calls cascade).
   *  Idempotent server-side (an unknown id still answers deleted:true). */
  deleteSession(sessionId: number, signal?: AbortSignal): Promise<void> {
    return this._req<void>('DELETE', `/chat/sessions/${sessionId}`, { signal })
  }

  // ── self-mount primitives (M4) — the agent reads/proposes its own Standing Context docs +
  //    skills. All hit /agent/* (verify_cf_access dual-auth: the embedded gateway's local-token leg
  //    passes — owner-equivalent on loopback). The gateway ApprovalGuard gates the writes; rules
  //    content is validated server-side. The tools that call these are only registered when
  //    MAILAGENT_SKILL_SELF_MOUNT is on.

  /** update_system_md (M4b) — overwrite a Standing Context doc. POST /agent/profile/docs/{name}.
   *  For name==='rules' the server runs validate_rules_content → 400 E_INVALID_ARG (→ DomainError)
   *  on a jailbreak/override phrase. The tool passes updatedBy='agent_proposed'. */
  setProfileDoc(
    name: string,
    body: { content: string; updatedBy?: string; sessionId?: number; messageId?: number },
    signal?: AbortSignal
  ): Promise<DomainProfileDocResult> {
    return this._req<DomainProfileDocResult>(
      'POST',
      `/agent/profile/docs/${encodeURIComponent(name)}`,
      { body, signal }
    )
  }

  // ── profile-config primitives (S1 R2) — read/history/restore Standing Context docs +
  //    memory.md edit. Same /agent/* owner surface as setProfileDoc (verify_cf_access local-token
  //    leg). The tools that call these are only registered when MAILAGENT_OPENNESS_CONFIG_TOOLS
  //    is on; the two writes are gated by the gateway ApprovalGuard (edit-tier, always ask).

  /** agent_profile_read (S1 R2) — full content + version info of one profile doc
   *  (soul/agent/rules/user/memory). GET /agent/profile/docs/{name}; memory carries
   *  budgetChars. */
  readProfileDoc(name: string, signal?: AbortSignal): Promise<DomainProfileDocResult> {
    return this._req<DomainProfileDocResult>(
      'GET',
      `/agent/profile/docs/${encodeURIComponent(name)}`,
      { signal }
    )
  }

  /** agent_profile_history (S1 R2) — version history (newest first). GET /agent/profile/history
   *  ?docName=&limit= → data.history. */
  async listProfileHistory(
    docName: string,
    limit?: number,
    signal?: AbortSignal
  ): Promise<DomainProfileHistoryEntry[]> {
    const data = await this._req<{ history: DomainProfileHistoryEntry[] }>(
      'GET',
      '/agent/profile/history',
      { query: { docName, limit }, signal }
    )
    return data.history ?? []
  }

  /** agent_profile_restore (S1 R2) — roll a profile doc back to a history version. POST
   *  /agent/profile/docs/{name}/rollback {targetHash}. For name==='rules' the server re-runs
   *  validate_rules_content on the target snapshot → 400 E_INVALID_ARG (→ DomainError) so a
   *  jailbreak version can never be revived. The tool passes updatedBy='agent_proposed'. */
  rollbackProfileDoc(
    name: string,
    targetHash: string,
    signal?: AbortSignal
  ): Promise<DomainProfileDocResult> {
    return this._req<DomainProfileDocResult>(
      'POST',
      `/agent/profile/docs/${encodeURIComponent(name)}/rollback`,
      { body: { targetHash, updatedBy: 'agent_proposed' }, signal }
    )
  }

  /** agent_memory_update (S1 R2) — overwrite memory.md (bounded memory). POST
   *  /agent/profile/docs/memory; the server enforces the hard character budget → 400
   *  E_INVALID_ARG (→ DomainError) when exceeded. Kept separate from setProfileDoc so the
   *  identity boundary stays explicit (memory ≠ Standing Context identity doc). */
  setMemoryDoc(content: string, signal?: AbortSignal): Promise<DomainProfileDocResult> {
    return this._req<DomainProfileDocResult>('POST', '/agent/profile/docs/memory', {
      body: { content, updatedBy: 'agent_proposed' },
      signal
    })
  }

  /** discover_skills (M4c) — list resolved skills (enabled/available/unavailableReason/toolCount).
   *  GET /agent/skills → data.skills. */
  async listResolvedSkills(signal?: AbortSignal): Promise<DomainResolvedSkill[]> {
    const data = await this._req<{ skills: DomainResolvedSkill[] }>('GET', '/agent/skills', {
      signal
    })
    return data.skills ?? []
  }

  /** set_skill_enabled (M4c) — enable/disable a skill (mount/unmount its tools). POST
   *  /agent/skills/{name}/enabled {enabled}. */
  setSkillEnabled(
    name: string,
    enabled: boolean,
    signal?: AbortSignal
  ): Promise<{ name: string; enabled: boolean }> {
    return this._req<{ name: string; enabled: boolean }>(
      'POST',
      `/agent/skills/${encodeURIComponent(name)}/enabled`,
      { body: { enabled }, signal }
    )
  }

  // ── web primitives (S1 R3) — outbound network via serve-api /web/* (never node:fetch in the
  //    gateway core): the business authority (SSRF guard, IP pinning, content extraction) lives in
  //    Python (routers/web.py) → remote parity for free. The tools that call these are only
  //    registered when MAILAGENT_OPENNESS_WEB_TOOLS is on; both are edit-tier (always ask).

  /** web_fetch (S1 R3) — fetch one http/https URL's content (SSRF-guarded, IP-pinned server-side).
   *  POST /web/fetch {url, max_chars}. Returns the extracted text (untrusted) + metadata.
   *  `constrain` (S6 W3, ADR-004 rev3.1 D-fix-1) — a gated headless agent fetch passes the run's
   *  agentId + derived contextMode so the endpoint enforces the per-agent redirect origin
   *  whitelist (the SAME enabled+dual-key candidate set policyEvaluate consults, resolved
   *  server-side — the gateway never assembles the origin list). Absent (manual / open tier) →
   *  the body is byte-identical to the S1 shape. */
  webFetch(
    url: string,
    maxChars: number,
    signal?: AbortSignal,
    constrain?: { agentId: string; contextMode: string }
  ): Promise<DomainWebFetchResult> {
    const body: Record<string, unknown> = { url, max_chars: maxChars }
    if (constrain) {
      body.agent_id = constrain.agentId
      body.context_mode = constrain.contextMode
    }
    return this._req<DomainWebFetchResult>('POST', '/web/fetch', { body, signal })
  }

  /** web_search (S1 R3) — DuckDuckGo web search (best-effort). POST /web/search {query, limit}. */
  webSearch(query: string, limit: number, signal?: AbortSignal): Promise<DomainWebSearchResult> {
    return this._req<DomainWebSearchResult>('POST', '/web/search', {
      body: { query, limit },
      signal
    })
  }

  // ── notion-agent primitive (task 07-21) — delegate a Notion request to the notion-agent CLI via
  //    the unified Skill Delivery invoke面 (POST /api/skills/invoke). The gateway never spawns the
  //    subprocess itself — Python's builtin notion_agent skill handler owns the subprocess bridge
  //    (serial gate + idle watchdog, src/skills/builtin/notion_agent.py → src/chat/notion_agent.py).
  //    The loopback local-token authenticates as the OWNER principal (scopes=None) so the tool's
  //    notion_agent:invoke scope passes. The server-side ToolDef confirmation_tier is 'edit' (codex
  //    HIGH-2 raised it from 'preview'), so a raw /api/skills/invoke call needs confirm=true; the
  //    gateway passes confirm=true only AFTER its own 恒-HITL card is approved (the tool is edit-tier
  //    HITL at the gateway too — the human decision reaches both gates). The tool
  //    that calls this is only registered when MAILAGENT_NOTION_AGENT_TOOL is on AND the notion_agent
  //    skill is advertised (SkillsSection toggle → skill_gating). ──

  /** notion_agent_chat (task 07-21) — run one notion-agent request. POST /api/skills/invoke
   *  {skill:'notion_agent', tool:'notion_agent_chat', input:{prompt, thread_id?, model?}}. Returns
   *  the tool result {final_content, thread_id}. */
  notionAgentChat(
    prompt: string,
    opts: { threadId?: string; model?: string },
    signal?: AbortSignal
  ): Promise<DomainNotionAgentChatResult> {
    const input: Record<string, unknown> = { prompt }
    if (opts.threadId !== undefined) input.thread_id = opts.threadId
    if (opts.model !== undefined) input.model = opts.model
    // 07-21 (codex HIGH-2) — notion_agent_chat is confirmation_tier=edit server-side, so the invoke
    // chokepoint requires an explicit boolean confirm=true (mirrors send/draft). This method only
    // runs from the gateway tool's execute, i.e. AFTER the 恒-HITL card was approved — so passing
    // confirm:true here is the human decision reaching Python's second gate (defense in depth). A
    // direct external /api/skills/invoke without confirm still 403s.
    return this._req<DomainNotionAgentChatResult>('POST', '/skills/invoke', {
      body: { skill: 'notion_agent', tool: 'notion_agent_chat', input, confirm: true },
      signal
    })
  }

  // ── MCP connector primitives (stage 1 PR2, MAILAGENT_MCP_CONNECTORS) — the connector tool
  //    manifest + call proxy live in Python serve-api /connector/* (the MCP client, OAuth
  //    credentials and the tool whitelist are all Python-side; the gateway only carries the
  //    envelope — web.ts / notion_agent.ts discipline). All three are only ever called when the
  //    flag is on AND the run is manual chat (tools/connector.ts + the lifecycle seam). ──

  /** List connectors (registry ∪ DB runtime state). GET /connector. */
  listConnectors(signal?: AbortSignal): Promise<DomainConnectorList> {
    return this._req<DomainConnectorList>('GET', '/connector', { signal })
  }

  /** List one connector's synced tool manifest (effective_mode already folded server-side —
   *  08-05 per-tool tiers; orphan rows still listed — the registration seam skips them).
   *  GET /connector/{id}/tools. */
  listConnectorTools(connectorId: string, signal?: AbortSignal): Promise<DomainConnectorTools> {
    return this._req<DomainConnectorTools>(
      'GET',
      `/connector/${encodeURIComponent(connectorId)}/tools`,
      { signal }
    )
  }

  /** Invoke one connector tool through the serve-api MCP call proxy (whitelist-gated server-side:
   *  unsynced/orphan/delete/disabled names never reach the remote; the result is already truncated
   *  to CALL_RESULT_MAX_CHARS). POST /connector/{id}/tools/{name}/invoke.
   *  `caller` (PR3) — the invocation provenance the gateway ALWAYS sends (manual →
   *  {context_mode:'manual_chat'}; headless → the actual mode + agent_id). 🔴 This is NOT a mere
   *  audit annotation: Python's `resolve_caller_ceiling` gates on it (manual → no ceiling, byte
   *  identical to PR2; headless → re-reads that agent's grant_connectors and denies 403 without a
   *  grant or above the ceiling; any other venue → hard deny; bad shape → 400). Sending a wrong /
   *  missing mode therefore CHANGES authorization — the gateway matrix + registration filter are
   *  the FIRST belt, this wire field is what lets the second one exist server-side. */
  invokeConnectorTool(
    connectorId: string,
    toolName: string,
    args: Record<string, unknown> | undefined,
    signal?: AbortSignal,
    caller?: {
      contextMode: string
      agentId?: string
      jobId?: number
      dispatchId?: number
      childTool?: string
    }
  ): Promise<DomainConnectorInvokeResult> {
    const body: Record<string, unknown> = { arguments: args ?? {} }
    if (caller) {
      body.caller = {
        context_mode: caller.contextMode,
        ...(caller.agentId !== undefined ? { agent_id: caller.agentId } : {}),
        ...(caller.jobId !== undefined ? { job_id: caller.jobId } : {}),
        ...(caller.dispatchId !== undefined ? { dispatch_id: caller.dispatchId } : {}),
        ...(caller.childTool !== undefined ? { child_tool: caller.childTool } : {})
      }
    }
    return this._req<DomainConnectorInvokeResult>(
      'POST',
      `/connector/${encodeURIComponent(connectorId)}/tools/${encodeURIComponent(toolName)}/invoke`,
      { body, signal }
    )
  }

  // ── exec primitives (S2 W1) — local command / filesystem execution via serve-api /exec/* (never
  //    child_process/fs in the gateway core): the business authority (fixed env allowlist, inode
  //    deny floor, no shell) lives in Python (routers/exec.py) → remote parity for free. The tools
  //    that call these are only registered when MAILAGENT_OPENNESS_EXEC_TOOLS is on; all three are
  //    edit-tier (always ask unless a whitelist rule matches).

  /** run_command (S2 W1) — run one local command (NO shell). POST /exec/run {argv, cwd?, timeout_ms}.
   *  `audit` (S5 W4, ADR-004 D4 附带项) — PURE audit annotation (context_mode + agent_id) for a
   *  headless agent run's ledger row; the endpoint never gates on it (authorization stays in the
   *  gateway matrix + evaluate). Absent (manual) → body byte-identical to the S2 shape. */
  runCommand(
    argv: string[],
    opts: { cwd?: string; timeoutMs?: number },
    signal?: AbortSignal,
    audit?: { contextMode?: string; agentId?: string }
  ): Promise<DomainExecRunResult> {
    const body: Record<string, unknown> = { argv }
    if (opts.cwd !== undefined) body.cwd = opts.cwd
    if (opts.timeoutMs !== undefined) body.timeout_ms = opts.timeoutMs
    this._applyExecAudit(body, audit)
    return this._req<DomainExecRunResult>('POST', '/exec/run', { body, signal })
  }

  /** file_read (S2 W1) — read a local file's text. POST /exec/file_read {path, max_bytes}.
   *  Sensitive targets → DomainError E_EXEC_FLOOR_DENIED (the inode deny floor). */
  fileRead(
    path: string,
    maxBytes: number,
    signal?: AbortSignal,
    audit?: { contextMode?: string; agentId?: string }
  ): Promise<DomainExecFileReadResult> {
    const body: Record<string, unknown> = { path, max_bytes: maxBytes }
    this._applyExecAudit(body, audit)
    return this._req<DomainExecFileReadResult>('POST', '/exec/file_read', { body, signal })
  }

  /** file_write (S2 W1) — write text to a local file. POST /exec/file_write {path, content, mode}.
   *  Sensitive targets → DomainError E_EXEC_FLOOR_DENIED; create_new on an existing file → E_FILE_EXISTS. */
  fileWrite(
    path: string,
    content: string,
    mode: 'overwrite' | 'append' | 'create_new',
    signal?: AbortSignal,
    audit?: { contextMode?: string; agentId?: string }
  ): Promise<DomainExecFileWriteResult> {
    const body: Record<string, unknown> = { path, content, mode }
    this._applyExecAudit(body, audit)
    return this._req<DomainExecFileWriteResult>('POST', '/exec/file_write', { body, signal })
  }

  /** S5 W4 — stamp the /exec/* audit annotation fields (snake_case per the Python body schema)
   *  onto a request body. Absent/empty audit → the body is untouched (manual byte-identical). */
  private _applyExecAudit(
    body: Record<string, unknown>,
    audit?: { contextMode?: string; agentId?: string }
  ): void {
    if (audit?.contextMode != null) body.context_mode = audit.contextMode
    if (audit?.agentId != null) body.agent_id = audit.agentId
  }

  // ── approval mode (07-16 approval-mode switcher) ─────────────────────────────────────────────

  /** GET /agent/approval-mode → the owner-global chat approval mode row
   *  ({mode: 'manual'|'bypass'} — 08-05 WP-11 retired 'acceptEdits'; serve-api fail-closes dirty
   *  and legacy rows to 'manual'). Consulted by the lifecycle's resolveGlobalApprovalMode
   *  (short-TTL cache + bounded timeout, any failure → 'manual'). READ-ONLY from the gateway:
   *  mode switching is an owner UI action (verify_cf_access endpoint) — no gateway tool can
   *  reach the PUT. */
  getApprovalMode(signal?: AbortSignal): Promise<{ mode: string }> {
    return this._req<{ mode: string }>('GET', '/agent/approval-mode', { signal })
  }

  /** g1 群聊 labs — GET /agent/labs → owner_settings 的实验开关行（今天只有
   *  `{groupAgents: 'on'|'off'}`，key `labs_group_agents`；缺行 / 脏值 serve-api 一律返 'off'）。
   *  由 lifecycle 的 resolveLabsFlags 消费（短 TTL + 有界超时，任何失败 → off，fail-closed）。
   *  READ-ONLY from the gateway：开关是 owner UI 动作（verify_cf_access PUT），没有任何 gateway
   *  工具够得着写面（policy_rules 同款纪律）。 */
  getLabsFlags(signal?: AbortSignal): Promise<{ groupAgents: string }> {
    return this._req<{ groupAgents: string }>('GET', '/agent/labs', { signal })
  }

  /** T4 主 agent 入群 — GET /agent/assistant-identity → owner_settings 的主 agent 显示身份
   *  ({name, avatar}；缺行 / 坏 JSON serve-api 自己 fail-open 成 {null, null}）。
   *
   *  🔴 任何读失败（E_NOT_FOUND / 网络 / serve-api 抖动）→ null，**不 throw**：唯一调用方是
   *  resolveGroupSession 的保留字分支，那里的硬约束是「成员绝不能因为读配置失败而消失」
   *  （成员事实是 speakAsAgentId 的安全判据，丢了就是 403）。返回 null 时调用方 push 一个
   *  降级成员，而不是丢掉这个成员。abort 照 _req 的约定原样抛（调用方要能区分取消）。
   *  READ-ONLY：身份的写面是 owner UI 的 PUT，没有 gateway 工具够得着。 */
  async getAssistantIdentity(signal?: AbortSignal): Promise<AssistantIdentity | null> {
    try {
      return await this._req<AssistantIdentity>('GET', '/agent/assistant-identity', { signal })
    } catch (e) {
      if (e instanceof Error && (e.name === 'AbortError' || /abort/i.test(e.message))) throw e
      return null
    }
  }

  /** g1 群聊 — POST /agent-runs/run-log：把一个群 spoke turn 镜像成一行 `agent_run_log`
   *  （团队页执行记录可见）。🔴 best-effort 语义在**调用方**（lifecycle 的 mirrorGroupRunLog
   *  catch 掉一切只 warn）：群消息在 ai_chat.db、run log 在 sync_store.db，跨库无事务，
   *  `ai_chat_group_turn` 才是指标权威源。
   *  🔴 `status` 值域 = run_log.py 的 AGENT_RUN_LOG_STATUS_VALUES（running / completed /
   *  failed / skipped，**没有 'stopped'**）；`steps[].kind` ∈ AGENT_RUN_STEP_KINDS，本路径只用
   *  trig / out。越域由服务端 400，不在这里静默改写。 */
  postRunLog(
    input: {
      agentId: string
      startedAtMs: number
      completedAtMs?: number | null
      status: string
      triggerKind?: string | null
      triggerDetail?: string | null
      summary?: string | null
      model?: string | null
      inputTokens?: number | null
      outputTokens?: number | null
      error?: string | null
      steps?: Array<{
        kind: string
        name?: string | null
        detail?: string | null
        payload?: Record<string, unknown> | null
        ok?: boolean | null
        ms?: number | null
      }>
    },
    signal?: AbortSignal
  ): Promise<{ runLogId: number | null }> {
    return this._req<{ runLogId: number | null }>('POST', '/agent-runs/run-log', {
      body: input,
      signal
    })
  }

  /** P4 GET /agent/auto-compact. Read-only from the gateway; only owner UI reaches PUT. */
  getAutoCompactSetting(signal?: AbortSignal): Promise<{ mode: string }> {
    return this._req<{ mode: string }>('GET', '/agent/auto-compact', { signal })
  }

  /** 0812 dogfood GET /agent/matter-web-face → the owner's web tier for Matter follow-up runs
   *  ({mode: 'keep'|'search_only'|'off'}; serve-api reads dirty/missing rows as 'keep'). Consulted
   *  by the lifecycle's resolveMatterRunWebFace (short-TTL cache + bounded timeout; any failure →
   *  'keep', fail-SAFE). Read-only from the gateway: the tier is an owner UI action
   *  (verify_cf_access PUT) — no gateway tool can reach it (policy_rules 同款纪律). */
  getMatterRunWebFace(signal?: AbortSignal): Promise<{ mode: string }> {
    return this._req<{ mode: string }>('GET', '/agent/matter-web-face', { signal })
  }

  /** 08-05 WP-11 — GET /agent/tool-prefs → the per-tool approval tiers of every built-in write
   *  tool (factory default + explicit override + folded effective) + the send recipient
   *  whitelist. Consulted by the lifecycle's resolveToolApprovalPrefs (short-TTL cache; any
   *  failure → null = ask semantics). READ-ONLY from the gateway: tier writes are owner UI
   *  actions (verify_cf_access endpoints) — no gateway tool can reach them (policy_rules 纪律). */
  getToolApprovalPrefs(signal?: AbortSignal): Promise<{
    tools: Array<{
      toolName: string
      group: string
      defaultTier: string
      tier: string | null
      effectiveTier: string
      configurable: boolean
      dangerAuto: boolean
    }>
    sendWhitelist: string[]
    acceptEditsPreset: string[]
  }> {
    return this._req('GET', '/agent/tool-prefs', { signal })
  }

  /** L4 批次1 #6 — POST /approval/preview → the approval-card line built from the REAL payload
   *  (server-derived reply-all recipients, the calendar row's CURRENT title/times …). `preview`
   *  is null when no deriver covers that tool — the normal case, and the caller (chatRun's
   *  resolveApprovalPreview) then falls back to the model's own args. NOT a write: it reads
   *  domain facts for a human to review, and the Python side never mutates. */
  async fetchApprovalPreview(
    toolName: string,
    input: unknown,
    signal?: AbortSignal
  ): Promise<string | null> {
    const data = await this._req<{ toolName: string; preview: string | null }>(
      'POST',
      '/approval/preview',
      { body: { toolName, input }, signal }
    )
    return typeof data?.preview === 'string' && data.preview.length > 0 ? data.preview : null
  }

  // ── policy primitives (S2 W1) — the structured whitelist. evaluate is consulted by the exec
  //    tools' needsApproval (auto_allow → skip card); the CRUD methods back the Settings automation
  //    policy page + the approval-card "always allow" affordance (rule creation is an OWNER action
  //    only — no gateway TOOL creates rules). All hit /agent/policy/* (owner API, verify_cf_access).

  /** POST /agent/policy/evaluate {capability, action, contextMode, agentId?} → the whitelist
   *  verdict. Called from the exec/write tools' needsApproval with the run's SERVER-ASSERTED
   *  contextMode (never a body value). `agentId` (S5 W4, ADR-004) keys the per-agent candidate
   *  set for a headless agent run — absent (every manual run) → the request body is byte-identical
   *  to the pre-ADR-004 shape and Python evaluates the manual (agent_id IS NULL) candidates. */
  policyEvaluate(
    capability: string,
    action: Record<string, unknown>,
    contextMode: string,
    signal?: AbortSignal,
    agentId?: string
  ): Promise<DomainPolicyVerdict> {
    return this._req<DomainPolicyVerdict>('POST', '/agent/policy/evaluate', {
      body: { capability, action, contextMode, ...(agentId != null ? { agentId } : {}) },
      signal
    })
  }

  /** GET /agent/policy/rules?capability=&contextMode= → data.rules (newest first). */
  async listPolicyRules(
    opts: { capability?: string; contextMode?: string } = {},
    signal?: AbortSignal
  ): Promise<DomainPolicyRule[]> {
    const data = await this._req<{ rules: DomainPolicyRule[] }>('GET', '/agent/policy/rules', {
      query: { capability: opts.capability, contextMode: opts.contextMode },
      signal
    })
    return data.rules ?? []
  }

  /** POST /agent/policy/rules {capability, matcher, contextMode?, note?} → the created rule (201).
   *  A malformed matcher → DomainError E_INVALID_ARG (422). This is the ONLY rule-creation path
   *  (approval-card "always allow" + Settings); no gateway tool can reach it. */
  createPolicyRule(
    input: {
      capability: string
      matcher: Record<string, unknown>
      contextMode?: string
      note?: string
      /** S6 W3-3 (ADR-004) — per-agent headless rule (web "always allow this domain" PIN). When
       *  present the endpoint DERIVES contextMode from the agent trigger and REJECTS an explicit
       *  contextMode, so the caller passes agentId XOR contextMode (never both). */
      agentId?: string
    },
    signal?: AbortSignal
  ): Promise<DomainPolicyRule> {
    const body: Record<string, unknown> = { capability: input.capability, matcher: input.matcher }
    if (input.contextMode !== undefined) body.contextMode = input.contextMode
    if (input.note !== undefined) body.note = input.note
    if (input.agentId !== undefined) body.agentId = input.agentId
    return this._req<DomainPolicyRule>('POST', '/agent/policy/rules', { body, signal })
  }

  /** PATCH /agent/policy/rules/{id} {enabled?, note?} → the updated rule. matcher is NOT patchable
   *  (widening = delete + recreate). Missing id → DomainError E_NOT_FOUND (404). */
  setPolicyRule(
    id: number,
    patch: { enabled?: boolean; note?: string },
    signal?: AbortSignal
  ): Promise<DomainPolicyRule> {
    const body: Record<string, unknown> = {}
    if (patch.enabled !== undefined) body.enabled = patch.enabled
    if (patch.note !== undefined) body.note = patch.note
    return this._req<DomainPolicyRule>('PATCH', `/agent/policy/rules/${id}`, { body, signal })
  }

  /** DELETE /agent/policy/rules/{id} → {id, removed} (idempotent). */
  deletePolicyRule(id: number, signal?: AbortSignal): Promise<{ id: number; removed: boolean }> {
    return this._req<{ id: number; removed: boolean }>('DELETE', `/agent/policy/rules/${id}`, {
      signal
    })
  }
}
