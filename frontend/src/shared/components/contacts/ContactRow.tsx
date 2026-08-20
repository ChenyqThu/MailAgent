// 通讯录列表行（设计 §2.1）：定高（紧凑 52 / 宽松 68）+ react-window 行渲染器。
// 行操作：hover 只出一个「更多」IconBtn + 右键同一菜单（🔒 不放行内悬浮危险钮）；
// 多选态行首 monogram 位换 checkbox（🔒 hover 不出现任何选择控件，进入多选只有
// 行菜单「选中此条」与 ⌘/Ctrl 点行两个显式入口）。
//
// 🔴 图标纪律见 `parts.tsx` 文件头：原型里 path 缺失、实际渲染为空 svg 的图标
// （组头的 bot/megaphone/building 等）**不补** —— 那不是 owner 看过的样子。

import { useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, MoreHorizontal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { RowComponentProps } from 'react-window'

import type { ContactRowDto } from '@shared/api/types/contact'
import { cn } from '@shared/lib/cn'
import { formatMatterAgo } from '@shared/lib/matterDerive'
import { Popmenu, type PopmenuItem } from '@shared/components/ui/Popmenu'

import { Monogram } from './Monogram'
import { ContactPip, GenderPip, HiddenPip, KindPip, SelfPip, TwoWayBar } from './parts'
import type { ContactDensity, ContactListRow } from './contactListModel'

/** 治理动作的最小目标形状 —— ContactRowDto 与档案页的 detail 投影都满足它，
 *  行菜单与档案头「更多操作」共用同一套 handler（同一份 toast 与失效）。 */
export interface ContactGovernanceTarget {
  id: number
  display_name: string | null
  primary_email: string | null
  is_self: boolean
  hidden_at: number | null
  kind: 'person' | 'robot' | 'list'
}

export interface ContactRowActions {
  onOpen(item: ContactGovernanceTarget): void
  onCompose(item: ContactGovernanceTarget): void
  /** WP5「写邮件并抄送上级」（收件人 = TA、抄送 = TA 的上级）。行菜单仅在
   *  行有 manager 时渲染此项；上级主邮箱由 handler 侧解析。 */
  onComposeCc(item: ContactGovernanceTarget, managerContactId: number): void
  onSetKind(item: ContactGovernanceTarget, kind: 'person' | 'robot' | 'list'): void
  onToggleSelf(item: ContactGovernanceTarget): void
  onToggleHidden(item: ContactGovernanceTarget): void
  onEnterSelection(item: ContactGovernanceTarget): void
  onToggleCheck(item: ContactGovernanceTarget): void
}

export interface ContactRowsProps extends ContactRowActions {
  rows: ContactListRow[]
  density: ContactDensity
  selectedId: number | null
  selectionMode: boolean
  checkedIds: ReadonlySet<number>
  menuOpenId: number | null
  onMenuOpenChange(id: number | null): void
  onToggleGroup(groupKey: string): void
}

function emailDomain(email: string | null): string | null {
  const at = (email ?? '').indexOf('@')
  return at >= 0 ? (email as string).slice(at + 1) : null
}

function rowMenuItems(
  item: ContactRowDto,
  t: (key: string) => string,
  actions: ContactRowActions
): PopmenuItem[] {
  // 提前取值：闭包里保住 narrowing（spread 条件里的判空进不了 onSelect）。
  const managerId = item.manager_contact_id
  const kindActions = (['robot', 'list', 'person'] as const)
    .filter((kind) => kind !== item.kind)
    .map(
      (kind): PopmenuItem => ({
        kind: 'action',
        id: `kind-${kind}`,
        label: t(
          kind === 'robot'
            ? 'contacts.action.kindRobot'
            : kind === 'list'
              ? 'contacts.action.kindList'
              : 'contacts.action.kindPerson'
        ),
        onSelect: () => actions.onSetKind(item, kind)
      })
    )
  return [
    {
      kind: 'action',
      id: 'open',
      label: t('contacts.action.open'),
      onSelect: () => actions.onOpen(item)
    },
    {
      kind: 'action',
      id: 'compose',
      label: t('contacts.action.compose'),
      onSelect: () => actions.onCompose(item)
    },
    // WP5 邮件场景（设计 §2.2.1）：行有上级才出现（可用性判据 = manager_contact_id）。
    ...(managerId != null
      ? ([
          {
            kind: 'action',
            id: 'compose-cc',
            label: t('contacts.org.composeCc'),
            onSelect: () => actions.onComposeCc(item, managerId)
          }
        ] satisfies PopmenuItem[])
      : []),
    { kind: 'separator', id: 'sep-kind' },
    ...kindActions,
    {
      kind: 'action',
      id: 'self',
      label: t(item.is_self ? 'contacts.action.unmarkSelf' : 'contacts.action.markSelf'),
      onSelect: () => actions.onToggleSelf(item)
    },
    {
      kind: 'action',
      id: 'hide',
      label: t(item.hidden_at != null ? 'contacts.action.unhide' : 'contacts.action.hide'),
      // 原型 `capp.jsx::menuItems` 只给「隐藏」标 danger，「取消隐藏」不标
      // （它是恢复动作，染红会把「撤销」读成「更危险」）。
      ...(item.hidden_at != null ? {} : { tone: 'danger' as const }),
      onSelect: () => actions.onToggleHidden(item)
    },
    { kind: 'separator', id: 'sep-select' },
    {
      kind: 'action',
      id: 'select',
      label: t('contacts.action.select'),
      onSelect: () => actions.onEnterSelection(item)
    }
  ]
}

export function ContactVirtualRow({
  index,
  style,
  rows,
  density,
  selectedId,
  selectionMode,
  checkedIds,
  menuOpenId,
  onMenuOpenChange,
  onToggleGroup,
  ...actions
}: RowComponentProps<ContactRowsProps>): React.ReactElement {
  const { t, i18n } = useTranslation()
  // render 期不许调 Date.now()（react-hooks/purity）——挂载时取一次快照，
  // 与 MatterList/MatterDetail 同一模式（相对时间不需要行内实时刷新）。
  const [now] = useState(() => Date.now())
  // 行菜单是 portal 档（见下方），定位与 outside-click 都以这颗「更多」钮为基准。
  const moreRef = useRef<HTMLButtonElement>(null)
  const row = rows[index]
  if (!row) return <div style={style} />

  if (row.type === 'header') {
    // 原型 `clist.jsx::GroupHead`：chevron + mono 大写字距标签 + mono 计数 +
    // 一根填满余宽的细线（图标见文件头「图标纪律」：原型里一半是空 svg，整组不补）。
    return (
      <div style={style} className="px-2">
        <button
          type="button"
          onClick={() => onToggleGroup(row.key)}
          className="flex h-full w-full items-center gap-[7px] px-2 text-left text-ink-fg-2 transition-colors duration-fast ease-standard hover:text-ink-fg-1"
        >
          {row.collapsed ? (
            <ChevronRight size={11} className="shrink-0 text-ink-fg-3" />
          ) : (
            <ChevronDown size={11} className="shrink-0 text-ink-fg-3" />
          )}
          <span className="min-w-0 truncate font-mono text-[10.5px] uppercase tracking-[0.08em]">
            {row.label}
          </span>
          <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-ink-fg-3">
            {row.count}
          </span>
          <span aria-hidden className="h-px min-w-4 flex-1 bg-ink-border-soft" />
        </button>
      </div>
    )
  }

  const item = row.item
  const selected = selectedId === item.id
  const checked = checkedIds.has(item.id)
  const hidden = item.hidden_at != null
  const subtitle =
    [item.organization, item.role_title].filter(Boolean).join(' · ') ||
    emailDomain(item.primary_email) ||
    ''
  const ago =
    item.last_seen_at != null
      ? formatMatterAgo(item.last_seen_at, now, i18n.language || 'zh-CN')
      : ''
  // 原型 `clist.jsx`：我发出过 → `{sent}↑ {总数}`；从未发出 → 只报总数
  // （恒显示 `↑0` 会把「单向收到」误读成「有来往」）。
  const exchange =
    item.sent_to_count > 0
      ? `${item.sent_to_count}↑ ${item.mail_count.toLocaleString()}`
      : item.mail_count.toLocaleString()
  const menuOpen = menuOpenId === item.id
  const monogramSlot = density === 'comfortable' ? 34 : 30

  return (
    <div style={style} className="px-2">
      <div
        role="button"
        tabIndex={0}
        data-contact-id={item.id}
        onClick={(event) => {
          if (selectionMode) {
            actions.onToggleCheck(item)
            return
          }
          if (event.metaKey || event.ctrlKey) {
            actions.onEnterSelection(item)
            return
          }
          actions.onOpen(item)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            if (selectionMode) actions.onToggleCheck(item)
            else actions.onOpen(item)
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          onMenuOpenChange(item.id)
        }}
        className={cn(
          'group relative flex h-full cursor-pointer items-center gap-2.5 rounded-[var(--r-row)]',
          'pl-[13px] pr-3 transition-colors duration-fast ease-standard',
          hidden && 'opacity-[0.55]',
          selected ? 'row-selected acc-select' : 'hover:bg-ink-3'
        )}
      >
        {/* 多选态 checkbox 占 monogram 的同宽槽 —— 换控件时行内容不左右位移。 */}
        {selectionMode ? (
          <span
            className="flex shrink-0 justify-center"
            style={{ width: monogramSlot }}
            onClick={(event) => {
              event.stopPropagation()
              actions.onToggleCheck(item)
            }}
          >
            <span
              aria-hidden
              className={cn(
                'inline-flex size-4 items-center justify-center rounded-[4px] border-[1.5px]',
                checked
                  ? 'border-coral bg-coral/100 text-accent-fg'
                  : 'border-ink-fg-3 bg-transparent text-transparent'
              )}
            >
              <Check size={11} strokeWidth={3} />
            </span>
          </span>
        ) : (
          <Monogram
            displayName={item.display_name}
            primaryEmail={item.primary_email}
            kind={item.kind}
            size={monogramSlot}
            dim={hidden}
          />
        )}

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn(
                'truncate text-body font-medium text-ink-fg',
                item.display_name == null && 'italic'
              )}
            >
              {item.display_name ?? item.primary_email?.split('@')[0] ?? '—'}
            </span>
            {/* 性别贴着名字（是名字的属性），排在状态 pip 之前。未知不渲染。 */}
            <GenderPip gender={item.gender} />
            {item.is_self ? <SelfPip /> : null}
            <KindPip kind={item.kind} />
            {hidden ? <HiddenPip /> : null}
          </div>
          <div className="mt-px flex min-w-0 items-center gap-1.5">
            <span className="truncate text-meta text-ink-fg-2">{subtitle}</span>
            {item.email_count > 1 ? (
              <ContactPip>{t('contacts.badge.emails', { n: item.email_count })}</ContactPip>
            ) : null}
          </div>
          {density === 'comfortable' && item.profile_summary ? (
            <div className="mt-0.5 truncate text-micro text-ink-fg-3">{item.profile_summary}</div>
          ) : null}
        </div>

        {/* 🔴 右列恒显示：原型没有 hover 抹掉行数据这回事。 */}
        <div className="flex shrink-0 flex-col items-end gap-[3px]">
          <span className="font-mono text-micro tabular-nums text-ink-fg-2">{exchange}</span>
          <TwoWayBar sent={item.sent_to_count} total={item.mail_count} className="w-[34px]" />
          <span className="text-micro text-ink-fg-3">{ago}</span>
        </div>

        {/* hover 唯一动作钮：更多（右键同一菜单）。占位恒在、只淡入淡出 ——
            绝对定位浮在行上会盖住右列数据。 */}
        <span className="-mr-1.5 shrink-0">
          <button
            ref={moreRef}
            type="button"
            aria-label={t('contacts.row.more')}
            onClick={(event) => {
              event.stopPropagation()
              onMenuOpenChange(menuOpen ? null : item.id)
            }}
            className={cn(
              'grid size-6 place-items-center rounded-[var(--r-ctl)] text-ink-fg-2 opacity-0',
              'transition-opacity duration-fast ease-standard',
              'hover:bg-ink-fg/[0.08] hover:text-ink-fg focus-visible:opacity-100 group-hover:opacity-100',
              menuOpen && 'opacity-100'
            )}
          >
            <MoreHorizontal size={13} />
          </button>
        </span>
        {/* 🔴 portal 档不是可选项：列表是 react-window 虚拟滚动，行是**无 z-index**
            的绝对定位兄弟节点 —— 行内 absolute 的菜单会被它后面每一行按 DOM 顺序
            画在上面（头像 / 姓名 / TwoWayBar 全糊在菜单上，读起来就是「半透明、
            根本看不见」），贴底的行还会被滚动容器整块裁掉。原型 cui.jsx 的 Menu
            从一开始就是 createPortal + fixed，本档即回到原型。 */}
        {menuOpen ? (
          <Popmenu
            open
            onClose={() => onMenuOpenChange(null)}
            ariaLabel={t('contacts.row.more')}
            items={rowMenuItems(item, t, actions)}
            triggerRef={moreRef}
            portal
            align="end"
            width={208}
            // 这份菜单最多 10 行（8 项 + 2 分隔线）≈ 327px，基座默认的 288px 上限
            // 正好把最后一项「选中此条」压进内滚区 —— 一屏放得下却要滚才看得到。
            // 抬到 400 让它整块展开；真放不下时基座仍按「面板顶到视口底」二次夹取。
            maxHeight={400}
          />
        ) : null}
      </div>
    </div>
  )
}
