import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Hourglass, Link2, Pencil, Plus, Save, Trash2, X } from 'lucide-react'

import type { ReportAgentConfig } from '@shared/api/types'
import { MATTER_ITEM_KINDS } from '@shared/api/types/matter'
import type {
  MatterItem,
  MatterItemDispatch,
  MatterItemExecProfile,
  MatterItemKind,
  MatterItemStatus,
  MatterResourceListItem,
  MatterStakeholder
} from '@shared/api/types/matter'
import { TranslatedBody } from '@shared/components/email/TranslatedBody'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { Input } from '@shared/components/ui/input'
import { cn } from '@shared/lib/cn'
import { formatMatterAgo, formatMatterDueRelative } from '@shared/lib/matterDerive'

import { MatterCheckToggle } from '../MatterCheckRow'
import { MatterItemDispatchBlock } from '../MatterItemDispatchBlock'
import {
  MATTER_ITEM_KIND_ICONS,
  MATTER_ITEM_KIND_TEXT_CLASS,
  MATTER_ITEM_STATUS_TONES,
  MATTER_TONE_CHIP_CLASS,
  MATTER_TONE_TEXT_CLASS,
  matterDueTone
} from '../matterVocab'
import { MatterSectionLabel } from './MatterDetailControls'

export interface ItemRowCallbacks {
  onToggle(item: MatterItem): void
  onRename(item: MatterItem, title: string): void
  onDelete(item: MatterItem): void
  onOpenResource(item: MatterResourceListItem): void
}

/** L4 批次 3 —— 执行契约那一块要往下传的东西，独立成一组免得两层各抄六个参数。 */
export interface ItemDispatchProps {
  matterId: string
  dispatchEnabled: boolean
  /** 本事项的全部派发（newest-first）。行内按 `item_id` 切片。 */
  dispatches: readonly MatterItemDispatch[]
  agentProfiles: readonly ReportAgentConfig[]
  onSetItemProfile(item: MatterItem, profile: MatterItemExecProfile): void
  onReviewUpdate(updateId: number): void
}

/** 模块级常量 = 引用稳定：`?? []` 每次 render 新建数组，会让下游 memo 全部失效。 */
const EMPTY_DISPATCHES: readonly MatterItemDispatch[] = []

export function ItemGroups({
  items,
  stakeholders,
  resources,
  now,
  locale,
  busy,
  onToggle,
  onAdd,
  onRename,
  onDelete,
  onOpenResource,
  ...dispatchProps
}: {
  items: readonly MatterItem[]
  stakeholders: readonly MatterStakeholder[]
  resources: readonly MatterResourceListItem[]
  now: number
  locale: string
  busy: boolean
  onAdd(kind: MatterItemKind): void
} & ItemRowCallbacks &
  ItemDispatchProps): React.ReactElement {
  const { t } = useTranslation()
  const activeItems = items.filter((item) => item.deleted_at === null)
  const groups = MATTER_ITEM_KINDS.map((kind) => ({
    kind,
    items: activeItems.filter((item) => item.kind === kind)
  })).filter((group) => group.items.length > 0)
  const stakeholdersById = useMemo(
    () => new Map(stakeholders.map((stakeholder) => [stakeholder.id, stakeholder])),
    [stakeholders]
  )
  const resourcesById = useMemo(
    () => new Map(resources.map((item) => [item.resource.id, item])),
    [resources]
  )
  if (groups.length === 0) {
    const starterKinds: MatterItemKind[] = [
      'action',
      'milestone',
      'decision',
      'blocker',
      'question'
    ]
    return (
      <EmptyState
        title={t('matters.item.empty')}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            {starterKinds.map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => onAdd(kind)}
                className="rounded-[var(--r-ctl)] border border-ink-border px-3 py-2 text-body hover:bg-ink-3"
              >
                <Plus size={13} className="mr-1 inline" />
                {t(`matters.item.kinds.${kind}`)}
              </button>
            ))}
          </div>
        }
      />
    )
  }
  return (
    <section className="space-y-4">
      {groups.map((group) => (
        <ItemGroup
          key={group.kind}
          kind={group.kind}
          items={group.items}
          stakeholdersById={stakeholdersById}
          resourcesById={resourcesById}
          now={now}
          locale={locale}
          busy={busy}
          onToggle={onToggle}
          onAdd={onAdd}
          onRename={onRename}
          onDelete={onDelete}
          onOpenResource={onOpenResource}
          {...dispatchProps}
        />
      ))}
    </section>
  )
}

