// S6 W2（PRD P5 红点链）— custom-agent 待审批（paused_pending）红点面。三个可复用件：
//   - PendingDot：脉冲红点（run 行 ① + Custom AI Agents 区 header ③）。animate-ping 先例
//     = SystemAlertBadge；oklch token `--c-fail`（bg-fail），不发明新色。
//   - AgentPendingCountBadge：per-agent 待审批计数徽标（CustomAgentCard ②）。count<=0 → null。
//   - TitleBarAgentPendingBadge：全局徽标（④），SystemAlertBadge 同款 5s 轮询 + popover。
//     flag off / customAgentsEnabled=false → useAgentPendingCount 不轮询、total 恒 0 → 返 null
//     （不渲染、不轮询，字节级同现状）。popover 每行点击即打开该次 run 的执行记录。
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
// 08-20 — 图标从 Bell 换成 ClipboardCheck：铃铛已归统一通知中心（同排两个铃铛会误导，
// design §6.1）；本徽标的语义是「待审批」，剪贴板打勾更贴。M2 收编进通知中心后本组件退场。
import { ClipboardCheck } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { DUR } from '@shared/lib/gsap'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { requestOpenAgentSession } from '@shared/state/ai-chat-panel'

import {
  useAgentPendingCount,
  useCustomAgentsEnabled,
  usePendingRuns,
  useReportConfig
} from './hooks'

/** 脉冲红点（animate-ping 淡入淡出，SystemAlertBadge 先例）。装饰性，title 供无障碍提示。 */
export function PendingDot({ title }: { title?: string }): React.ReactElement {
  return (
    <span
      className="relative inline-flex shrink-0"
      style={{ width: 7, height: 7 }}
      title={title}
      aria-label={title}
    >
      <span className="absolute inset-0 rounded-full bg-fail opacity-75 animate-ping" aria-hidden />
      <span className="absolute inset-0 rounded-full bg-fail" aria-hidden />
    </span>
  )
}

/** per-agent 待审批计数徽标（CustomAgentCard ②）。count<=0 → 不渲染。 */
export function AgentPendingCountBadge({ count }: { count: number }): React.ReactElement | null {
  const { t } = useTranslation()
  if (count <= 0) return null
  const label = t('agents.custom.runs.pendingBadge', { count })
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-fail/40 bg-fail/15 px-1.5 py-0.5 text-micro font-mono text-fail"
      title={label}
    >
      <PendingDot />
      <span className="tabular-nums">{label}</span>
    </span>
  )
}

/** 相对时间（"N 分钟前"）：run 触发/结束时间 → 一行摘要。epoch 秒或毫秒容错。 */
function relTime(
  t: (k: string, o?: Record<string, unknown>) => string,
  ts: number | null | undefined
): string {
  if (ts == null) return ''
  const ms = ts < 1e12 ? ts * 1000 : ts
  const diff = Date.now() - ms
  const mins = Math.max(0, Math.floor(diff / 60000))
  if (mins < 1) return t('agents.custom.runs.ageJustNow')
  if (mins < 60) return t('agents.custom.runs.ageMinutes', { n: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('agents.custom.runs.ageHours', { n: hours })
  return t('agents.custom.runs.ageDays', { n: Math.floor(hours / 24) })
}

/** TitleBar 全局待审批徽标（④）。外层只做 flag + 计数门（SystemAlertBadge 同款 5s 轮询，flag off →
 *  enabled=false → 不轮询、total 恒 0），total>0 才挂载内层（popover + 列表/名字映射查询——避免 flag off
 *  时白拉 getConfig / listRuns）。 */
export function TitleBarAgentPendingBadge(): React.ReactElement | null {
  const customAgentsEnabled = useCustomAgentsEnabled()
  // flag off → enabled=false → 不轮询、total 恒 0 → 下方 return null（字节级不渲染、无任何查询）。
  const total = useAgentPendingCount(customAgentsEnabled).total
  if (!customAgentsEnabled || total === 0) return null
  return <TitleBarAgentPendingBadgeInner total={total} />
}

/** 徽标内层：仅在有待审批时挂载 → popover 列表 + 名字映射查询都随之激活/卸载。 */
function TitleBarAgentPendingBadgeInner({ total }: { total: number }): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(open, {
    backdrop: false,
    from: { autoAlpha: 0, y: -6, scale: 0.97, transformOrigin: 'top right' },
    enterDuration: DUR.fast
  })
  // popover 打开时才拉列表；名字映射复用 report config 缓存（同样只在内层挂载期查询）。
  const { runs } = usePendingRuns(open)
  const { agents } = useReportConfig()
  const titleFor = (agentId: string): string =>
    agents.find((a) => a.id === agentId)?.title ?? agentId

  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent): void => {
      const target = e.target as Node
      if (scopeRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return (): void => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const openRecord = (sessionId: number): void => {
    setOpen(false)
    requestOpenAgentSession(sessionId)
    void navigate({ to: '/sessions' })
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={t('agents.custom.runs.titleBar.tooltip', { count: total })}
        aria-live="polite"
        aria-label={t('agents.custom.runs.titleBar.aria', { count: total })}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        className={cn(
          'group flex items-center gap-1.5 px-2 py-0.5 rounded-md text-meta font-mono',
          'border border-fail/40 bg-fail/15 text-fail transition-colors duration-fast hover:bg-fail/25'
        )}
      >
        <span className="relative inline-flex">
          <ClipboardCheck size={11} strokeWidth={2.25} />
          <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5">
            <span className="absolute inset-0 rounded-full bg-fail opacity-75 animate-ping" />
            <span className="absolute inset-0 rounded-full bg-fail" />
          </span>
        </span>
        <span className="tabular-nums">{total}</span>
      </button>

      {shouldRender &&
        createPortal(
          <div
            ref={scopeRef}
            role="dialog"
            aria-label={t('agents.custom.runs.titleBar.title')}
            className="theme-popover glass-pop"
            style={{ width: 320, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <div className="px-4 pt-3 pb-2 border-b border-ink-border-soft">
              <div className="text-micro font-mono uppercase tracking-wider text-ink-fg-2">
                {t('agents.custom.runs.titleBar.kicker')}
              </div>
              <div className="mt-0.5 flex items-center gap-2">
                <span className="text-aux text-ink-fg">
                  {t('agents.custom.runs.titleBar.title')}
                </span>
                <span className="px-1.5 rounded text-micro font-mono bg-fail/15 text-fail border border-fail/40 tabular-nums">
                  {total}
                </span>
              </div>
            </div>
            <ul className="max-h-72 overflow-y-auto py-1">
              {runs.length === 0 ? (
                <li className="px-4 py-3 text-meta text-ink-fg-3">
                  {t('agents.custom.runs.titleBar.empty')}
                </li>
              ) : (
                runs.map((r) => (
                  <li key={r.jobId}>
                    <button
                      type="button"
                      disabled={r.sessionId == null}
                      onClick={() => r.sessionId != null && openRecord(r.sessionId)}
                      className={cn(
                        'w-full px-4 py-2.5 flex items-start gap-2.5 text-left',
                        'transition-colors duration-fast hover:bg-ink-3 disabled:opacity-50 disabled:cursor-default'
                      )}
                    >
                      <span className="mt-1 shrink-0">
                        <PendingDot />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-aux text-ink-fg leading-snug truncate">
                          {titleFor(r.agentId)}
                        </div>
                        <div className="text-micro font-mono text-ink-fg-3 mt-0.5">
                          {relTime(t, r.finishedAt ?? r.createdAt)}
                        </div>
                      </div>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>,
          document.body
        )}
    </>
  )
}
