import { getChatDb } from './connection'

import type {
  AnchorType,
  ChatSession,
  ChatSessionOriginFilter,
  ChatSessionSummary,
  OpenSessionInput,
  PausedApprovalMarker
} from '@shared/chat_model'

// ── sessions ────────────────────────────────────────────────────────────

/** P2c — resolve an OpenSessionInput to its concrete anchor columns. Email
 *  (the default): email_id is a required non-negative int and anchor_id mirrors
 *  it. General: both NULL — NEVER accept an emailId here (no sentinel). Throws
 *  E_INVALID_ARG-shaped Error for a missing/invalid email anchor so the caller
 *  doesn't silently insert a row that the v7 CHECK would reject. */
function resolveAnchor(input: OpenSessionInput): {
  anchorType: AnchorType
  emailId: number | null
  anchorId: number | null
} {
  const anchorType: AnchorType = input.anchorType ?? 'email'
  if (anchorType === 'general') {
    // codex review HIGH — a general anchor carrying ANY non-null emailId (incl. 0)
    // is rejected, never silently dropped: that's exactly the sentinel we banned.
    if (input.emailId != null) {
      throw new Error(
        `getOrCreateSession: general anchor must not carry an emailId (got ${input.emailId})`
      )
    }
    return { anchorType: 'general', emailId: null, anchorId: null }
  }
  if (anchorType === 'matter') {
    if (input.emailId != null) {
      throw new Error(
        `getOrCreateSession: matter anchor must not carry an emailId (got ${input.emailId})`
      )
    }
    const matterId = input.matterId
    if (typeof matterId !== 'number' || !Number.isInteger(matterId) || matterId <= 0) {
      throw new Error(
        `getOrCreateSession: anchor_type='matter' requires a positive integer matterId, got ${String(matterId)}`
      )
    }
    return { anchorType: 'matter', emailId: null, anchorId: matterId }
  }
  // codex review NIT — reject any anchorType that's neither 'general', 'matter', nor 'email'
  // (parity with router/runtime/dispatcher/db.py) instead of silently treating it
  // as email. input is wire-sourced, so a bad string can reach here at runtime.
  if (anchorType !== 'email') {
    throw new Error(`getOrCreateSession: invalid anchorType ${String(anchorType)}`)
  }
  const emailId = input.emailId
  if (typeof emailId !== 'number' || !Number.isInteger(emailId) || emailId < 0) {
    throw new Error(
      `getOrCreateSession: anchor_type='email' requires a non-negative integer emailId, got ${String(emailId)}`
    )
  }
  return { anchorType: 'email', emailId, anchorId: emailId }
}

