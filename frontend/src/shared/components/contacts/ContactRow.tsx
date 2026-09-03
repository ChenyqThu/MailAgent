// 通讯录列表行（设计 §2.1）：定高（紧凑 52 / 宽松 68）+ react-window 行渲染器。
// 行上没有任何操作控件：点行即打开人物页，治理 / 写邮件全部走档案页右上角
// 「更多操作」（🔒 不放行内悬浮危险钮）。
//
// 🔴 图标纪律见 `parts.tsx` 文件头：原型里 path 缺失、实际渲染为空 svg 的图标
// （组头的 bot/megaphone/building 等）**不补** —— 那不是 owner 看过的样子。

import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { RowComponentProps } from 'react-window'

import { cn } from '@shared/lib/cn'
import { formatMatterAgo } from '@shared/lib/matterDerive'

import { Monogram } from './Monogram'
import { ContactPip, GenderPip, HiddenPip, KindPip, SelfPip, TwoWayBar } from './parts'
import type { ContactDensity, ContactListRow } from './contactListModel'

/** 治理动作的最小目标形状 —— ContactRowDto 与档案页的 detail 投影都满足它，
 *  档案头「更多操作」按它调 handler（同一份 toast 与失效）。 */
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
  onSetKind(item: ContactGovernanceTarget, kind: 'person' | 'robot' | 'list'): void
  onToggleSelf(item: ContactGovernanceTarget): void
  onToggleHidden(item: ContactGovernanceTarget): void
}

export interface ContactRowsProps extends ContactRowActions {
  rows: ContactListRow[]
  density: ContactDensity
  selectedId: number | null
  onToggleGroup(groupKey: string): void
}

function emailDomain(email: string | null): string | null {
  const at = (email ?? '').indexOf('@')
  return at >= 0 ? (email as string).slice(at + 1) : null
}

export function ContactVirtualRow({
  index,
  style,
  rows,
  density,
  selectedId,
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
  const monogramSlot = density === 'comfortable' ? 34 : 30

  return (
    <div style={style} className="px-2">
      <div
        role="button"
        tabIndex={0}
        data-contact-id={item.id}
        onClick={() => actions.onOpen(item)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            actions.onOpen(item)
          }
        }}
        className={cn(
          'relative flex h-full cursor-pointer items-center gap-2.5 rounded-[var(--r-row)]',
          'pl-[13px] pr-3 transition-colors duration-fast ease-standard',
          hidden && 'opacity-[0.55]',
          selected ? 'row-selected acc-select' : 'hover:bg-ink-3'
        )}
      >
        <Monogram
          displayName={item.display_name}
          primaryEmail={item.primary_email}
          kind={item.kind}
          size={monogramSlot}
          dim={hidden}
        />

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
      </div>
    </div>
  )
}
