// harness-chat lane A B3 (task 07-15) — the SHARED in-panel approval card.
//
// Generalized from AgentRecordView's InRecordApprovalPanel (S6 W2) so the SAME actionable decide
// card serves all three surfaces: the agent-run record view (which wraps it, keeping its runState-
// derived expired notice), the email chat panel (AiChatPanel pendingSlot — replaces the old
// informational "act on the island" notice) and the general agent conversation (AgentConversation
// pendingSlot, new probe). 07-15 owner拍板: the in-panel card is the PRIMARY approval surface —
// island-independent (works with MAILAGENT_ISLAND_AGENT_ENABLED explicitly false) and the copy never
// points the user at the island.
//
// 纪律（unchanged from S6 W2）：
//  • pending 真值 = live 查 gateway ApprovalRunStash（fetchPendingApproval），命中渲染可决策卡，
//    miss → 能证明"曾暂停"才渲染诚实失效态，否则不渲染。两个证据源：record view 的 run 读态
//    （showExpiredState）与 L4 批次3 R7 给 manual 会话补的持久 marker（pausedMarkerJson，
//    ai_chat.db v28 `paused_marker_json`）——「manual miss 恒静默」的已知残留到此为止。
//  • 🔴 marker 只是**证据**不是**能力**：stash（body/responseMessage/resumeToken）仍是进程内存，
//    重启后这条审批恒不可批。所以 marker 命中渲染的是静态失效提示，绝不是可决策卡。
//  • 决策走既有 POST /api/ai/approval/decide（{approvalId} 形状，resumeToken 不出 gateway）；
//    not_found = 已被其它面处理（并发），静默失活。
//  • web PIN affordance 是数据驱动的（agentId 非空 + web_fetch）——只有 headless agent run 会命中，
//    manual 会话恒不显示（dead-config boundary，S6 W3-3）。
//
// L4 批次2「审批四维」—— 本面是四维里 edit / response / remember 三维的落点（chat 内 3 张富编辑卡
// 现状不动，其余卡本轮不加编辑器）：
//  • edit —— `editableFields` 非空时出「编辑参数」，提交顺序**先 /resolve 再 /decide**（/decide 会
//    claim stash，反过来编辑就落空了）。编辑只覆盖 gateway 注册的 editableFields，身份字段服务端 PIN，
//    模型 history input 一个字节不动（security/approval.ts:35-45）。
//  • response —— 拒绝键走 ApprovalActions 的 `rejectReason` 两步式，理由随 /decide 上行，模型在
//    resume 后读到 `execution-denied {reason}`。
//  • remember —— 勾选写 owner `tool_approval_pref` tier='auto'（PUT /api/agent/tool-prefs/{name}，
//    serve-api，远程可达）。🔴 只在 contextMode='manual_chat' 时出现：审批梯子 ④/⑦ 只在 manual_chat
//    读这张表（tools/types.ts:411 + tool_prefs.py 头注），headless / im_chat 下写它是死配置。
//    exec / web 两组有各自更细的 policy_rules「总是允许」，不叠加第二个勾选。
//    🔴 remember 恒是用户动作（没有任何模型工具能写这张表），且 best-effort：写失败不挡决策。

import { useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { qk } from '@shared/lib/queryKeys'
import { ageLabel } from '@shared/lib/ageLabel'
import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'
import { Checkbox } from '@shared/components/ui/checkbox'
import { ApprovalActions } from '@shared/assistant/tools/_cardShell'
import {
  fetchPendingApproval,
  postApprovalDecide,
  postApprovalResolveEdit,
  postRememberWebPolicy,
  type PendingApprovalInfo
} from '@shared/assistant/approvalRecordClient'
import { ReportIcon } from '@shared/components/agents/primitives'
import type { ToolApprovalPrefsPayload } from '@shared/api/types'

/** The card's body copy: agent runs name the agent; manual sessions use the assistant phrasing. */
function approvalBody(t: TFunction, agentName: string | null, toolName: string): string {
  return agentName != null
    ? t('agents.custom.runs.approvalBody', { agent: agentName, tool: toolName })
    : t('chat.aiSdk.approvalBodyManual', { tool: toolName })
}

/** One editable parameter row: a registered editable field that is PRESENT in the effective input
 *  with a shape the generic editor can round-trip. */
interface EditableRow {
  name: string
  /** `text` = the input holds a string; `list` = an array of strings (edited one per line). */
  kind: 'text' | 'list'
  /** The current value as text (a list joins with newlines). */
  initial: string
}

/** Project the editor rows out of the effective input.
 *
 *  🔴 Only fields the model actually PROPOSED are editable. An absent field is skipped rather than
 *  rendered as an empty box: without a value there is no way to know whether the tool wants a string
 *  or a string[], and guessing wrong produces a schema error at execute time — after the owner
 *  approved. (The three rich chat cards can offer add-a-recipient because they know their own tool's
 *  schema; this generic editor does not.)
 *
 *  A field whose value is neither a string nor a string[] (e.g. skill_draft_publish's boolean
 *  `enabled`) is skipped for the same reason — no widget here can round-trip it faithfully. Nothing
 *  is hidden by that: the full proposal is still summarized in the card's inputPreview line, and
 *  every field the editor does NOT show simply keeps the model's value. */
function editableRows(input: unknown, names: readonly string[]): EditableRow[] {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return []
  const obj = input as Record<string, unknown>
  const rows: EditableRow[] = []
  for (const name of names) {
    const value = obj[name]
    if (typeof value === 'string') rows.push({ name, kind: 'text', initial: value })
    else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      rows.push({ name, kind: 'list', initial: (value as string[]).join('\n') })
    }
  }
  return rows
}

/** Parse an edited row back to the wire value (a list splits on newlines AND commas, trims, and
 *  drops empties — both separators are natural for a recipient list). */
