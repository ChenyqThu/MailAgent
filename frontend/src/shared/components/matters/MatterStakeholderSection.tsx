// 干系人区（S2，v60）—— 核心 / 其他两组，grid 卡片拖拽重排 + 跨组拖拽，其他组默认折叠。
//
// 拖拽机制全在通用基座 `ui/SortableBoard`（dnd-kit：二维命中 / 多容器 / 键盘 / 播报）。
// 本文件只做**业务映射**：tier ⇄ 组 id、reorder payload、卡片长什么样。
//
// 基座选型见 `SortableBoard.tsx` 文件头的分工说明（一维单列 → DragReorderList；
// grid 或跨组 → SortableBoard）。

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Edit3, GripVertical, Star, StarOff, Trash2, Users } from 'lucide-react'

import type {
  Matter,
  MatterResourceListItem,
  MatterStakeholder,
  MatterStakeholderReorderItem,
  MatterStakeholderTier
} from '@shared/api/types/matter'
import { MATTER_STAKEHOLDER_DEFAULT_TIER } from '@shared/api/types/matter'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { CollapseChevron } from '@shared/components/ui/collapsible'
import { SortableBoard, type SortableBoardOrder } from '@shared/components/ui/SortableBoard'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { toastError } from '@shared/state/toast'

import { useMattersApi } from './hooks'
import { useMatterMutation } from './matterMutation'
import { buildReorderPayload, splitStakeholdersByTier } from './matterStakeholderTier'

interface StakeholderSectionProps {
  matter: Matter
  stakeholders: readonly MatterStakeholder[]
  resources: readonly MatterResourceListItem[]
  onEdit(stakeholder: MatterStakeholder): void
  onRemove(stakeholderId: number): void
  onChanged(): void
  /** 单个干系人卡的内容（identity + 角色 + 最近联系 + relationship）。
   *  由 MatterContextTab 提供 —— 那些子组件（StakeholderIdentity / StakeholderLastContact）
   *  长在它那里，搬过来会把一个纯展示改动变成跨文件挪动。 */
  renderBody(stakeholder: MatterStakeholder): React.ReactNode
}

