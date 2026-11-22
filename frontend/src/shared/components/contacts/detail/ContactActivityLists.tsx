import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Inbox, Send, UsersRound } from 'lucide-react'

import { CONTACT_MAIL_DIRECTIONS } from '@shared/api/types/contact'
import type { ContactMailDirection } from '@shared/api/types/contact'
import type { MatterStatus } from '@shared/api/types/matter'
import { MatterPip } from '@shared/components/matters/MatterPip'
import { MATTER_STATUS_ICONS, MATTER_STATUS_TONES } from '@shared/components/matters/matterVocab'
import { useMatterNavigation } from '@shared/components/matters/navigation'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { cn } from '@shared/lib/cn'
import { formatMatterAgo } from '@shared/lib/matterDerive'
import { useActiveEmail } from '@shared/state/active-email'

import { useContactMails, useContactMatters } from '../hooks'
import { SecHead } from '../parts'

// ── 关联邮件 ──────────────────────────────────────────────────────────────────

/** 🔴 `direction` 由 `ContactDetail` 持有（waterfall 拆解）：顶层要用同一个方向声明同一条
 *  查询，两处的 queryKey 才是同一个 —— 状态留在这里的话顶层只能猜一个方向，猜错就是白发一次。 */
export function ContactMailList({
  contactId,
  direction,
  onDirectionChange
}: {
  contactId: number
  direction: ContactMailDirection
  onDirectionChange(direction: ContactMailDirection): void
}): React.ReactElement {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const setActiveEmail = useActiveEmail((state) => state.setActive)
  // render 期不许调 Date.now()（react-hooks/purity）—— 挂载时取一次快照。
  const [now] = useState(() => Date.now())
  const query = useContactMails(contactId, direction)
  const items = useMemo(() => (query.data?.pages ?? []).flatMap((page) => page.items), [query.data])
  const total = query.data?.pages[0]?.total ?? 0
  const remaining = Math.max(0, total - items.length)
  return (
    <section>
      <SecHead
        title={t('contacts.section.mails')}
        count={total}
        right={
          <SegmentedControl<ContactMailDirection>
            size="sm"
            ariaLabel={t('contacts.section.mails')}
            value={direction}
            onChange={(next) => onDirectionChange(next)}
            options={CONTACT_MAIL_DIRECTIONS.map((value) => ({
              value,
              label: t(`contacts.mail.filter.${value}`)
            }))}
          />
        }
      />
      {items.length === 0 && !query.isPending ? (
        <div className="py-3 text-meta text-ink-fg-3">{t('contacts.mail.empty')}</div>
      ) : (
        <div className="flex flex-col">
          {items.map((mail) => {
            // 方向由后端给（自有地址集的权威在 resolve_self_addresses，前端再算
            // 一遍就是第二个真源）；cc 只作行内次要标记，不参与方向判定。
            const ccOnly =
              mail.direction !== 'from_them' &&
              mail.roles.includes('cc') &&
              !mail.roles.includes('to')
            const RoleIcon =
              mail.direction === 'from_them'
                ? Inbox
                : mail.direction === 'from_me'
                  ? Send
                  : UsersRound
            const roleKey = `contacts.mail.filter.${mail.direction}`
            return (
              <button
                key={mail.internal_id}
                type="button"
                onClick={() => {
                  // 🔴 `{ navTarget: true }` 与画像卡的证据钮同因：往来邮件按定义大多在
                  // 收件箱列表当前加载窗口之外，不豁免的话 useEmailListRows 的 active-reset
                  // 会立刻把 active 抢回列表第一封（dogfood 报的「点击也无法跳转」）。
                  setActiveEmail(mail.internal_id, { navTarget: true })
                  void navigate({ to: '/' })
                }}
                className="flex w-full items-start gap-2.5 rounded-[var(--r-row)] px-2.5 py-2 text-left transition-colors duration-fast ease-standard hover:bg-ink-fg/[0.035]"
              >
                <RoleIcon size={13} aria-hidden className="mt-0.5 shrink-0 text-ink-fg-3" />
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  {!mail.is_read ? (
                    <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-coral/100" />
                  ) : null}
                  <span
                    className={cn(
                      'min-w-0 truncate text-body text-ink-fg',
                      mail.is_read ? 'font-medium' : 'font-semibold'
                    )}
                  >
                    {mail.subject || '—'}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-[3px]">
                  <span className="text-micro tabular-nums text-ink-fg-3">
                    {mail.seen_at != null
                      ? formatMatterAgo(mail.seen_at, now, i18n.language || 'zh-CN')
                      : ''}
                  </span>
                  <span className="text-[10.5px] leading-none text-ink-fg-3">
                    {ccOnly ? `${t(roleKey)} · ${t('contacts.mail.ccMark')}` : t(roleKey)}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      )}
      {query.hasNextPage ? (
        <button
          type="button"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
          className="ml-2.5 mt-1.5 self-start text-meta text-coral transition-opacity duration-fast ease-standard hover:opacity-80 disabled:opacity-50"
        >
          {t('contacts.mail.more', { n: remaining })}
        </button>
      ) : null}
    </section>
  )
}

// ── 关联事项 ──────────────────────────────────────────────────────────────────

export function ContactMatterList({ contactId }: { contactId: number }): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const openMatter = useMatterNavigation((state) => state.open)
  const query = useContactMatters(contactId, true)
  const items = query.data?.items ?? []
  return (
    <section>
      <SecHead title={t('contacts.section.matters')} count={items.length} />
      {items.length === 0 ? (
        <div className="py-2 text-meta text-ink-fg-3">{t('contacts.matters.empty')}</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {items.map((matter) => {
            const status = matter.status as MatterStatus
            const StatusIcon = MATTER_STATUS_ICONS[status]
            return (
              <button
                key={matter.matter_id}
                type="button"
                onClick={() => {
                  openMatter(matter.public_id)
                  void navigate({ to: '/matters' })
                }}
                className="flex w-full items-center gap-2.5 rounded-[var(--r-row)] border border-ink-border bg-ink-2 px-2.5 py-2 text-left transition-colors duration-fast ease-standard hover:border-ink-fg-3"
              >
                {StatusIcon ? (
                  <MatterPip tone={MATTER_STATUS_TONES[status] ?? 'neutral'} icon={StatusIcon}>
                    {t(`matters.status.${matter.status}`, { defaultValue: matter.status })}
                  </MatterPip>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-body text-ink-fg">
                  {matter.title}
                </span>
                {matter.role ? (
                  <span className="shrink-0 truncate text-meta text-ink-fg-3">{matter.role}</span>
                ) : null}
                <ChevronRight size={13} className="shrink-0 text-ink-fg-3" />
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}
