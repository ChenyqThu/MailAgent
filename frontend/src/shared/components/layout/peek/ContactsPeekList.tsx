// 通讯录域 peek —— 投影变体（design.md §3：`ContactListPane` 是工作台状态机的一部分，
// 40 个 props 里多选 / 行菜单 / 视图切换 / 治理台入口在浮层里都是空操作）。
// 行几何对齐 `ContactRow` compact 档（52px：30px monogram + 名 + 组织 / 域名 + 来往计数）；
// 数据 = `contactListPagedOptions`（与工作台同 key：上次视图 + 当前排序，空搜索）第一页。
// 点行 = `useContactNavigation.open`（⌘K / 搜索页跨页打开联系人的同一条桥）。

import { useInfiniteQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import type { ContactRowDto } from '@shared/api/types/contact'
import { readLastContactVisit } from '@shared/components/contacts/contactLastVisit'
import { readContactListPrefs } from '@shared/components/contacts/contactListPrefs'
import { contactListPagedOptions, useContactsApi } from '@shared/components/contacts/hooks'
import { useContactNavigation } from '@shared/components/contacts/navigation'
import { cn } from '@shared/lib/cn'
import { navigateToDomain } from '@shared/navigation/domain-location'

import { PeekEmpty, PeekHeader, PeekSkeleton, type PeekListProps } from './PeekChrome'

const MAX_ROWS = 60

function displayName(item: ContactRowDto): string {
  return item.display_name?.trim() || item.formal_name?.trim() || item.primary_email || '—'
}

function subtitle(item: ContactRowDto): string {
  const org = [item.organization, item.role_title].filter(Boolean).join(' · ')
  if (org) return org
  const at = item.primary_email?.indexOf('@') ?? -1
  return at >= 0 ? (item.primary_email ?? '').slice(at + 1) : ''
}

function monogram(name: string): string {
  const s = name.trim()
  if (!s) return '?'
  // 中文取末字（姓名常见「姓 + 名」，末字辨识度更高）；拉丁取首字母。
  return /^[一-鿿]/.test(s) ? s.slice(-1) : s.slice(0, 1).toUpperCase()
}

export default function ContactsPeekList({ onNavigate }: PeekListProps): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const api = useContactsApi()
  const view = readLastContactVisit()?.view ?? 'known'
  const { sort } = readContactListPrefs()
  const q = useInfiniteQuery(contactListPagedOptions(api, view, '', sort))
  const items = (q.data?.pages[0]?.items ?? []).slice(0, MAX_ROWS)
  const total = q.data?.pages[0]?.total

  return (
    <>
      <PeekHeader
        title={t('contacts.nav.title')}
        meta={total !== undefined ? String(total) : undefined}
      />
      <div
        className="flex-1 min-h-0 overflow-y-auto scrollbar-thin p-2"
        data-nav-peek-list="contacts"
      >
        {q.isPending ? (
          <PeekSkeleton />
        ) : items.length === 0 ? (
          <PeekEmpty text={t('empty.state')} />
        ) : (
          items.map((item) => {
            const name = displayName(item)
            const sub = subtitle(item)
            return (
              <button
                key={item.id}
                type="button"
                data-contact-id={item.id}
                onClick={() => {
                  useContactNavigation.getState().open(item.id)
                  navigateToDomain(navigate, 'contacts')
                  onNavigate()
                }}
                className={cn(
                  'flex h-[52px] w-full items-center gap-2.5 rounded-[var(--r-row)] pl-[13px] pr-3 text-left',
                  'transition-colors duration-fast ease-standard hover:bg-ink-3',
                  item.hidden_at != null && 'opacity-[0.55]'
                )}
              >
                <span
                  aria-hidden
                  className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-ink-5 text-[12px] font-semibold text-ink-fg"
                >
                  {monogram(name)}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-body text-ink-fg">{name}</span>
                  {sub !== '' && <span className="truncate text-meta text-ink-fg-3">{sub}</span>}
                </span>
                <span className="shrink-0 font-mono text-meta tabular-nums text-ink-fg-3">
                  {item.mail_count.toLocaleString()}
                </span>
              </button>
            )
          })
        )}
      </div>
    </>
  )
}
