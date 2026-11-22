import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, FileCheck, Pencil, RefreshCw, Sparkles, TriangleAlert } from 'lucide-react'

import type { Matter } from '@shared/api/types/matter'
import { cn } from '@shared/lib/cn'
import { formatMatterAgo } from '@shared/lib/matterDerive'

import { MatterSectionLabel } from './MatterDetailControls'

/**
 * 「当前状态 · 已接受」卡（设计 detail.jsx:339-362）。
 *
 * 🔴 只管**已接受的摘要**：背景与目标、完成标志已拆到 `GoalCard` 并排在它之前
 * （G-06 / 补充规格 §5.1）。别再往这里加目标相关的东西 —— 两者的写入语义不同，
 * 摘要走「Agent 提案 → 你接受」，目标是用户自己写的（HANDOFF §3 硬约束①）。
 */
export function StateCard({
  matter,
  pendingCount,
  onReview,
  saving,
  now,
  locale,
  onSummarySave,
  onRegenerate,
  regenerating = false
}: {
  matter: Matter
  pendingCount: number
  onReview(): void
  saving: boolean
  now: number
  locale: string
  onSummarySave(summary: string | null, onSaved: () => void): void
  /** G-10 —— 「重新生成摘要」= 触发一次跟进 run；agent flag 关时不传，只留新鲜度指示。 */
  onRegenerate?: () => void
  regenerating?: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  const [summaryEditing, setSummaryEditing] = useState(false)
  const [summaryDraft, setSummaryDraft] = useState(matter.current_summary ?? '')
  const summaryValue = matter.current_summary ?? ''
  const normalizedSummaryDraft = summaryDraft.trim() ? summaryDraft : null
  // G-10 新鲜度（设计 detail.jsx:340-350）：>14 天 warn「已 N 天未更新」，否则「{ago}由你接受」
  // （直接编辑走的也是隐藏 accepted Manual Update 路径，「由你接受」对两种来源都成立）。
  const staleDays =
    matter.summary_at != null ? Math.floor((now - matter.summary_at) / 86_400_000) : null
  const stale = staleDays !== null && staleDays > 14

  useEffect(() => {
    if (!summaryEditing) setSummaryDraft(matter.current_summary ?? '')
  }, [matter.current_summary, summaryEditing])

  const saveSummary = (): void => {
    onSummarySave(normalizedSummaryDraft, () => setSummaryEditing(false))
  }

  return (
    <section>
      {/* D8 —— 分节标签移出卡片、带 icon（设计 detail.jsx:350 `<RailLabel icon="filecheck">`）。
          微调项：视觉标题带「· 已接受」后缀，但 `matters.state.title` 键保持原值 ——
          它参与下面编辑按钮的 aria-label 组合（MatterStateCard.test 断言），后缀只进视觉层。 */}
      <MatterSectionLabel
        icon={<FileCheck size={12} className="shrink-0 text-ink-fg-2" />}
        right={
          <span className="flex shrink-0 items-center gap-1.5">
            {staleDays !== null ? (
              <span
                className={cn(
                  'inline-flex items-center gap-1 text-micro',
                  stale ? 'text-warn' : 'text-ink-fg-3'
                )}
              >
                {stale ? <TriangleAlert size={11} /> : <CheckCircle2 size={11} />}
                {stale
                  ? t('matters.state.freshnessStale', { count: staleDays })
                  : t('matters.state.freshnessFresh', {
                      time: formatMatterAgo(matter.summary_at as number, now, locale)
                    })}
              </span>
            ) : null}
            {onRegenerate ? (
              <button
                type="button"
                disabled={regenerating}
                onClick={onRegenerate}
                title={t('matters.state.regenerate')}
                aria-label={t('matters.state.regenerate')}
                className="rounded-[var(--r-ctl)] p-1.5 text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-50"
              >
                <RefreshCw size={12} className={regenerating ? 'animate-spin' : undefined} />
              </button>
            ) : null}
            {!summaryEditing ? (
              <button
                type="button"
                onClick={() => setSummaryEditing(true)}
                aria-label={`${t('matters.state.title')} ${t('matters.actions.edit')}`}
                className="rounded-[var(--r-ctl)] p-1.5 text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
              >
                <Pencil size={12} />
              </button>
            ) : null}
          </span>
        }
      >
        {t('matters.state.title')}
        <span aria-hidden className="font-normal normal-case tracking-normal text-ink-fg-3">
          {' '}
          · {t('matters.state.titleAccepted')}
        </span>
      </MatterSectionLabel>
      <div className="rounded-[var(--r-card)] border border-ink-border bg-ink-1/75 p-4">
        {summaryEditing ? (
          <div>
            <textarea
              autoFocus
              rows={5}
              value={summaryDraft}
              onChange={(event) => setSummaryDraft(event.target.value)}
              placeholder={t('matters.state.summaryPlaceholder')}
              aria-label={t('matters.state.title')}
              className="w-full resize-y rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 text-body text-ink-fg outline-none transition-colors duration-fast ease-standard placeholder:text-ink-fg-3 focus-visible:border-coral/60 focus-visible:ring-2 focus-visible:ring-coral/70"
            />
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setSummaryDraft(summaryValue)
                  setSummaryEditing(false)
                }}
                className="rounded-[var(--r-ctl)] px-2.5 py-1.5 text-aux text-ink-fg-1 transition-colors duration-fast ease-standard hover:bg-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
              >
                {t('matters.actions.cancel')}
              </button>
              <button
                type="button"
                disabled={saving || normalizedSummaryDraft === (matter.current_summary ?? null)}
                onClick={saveSummary}
                className="rounded-[var(--r-ctl)] bg-coral/100 px-3 py-1.5 text-aux font-medium text-accent-fg transition-[background-color,transform] duration-fast ease-standard hover:bg-coral-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 active:scale-[0.96] disabled:opacity-50"
              >
                {t('matters.actions.save')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="whitespace-pre-wrap text-body text-ink-fg-1">
              {matter.current_summary || t('matters.state.noSummary')}
            </p>
            {matter.current_summary && (matter.summary_at != null || matter.summary_by_kind) ? (
              <p className="mt-2 flex flex-wrap items-center gap-2 text-meta text-ink-fg-2">
                {matter.summary_at != null ? (
                  <span>
                    {t('matters.state.summaryUpdatedAt', {
                      time: new Date(matter.summary_at).toLocaleString()
                    })}
                  </span>
                ) : null}
                {matter.summary_by_kind ? (
                  <span>{t(`matters.state.summaryBy.${matter.summary_by_kind}`)}</span>
                ) : null}
              </p>
            ) : null}
          </>
        )}
        <p className="mt-3 border-t border-ink-border pt-3 text-meta text-ink-fg-2">
          {t('matters.state.summaryGuard')}
        </p>
        {pendingCount > 0 ? (
          <button
            type="button"
            onClick={onReview}
            className="mt-4 inline-flex items-center gap-1 rounded-lg bg-ai/10 px-3 py-2 text-aux text-ai"
          >
            <Sparkles size={12} />
            {t('matters.state.pendingProposals', { count: pendingCount })}
          </button>
        ) : null}
      </div>
    </section>
  )
}
