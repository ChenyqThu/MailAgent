import { createElement, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  ChevronRight,
  History,
  Link2,
  Mail,
  Pencil,
  Plus,
  Save,
  Sparkles,
  SquareArrowOutUpRight,
  Trash2,
  X
} from 'lucide-react'

import { MATTER_PROGRESS_KINDS } from '@shared/api/types/matter'
import type {
  MatterEvent,
  MatterMutationResult,
  MatterProgress,
  MatterProgressCreateInput,
  MatterProgressKind,
  MatterProgressPatchInput,
  MatterProgressRef
} from '@shared/api/types/matter'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { Input } from '@shared/components/ui/input'
import { errorMessage } from '@shared/lib/ipcErrors'
import { cn } from '@shared/lib/cn'
import { toastError } from '@shared/state/toast'

import { useMattersApi } from './hooks'
import { dayLabelOf, groupByDay, type Translate } from './matterDayGroups'
import { MatterAuditLogModal } from './MatterAuditLogModal'
import { MatterNarrativeBody } from './MatterNarrativeBody'
import { refreshMatter, useMatterMutation } from './matterMutation'
import { MATTER_PROGRESS_KIND_ICONS, MATTER_PROGRESS_KIND_TONE_CLASS } from './matterProgressVocab'
import { useMatterUndoToast } from './useMatterUndoToast'

/**
 * 事项详情的「进展」tab —— **curated lane**（task 08-25）。
 *
 * owner 原话：「进展默认不把操作日志记录进来，交由用户自己记录，并开放进展的编辑权限给
 * agents，核心是把这个事情的目标、关键进展、关键信号、里程碑等事情记录下来，要的是事情的
 * 发展脉络」。所以这一层的数据是 `matter_progress` 行，**不再**是 38 类 `matter_event` 的
 * 降级映射：
 *   · 没有条目就是空态 + 引导，**不回落**到事件视图（回落等于这次改动没发生）；
 *   · 事件那一路整体搬进操作日志弹窗（`MatterAuditLogModal`），入口仍在这一屏（区头 +
 *     脚注）—— 「只追加、可追溯」是那套东西的立身之本，收进弹窗 ≠ 删掉。
 *
 * 写入方三条，姿态各异：用户在这里直写（下面的 composer）· 事项对话里 agent 走
 * `matter_progress_mutate`（HITL）· 定时跟进 run **只有提案通道**（红线：它拿不到写工具）。
 * 三条都经服务端同一个写面，每次写都往 `matter_event` 追一条审计事件 —— 所以进展的维护
 * 痕迹在操作日志里天然看得见。
 */
