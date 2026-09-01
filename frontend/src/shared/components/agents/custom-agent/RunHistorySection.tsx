// CustomAgentDrawer 拆分（Lane C2 纯机械搬迁）：run 历史区 + 状态徽标（9 状态穷举）。
// 原样自 CustomAgentDrawer.tsx 抽出，逻辑逐字节不变。RunStateBadge 由主文件 re-export
// 供 AgentRecordView 复用。
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'

import { requestOpenAgentSession } from '@shared/state/ai-chat-panel'
import { AnimatedBadge, type AnimatedBadgeStatus } from '@shared/components/ui/animated-badge'
import { PendingDot } from '../AgentPendingBadge'
import type { AgentRunHistoryItem, AgentRunState } from '@shared/api/types'
import { ReportIcon } from '../primitives'
import { useAgentRuns, useReportConfig, useRunNow } from '../hooks'
import { errText } from './shared'
import { AgentAvatar } from '../AgentAvatar'

// epoch（秒或毫秒都容错）→ 本地时间串。
function fmtTime(ts: number | null | undefined): string {
  if (ts == null) return ''
  const ms = ts < 1e12 ? ts * 1000 : ts
  return new Date(ms).toLocaleString()
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`
}

function totalTokens(tokens: Record<string, unknown> | null | undefined): number | null {
  if (!tokens) return null
  if (typeof tokens.totalTokens === 'number') return tokens.totalTokens
  const input = tokens.inputTokens
  const output = tokens.outputTokens
  const inputTotal =
    typeof input === 'number'
      ? input
      : input &&
          typeof input === 'object' &&
          typeof (input as { total?: unknown }).total === 'number'
        ? ((input as { total: number }).total ?? 0)
        : 0
  const outputTotal =
    typeof output === 'number'
      ? output
      : output &&
          typeof output === 'object' &&
          typeof (output as { total?: unknown }).total === 'number'
        ? ((output as { total: number }).total ?? 0)
        : 0
  return inputTotal + outputTotal > 0 ? inputTotal + outputTotal : null
}

// 免卡 badge 分源投影（S6 W3-2，ADR-004 rev3.1 §4.4 / F#3）：rule-source（白名单规则命中）与
// grant-source（rule_id=null 的 grant 级免卡，按工具分「全开放联网 / 搜索授权 / 授权放行」）
// 分开标注 —— owner 误判授权范围的防线。🔴 不假设 rule_id 非空（grant 桶是一等来源）。
// breakdown 缺席（旧 serve-api 无此字段）→ 回退泛化「自动放行 ×n」；null（账本不可达）→ 不渲染。
function autoWhitelistBadges(
  r: AgentRunHistoryItem,
  t: (key: string, opts?: Record<string, unknown>) => string
): string[] {
  const bd = r.autoWhitelistedBreakdown
  if (bd == null) {
    return typeof r.autoWhitelistedWrites === 'number' && r.autoWhitelistedWrites > 0
      ? [t('agents.custom.runs.autoWhitelisted', { n: r.autoWhitelistedWrites })]
      : []
  }
  const out: string[] = []
  if (bd.rule > 0) out.push(t('agents.custom.runs.autoWhitelistedRule', { n: bd.rule }))
  let otherGrant = 0
  for (const [tool, n] of Object.entries(bd.grant)) {
    if (n <= 0) continue
    if (tool === 'web_fetch') out.push(t('agents.custom.runs.autoWhitelistedWebOpen', { n }))
    else if (tool === 'web_search')
      out.push(t('agents.custom.runs.autoWhitelistedWebSearch', { n }))
    else otherGrant += n
  }
  if (otherGrant > 0) out.push(t('agents.custom.runs.autoWhitelistedGrant', { n: otherGrant }))
  return out
}

interface RunVisual {
  labelKey: string
  status: AnimatedBadgeStatus
  pulse?: boolean
}

// 9 状态穷举视觉映射。**无 default**：switch 覆盖全部 AgentRunState 后由 assertNever
// 兜底——新增状态时 `state` 不再收窄为 never → tsc 编译红（防漏兜 + 防 paused_* 误渲成功）。
function runStateVisual(state: AgentRunState): RunVisual {
  switch (state) {
    case 'queued':
      return {
        labelKey: 'agents.custom.runs.state.queued',
        status: 'neutral'
      }
    case 'running':
      return {
        labelKey: 'agents.custom.runs.state.running',
        status: 'loading',
        pulse: true
      }
    case 'completed':
      return {
        labelKey: 'agents.custom.runs.state.completed',
        status: 'success'
      }
    case 'skipped':
      return {
        labelKey: 'agents.custom.runs.state.skipped',
        status: 'neutral'
      }
    case 'paused_pending':
      return {
        labelKey: 'agents.custom.runs.state.pausedPending',
        status: 'warning'
      }
    case 'paused_expired':
      return {
        labelKey: 'agents.custom.runs.state.pausedExpired',
        status: 'neutral'
      }
    case 'paused_approved':
      return {
        labelKey: 'agents.custom.runs.state.pausedApproved',
        status: 'success'
      }
    case 'paused_rejected':
      return {
        labelKey: 'agents.custom.runs.state.pausedRejected',
        status: 'danger'
      }
    case 'failed':
      return {
        labelKey: 'agents.custom.runs.state.failed',
        status: 'danger'
      }
  }
  // 穷举兜底：AgentRunState 若新增成员，此处 state 非 never → tsc 报错，逼同步补 case。
  return assertNever(state)
}

function assertNever(x: never): never {
  throw new Error(`unhandled AgentRunState: ${String(x)}`)
}

export function RunStateBadge({ state }: { state: AgentRunState }): React.ReactElement {
  const { t } = useTranslation()
  const v = runStateVisual(state)
  return (
    <AnimatedBadge status={v.status} pulse={v.pulse} contentKey={state}>
      {t(v.labelKey)}
    </AnimatedBadge>
  )
}

// run 历史区（编辑既有 custom agent 时展示；新建时 agent 尚未存在 → 不渲染）。
export function RunHistorySection({ agentId }: { agentId: string }): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { runs, isLoading, hasMore, isLoadingMore, loadMore } = useAgentRuns(agentId)
  const { agents } = useReportConfig()
  const agent = agents.find((item) => item.id === agentId)
  const { run, isRunning } = useRunNow()
  // run-now 传输/服务失败（flag off / gateway 不可达）→ 展示后端 detail，不静默吞。
  // 每日额度耗尽已改为成功返回 + 可见 skipped 历史行，不再走这里。
  const [runErr, setRunErr] = useState<string | null>(null)

  const onRunNow = (): void => {
    if (isRunning) return
    setRunErr(null)
    run(agentId, { type: 'custom' }).catch((e: unknown) => setRunErr(errText(e)))
  }

  // S6 W2 — 打开该次 run 的执行记录 = 打开该 origin='agent' session（复用 AssistantChatModal
  // fullscreen 手法：park sessionId → 导航到 /sessions → AgentViewLayout 消费并 select）。从设置里
  // 触发 → 导航离开设置进入 agent 视图（记录视图 read-mostly，见 AgentConversation）。
  const openRecord = (sessionId: number): void => {
    requestOpenAgentSession(sessionId)
    void navigate({ to: '/sessions' })
  }

  return (
    <div>
      <div className="flex items-center" style={{ gap: 8, marginBottom: 9 }}>
        <label style={{ fontSize: 13, fontWeight: 500, color: 'rgb(var(--ink-fg))', flex: 1 }}>
          {t('agents.custom.runs.section')}
        </label>
        <button
          type="button"
          onClick={onRunNow}
          disabled={isRunning}
          className="flex items-center"
          style={{
            gap: 5,
            fontFamily: 'inherit',
            fontSize: 12.5,
            padding: '5px 11px',
            borderRadius: 7,
            cursor: isRunning ? 'wait' : 'pointer',
            color: 'rgb(var(--c-accent))',
            background: 'rgb(var(--c-accent) / 0.12)',
            border: '1px solid rgb(var(--c-accent) / 0.28)'
          }}
        >
          <ReportIcon name="zap" size={13} />
          {t('agents.custom.runs.runNow')}
        </button>
      </div>
      {runErr && (
        <div
          style={{
            fontSize: 11.5,
            color: 'rgb(var(--c-fail))',
            padding: '9px 12px',
            marginBottom: 8,
            borderRadius: 9,
            background: 'rgb(var(--c-fail) / 0.10)',
            border: '1px solid rgb(var(--c-fail) / 0.25)',
            wordBreak: 'break-word'
          }}
        >
          {runErr}
        </div>
      )}
      {runs.length === 0 ? (
        <div
          style={{
            fontSize: 12.5,
            color: 'rgb(var(--ink-fg-3))',
            padding: '11px 13px',
            borderRadius: 9,
            background: 'rgb(var(--ink-1) / 0.5)',
            border: '1px solid rgb(var(--ink-border-soft))'
          }}
        >
          {isLoading ? t('agents.custom.runs.loading') : t('agents.custom.runs.empty')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {runs.map((r) => (
            <div
              key={r.jobId}
              style={{
                padding: '10px 12px',
                borderRadius: 9,
                background: 'rgb(var(--ink-1) / 0.5)',
                border: '1px solid rgb(var(--ink-border-soft))'
              }}
            >
              <div className="flex items-center" style={{ gap: 8 }}>
                <AgentAvatar agentId={agentId} config={agent?.avatar} size={24} />
                <RunStateBadge state={r.state} />
                {/* 红点链 ①（P5）：paused_pending run 待审批脉冲红点，紧邻状态徽标。 */}
                {r.state === 'paused_pending' && (
                  <PendingDot title={t('agents.custom.runs.pendingDot')} />
                )}
                {/* 免卡写 badge（ADR-004 D6；S6 W3-2 rev3.1 §4.4 分源）：虚线边框与人审状态
                    徽标（实线）视觉区分；null（无会话/账本不可达）不渲染 —— 不渲染 ≠「0 次
                    免卡」。分源标签见 autoWhitelistBadges（rule vs grant 两源）。 */}
                {autoWhitelistBadges(r, t).map((label) => (
                  <span
                    key={label}
                    style={{
                      fontSize: 11,
                      fontWeight: 500,
                      padding: '2px 8px',
                      borderRadius: 5,
                      whiteSpace: 'nowrap',
                      color: 'rgb(var(--c-ai))',
                      background: 'rgb(var(--c-ai) / 0.08)',
                      border: '1px dashed rgb(var(--c-ai) / 0.45)'
                    }}
                  >
                    {label}
                  </span>
                ))}
                <span style={{ fontSize: 12, color: 'rgb(var(--ink-fg-2))', flex: 1 }}>
                  {fmtTime(r.finishedAt ?? r.createdAt)}
                </span>
                {/* S6 W2 — 「查看执行记录」入口（有 sessionId 即显）→ 打开该次 run 的对话。 */}
                {r.sessionId != null && (
                  <button
                    type="button"
                    onClick={() => openRecord(r.sessionId as number)}
                    className="flex items-center"
                    style={{
                      gap: 4,
                      fontFamily: 'inherit',
                      fontSize: 11.5,
                      padding: '3px 8px',
                      borderRadius: 6,
                      cursor: 'pointer',
                      color: 'rgb(var(--ink-fg-2))',
                      background: 'rgb(var(--ink-fg) / 0.05)',
                      border: '1px solid rgb(var(--ink-border-soft))'
                    }}
                  >
                    <ReportIcon name="message" size={12} />
                    {t('agents.custom.runs.viewRecord')}
                  </button>
                )}
              </div>
              {(r.steps != null || r.durationSeconds != null || totalTokens(r.tokens) != null) && (
                <div
                  className="flex flex-wrap items-center"
                  style={{ gap: 10, marginTop: 7, fontSize: 11.5, color: 'rgb(var(--ink-fg-3))' }}
                >
                  {r.steps != null && <span>{t('agents.custom.runs.steps', { n: r.steps })}</span>}
                  {totalTokens(r.tokens) != null && (
                    <span>
                      {t('agents.custom.runs.tokens', {
                        n: (totalTokens(r.tokens) as number).toLocaleString()
                      })}
                    </span>
                  )}
                  {r.durationSeconds != null && <span>{fmtDuration(r.durationSeconds)}</span>}
                </div>
              )}
              {r.state === 'skipped' && (
                <div
                  style={{
                    fontSize: 11.5,
                    color: 'rgb(var(--ink-fg-3))',
                    marginTop: 6,
                    lineHeight: 1.5
                  }}
                >
                  {t('agents.custom.runs.skippedHint')}
                </div>
              )}
              {r.state === 'paused_pending' && (
                <div
                  style={{
                    fontSize: 11.5,
                    color: 'rgb(var(--ink-fg-3))',
                    marginTop: 6,
                    lineHeight: 1.5
                  }}
                >
                  {t('agents.custom.runs.pausedPendingHint')}
                </div>
              )}
              {r.state === 'paused_expired' && (
                <div
                  style={{
                    fontSize: 11.5,
                    color: 'rgb(var(--ink-fg-3))',
                    marginTop: 6,
                    lineHeight: 1.5
                  }}
                >
                  {t('agents.custom.runs.pausedExpiredHint')}
                </div>
              )}
              {r.error && (
                <div
                  style={{
                    fontSize: 11.5,
                    fontFamily: 'var(--font-mono, monospace)',
                    color: 'rgb(var(--c-fail))',
                    marginTop: 6,
                    wordBreak: 'break-all'
                  }}
                >
                  {r.error}
                </div>
              )}
              {/* last_error 是 gateway 原始错误码（`E_SPEC_AGENT_INVALID` 等），对用户不可读 ——
                  给最常撞见的那个补一句人话（码本身保留，报障时仍可读）。 */}
              {r.error?.includes('E_SPEC_AGENT_INVALID') && (
                <div
                  style={{
                    fontSize: 11.5,
                    color: 'rgb(var(--ink-fg-3))',
                    marginTop: 4,
                    lineHeight: 1.5
                  }}
                >
                  {t('agents.custom.runs.specInvalidHint')}
                </div>
              )}
            </div>
          ))}
          {/* task 07-21 — 「加载更多」触底分页（从简：抽屉里用按钮，非滚动预取）。 */}
          {hasMore && (
            <button
              type="button"
              onClick={() => loadMore()}
              disabled={isLoadingMore}
              className="flex items-center justify-center"
              style={{
                fontFamily: 'inherit',
                fontSize: 12,
                padding: '7px 12px',
                borderRadius: 8,
                cursor: isLoadingMore ? 'wait' : 'pointer',
                color: 'rgb(var(--ink-fg-2))',
                background: 'rgb(var(--ink-1) / 0.5)',
                border: '1px solid rgb(var(--ink-border-soft))'
              }}
            >
              {isLoadingMore
                ? t('agents.custom.runs.loadMoreLoading')
                : t('agents.custom.runs.loadMore')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
