// 通讯录列表行（设计 §2.1）：定高（紧凑 52 / 宽松 68）+ react-window 行渲染器。
// 行操作：hover 只出一个「更多」IconBtn + 右键同一菜单（🔒 不放行内悬浮危险钮）；
// 多选态行首 monogram 位换 checkbox（🔒 hover 不出现任何选择控件，进入多选只有
// 行菜单「选中此条」与 ⌘/Ctrl 点行两个显式入口）。

import { useState } from 'react'
import { Check, ChevronDown, ChevronRight, MoreHorizontal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { RowComponentProps } from 'react-window'

import type { ContactRowDto } from '@shared/api/types/contact'
import { cn } from '@shared/lib/cn'
import { formatMatterAgo } from '@shared/lib/matterDerive'
import { Popmenu, type PopmenuItem } from '@shared/components/ui/Popmenu'

import { Monogram } from './Monogram'
import { HiddenPip, KindPip, SelfPip, TwoWayBar } from './parts'
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
  const row = rows[index]
  if (!row) return <div style={style} />

  if (row.type === 'header') {
    return (
      <div style={style} className="px-2">
        <button
          type="button"
          onClick={() => onToggleGroup(row.key)}
          className="flex h-full w-full items-center gap-1.5 px-2 text-left text-meta font-medium text-ink-fg-2 hover:text-ink-fg-1"
        >
          {row.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <span className="min-w-0 flex-1 truncate">{row.label}</span>
          <span className="font-mono text-micro tabular-nums text-ink-fg-3">{row.count}</span>
        </button>
      </div>
    )
  }

  const item = row.item
  const selected = selectedId === item.id
  const checked = checkedIds.has(item.id)
  const subtitle =
    [item.organization, item.role_title].filter(Boolean).join(' · ') ||
    emailDomain(item.primary_email) ||
    ''
  const ago =
    item.last_seen_at != null
      ? formatMatterAgo(item.last_seen_at, now, i18n.language || 'zh-CN')
      : ''
  const menuOpen = menuOpenId === item.id

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
          'group relative flex h-full cursor-default items-center gap-2.5 rounded-[var(--r-row)] px-2',
          selected ? 'row-selected acc-select' : 'hover:bg-ink-3'
        )}
      >
        {selectionMode ? (
          <span
            aria-hidden
            className={cn(
              'inline-flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border',
              checked
                ? 'border-coral bg-coral/100 text-accent-fg'
                : 'border-ink-border bg-transparent text-transparent'
            )}
          >
            <Check size={12} strokeWidth={3} />
          </span>
        ) : (
          <Monogram
            displayName={item.display_name}
            primaryEmail={item.primary_email}
            kind={item.kind}
            size={density === 'comfortable' ? 34 : 30}
          />
        )}

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn(
                'truncate text-body text-ink-fg',
                item.display_name == null && 'italic text-ink-fg-1'
              )}
            >
              {item.display_name ?? item.primary_email?.split('@')[0] ?? '—'}
            </span>
            {item.is_self ? <SelfPip /> : null}
            <KindPip kind={item.kind} />
            {item.hidden_at != null ? <HiddenPip /> : null}
          </div>
          <div className="truncate text-meta text-ink-fg-2">{subtitle}</div>
          {density === 'comfortable' && item.profile_summary ? (
            <div className="truncate text-meta text-ink-fg-3">{item.profile_summary}</div>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="font-mono text-micro tabular-nums text-ink-fg-2 group-hover:opacity-0">
            ↑{item.sent_to_count} <span className="text-ink-fg-3">{item.mail_count}</span>
          </span>
          <TwoWayBar
            sent={item.sent_to_count}
            total={item.mail_count}
            className="w-14 group-hover:opacity-0"
          />
          <span className="font-mono text-micro tabular-nums text-ink-fg-3 group-hover:opacity-0">
            {ago}
          </span>
        </div>

        {/* hover 唯一动作钮：更多（右键同一菜单）。 */}
        <button
          type="button"
          aria-label={t('contacts.row.more')}
          onClick={(event) => {
            event.stopPropagation()
            onMenuOpenChange(menuOpen ? null : item.id)
          }}
          className={cn(
            'absolute right-2 top-1/2 -translate-y-1/2 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 p-1 text-ink-fg-2 opacity-0 transition-opacity hover:text-ink-fg focus-visible:opacity-100 group-hover:opacity-100',
            menuOpen && 'opacity-100'
          )}
        >
          <MoreHorizontal size={14} />
        </button>
        {menuOpen ? (
          <Popmenu
            open
            onClose={() => onMenuOpenChange(null)}
            ariaLabel={t('contacts.row.more')}
            items={rowMenuItems(item, t, actions)}
            align="end"
            anchorClassName="absolute right-2 top-full z-30"
            width={220}
          />
        ) : null}
      </div>
    </div>
  )
}