export function getOrCreateSession(input: OpenSessionInput): ChatSession {
  const db = getChatDb()
  const now = Date.now()
  const backendAgentPageId = input.backendAgentPageId ?? null
  const backendModel = input.backendModel ?? null
  const { anchorType, emailId, anchorId } = resolveAnchor(input)

  // SQLite treats UNIQUE NULL columns as always-distinct, so we can't lean
  // on `UNIQUE(email_id, backend_kind, backend_agent_page_id)` alone when
  // backend_agent_page_id is null. Branch by null to keep the lookup well-defined.
  const pageClause =
    backendAgentPageId === null ? 'backend_agent_page_id IS NULL' : 'backend_agent_page_id = ?'
  const pageParams = backendAgentPageId === null ? [] : [backendAgentPageId]

  // Reuse lookup. Email: keyed on email_id — byte-identical to pre-v7 (email_id
  // is non-null only for email rows per the CHECK, so this naturally excludes
  // general rows; zero regression for the per-email sidebar). General: keyed on
  // anchor_type + email_id IS NULL, reusing the most-recently-touched general
  // session (no anchor_id to dedupe on → "latest" is the contract; an explicit
  // fresh general session goes through createNewSession). Matter: keyed on its
  // internal integer anchor_id and interactive origin only, so a headless agent
  // run for the same Matter is never revived as the owner's conversation.
  let existing: ChatSession | undefined
  if (anchorType === 'email') {
    existing = db
      .prepare(
        `SELECT * FROM ai_chat_sessions
          WHERE email_id = ? AND backend_kind = ? AND ${pageClause}`
      )
      .get(emailId, input.backendKind, ...pageParams) as ChatSession | undefined
  } else if (anchorType === 'general') {
    existing = db
      .prepare(
        `SELECT * FROM ai_chat_sessions
          WHERE anchor_type = 'general' AND email_id IS NULL
            AND backend_kind = ? AND ${pageClause}
          ORDER BY updated_at DESC LIMIT 1`
      )
      .get(input.backendKind, ...pageParams) as ChatSession | undefined
  } else {
    existing = db
      .prepare(
        `SELECT * FROM ai_chat_sessions
          WHERE anchor_type = 'matter' AND anchor_id = ?
            AND backend_kind = ? AND ${pageClause}
            AND COALESCE(origin, 'interactive') = 'interactive'
          ORDER BY updated_at DESC LIMIT 1`
      )
      .get(anchorId, input.backendKind, ...pageParams) as ChatSession | undefined
  }

  if (existing) {
    // The conversation's effective model can change between turns (user
    // swaps via BackendSelector) — refresh on touch.
    if (backendModel && backendModel !== existing.backend_model) {
      db.prepare('UPDATE ai_chat_sessions SET backend_model = ?, updated_at = ? WHERE id = ?').run(
        backendModel,
        now,
        existing.id
      )
      return { ...existing, backend_model: backendModel, updated_at: now }
    }
    return existing
  }

  const result = db
    .prepare(
      `INSERT INTO ai_chat_sessions
        (email_id, anchor_type, anchor_id, backend_kind, backend_model,
         backend_agent_page_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      emailId,
      anchorType,
      anchorId,
      input.backendKind,
      backendModel,
      backendAgentPageId,
      input.title ?? null,
      now,
      now
    )

  return {
    id: Number(result.lastInsertRowid),
    email_id: emailId,
    anchor_type: anchorType,
    anchor_id: anchorId,
    backend_kind: input.backendKind,
    backend_model: backendModel,
    backend_agent_page_id: backendAgentPageId,
    title: input.title ?? null,
    archived: false,
    created_at: now,
    updated_at: now
  }
}

/**
 * Sprint 19 — unconditionally INSERT a new ai_chat_sessions row, bypassing
 * the (email_id, backend_kind, backend_agent_page_id) reuse lookup. Used by
 * the `chat:newSession` IPC so the user clicking "+ 新建会话" actually gets
 * a fresh session row instead of reviving the latest one for the email
 * (the v3 UNIQUE was dropped in v4 migration so multi-session per email is
 * now legitimate).
 *
 * Call sites:
 *   - handlers/chat.ts chat:newSession IPC — explicit user intent
 *   - Tests — they can pre-create multiple sessions for an email to verify
 *     listSessionsForEmail ordering + deleteSession isolation
 *
 * NOT called by startChat — that path keeps `getOrCreateSession` so the
 * first user message on an email lands in the latest session by default
 * (preserves "open email → continue last conversation" UX).
 */
export function createNewSession(input: OpenSessionInput): ChatSession {
  const db = getChatDb()
  const now = Date.now()
  const backendAgentPageId = input.backendAgentPageId ?? null
  const backendModel = input.backendModel ?? null
  const { anchorType, emailId, anchorId } = resolveAnchor(input)
  // P4b (CHAT_DB v29 value domain) — an interactive session opened AS a team agent: stamp
  // origin='team' + agent_id so the gateway can assemble the identity by sessionId reverse
  // lookup (S2 W0: identity is NEVER read from the chat body). Absent agentId → INSERT
  // byte-identical.
  // 🔴 The two shape checks below (non-empty id + general anchor) mirror serve-api's
  // /sessions/new; its THIRD check — the agent row exists and is chat-capable — is deliberately
  // NOT mirrored here: that needs the report_agent store, which this leaf must not import. The
  // renderer never reaches this function (every session create goes through createChatRuntime →
  // serve-api), so the authoritative check is the one that is actually on the live path.
  const agentId = input.agentId ?? null
  if (agentId !== null) {
    if (typeof agentId !== 'string' || agentId.trim().length === 0) {
      throw new Error('createNewSession: agentId must be a non-empty string')
    }
    if (anchorType !== 'general') {
      throw new Error(
        `createNewSession: agent sessions must use the general anchor, got ${anchorType}`
      )
    }
  }
  // v30（群聊）— origin='group' + members_json 双载体写入（恒 general anchor，与 agentId 互斥）。
  // 形状检查镜像 serve-api /sessions/new 的 group 分支；成员存在性/chat-capable 校验只在
  // serve-api（live path）做（同 agentId 分支的第三检查纪律）。
  const groupMembers = input.groupMembers ?? null
  if (groupMembers !== null) {
    if (agentId !== null) {
      throw new Error('createNewSession: groupMembers and agentId are mutually exclusive')
    }
    if (
      !Array.isArray(groupMembers) ||
      groupMembers.length === 0 ||
      groupMembers.some((m) => typeof m !== 'string' || m.trim().length === 0)
    ) {
      throw new Error('createNewSession: groupMembers must be a non-empty string array')
    }
    if (anchorType !== 'general') {
      throw new Error(
        `createNewSession: group sessions must use the general anchor, got ${anchorType}`
      )
    }
  }
  const membersJson = groupMembers !== null ? JSON.stringify(groupMembers) : null
  const result =
    agentId !== null
      ? db
          .prepare(
            `INSERT INTO ai_chat_sessions
              (email_id, anchor_type, anchor_id, backend_kind, backend_model,
               backend_agent_page_id, title, created_at, updated_at, origin, agent_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'team', ?)`
          )
          .run(
            emailId,
            anchorType,
            anchorId,
            input.backendKind,
            backendModel,
            backendAgentPageId,
            input.title ?? null,
            now,
            now,
            agentId
          )
      : membersJson !== null
        ? db
            .prepare(
              `INSERT INTO ai_chat_sessions
                (email_id, anchor_type, anchor_id, backend_kind, backend_model,
                 backend_agent_page_id, title, created_at, updated_at, origin, members_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'group', ?)`
            )
            .run(
              emailId,
              anchorType,
              anchorId,
              input.backendKind,
              backendModel,
              backendAgentPageId,
              input.title ?? null,
              now,
              now,
              membersJson
            )
        : db
            .prepare(
              `INSERT INTO ai_chat_sessions
                (email_id, anchor_type, anchor_id, backend_kind, backend_model,
                 backend_agent_page_id, title, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              emailId,
              anchorType,
              anchorId,
              input.backendKind,
              backendModel,
              backendAgentPageId,
              input.title ?? null,
              now,
              now
            )
  return {
    id: Number(result.lastInsertRowid),
    email_id: emailId,
    anchor_type: anchorType,
    anchor_id: anchorId,
    backend_kind: input.backendKind,
    backend_model: backendModel,
    backend_agent_page_id: backendAgentPageId,
    title: input.title ?? null,
    archived: false,
    created_at: now,
    updated_at: now,
    ...(agentId !== null ? { origin: 'team', agent_id: agentId } : {}),
    ...(membersJson !== null ? { origin: 'group', members_json: membersJson } : {})
  }
}

/**
 * S4 W3 (task 07-02-s4-custom-agent-core, ADR-003 D3) — create the ai_chat.db session a HEADLESS
 * custom-agent run persists into. Unconditionally INSERTs a general-anchor 'ai-sdk' row stamped with
 * origin='agent' + agent_id + agent_job_id (the async_jobs.job_id as TEXT), so the run appears in the
 * same history UI and onServerResumeSettled can resolve the job from the session. NOT deduped (each
 * run is its own session). Returns the new session id. The gateway (electron main) calls this via the
 * cfg.createAgentSession hook, wired only when MAILAGENT_CUSTOM_AGENTS_ENABLED is on.
 *
 * Matters MVP P4 (D7) — an optional `anchor` makes the row anchor_type='matter' + anchor_id=<matter
 * id> instead of the general anchor, so a follow-up run's session hangs off its Matter. ADDITIVE:
 * omitting it reproduces the pre-P4 INSERT byte-for-byte, and CHAT_DB v27's CHECK already admits
 * matter+agent, so no migration is involved. A non-positive/non-integer id is rejected rather than
 * written as a dangling anchor (mirrors resolveAnchor's matter branch above).
 *
 * L4 批次3 (CHAT_DB v28) — an optional `itemId` additionally stamps the matter_item (行动项) the run
 * executes, so a 行动项 can list every session under it (listSessionsForItem). Independent of the
 * anchor triple (an item run still anchors on its Matter); omitting it keeps the INSERT unchanged.
 */
export function createAgentSession(input: {
  agentId: string
  jobId?: number | null
  title: string
  triggerId?: string | null
  triggerKind?: string | null
  triggerFiredAt?: number | null
  parentSessionId?: number | null
  parentToolCallId?: string | null
  invokedBy?: 'user' | 'main_agent' | null
  anchor?: { type: 'matter'; id: number }
  itemId?: number | null
}): number {
  const db = getChatDb()
  const now = Date.now()
  const matterId = input.anchor?.id
  if (input.anchor !== undefined && (!Number.isInteger(matterId) || (matterId as number) <= 0)) {
    throw new Error(
      `createAgentSession: anchor.type='matter' requires a positive integer id, got ${String(matterId)}`
    )
  }
  const itemId = input.itemId
  if (itemId != null && (!Number.isInteger(itemId) || itemId <= 0)) {
    throw new Error(`createAgentSession: itemId must be a positive integer, got ${String(itemId)}`)
  }
  const anchorType = input.anchor ? 'matter' : 'general'
  const anchorId = input.anchor ? (matterId as number) : null
  const result = db
    .prepare(
      `INSERT INTO ai_chat_sessions
        (email_id, anchor_type, anchor_id, backend_kind, backend_model,
         backend_agent_page_id, title, created_at, updated_at, origin, agent_id, agent_job_id,
         trigger_id, trigger_kind, trigger_fired_at, parent_session_id, parent_tool_call_id, invoked_by,
         item_id)
       VALUES (NULL, ?, ?, 'ai-sdk', NULL, NULL, ?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      anchorType,
      anchorId,
      input.title,
      now,
      now,
      input.agentId,
      input.jobId == null ? null : String(input.jobId),
      input.triggerId ?? null,
      input.triggerKind ?? null,
      input.triggerFiredAt ?? null,
      input.parentSessionId ?? null,
      input.parentToolCallId ?? null,
      input.invokedBy ?? null,
      itemId ?? null
    )
  return Number(result.lastInsertRowid)
}

export function findSessionByParentToolCall(
  parentSessionId: number,
  parentToolCallId: string
): number | null {
  const row = getChatDb()
    .prepare(
      `SELECT id FROM ai_chat_sessions
       WHERE parent_session_id = ? AND parent_tool_call_id = ?
       ORDER BY created_at ASC, id ASC LIMIT 1`
    )
    .get(parentSessionId, parentToolCallId) as { id: number } | undefined
  return row ? Number(row.id) : null
}

export function setAgentSessionJobId(sessionId: number, jobId: number): void {
  getChatDb()
    .prepare('UPDATE ai_chat_sessions SET agent_job_id = ? WHERE id = ?')
    .run(String(jobId), sessionId)
}

/**
 * Stage 2 PR-1 (task 08-01 messenger, MAILAGENT_IM_FEISHU) — create the ai_chat.db session an IM
 * (飞书) conversation persists into. Modeled on createAgentSession above: an unconditional
 * general-anchor 'ai-sdk' INSERT, stamped origin='im' (v22 value-domain registration; agent_id /
 * agent_job_id stay NULL — an IM session is owner-driven, not a headless job). title starts NULL —
 * the first-user-message preview / auto-title flow name it like any interactive session. Because
 * the default history filter only excludes origin='agent', the row is AUTOMATICALLY visible in the
 * desktop session list (Q18=A「来自飞书」— AgentThreadList badges it off `origin`). Called by the
 * gateway via cfg.createImSession on the FIRST turn of a conversation (no sessionId in the body),
 * wired only when MAILAGENT_IM_FEISHU is on.
 */
export function createImSession(): number {
  const db = getChatDb()
  const now = Date.now()
  const result = db
    .prepare(
      `INSERT INTO ai_chat_sessions
        (email_id, anchor_type, anchor_id, backend_kind, backend_model,
         backend_agent_page_id, title, created_at, updated_at, origin)
       VALUES (NULL, 'general', NULL, 'ai-sdk', NULL, NULL, NULL, ?, ?, 'im')`
    )
    .run(now, now)
  return Number(result.lastInsertRowid)
}

export function listSessionsForEmail(emailId: number): ChatSession[] {
  return getChatDb()
    .prepare('SELECT * FROM ai_chat_sessions WHERE email_id = ? ORDER BY updated_at DESC')
    .all(emailId) as ChatSession[]
}

export function listSessionsForMatter(matterId: number): ChatSession[] {
  return getChatDb()
    .prepare(
      "SELECT * FROM ai_chat_sessions WHERE anchor_type = 'matter' AND anchor_id = ? AND COALESCE(origin, 'interactive') <> 'agent' ORDER BY updated_at DESC"
    )
    .all(matterId) as ChatSession[]
}

/** L4 批次3 (CHAT_DB v28) — every session under one 行动项 (matter_item), newest-first. Unlike
 *  listSessionsForMatter this deliberately does NOT filter origin='agent': the whole point of the
 *  item_id column is that a 行动项 shows its EXECUTION history (headless runs), and an interactive
 *  session stamped with an item_id belongs there too. Reads the index idx_chat_sessions_item. */
export function listSessionsForItem(itemId: number): ChatSession[] {
  return getChatDb()
    .prepare('SELECT * FROM ai_chat_sessions WHERE item_id = ? ORDER BY created_at DESC, id DESC')
    .all(itemId) as ChatSession[]
}

/** P2c — list general (context-free) sessions, newest-first. The per-email
 *  sidebar uses listSessionsForEmail (anchor_type='email' via email_id=?); this
 *  is its general-anchor counterpart for the Cmd+O surface (P3). Kept separate
 *  so a general session never leaks into a specific email's sidebar. */
export function listGeneralSessions(): ChatSession[] {
  // P4b — 'team' rows (general anchor + agent identity) are excluded like 'agent' rows: their
  // home is the team page's record column. v30 — 'group' rows likewise (their home is the
  // sessions domain's 群聊 tab). Exclusion set mirrors src/chat/db.py
  // list_general_sessions verbatim (gate: test_chat_type_mirror_parity.py
  // ::test_chat_interactive_origin_exclusion_mirror_parity).
  return getChatDb()
    .prepare(
      "SELECT * FROM ai_chat_sessions WHERE anchor_type = 'general' AND COALESCE(origin, 'interactive') NOT IN ('agent', 'team', 'group') ORDER BY updated_at DESC"
    )
    .all() as ChatSession[]
}

// Cross-email session history for the global "AI 会话历史" page. Sessions with
// no messages at all (a "+ 新建会话" click the user never sent into) are
// excluded — they'd be noise in a history list. The first-user-message
// preview is substr'd to 500 chars so an enormous prompt doesn't bloat the
// IPC payload; the renderer truncates further for display. `limit` caps the
// list so an account with thousands of conversations doesn't ship them all at
// once (newest-first, so the cap drops the least-recently-touched).
export interface ListAllSessionsOptions {
  limit?: number
  includeArchived?: boolean
  origin?: ChatSessionOriginFilter
}

export function listAllSessions(options: ListAllSessionsOptions = {}): ChatSessionSummary[] {
  const limit = options.limit ?? 300
  const includeArchived = options.includeArchived ?? false
  const origin = options.origin ?? 'interactive'
  // Stage 2 PR-1 — origin='im' rows (飞书 conversations, v22 value domain) deliberately RIDE the
  // default 'interactive' clause, so IM sessions appear in the desktop history automatically
  // (Q18=A). P4b — origin='team' rows (v29: interactive sessions opened AS a team agent) are
  // EXCLUDED from the default clause: they belong to the team page (which fetches origin='team').
  // v30 — origin='group' rows (multi-agent group chats) are excluded the same way: they belong to
  // the sessions domain's 群聊 tab (fetched via origin='group').
  // Exclusion set mirrors src/chat/db.py list_all_sessions verbatim (gate:
  // test_chat_type_mirror_parity.py::test_chat_interactive_origin_exclusion_mirror_parity).
  const originClause =
    origin === 'agent'
      ? "s.origin = 'agent'"
      : origin === 'im'
        ? "s.origin = 'im'"
        : origin === 'team'
          ? "s.origin = 'team'"
          : origin === 'group'
            ? // T3 (v32) — 话题不进群清单。话题与子群同是 origin='group' + parent_session_id
              // 非空，**只有 invoked_by 这一个显式判据**能把它们分开：漏了这条，每开一个话题
              // 群列表就多出一行。🔴 与 Python 镜像 src/chat/db.py::list_all_sessions 的 'group'
              // 支逐字对齐（闸 test_chat_type_mirror_parity.py
              // ::test_group_list_thread_exclusion_mirror_parity）。
              "s.origin = 'group' AND COALESCE(s.invoked_by, '') <> 'thread'"
            : origin === 'all'
              ? '1 = 1'
              : "COALESCE(s.origin, 'interactive') NOT IN ('agent', 'team', 'group')"
  // T3 (v32) — 群行的派生列「底下有没有未读话题」。话题回复只 bump 话题行的 updated_at，父群行
  // 一动不动 —— 不派生这一列，群列表 / rail / peek 就永远不会因为话题里的回复而亮。口径与群行
  // 自己的未读一致（`last_read_at IS NOT NULL` = 从没打开过不算未读）。只在群清单这一支算：
  // 其余读路径没有消费点，白搭一个逐行子查询。🔴 与 Python 镜像 list_all_sessions 的同名列对齐。
  const threadUnreadCol =
    origin === 'group'
      ? `,
         EXISTS (SELECT 1 FROM ai_chat_sessions t WHERE t.parent_session_id = s.id
           AND COALESCE(t.invoked_by, '') = 'thread'
           AND t.last_read_at IS NOT NULL AND t.updated_at > t.last_read_at) AS has_unread_threads`
      : ''
  // dogfood-3 — includeArchived (default false → only active sessions, byte-identical to before; the
  // agent view passes true to also pull archived rows for its bottom "归档" group). SELECT now carries
  // s.archived so the renderer can split active vs archived. The archived branch is a fixed boolean (no
  // user input), so inlining it in the WHERE is injection-safe.
  const rows = getChatDb()
    .prepare(
      `SELECT
         s.id, s.email_id, s.anchor_type, s.anchor_id, s.backend_kind, s.backend_model,
         s.backend_agent_page_id, s.title, s.archived, s.created_at, s.updated_at,
         s.origin, s.agent_id, s.agent_job_id, s.trigger_id, s.trigger_kind, s.trigger_fired_at,
         s.last_read_at, s.pinned_at, s.starred, s.members_json,
         (SELECT substr(m.content, 1, 500) FROM ai_chat_messages m
            WHERE m.session_id = s.id AND m.role = 'user'
            ORDER BY m.created_at ASC LIMIT 1) AS first_user_message,
         (SELECT COUNT(*) FROM ai_chat_messages m WHERE m.session_id = s.id) AS message_count${threadUnreadCol}
       FROM ai_chat_sessions s
       WHERE ${includeArchived ? '1 = 1' : 's.archived = 0'}
         AND ${originClause}
         AND ${origin === 'group' ? '1 = 1' : 'EXISTS (SELECT 1 FROM ai_chat_messages m WHERE m.session_id = s.id)'}
       ORDER BY s.updated_at DESC
       LIMIT ?`
    )
    .all(limit) as ChatSessionSummary[]
  // 🔴 SQLite 的 EXISTS 给的是 0/1，读侧判据是 `has_unread_threads === true`（isGroupRowUnread）
  // —— 不折成真 boolean，拿到的就是个 1，群行永远不亮而且没人会报错。
  if (!threadUnreadCol) return rows
  return rows.map((row) => ({
    ...row,
    has_unread_threads: (row.has_unread_threads as unknown as number) === 1
  }))
}

export function getSession(sessionId: number): ChatSession | null {
  const row = getChatDb().prepare('SELECT * FROM ai_chat_sessions WHERE id = ?').get(sessionId) as
    | ChatSession
    | undefined
  return row ?? null
}

export function deleteSession(sessionId: number): void {
  // Message rows go via the CASCADE foreign key — pragma foreign_keys is
  // set ON in getChatDb().
  getChatDb().prepare('DELETE FROM ai_chat_sessions WHERE id = ?').run(sessionId)
}

/** Phase 10 — set a session's title (manual rename, or the gateway's haiku auto-title). Deliberately
 *  does NOT bump updated_at so a rename never reorders the history list. Safe on a missing id (UPDATE
 *  matches 0 rows). The gateway (electron main) calls this directly; the renderer rename goes through
 *  serve-api → src/chat/db.py.update_session_title (same ai_chat.db file). */
export function updateSessionTitle(sessionId: number, title: string): void {
  getChatDb().prepare('UPDATE ai_chat_sessions SET title = ? WHERE id = ?').run(title, sessionId)
}

/** dogfood-2 — 归档 / 取消归档一个 session（软删：archived=1 从 listAllSessions 过滤，行保留）。
 *  不 bump updated_at（与 updateSessionTitle 同纪律，归档不该重排历史）。Safe on missing id。 */
export function updateSessionArchived(sessionId: number, archived: boolean): void {
  getChatDb()
    .prepare('UPDATE ai_chat_sessions SET archived = ? WHERE id = ?')
    .run(archived ? 1 : 0, sessionId)
}

/** custom-agent epic W3 — pin/unpin without touching updated_at. Re-pinning refreshes pin order. */
export function updateSessionPinned(sessionId: number, pinned: boolean): void {
  getChatDb()
    .prepare('UPDATE ai_chat_sessions SET pinned_at = ? WHERE id = ?')
    .run(pinned ? Date.now() : null, sessionId)
}

/** L4 批次3 R7 (CHAT_DB v28) — write (or clear with `null`) the session's「曾在审批处暂停」marker.
 *  Keep-latest: a re-pause overwrites, a settled/newly-started run clears. Like updateSessionTitle /
 *  updateSessionArchived it deliberately does NOT bump updated_at — the marker is derived run state,
 *  and bumping would reorder history and fake unread. Safe on a missing id (UPDATE matches 0 rows). */
export function updateSessionPausedMarker(
  sessionId: number,
  marker: PausedApprovalMarker | null
): void {
  getChatDb()
    .prepare('UPDATE ai_chat_sessions SET paused_marker_json = ? WHERE id = ?')
    .run(marker === null ? null : JSON.stringify(marker), sessionId)
}

/** custom-agent epic W3 — star is a durable icon state only; it never reorders or regroups. */
export function updateSessionStarred(sessionId: number, starred: boolean): void {
  getChatDb()
    .prepare('UPDATE ai_chat_sessions SET starred = ? WHERE id = ?')
    .run(starred ? 1 : 0, sessionId)
}

/** Phase 10b — the first user message's text for a session (the auto-title generation input). Null
 *  when the session has no user message yet. Mirrors the listAllSessions first_user_message subquery
 *  (oldest user row by created_at, id tiebreak). */
export function getFirstUserText(sessionId: number): string | null {
  const row = getChatDb()
    .prepare(
      `SELECT content FROM ai_chat_messages
         WHERE session_id = ? AND role = 'user'
         ORDER BY created_at ASC, id ASC LIMIT 1`
    )
    .get(sessionId) as { content: string } | undefined
  return row?.content ?? null
}