export function MatterStakeholderSection({
  matter,
  stakeholders,
  onEdit,
  onRemove,
  onChanged,
  renderBody
}: StakeholderSectionProps): React.ReactElement {
  const { t } = useTranslation()
  const api = useMattersApi()

  const groups = useMemo(() => splitStakeholdersByTier(stakeholders), [stakeholders])
  // 🔴 「还没人被标核心」时「其他」默认展开：存量事项的干系人全是 normal（tier 是 v60 才有
  // 的列），一律折叠等于打开事项一个干系人都看不见。只在初次挂载时判 —— core 从空变非空
  // 不该当场把用户正在看的列表收起来。
  const [othersOpen, setOthersOpen] = useState(() => groups.core.length === 0)
  /** 悬停展开是为这一次拖拽提供落点；真放进去了才保留展开态。 */
  const [expandedByDrag, setExpandedByDrag] = useState(false)

  const byId = useMemo(
    () => new Map(stakeholders.map((row) => [String(row.id), row])),
    [stakeholders]
  )

  const reorder = useMatterMutation({
    matterId: matter.public_id,
    mutationFn: (items: MatterStakeholderReorderItem[]) =>
      api.reorderStakeholders(matter.public_id, items, {
        expectedVersion: matter.version,
        reason: 'user_reordered_stakeholders'
      }),
    onSuccess: onChanged,
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  const commit = (
    core: readonly MatterStakeholder[],
    normal: readonly MatterStakeholder[]
  ): void => {
    reorder.mutate(buildReorderPayload(core, normal))
  }

  const onBoardReorder = (order: SortableBoardOrder): void => {
    const pick = (groupId: MatterStakeholderTier): MatterStakeholder[] =>
      (order.find((entry) => entry.id === groupId)?.itemIds ?? [])
        .map((id) => byId.get(id))
        .filter((row): row is MatterStakeholder => row != null)
    const normal = pick('normal')
    // 拖进「其他」了就让它开着 —— 收起来用户看不见自己刚放的结果。
    if (expandedByDrag && normal.length > groups.normal.length) setOthersOpen(true)
    setExpandedByDrag(false)
    commit(pick('core'), normal)
  }

  /** 换组按钮：拖拽之外的第二条路 —— 触摸设备、以及「一键提核心」这种不需要定位的场景。 */
  const switchTier = (stakeholder: MatterStakeholder, to: MatterStakeholderTier): void => {
    const without = (rows: readonly MatterStakeholder[]): MatterStakeholder[] =>
      rows.filter((row) => row.id !== stakeholder.id)
    if (to === 'core') commit([...without(groups.core), stakeholder], without(groups.normal))
    else commit(without(groups.core), [...without(groups.normal), stakeholder])
  }

  if (stakeholders.length === 0) {
    return (
      <EmptyState
        icon={<Users size={22} />}
        title={t('matters.context.noStakeholdersTitle')}
        hint={t('matters.context.noStakeholdersHint')}
      />
    )
  }

  const label = (row: MatterStakeholder): string =>
    row.display_name ?? row.email_normalized ?? t('matters.context.unnamed')

  return (
    <div className="space-y-3">
      <SortableBoard<MatterStakeholder>
        groups={[
          { id: 'core', items: groups.core },
          { id: 'normal', items: groups.normal, collapsed: !othersOpen }
        ]}
        getItemId={(row) => String(row.id)}
        onReorder={onBoardReorder}
        onRequestExpand={(groupId) => {
          if (groupId !== 'normal' || othersOpen) return
          setOthersOpen(true)
          setExpandedByDrag(true)
        }}
        announcements={{
          onDragStart: ({ active }) =>
            t('matters.context.reorder.grabbed', { label: label(byId.get(String(active.id))!) }),
          onDragOver: () => undefined,
          onDragEnd: ({ active }) =>
            t('matters.context.reorder.dropped', { label: label(byId.get(String(active.id))!) }),
          onDragCancel: ({ active }) =>
            t('matters.context.reorder.cancelled', { label: label(byId.get(String(active.id))!) })
        }}
        renderEmpty={(group, { isOver }) => (
          <p
            className={cn(
              'rounded-[var(--r-card)] border border-dashed px-3 py-2.5 text-meta transition-colors duration-fast',
              isOver ? 'border-ai/45 bg-ai/[0.06] text-ai' : 'border-ink-border text-ink-fg-3'
            )}
          >
            {group.id === 'core' ? t('matters.context.tierCoreEmpty') : ' '}
          </p>
        )}
        renderGroup={({ group, children, headerRef, isOver }) =>
          group.id === 'core' ? (
            <section key="core">
              <h4 className="mb-1.5 text-meta font-medium text-ink-fg-2">
                {t('matters.context.tierCore')}
                <span className="ml-1.5 tabular-nums text-ink-fg-3">{group.items.length}</span>
              </h4>
              {children}
            </section>
          ) : group.items.length > 0 || othersOpen ? (
            <section key="normal" className="mt-3">
              <button
                ref={headerRef}
                type="button"
                onClick={() => setOthersOpen((open) => !open)}
                aria-expanded={othersOpen}
                className={cn(
                  'mb-1.5 flex w-full items-center gap-1.5 rounded-[var(--r-ctl)] px-1 py-0.5 text-meta font-medium transition-colors duration-fast',
                  isOver && !othersOpen ? 'bg-ai/[0.08] text-ai' : 'text-ink-fg-2 hover:text-ink-fg'
                )}
              >
                <CollapseChevron expanded={othersOpen} />
                {t('matters.context.tierOthers')}
                <span className="tabular-nums text-ink-fg-3">{group.items.length}</span>
                {!othersOpen && isOver ? (
                  <span className="ml-1 text-aux text-ai">
                    {t('matters.context.tierDropToExpand')}
                  </span>
                ) : null}
              </button>
              {children}
            </section>
          ) : null
        }
        renderOverlay={(row) => (
          // `.reorder-card-lifted` 是仓里既有的「被拖起来的卡」阴影档（双主题，
          // index.css 与 DragReorderList 共用）—— 不要用 tailwind 的 shadow-lg，
          // 那是给亮色调的固定值，暗色下几乎看不见（`mailagent/no-heavy-shadow` 拦它）。
          <div className="reorder-card-lifted rounded-[var(--r-card)] border border-ai/35 bg-ink-2 p-3">
            {renderBody(row)}
          </div>
        )}
        renderItem={(row, { dragging, handleProps }) => {
          const isCore = (row.tier ?? MATTER_STAKEHOLDER_DEFAULT_TIER) === 'core'
          const promoteLabel = t(
            isCore ? 'matters.context.demoteStakeholder' : 'matters.context.promoteStakeholder'
          )
          return (
            <article
              className={cn(
                'group/card relative h-full rounded-[var(--r-card)] border p-3',
                row.is_waiting_on ? 'border-warn/25 bg-warn/[0.06]' : 'border-ink-border bg-ink-2',
                dragging && 'opacity-40'
              )}
            >
              <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity duration-fast ease-standard focus-within:opacity-100 group-hover/card:opacity-100">
                <button
                  type="button"
                  title={promoteLabel}
                  aria-label={promoteLabel}
                  onClick={() => switchTier(row, isCore ? 'normal' : 'core')}
                  className="rounded-[var(--r-ctl)] p-1.5 text-ink-fg-2 hover:bg-ink-3"
                >
                  {isCore ? <StarOff size={13} /> : <Star size={13} />}
                </button>
                <button
                  type="button"
                  title={t('matters.context.editStakeholder')}
                  aria-label={t('matters.context.editStakeholder')}
                  onClick={() => onEdit(row)}
                  className="rounded-[var(--r-ctl)] p-1.5 text-ink-fg-2 hover:bg-ink-3"
                >
                  <Edit3 size={13} />
                </button>
                <button
                  type="button"
                  title={t('matters.context.removeStakeholder')}
                  aria-label={t('matters.context.removeStakeholder')}
                  onClick={() => onRemove(row.id)}
                  className="rounded-[var(--r-ctl)] p-1.5 text-ink-fg-2 hover:bg-fail/10 hover:text-fail"
                >
                  <Trash2 size={13} />
                </button>
                {/* 起拖点。整卡不可拖 —— 那会把左边三颗钮的点击和文本选择一起吃掉。
                    它同时是键盘拖拽的入口（dnd-kit 的 KeyboardSensor 读 attributes）。 */}
                <button
                  type="button"
                  {...handleProps}
                  title={t('matters.context.reorder.handle')}
                  aria-label={t('matters.context.reorder.grip', { label: label(row) })}
                  className="cursor-grab rounded-[var(--r-ctl)] p-1.5 text-ink-fg-3 hover:bg-ink-3 hover:text-ink-fg active:cursor-grabbing"
                >
                  <GripVertical size={13} />
                </button>
              </div>
              {renderBody(row)}
            </article>
          )
        }}
      />
    </div>
  )
}