function parseRow(row: EditableRow, text: string): unknown {
  if (row.kind === 'text') return text
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** The overlay to POST to /resolve: only rows the owner actually CHANGED (an untouched card sends
 *  nothing at all, keeping the approve byte-identical to the pre-L4 one). */
function editedOverlay(
  rows: EditableRow[],
  values: Record<string, string>
): Record<string, unknown> {
  const overlay: Record<string, unknown> = {}
  for (const row of rows) {
    const text = values[row.name]
    if (text === undefined || text === row.initial) continue
    overlay[row.name] = parseRow(row, text)
  }
  return overlay
}

/** Whether the「记住：以后不再询问」affordance is a LIVE config for this approval.
 *
 *  🔴 Four conditions, each of which would otherwise make the checkbox a lie:
 *   1. `contextMode === 'manual_chat'` — the only mode whose ladder reads `tool_approval_pref`;
 *   2. the tool is in the built-in registry and `configurable` (send / run_command / 供应链 /
 *      custom-agent CRUD are structurally fixed at ask, `tool_prefs.py:180`);
 *   3. its effective tier is still `ask` (already `auto` ⇒ nothing to remember);
 *   4. it is not an exec/web tool — those have the finer structured policy_rules「总是允许」, and
 *      stacking a second, coarser checkbox on the same card would be two answers to one question. */
function canRememberTool(
  pending: PendingApprovalInfo,
  prefs: ToolApprovalPrefsPayload | null
): boolean {
  if (pending.contextMode !== 'manual_chat') return false
  const row = prefs?.tools.find((r) => r.toolName === pending.toolName)
  if (!row || !row.configurable || row.effectiveTier !== 'ask') return false
  return row.group !== 'exec' && row.group !== 'web'
}

export function PendingApprovalPanel({
  sessionId,
  agentName = null,
  showExpiredState = false,
  pausedMarkerJson = null,
  refreshKey = 0,
  onDecided,
  onDecideBusyChange
}: {
  sessionId: number | null
  /** Custom-agent display name for the body copy; null → manual-chat copy. */
  agentName?: string | null
  /** Render the honest "已失效" notice on a probe miss — the record view derives it from the run's
   *  paused_* read state. Manual surfaces have no run read state and pass the marker below instead. */
  showExpiredState?: boolean
  /** L4 批次3 R7 — the session row's `paused_marker_json` (ai_chat.db v28). Non-empty = this session
   *  WAS paused at an approval and nothing has settled it since, so a probe miss means "expired /
   *  app restarted", not "nothing to show". Null/absent keeps the pre-R7 silence. */
  pausedMarkerJson?: string | null
  /** Folded into the query key so a settle-driven remount/nonce re-probes deterministically. */
  refreshKey?: number
  onDecided: () => void
  /** P1-2 (codex r1) — decide-in-flight signal: /decide runs the server-side resume synchronously
   *  and holds the session lease for its whole duration, so the parent disables its composer while
   *  true (a send would 409 E_RUN_ACTIVE anyway — this makes the fence visible instead of an
   *  error). codex r2 [E] — carries the DECIDING session's id (captured at decide start) so the
   *  parent scopes the disable to that session only (useApprovalDecideBusy): switching sessions
   *  must not lock an unrelated composer. Optional: the record view has no composer. */
  onDecideBusyChange?: (busy: boolean, sessionId: number | null) => void
}): React.ReactElement | null {
  const { t } = useTranslation()
  const qc = useQueryClient()
  // Prefix-shared with qk.agentApprovalPending(sessionId) so existing invalidations
  // (AgentRecordView's settle handler) still hit; refreshKey extends the key without breaking them.
  const pendingKey = [...qk.agentApprovalPending(sessionId), refreshKey] as const
  const q = useQuery({
    queryKey: pendingKey,
    queryFn: () => (sessionId == null ? Promise.resolve(null) : fetchPendingApproval(sessionId)),
    enabled: sessionId != null,
    // pending 是进程内存真值（重启即丢）→ 短 staleTime，不长轮询（打开/决策后手动 invalidate）。
    staleTime: 3_000,
    refetchOnWindowFocus: true
  })
  const pending = q.data ?? null
  // S6 W3-3 — the "总是允许该域名" web PIN affordance. ONLY for an agent-run web_fetch approval
  // (agentId present): a manual web_fetch never stashes / never runs policyEvaluate, so a per-agent
  // web rule built from a manual card would be a dead, misleading config. Gate the affordance on both.
  const isAgentWebFetch =
    pending != null && pending.agentId != null && pending.toolName === 'web_fetch'
  const [rememberDomain, setRememberDomain] = useState(false)

  // L4 批次2 — the built-in tool approval tiers, ONLY fetched for a manual_chat pause (the only
  // mode whose ladder reads them). Shares qk.toolApprovalPrefs with the settings face, so the two
  // never disagree and a write here refreshes both.
  const api = useMailApi()
  const prefsQuery = useQuery<ToolApprovalPrefsPayload>({
    queryKey: qk.toolApprovalPrefs(),
    queryFn: () => api.chat.getToolPrefs(),
    enabled: pending != null && pending.contextMode === 'manual_chat',
    staleTime: 10_000,
    retry: false
  })
  const rememberToolAvailable = pending != null && canRememberTool(pending, prefsQuery.data ?? null)
  const [rememberTool, setRememberTool] = useState(false)

  // L4 批次2 — the edit-参数 affordance. Rows come from the gateway (registered editableFields ∩
  // what the model actually proposed); an empty list means this approval is approve/reject only.
  const rows = pending ? editableRows(pending.input, pending.editableFields) : []
  const [editOpen, setEditOpen] = useState(false)
  const [editValues, setEditValues] = useState<Record<string, string>>({})

  // 🔴 Reset the per-approval scratch state when the card switches to a DIFFERENT approval. This
  // component does NOT remount between approvals: a re-pause (the model asks for a second write in
  // the same turn) just swaps the probe's payload, so without this the previous approval's edited
  // text would be diffed against the NEW proposal and posted as an edit of it — the owner's words
  // applied to an action they never wrote them for. Render-time adjustment (React's "adjust state
  // when a prop changes"), not an effect: it must land before this render's overlay is computed.
  const [scratchFor, setScratchFor] = useState<string | null>(null)
  if (pending != null && scratchFor !== pending.approvalId) {
    setScratchFor(pending.approvalId)
    setEditOpen(false)
    setEditValues({})
    setRememberTool(false)
    setRememberDomain(false)
  }

  const decide = async (decision: 'approve' | 'reject', reason?: string): Promise<void> => {
    if (!pending) return
    // codex r2 [E] — capture the deciding session NOW: the prop can move to another session while
    // the resume is in flight (panel-level component, session switch re-renders it), and the finally
    // must clear the busy entry of the session that STARTED the decide, not the one now displayed.
    const decideSessionId = sessionId
    onDecideBusyChange?.(true, decideSessionId)
    try {
      if (decision === 'approve') {
        // 🔴 EDIT FIRST, and it is the one step allowed to abort the approve: /decide claims the
        // stash, so an overlay posted after it would be dropped, and approving with an unsaved edit
        // would run the MODEL's proposal while the owner believes theirs ran. A typed failure
        // (not-found / expired / not-editable) propagates to ApprovalActions' inline error and the
        // card stays live.
        const overlay = editedOverlay(rows, editValues)
        if (Object.keys(overlay).length > 0) {
          await postApprovalResolveEdit(pending.approvalId, overlay)
        }
        // Best-effort PIN BEFORE /decide (peek is read-only; /decide claims + consumes the stash — so the
        // rule must derive from the still-live entry first). A rule-creation failure must not block the
        // approve the owner already made.
        if (rememberDomain && isAgentWebFetch) {
          await postRememberWebPolicy(pending.approvalId)
        }
        // Same best-effort discipline for the per-tool tier (a user action, never a model one):
        // a failed write must not swallow the approval the owner already made.
        if (rememberTool && rememberToolAvailable) {
          try {
            await api.chat.setToolPref(pending.toolName, 'auto')
            await qc.invalidateQueries({ queryKey: qk.toolApprovalPrefs() })
          } catch (err) {
            console.warn('[approval] remember tool tier failed (approval proceeds)', err)
          }
        }
      }
      const res = await postApprovalDecide({
        approvalId: pending.approvalId,
        decision,
        ...(reason !== undefined ? { reason } : {})
      })
      // P2-1 (codex r1) — judge the result FIRST: a non-not_found failure (gateway unreachable /
      // 500 / resume tool error / P1-2's 409 lease miss) throws to ApprovalActions' inline error
      // state and the card STAYS live — the approval did NOT happen, and destroying the card (the
      // old invalidate+onDecided-before-check order) would hide exactly that. not_found = already
      // handled on another surface (concurrency) → benign deactivation.
      if (!res.ok && res.status !== 'not_found') {
        throw new Error(res.error ?? t('agents.custom.runs.decideFailed'))
      }
      // ok / not_found：card 失活（re-query → miss），并让父层 reload 消息 + 刷新计数/历史。
      await qc.invalidateQueries({ queryKey: qk.agentApprovalPending(sessionId) })
      onDecided()
    } finally {
      onDecideBusyChange?.(false, decideSessionId)
    }
  }

  if (pending) {
    const ago = ageLabel(t, pending.ageMs)
    return (
      <div
        data-in-record-approval-card
        className="mx-auto w-full max-w-[var(--thread-max-width)] rounded-xl border border-ai/30 bg-ink-2 px-3.5 py-3"
      >
        <div className="flex items-center gap-2">
          <ReportIcon name="bell" size={13} />
          <span className="text-aux font-medium text-ink-fg">
            {t('agents.custom.runs.approvalTitle')}
          </span>
          <span className="text-meta text-ink-fg-3 ml-auto">{ago}</span>
        </div>
        <div className="mt-1.5 text-meta text-ink-fg-2 leading-snug">
          {approvalBody(t, agentName, pending.toolName)}
        </div>
        <div className="mt-1.5 rounded-md border border-ink-border-soft bg-ink-1/60 px-2.5 py-1.5 font-mono text-micro text-ink-fg-2 break-words">
          {pending.inputPreview}
        </div>
        {rows.length > 0 && (
          <div className="mt-2">
            <button
              type="button"
              aria-expanded={editOpen}
              onClick={() => setEditOpen(!editOpen)}
              className="rounded-md text-meta text-ink-fg-3 transition-colors duration-fast hover:text-ink-fg-2"
            >
              {editOpen
                ? t('agents.custom.runs.editParamsClose')
                : t('agents.custom.runs.editParams')}
            </button>
            {editOpen && (
              <div className="mt-1.5 space-y-2 rounded-md border border-ink-border-soft bg-ink-1/60 px-2.5 py-2">
                <div className="text-meta text-ink-fg-3">
                  {t('agents.custom.runs.editParamsHint')}
                </div>
                {rows.map((row) => (
                  <label key={row.name} className="block">
                    <span className="mb-0.5 block font-mono text-micro text-ink-fg-3">
                      {row.name}
                    </span>
                    <textarea
                      rows={row.kind === 'list' ? 2 : 3}
                      value={editValues[row.name] ?? row.initial}
                      onChange={(e) => setEditValues({ ...editValues, [row.name]: e.target.value })}
                      className={cn(
                        'w-full resize-y rounded-md border border-ink-border-soft bg-ink-2 px-2 py-1.5',
                        'text-aux text-ink-fg focus:border-ink-border focus:outline-none'
                      )}
                    />
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        {rememberToolAvailable && (
          <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-md border border-ink-border-soft bg-ink-1/60 px-2.5 py-2">
            <Checkbox checked={rememberTool} onCheckedChange={setRememberTool} className="mt-0.5" />
            <span className="text-aux text-ink-fg-2">
              {t('agents.custom.runs.rememberTool')}
              <span className="mt-0.5 block text-ink-fg-3">
                {t('agents.custom.runs.rememberToolHint', { tool: pending.toolName })}
              </span>
            </span>
          </label>
        )}
        {isAgentWebFetch && (
          <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-md border border-ink-border-soft bg-ink-1/60 px-2.5 py-2">
            <Checkbox
              checked={rememberDomain}
              onCheckedChange={setRememberDomain}
              className="mt-0.5"
            />
            <span className="text-aux text-ink-fg-2">
              {t('agents.custom.runs.rememberDomain')}
              <span className="mt-0.5 block text-ink-fg-3">
                {t('agents.custom.runs.rememberDomainHint')}
              </span>
            </span>
          </label>
        )}
        <ApprovalActions
          // Same reason as the scratch reset above: the action row owns the reject-reason draft, and
          // a re-pause must not carry it into the next approval. Keying it on the approval id makes
          // that a remount instead of a second reset path to keep in sync.
          key={pending.approvalId}
          approveLabel={t('agents.custom.runs.approveLabel')}
          onApprove={() => decide('approve')}
          // P2-1 — returned (not void'd) so ApprovalActions' shared machine awaits it: a reject
          // failure enters the same busy/error state instead of an unhandled rejection.
          // L4 批次2 — rejectReason on: this host FORWARDS the reason to /decide, which turns it
          // into the model-visible `execution-denied {reason}` on the resumed turn.
          onReject={(reason) => decide('reject', reason)}
          rejectReason
        />
      </div>
    )
  }

  // miss：能证明"曾在审批处暂停"（record view 的 paused_* 读态 / manual 会话的持久 marker）→
  // 诚实失效态（非卡片，静态提示）；两个证据都没有 → 不渲染。
  if (showExpiredState || (pausedMarkerJson ?? '').length > 0) {
    return (
      <div
        data-in-record-approval-expired
        className="mx-auto w-full max-w-[var(--thread-max-width)] rounded-lg border border-ink-border bg-ink-3/70 px-3 py-2 text-meta text-ink-fg-2"
      >
        {t('agents.custom.runs.approvalExpired')}
      </div>
    )
  }
  return null
}