function ItemGroup({
  kind,
  items,
  stakeholdersById,
  resourcesById,
  now,
  locale,
  busy,
  onToggle,
  onAdd,
  onRename,
  onDelete,
  onOpenResource,
  matterId,
  dispatchEnabled,
  dispatches,
  agentProfiles,
  onSetItemProfile,
  onReviewUpdate
}: {
  kind: MatterItemKind
  items: readonly MatterItem[]
  stakeholdersById: ReadonlyMap<number, MatterStakeholder>
  resourcesById: ReadonlyMap<number, MatterResourceListItem>
  now: number
  locale: string
  busy: boolean
  onAdd(kind: MatterItemKind): void
} & ItemRowCallbacks &
  ItemDispatchProps): React.ReactElement {
  const { t } = useTranslation()
  // 一次 O(n) 分桶：行内 `dispatches.filter(...)` 是 O(行数 × 派发数)。
  const dispatchesByItem = useMemo(() => {
    const byItem = new Map<number, MatterItemDispatch[]>()
    for (const dispatch of dispatches) {
      const bucket = byItem.get(dispatch.item_id)
      if (bucket) bucket.push(dispatch)
      else byItem.set(dispatch.item_id, [dispatch])
    }
    return byItem
  }, [dispatches])
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [editingId, setEditingId] = useState<number | null>(null)
  const [titleDraft, setTitleDraft] = useState('')

  const startEdit = (item: MatterItem): void => {
    setEditingId(item.id)
    setTitleDraft(item.title)
  }
  const saveEdit = (item: MatterItem): void => {
    const title = titleDraft.trim()
    setEditingId(null)
    if (!title || title === item.title) return
    onRename(item, title)
  }

  const KindIcon = MATTER_ITEM_KIND_ICONS[kind]
  // 设计 detail.jsx:322/328 —— 标签后缀是「· N 项未完成」，不是总数；note / decision
  // 这两类没有「完成」语义（设计明确排除），只出类型名。
  const openCount = items.filter(
    (item) => item.status !== 'done' && item.status !== 'canceled'
  ).length
  const showOpenCount = openCount > 0 && kind !== 'note' && kind !== 'decision'

  return (
    <section>
      {/* D8 —— 分节标签移出卡片、带本类型的 icon（设计 detail.jsx:325-330）。 */}
      <MatterSectionLabel
        icon={<KindIcon size={12} className={cn('shrink-0', MATTER_ITEM_KIND_TEXT_CLASS[kind])} />}
        right={
          <button
            type="button"
            onClick={() => onAdd(kind)}
            aria-label={t('matters.item.addKind', { kind: t(`matters.item.kinds.${kind}`) })}
            title={t('matters.item.addKind', { kind: t(`matters.item.kinds.${kind}`) })}
            className="shrink-0 rounded-[var(--r-ctl)] p-1 text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
          >
            <Plus size={13} />
          </button>
        }
      >
        {t(`matters.item.kinds.${kind}`)}
        {showOpenCount ? (
          <span className="font-normal normal-case tracking-normal text-ink-fg-3">
            {' '}
            · {t('matters.item.openCount', { count: openCount })}
          </span>
        ) : null}
      </MatterSectionLabel>
      {/* 边框改 `ink-border-soft`（设计 detail.jsx:331）；行的几何不动 —— D8 只收分节。 */}
      <div className="overflow-hidden rounded-[var(--r-card)] border border-ink-border-soft bg-ink-1/65">
        <div className="divide-y divide-ink-border-soft">
          {items.map((item) => {
            const isExpanded = expanded.has(item.id)
            const done = item.status === 'done'
            const editing = editingId === item.id
            // G-11 meta 行的数据面：状态 Pip（action 未完成）· 等 {人} · 到期 · 完成时间 ·
            // 来源链接。设计里的 `已阻塞 {时长}`（it.since）与 owner 头像是 mock-only 字段，
            // 数据里没有，不渲染。
            const waitingOn =
              item.waiting_on_stakeholder_id != null
                ? stakeholdersById.get(item.waiting_on_stakeholder_id)
                : undefined
            const sourceResource =
              item.source_resource_id != null
                ? resourcesById.get(item.source_resource_id)
                : undefined
            const dueTone = matterDueTone(item.due_at, now)
            const showStatusPip =
              item.kind === 'action' &&
              item.status !== null &&
              item.status !== 'done' &&
              item.status !== 'canceled'
            const hasMeta =
              showStatusPip ||
              waitingOn !== undefined ||
              (item.due_at != null && !done) ||
              (done && item.completed_at != null) ||
              sourceResource !== undefined
            return (
              <div key={item.id} className="group/item px-4 py-3">
                <div className="flex items-start gap-2.5">
                  {/* 勾选外观与「完成标志」同一个单源（`MatterCheckRow.tsx`）。这里只有图标
                    可点：整行做成 button 会把下面的改标题 / 删除 / 来源 / 展开清单四个钮
                    嵌进去（非法）。 */}
                  {item.kind === 'action' ? (
                    <MatterCheckToggle
                      done={done}
                      label={item.title}
                      className="mt-0.5"
                      onToggle={() => onToggle(item)}
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    {editing ? (
                      <div className="flex items-center gap-1.5">
                        <Input
                          autoFocus
                          value={titleDraft}
                          onChange={(event) => setTitleDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') saveEdit(item)
                            if (event.key === 'Escape') setEditingId(null)
                          }}
                          aria-label={t('matters.item.editTitle')}
                          className="h-7 min-w-0 flex-1 px-2 text-body"
                        />
                        <button
                          type="button"
                          disabled={!titleDraft.trim() || busy}
                          onClick={() => saveEdit(item)}
                          aria-label={t('matters.actions.save')}
                          className="rounded-[var(--r-ctl)] p-1.5 text-ok transition-colors duration-fast ease-standard hover:bg-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-50"
                        >
                          <Save size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          aria-label={t('matters.actions.cancel')}
                          className="rounded-[var(--r-ctl)] p-1.5 text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-start gap-1.5">
                        <div
                          className={cn(
                            'min-w-0 flex-1 text-body',
                            done && 'text-ink-fg-2 line-through'
                          )}
                        >
                          {item.title}
                        </div>
                        {/* hover 出 ✎/🗑（设计 detail.jsx:296-298 的 rowact 形态）。 */}
                        <span className="inline-flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-fast group-focus-within/item:opacity-100 group-hover/item:opacity-100">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => startEdit(item)}
                            aria-label={t('matters.item.editTitle')}
                            className="rounded-[var(--r-ctl)] p-1 text-ink-fg-3 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-40"
                          >
                            <Pencil size={12} />
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => onDelete(item)}
                            aria-label={t('matters.item.deleteItem')}
                            className="rounded-[var(--r-ctl)] p-1 text-ink-fg-3 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-fail focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-40"
                          >
                            <Trash2 size={12} />
                          </button>
                        </span>
                      </div>
                    )}
                    {item.description ? (
                      <div className="mt-1 [&_.mail-body]:text-aux [&_.mail-body]:leading-relaxed [&_.mail-body_p]:mb-2 [&_.mail-body_p:last-child]:mb-0">
                        <TranslatedBody text={item.description} />
                      </div>
                    ) : null}
                    {hasMeta ? (
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        {showStatusPip ? (
                          <span
                            className={cn(
                              'inline-flex items-center rounded-full border px-1.5 py-0.5 text-micro',
                              MATTER_TONE_CHIP_CLASS[
                                MATTER_ITEM_STATUS_TONES[item.status as MatterItemStatus]
                              ]
                            )}
                          >
                            {t(`matters.item.status.${item.status}`)}
                          </span>
                        ) : null}
                        {waitingOn ? (
                          <span className="inline-flex items-center gap-1 text-micro text-warn">
                            <Hourglass size={10} />
                            {t('matters.item.waitingOn', {
                              name: waitingOn.display_name ?? waitingOn.email_normalized ?? '—'
                            })}
                          </span>
                        ) : null}
                        {item.due_at != null && !done ? (
                          <span
                            className={cn(
                              'text-micro',
                              dueTone === null || dueTone === 'neutral'
                                ? 'text-ink-fg-3'
                                : MATTER_TONE_TEXT_CLASS[dueTone]
                            )}
                          >
                            {t('matters.item.dueRelative', {
                              time: formatMatterDueRelative(item.due_at, now, locale)
                            })}
                          </span>
                        ) : null}
                        {done && item.completed_at != null ? (
                          <span className="text-micro text-ink-fg-3">
                            {t('matters.item.completedAt', {
                              time: formatMatterAgo(item.completed_at, now, locale)
                            })}
                          </span>
                        ) : null}
                        {sourceResource ? (
                          <button
                            type="button"
                            onClick={() => onOpenResource(sourceResource)}
                            className="inline-flex items-center gap-1 rounded-[var(--r-ctl)] text-micro text-ink-fg-3 transition-colors duration-fast ease-standard hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
                          >
                            <Link2 size={10} />
                            {t('matters.item.source')}
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    {item.checklist.length > 0 ? (
                      <button
                        type="button"
                        onClick={() =>
                          setExpanded((current) => {
                            const next = new Set(current)
                            if (next.has(item.id)) next.delete(item.id)
                            else next.add(item.id)
                            return next
                          })
                        }
                        className="mt-2 inline-flex items-center gap-1 text-meta text-ink-fg-2 hover:text-ink-fg"
                      >
                        {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        {t('matters.item.checklist', { count: item.checklist.length })}
                      </button>
                    ) : null}
                    {isExpanded ? (
                      <ul className="mt-2 space-y-1 pl-4 text-aux text-ink-fg-1">
                        {item.checklist.map((entry) => (
                          <li
                            key={entry.id}
                            className={entry.done ? 'line-through text-ink-fg-2' : ''}
                          >
                            {entry.done ? '✓' : '○'} {entry.text}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {/* 执行契约只挂行动项 —— 其余五种 kind 结构上就没有状态机（服务端表级
                        CHECK 同判）。派发史为空且档关着时整块不渲染，行的样子一个像素不变。 */}
                    {item.kind === 'action' &&
                    (dispatchEnabled || (dispatchesByItem.get(item.id)?.length ?? 0) > 0) ? (
                      <MatterItemDispatchBlock
                        matterId={matterId}
                        item={item}
                        dispatches={dispatchesByItem.get(item.id) ?? EMPTY_DISPATCHES}
                        agents={agentProfiles}
                        now={now}
                        locale={locale}
                        busy={busy}
                        onProfileChange={(profile) => onSetItemProfile(item, profile)}
                        onReview={onReviewUpdate}
                      />
                    ) : null}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
