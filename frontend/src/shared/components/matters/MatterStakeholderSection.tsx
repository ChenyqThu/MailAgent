// 干系人区（S2，v60）—— 核心 / 其他两组，其他默认折叠，两组各自可拖拽重排。
//
// 为什么从 grid 卡片改成单列可拖行：拖拽基座 `DragReorderList` 是**垂直列表**
// （slot 高度 + y 位移 + FLIP）。grid 里拖拽要二维命中计算，基座做不到，而自己写一套
// 正是 Popmenu 那条教训（「凭印象重写，owner dogfood 判交互质感一坨屎」）说过别走的路。
// 单列保留了原卡片的**全部信息**（头像 / 姓名 / 组织 / 角色 / 等待态 / 最近联系 /
// relationship / hover 动作），只是从 2-3 列变成 1 列。
// ⚠️ 这是本批唯一一处**没有原型权威**的视觉决策（分层与拖拽都是新需求，
//    `matters 2/` 的设计稿里没有它们）—— owner 若要保留 grid，改法是把拖拽换成
//    「上移 / 下移 / 设为核心」的行内动作，不是在 grid 里硬做拖拽。
//
// 🔴 换组（核心 ⇄ 其他）走**行内动作按钮**，不是跨组拖拽：`DragReorderList` 是单列表内
//    重排，跨列表拖需要另一套命中测试与两份 slot 几何。硬做等于重写基座内核 —— 而且
//    「其他」组默认折叠，往一个收起来的区里拖本来就没有落点。按钮是这里更诚实的形态。
//
// 🔴 一次拖拽 / 一次换组都发**一个** reorder 请求（`api.reorderStakeholders`）。逐条
//    patch 的话第 2 个必撞 E_VERSION_CONFLICT —— 动一行会同时改它和让位的所有行。

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Edit3, Star, StarOff, Trash2, Users } from 'lucide-react'

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
import { DragReorderList, type ReorderItem } from '@shared/components/ui/DragReorderList'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { toastError } from '@shared/state/toast'