export function MatterProgressLane({
  matterId,
  matterVersion,
  entries,
  events,
  locale
}: {
  matterId: string
  /** 乐观锁基线 = 渲染这一刻的 `matter.version`（同详情页其余写路径）。 */
  matterVersion: number
  /** 服务端已按**叙事时间**倒序（`happened_at DESC, id DESC`），软删的不在里面。 */
  entries: readonly MatterProgress[]
  /** 操作日志弹窗的数据面：全量事件，一条不少。 */
  events: readonly MatterEvent[]
  locale: string
}): React.ReactElement {
  const { t } = useTranslation()
  const translate = t as unknown as Translate
  const api = useMattersApi()
  const queryClient = useQueryClient()
  const pushUndoToast = useMatterUndoToast()
  const [auditOpen, setAuditOpen] = useState(false)
  const [composerOpen, setComposerOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  // 「今天/昨天」的基准挂载时冻结（react-hooks/purity：render 期间不许调 Date.now()）。
  const [now] = useState(() => Date.now())

  const refresh = (): Promise<void> => refreshMatter(queryClient, matterId)

  const addProgress = useMatterMutation({
    matterId,
    mutationFn: (input: MatterProgressCreateInput) =>
      api.createProgress(matterId, input, { expectedVersion: matterVersion }),
    onSuccess: async () => {
      setComposerOpen(false)
      await refresh()
    },
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  const editProgress = useMatterMutation({
    matterId,
    mutationFn: ({ id, patch }: { id: number; patch: MatterProgressPatchInput }) =>
      api.patchProgress(matterId, id, patch, { expectedVersion: matterVersion }),
    onSuccess: async () => {
      setEditingId(null)
      await refresh()
    },
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  const removeProgress = useMatterMutation({
    matterId,
    mutationFn: (id: number) =>
      api.deleteProgress(matterId, id, { expectedVersion: matterVersion }),
    onSuccess: async (result: MatterMutationResult) => {
      await refresh()
      // 软删 —— 服务端给得出反向 descriptor（restore），toast 上就有撤销。
      pushUndoToast(t('matters.progress.deleted'), result, matterId)
    },
    onError: (error) => toastError(t('matters.toast.deleteFailed'), errorMessage(error))
  })

  const busy = addProgress.isPending || editProgress.isPending || removeProgress.isPending
  const days = useMemo(() => groupByDay(entries, (entry) => entry.happened_at), [entries])

  return (
    <section>
      {/* 区头 = 设计稿 `RailLabel right={…}>事情的进展</RailLabel>`。🔴 不用仓库的
          SectionHeader —— 它是 mono UPPERCASE，且有 CI lint 规则 `no-cjk-in-mono-size` 禁 CJK。 */}
      <h2 className="mb-2 flex items-center justify-between gap-3 text-meta font-semibold uppercase tracking-[0.08em] text-ink-fg-2">
        <span className="min-w-0 truncate">{t('matters.progress.sectionTitle')}</span>
        <span className="inline-flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              setEditingId(null)
              setComposerOpen(true)
            }}
            className="inline-flex items-center gap-1 rounded-[var(--r-ctl)] px-1.5 py-1 text-meta font-normal normal-case tracking-normal text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
          >
            <Plus size={12} />
            {t('matters.progress.add')}
          </button>
          <button
            type="button"
            onClick={() => setAuditOpen(true)}
            title={t('matters.timeline.auditLog')}
            aria-label={t('matters.timeline.auditLog')}
            className="grid size-6 place-items-center rounded-[var(--r-ctl)] text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
          >
            <History size={13} />
          </button>
        </span>
      </h2>

      {composerOpen ? (
        <ProgressComposer
          busy={addProgress.isPending}
          onCancel={() => setComposerOpen(false)}
          onSubmit={(draft) => addProgress.mutate(draft)}
        />
      ) : null}

      {days.map((day) => (
        <div key={day.key} data-testid="matter-progress-day" className="mt-1.5">
          {/* 天分组头（设计 progress.jsx:179-184）：标签 + 发丝线 + 条数。 */}
          <div className="flex items-center gap-2 px-0.5 pb-0.5 pt-1.5">
            <span className="text-meta font-medium text-ink-fg-2">
              {dayLabelOf(day.at, now, locale, translate)}
            </span>
            <span aria-hidden className="h-px flex-1 bg-ink-border-soft" />
            <span className="text-micro text-ink-fg-3">
              {t('matters.timeline.dayCount', { count: day.rows.length })}
            </span>
          </div>
          {/* 一条贯穿竖线 + 每条一个按 kind 定色的圆节点。竖线 left 16px = 节点半径 12.5 +
              pl-1 的 4px，正好穿过圆心；节点用 bg-ink-0 盖住线。 */}
          <div className="relative pl-1">
            <span aria-hidden className="absolute bottom-3 left-4 top-3 w-px bg-ink-border" />
            {day.rows.map((entry) =>
              editingId === entry.id ? (
                <ProgressComposer
                  key={entry.id}
                  entry={entry}
                  busy={editProgress.isPending}
                  onCancel={() => setEditingId(null)}
                  onSubmit={(patch) => editProgress.mutate({ id: entry.id, patch })}
                />
              ) : (
                <ProgressRow
                  key={entry.id}
                  entry={entry}
                  busy={busy}
                  locale={locale}
                  t={translate}
                  onEdit={() => {
                    setComposerOpen(false)
                    setEditingId(entry.id)
                  }}
                  onDelete={() => removeProgress.mutate(entry.id)}
                />
              )
            )}
          </div>
        </div>
      ))}

      {entries.length === 0 && !composerOpen ? (
        <EmptyState
          title={t('matters.progress.empty')}
          hint={t('matters.progress.emptyHint')}
          action={
            <button
              type="button"
              onClick={() => setComposerOpen(true)}
              className="rounded-[var(--r-ctl)] border border-ink-border px-3 py-2 text-body hover:bg-ink-3"
            >
              <Plus size={13} className="mr-1 inline" />
              {t('matters.progress.add')}
            </button>
          }
        />
      ) : null}

      {/* 操作日志脚注（设计 progress.jsx:192-198）：计数说的是**全部事件**，与弹窗内容一致。 */}
      <div className="mt-3 flex items-center gap-2 border-t border-ink-border-soft pt-2.5">
        <History size={12} className="shrink-0 text-ink-fg-3" />
        <span className="min-w-0 flex-1 text-meta text-ink-fg-3">
          {t('matters.timeline.auditFooter', { count: events.length })}
        </span>
        <button
          type="button"
          onClick={() => setAuditOpen(true)}
          className="inline-flex shrink-0 items-center gap-1 rounded-[var(--r-ctl)] px-1.5 py-1 text-meta text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
        >
          {t('matters.timeline.auditOpen')}
          <ChevronRight size={11} />
        </button>
      </div>

      <MatterAuditLogModal
        open={auditOpen}
        events={events}
        locale={locale}
        onOpenChange={setAuditOpen}
      />
    </section>
  )
}

function ProgressRow({
  entry,
  busy,
  locale,
  t,
  onEdit,
  onDelete
}: {
  entry: MatterProgress
  busy: boolean
  locale: string
  t: Translate
  onEdit(): void
  onDelete(): void
}): React.ReactElement {
  // 🔴 成员索引而不是查表函数：eslint `react-hooks/static-components` 不接受
  // `const Icon = someFn(...)`（同 matterVocab.ts 的先例）；`createElement` 绕开的是写法。
  const icon = createElement(MATTER_PROGRESS_KIND_ICONS[entry.kind], { size: 12 })
  return (
    <div
      className="group/progress relative flex gap-[11px] py-[7px]"
      data-testid="matter-progress-entry"
    >
      {/* D13 —— 圆底只为盖住贯穿竖线，**不描边**。 */}
      <span
        className={cn(
          'z-[1] grid size-[25px] shrink-0 place-items-center rounded-full bg-ink-0',
          MATTER_PROGRESS_KIND_TONE_CLASS[entry.kind]
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex items-start gap-1.5">
          {/* 主句（设计 ProgressEntry：13.5/500）—— 一条进展先让人读懂发生了什么。 */}
          <div className="min-w-0 flex-1 text-body font-medium leading-[1.5] text-ink-fg">
            {entry.title}
          </div>
          {/* hover 出 ✎/🗑（设计 detail.jsx:296-298 的 rowact 形态，同条目行）。 */}
          <span className="inline-flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-fast group-focus-within/progress:opacity-100 group-hover/progress:opacity-100">
            <button
              type="button"
              disabled={busy}
              onClick={onEdit}
              aria-label={t('matters.progress.edit')}
              className="rounded-[var(--r-ctl)] p-1 text-ink-fg-3 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-40"
            >
              <Pencil size={12} />
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onDelete}
              aria-label={t('matters.progress.delete')}
              className="rounded-[var(--r-ctl)] p-1 text-ink-fg-3 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-fail focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-40"
            >
              <Trash2 size={12} />
            </button>
          </span>
        </div>
        {/* 正文紧跟主句、排在时间/来源那行**之前** —— 内容是第一等的，元信息才是脚注。
            `truncated` 恒 false：进展正文是原文，服务端不截（与事件 narrative 的摘录不同）。 */}
        {entry.body ? <MatterNarrativeBody text={entry.body} /> : null}
        {entry.refs.length > 0 ? <ProgressRefs refs={entry.refs} t={t} /> : null}
        <div className="mt-[3px] flex flex-wrap items-center gap-[7px]">
          <time className="font-mono text-micro text-ink-fg-3">
            {new Date(entry.happened_at).toLocaleString(locale)}
          </time>
          {entry.actor_kind === 'agent' ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-ai/10 px-1.5 py-0.5 text-micro text-ai">
              <Sparkles size={9} />
              {t('matters.timeline.agent')}
            </span>
          ) : (
            <span className="text-micro text-ink-fg-3">
              · {t(`matters.eventActor.${entry.actor_kind}`, { defaultValue: entry.actor_kind })}
            </span>
          )}
          <span className="text-micro text-ink-fg-3">
            · {t(`matters.progress.kind.${entry.kind}`)}
          </span>
        </div>
      </div>
    </div>
  )
}

/**
 * 证据链（`refs`）。
 *
 * 🔴 形状**认不出就不猜**：服务端的归一层有意宽松（只保证是对象 + `type` 非空），所以这里
 * 只对能确定的形态给出可点的入口 —— 目前只有 `url`。email / resource 引用要跳到目标需要
 * 另一套解析（message_id ≠ 本地 internal_id），在没有那条链路之前渲染成**不可点**的标签
 * 比渲染一个点了报错的链接诚实。
 */
function ProgressRefs({
  refs,
  t
}: {
  refs: readonly MatterProgressRef[]
  t: Translate
}): React.ReactElement {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {refs.map((ref, index) => {
        const label = t(`matters.progress.refKind.${ref.type}`, { defaultValue: ref.type })
        const url = typeof ref.url === 'string' && ref.url.length > 0 ? ref.url : null
        const className =
          'inline-flex max-w-full items-center gap-1 rounded-full border border-ink-border-soft px-1.5 py-0.5 text-micro text-ink-fg-3'
        const icon =
          ref.type === 'email' ? (
            <Mail size={9} className="shrink-0" />
          ) : url ? (
            <SquareArrowOutUpRight size={9} className="shrink-0" />
          ) : (
            <Link2 size={9} className="shrink-0" />
          )
        return url ? (
          <button
            key={`${ref.type}-${index}`}
            type="button"
            onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
            className={cn(
              className,
              'transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70'
            )}
          >
            {icon}
            <span className="min-w-0 truncate">{url}</span>
          </button>
        ) : (
          <span key={`${ref.type}-${index}`} className={className}>
            {icon}
            <span className="min-w-0 truncate">{label}</span>
          </span>
        )
      })}
    </div>
  )
}

/**
 * 新增 / 编辑一条进展。
 *
 * 有意只收 kind / 主句 / 正文三样：`happened_at` 新建时留空 = 服务端盖「现在」，编辑时**不动**
 * （补记历史时间是 agent 侧带 `happened_at` 的用法；这里加一个日期选择等于给最常见的
 * 「刚发生一件事」多一步）。`refs` 同理 —— 用户手填证据链没有可用的选取面，agent 才有。
 */
function ProgressComposer({
  entry,
  busy,
  onCancel,
  onSubmit
}: {
  entry?: MatterProgress
  busy: boolean
  onCancel(): void
  onSubmit(draft: MatterProgressCreateInput): void
}): React.ReactElement {
  const { t } = useTranslation()
  const [kind, setKind] = useState<MatterProgressKind>(entry?.kind ?? 'progress')
  const [title, setTitle] = useState(entry?.title ?? '')
  const [body, setBody] = useState(entry?.body ?? '')
  const trimmed = title.trim()

  return (
    <div
      data-testid="matter-progress-composer"
      // 🔴 `relative z-[1]`：行内编辑时这张卡长在时间轴里，而贯穿竖线是 absolute（定位元素
      // 恒画在普通块的背景之上）—— 不抬层的话那条线会从卡片正文里穿过去。
      className="relative z-[1] my-1.5 space-y-2 rounded-[var(--r-card)] border border-ink-border-soft bg-ink-1 p-2.5"
    >
      {/* kind picker：五档一行。图标 + 名字一起出 —— 色/形就是这条进展在时间轴上的样子，
          选的时候先看见它，读的时候才对得上。 */}
      <div className="flex flex-wrap gap-1.5">
        {MATTER_PROGRESS_KINDS.map((value) => {
          const icon = createElement(MATTER_PROGRESS_KIND_ICONS[value], { size: 11 })
          const active = value === kind
          return (
            <button
              key={value}
              type="button"
              aria-pressed={active}
              onClick={() => setKind(value)}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-meta transition-colors duration-fast ease-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70',
                active
                  ? 'border-ink-border bg-ink-3 text-ink-fg'
                  : 'border-ink-border-soft text-ink-fg-2 hover:bg-ink-2'
              )}
            >
              <span className={MATTER_PROGRESS_KIND_TONE_CLASS[value]}>{icon}</span>
              {t(`matters.progress.kind.${value}`)}
            </button>
          )
        })}
      </div>
      <Input
        autoFocus
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel()
        }}
        aria-label={t('matters.progress.titleLabel')}
        placeholder={t('matters.progress.titlePlaceholder')}
        className="h-8 w-full px-2 text-body"
      />
      <textarea
        rows={2}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        aria-label={t('matters.progress.bodyLabel')}
        placeholder={t('matters.progress.bodyPlaceholder')}
        className="w-full resize-y rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2 py-1.5 text-aux outline-none focus:border-coral/60"
      />
      <div className="flex justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-1 rounded-[var(--r-ctl)] px-2 py-1 text-meta text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
        >
          <X size={12} />
          {t('matters.actions.cancel')}
        </button>
        <button
          type="button"
          disabled={trimmed.length === 0 || busy}
          onClick={() =>
            onSubmit({ kind, title: trimmed, body: body.trim().length > 0 ? body.trim() : null })
          }
          className="inline-flex items-center gap-1 rounded-[var(--r-ctl)] bg-coral/100 px-2.5 py-1 text-meta font-medium text-accent-fg transition-opacity duration-fast disabled:opacity-50"
        >
          <Save size={12} />
          {t('matters.actions.save')}
        </button>
      </div>
    </div>
  )
}
