// 搜人列表核心组件（task 08-13 WP3，设计 §2.5 的行形态）。
//
// 🔴 纯展示：数据由父组件取（contactsApi.list 一次批量 + 服务端 q —— 任一锚点
// 邮箱可搜），这里只管搜索框 + 行渲染 + 选中态。这样 merge 步骤 1（单选）、
// 干系人 picker（多选 + taken 置灰）、WP5 指定上级都能共用，不做死组件。
// 行内容：Monogram / 姓名（裸邮箱 D8 斜体降级）/ 组织·职务 / 主邮箱 + 其余
// 计数 / 画像摘要一行（WP6 前恒空不占位）/ 往来计数。

import { Check, Loader2, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { ContactRowDto } from '@shared/api/types/contact'
import { cn } from '@shared/lib/cn'

import { Monogram } from './Monogram'
import { ContactPip } from './parts'

export interface PersonPickerProps {
  items: readonly ContactRowDto[]
  loading?: boolean
  search: string
  onSearchChange(value: string): void
  searchPlaceholder: string
  /** 单选（merge 步骤 1）：点行即 onPick。多选：checkbox 语义走 onToggle。 */
  mode: 'single' | 'multi'
  selectedIds?: ReadonlySet<number>
  onToggle?(row: ContactRowDto): void
  onPick?(row: ContactRowDto): void
  /** 置灰打勾禁选（已在事项中）。 */
  takenIds?: ReadonlySet<number>
  takenLabel?: string
  /** 列表上方插槽（虚线占位 / 「以这个邮箱新建」行）。 */
  aboveList?: React.ReactNode
  belowList?: React.ReactNode
  empty?: React.ReactNode
}

export function PersonPicker({
  items,
  loading = false,
  search,
  onSearchChange,
  searchPlaceholder,
  mode,
  selectedIds,
  onToggle,
  onPick,
  takenIds,
  takenLabel,
  aboveList,
  belowList,
  empty
}: PersonPickerProps): React.ReactElement {
  return (
    <div className="flex min-h-0 flex-col gap-2.5">
      <div className="relative shrink-0">
        <Search
          size={13}
          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-fg-3"
        />
        <input
          autoFocus
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          className="h-8 w-full rounded-[var(--r-ctl)] border border-ink-border bg-ink-1 pl-7 pr-2 text-body text-ink-fg outline-none placeholder:text-ink-fg-3 focus:border-coral/50"
        />
      </div>
      {aboveList}
      {loading && items.length === 0 ? (
        <div className="flex items-center gap-2 rounded-[var(--r-card)] border border-ink-border bg-ink-2/50 px-3 py-2.5 text-meta text-ink-fg-3">
          <Loader2 size={13} className="animate-spin" />
        </div>
      ) : items.length === 0 ? (
        empty ?? null
      ) : (
        <div className="min-h-0 overflow-y-auto rounded-[var(--r-card)] border border-ink-border scrollbar-thin">
          {items.map((row) => {
            const taken = takenIds?.has(row.id) ?? false
            const picked = selectedIds?.has(row.id) ?? false
            return (
              <PersonPickerRow
                key={row.id}
                row={row}
                mode={mode}
                picked={picked}
                taken={taken}
                takenLabel={takenLabel}
                onSelect={() => {
                  if (taken) return
                  if (mode === 'single') onPick?.(row)
                  else onToggle?.(row)
                }}
              />
            )
          })}
        </div>
      )}
      {belowList}
    </div>
  )
}

function PersonPickerRow({
  row,
  mode,
  picked,
  taken,
  takenLabel,
  onSelect
}: {
  row: ContactRowDto
  mode: 'single' | 'multi'
  picked: boolean
  taken: boolean
  takenLabel?: string
  onSelect(): void
}): React.ReactElement {
  const { t } = useTranslation()
  const bare = !row.display_name
  const localPart = row.primary_email?.split('@')[0] ?? '—'
  const orgLine = [row.organization, row.role_title].filter(Boolean).join(' · ')
  const extraEmails = Math.max(0, row.email_count - 1)
  const exchange =
    row.sent_to_count > 0
      ? `${row.sent_to_count}↑ ${row.mail_count.toLocaleString()}`
      : row.mail_count.toLocaleString()
  return (
    <button
      type="button"
      disabled={taken}
      aria-pressed={mode === 'multi' ? picked : undefined}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2.5 border-t border-ink-border px-3 py-2 text-left first:border-t-0',
        'transition-colors duration-fast ease-standard',
        taken
          ? 'cursor-default opacity-55'
          : picked
            ? 'bg-coral/[0.07] shadow-[inset_2px_0_0_0_rgb(var(--c-accent))]'
            : 'hover:bg-ink-3/60'
      )}
    >
      {/* 首位是一个 30px 固定槽（原型 `cpicker.jsx::PickerRow`）：
          已在事项中 → 勾 · 已选 → checkbox · 其余 → Monogram。三态换控件不位移。 */}
      <span className="grid w-[30px] shrink-0 place-items-center">
        {taken ? (
          <Check size={14} strokeWidth={2.5} aria-hidden className="text-ok" />
        ) : picked ? (
          <span
            aria-hidden
            className="flex size-4 items-center justify-center rounded-[4px] border-[1.5px] border-coral bg-coral/100 text-accent-fg"
          >
            <Check size={11} strokeWidth={3} />
          </span>
        ) : (
          <Monogram
            displayName={row.display_name}
            primaryEmail={row.primary_email}
            kind={row.kind}
            size={28}
          />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              'truncate text-body font-medium text-ink-fg',
              bare && 'font-normal italic text-ink-fg-1'
            )}
          >
            {row.display_name ?? localPart}
          </span>
          {orgLine ? <span className="truncate text-meta text-ink-fg-2">{orgLine}</span> : null}
          {row.email_count > 1 ? (
            <ContactPip>{t('contacts.badge.emails', { n: row.email_count })}</ContactPip>
          ) : null}
          {taken && takenLabel ? <ContactPip tone="ok">{takenLabel}</ContactPip> : null}
        </span>
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate font-mono text-micro text-ink-fg-3">
            {row.primary_email ?? '—'}
          </span>
          {extraEmails > 0 ? (
            <span className="shrink-0 font-mono text-micro text-ink-fg-3">+{extraEmails}</span>
          ) : null}
        </span>
        {row.profile_summary ? (
          <span className="block truncate text-meta text-ink-fg-2">{row.profile_summary}</span>
        ) : null}
      </span>
      {!taken ? (
        <span className="shrink-0 font-mono text-micro tabular-nums text-ink-fg-3">{exchange}</span>
      ) : null}
    </button>
  )
}