import { useMattersApi } from './hooks'
import { buildReorderPayload, splitStakeholdersByTier } from './matterStakeholderTier'
import { useMatterMutation } from './matterMutation'

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
  const { core, normal } = useMemo(() => splitStakeholdersByTier(stakeholders), [stakeholders])
  // 🔴 「还没人被标核心」时「其他」默认**展开**：存量事项的干系人全是 normal（tier 是
  // v60 才有的列），一律折叠等于打开事项一个干系人都看不见 —— 那不是「非核心默认折叠」
  // 的意图，是把整个区藏起来。只在初次挂载时判：core 从空变非空不该当场把用户正在看的
  // 列表收起来。
  const [othersOpen, setOthersOpen] = useState(() => core.length === 0)
  const byId = useMemo(
    () => new Map(stakeholders.map((stakeholder) => [String(stakeholder.id), stakeholder])),
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

  const commit = (nextCore: MatterStakeholder[], nextNormal: MatterStakeholder[]): void => {
    reorder.mutate(buildReorderPayload(nextCore, nextNormal))
  }

  const toReorderItems = (rows: readonly MatterStakeholder[]): ReorderItem[] =>
    rows.map((stakeholder) => ({
      id: String(stakeholder.id),
      label:
        stakeholder.display_name ?? stakeholder.email_normalized ?? t('matters.context.unnamed')
    }))

  /** 换组：把这个人从当前组挪到另一组的**末尾**，其余相对次序不动。 */
  const switchTier = (stakeholder: MatterStakeholder, to: MatterStakeholderTier): void => {
    const withoutIt = (rows: MatterStakeholder[]): MatterStakeholder[] =>
      rows.filter((row) => row.id !== stakeholder.id)
    if (to === 'core') commit([...withoutIt(core), stakeholder], withoutIt(normal))
    else commit(withoutIt(core), [...withoutIt(normal), stakeholder])
  }

  const renderRow = (item: ReorderItem): React.ReactNode => {
    const stakeholder = byId.get(item.id)
    if (!stakeholder) return null
    const isCore = (stakeholder.tier ?? MATTER_STAKEHOLDER_DEFAULT_TIER) === 'core'
    return (
      <div className="group/row relative">
        {renderBody(stakeholder)}
        <div className="absolute right-0 top-0 flex gap-1 opacity-0 transition-opacity duration-fast ease-standard focus-within:opacity-100 group-hover/row:opacity-100">
          <button
            type="button"
            title={t(
              isCore ? 'matters.context.demoteStakeholder' : 'matters.context.promoteStakeholder'
            )}
            aria-label={t(
              isCore ? 'matters.context.demoteStakeholder' : 'matters.context.promoteStakeholder'
            )}
            onClick={() => switchTier(stakeholder, isCore ? 'normal' : 'core')}
            className="rounded-[var(--r-ctl)] p-1.5 text-ink-fg-2 hover:bg-ink-3"
          >
            {isCore ? <StarOff size={13} /> : <Star size={13} />}
          </button>
          <button
            type="button"
            title={t('matters.context.editStakeholder')}
            aria-label={t('matters.context.editStakeholder')}
            onClick={() => onEdit(stakeholder)}
            className="rounded-[var(--r-ctl)] p-1.5 text-ink-fg-2 hover:bg-ink-3"
          >
            <Edit3 size={13} />
          </button>
          <button
            type="button"
            title={t('matters.context.removeStakeholder')}
            aria-label={t('matters.context.removeStakeholder')}
            onClick={() => onRemove(stakeholder.id)}
            className="rounded-[var(--r-ctl)] p-1.5 text-ink-fg-2 hover:bg-fail/10 hover:text-fail"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    )
  }

  const messages = {
    listLabel: t('matters.context.stakeholders'),
    grip: (label: string, pos: number, count: number, grabbed: boolean) =>
      t('matters.context.reorder.grip', { label, pos, count }) + (grabbed ? '' : ''),
    grabbed: (label: string, pos: number, count: number) =>
      t('matters.context.reorder.grabbed', { label, pos, count }),
    dropped: (label: string, pos: number, count: number) =>
      t('matters.context.reorder.dropped', { label, pos, count }),
    moved: (label: string, pos: number, count: number) =>
      t('matters.context.reorder.moved', { label, pos, count }),
    cancelled: (label: string) => t('matters.context.reorder.cancelled', { label })
  }

  const renderGroup = (
    rows: MatterStakeholder[],
    onReorder: (next: MatterStakeholder[]) => void
  ): React.ReactElement => (
    <DragReorderList
      items={toReorderItems(rows)}
      onReorder={(next) => {
        const mapped = next
          .map((entry) => byId.get(entry.id))
          .filter((entry): entry is MatterStakeholder => entry != null)
        onReorder(mapped)
      }}
      renderItem={renderRow}
      rowClassName="items-start border border-ink-border bg-ink-2 py-3 pr-3"
      messages={messages}
      className="space-y-1.5"
    />
  )

  if (stakeholders.length === 0) {
    return (
      <EmptyState
        icon={<Users size={22} />}
        title={t('matters.context.noStakeholdersTitle')}
        hint={t('matters.context.noStakeholdersHint')}
      />
    )
  }

  return (
    <div className="space-y-3">
      <section>
        <h4 className="mb-1.5 text-meta font-medium text-ink-fg-2">
          {t('matters.context.tierCore')}
          <span className="ml-1.5 tabular-nums text-ink-fg-3">{core.length}</span>
        </h4>
        {core.length > 0 ? (
          renderGroup(core, (next) => commit(next, normal))
        ) : (
          <p className="rounded-[var(--r-card)] border border-dashed border-ink-border px-3 py-2.5 text-meta text-ink-fg-3">
            {t('matters.context.tierCoreEmpty')}
          </p>
        )}
      </section>

      {normal.length > 0 ? (
        <section>
          <button
            type="button"
            onClick={() => setOthersOpen((open) => !open)}
            aria-expanded={othersOpen}
            className="mb-1.5 flex w-full items-center gap-1.5 text-meta font-medium text-ink-fg-2 hover:text-ink-fg"
          >
            <CollapseChevron expanded={othersOpen} />
            {t('matters.context.tierOthers')}
            <span className={cn('tabular-nums', othersOpen ? 'text-ink-fg-3' : 'text-ink-fg-2')}>
              {normal.length}
            </span>
          </button>
          {othersOpen ? renderGroup(normal, (next) => commit(core, next)) : null}
        </section>
      ) : null}
    </div>
  )
}
