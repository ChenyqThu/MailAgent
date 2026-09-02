// 邮件域 peek —— 投影变体（design.md §3：`EmailList` 挂着 j/k 等全局键盘注册与
// BatchActionBar portal，折叠态下真列表仍挂载，再渲染一份会把快捷键注册两遍）。
// 行 = 同一个 `EmailRow`；数据 = 与 `useEmailListRows` 主查询**同 key 同 fn**
// （首页 PAGE_SIZE 那份：访问过收件箱即命中缓存零请求；没访问过先骨架后到数据）。

import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { EmailRow } from '@shared/components/email/EmailRow'
import { useMailApi } from '@shared/hooks/useMailApi'
import { listOptsForView, PAGE_SIZE } from '@shared/hooks/useEmailListRows'
import { qk } from '@shared/lib/queryKeys'
import { navigateToDomain } from '@shared/navigation/domain-location'
import { useActiveEmail } from '@shared/state/active-email'
import { useEmailFilter } from '@shared/state/email-filter'
import { useMailbox } from '@shared/state/mailbox'

import { PeekEmpty, PeekHeader, PeekSkeleton, type PeekListProps } from './PeekChrome'

/** 浮层里只画前 N 行 —— peek 是「看一眼再切」，不是完整列表。 */
const MAX_ROWS = 40

export default function MailPeekList({ onNavigate }: PeekListProps): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const mailApi = useMailApi()
  const view = useEmailFilter((s) => s.view)
  const customMailbox = useEmailFilter((s) => s.customMailbox)
  const sortKey = useEmailFilter((s) => s.sortKey)
  const sortDir = useEmailFilter((s) => s.sortDir)
  const activeMailbox = useMailbox((s) => s.active)
  const activeId = useActiveEmail((s) => s.activeInternalId)
  const setActive = useActiveEmail((s) => s.setActive)

  const q = useQuery({
    queryKey: qk.emails.list(view, customMailbox, activeMailbox, PAGE_SIZE, sortKey, sortDir),
    queryFn: () =>
      mailApi.email.listEnriched(
        listOptsForView(view, PAGE_SIZE, customMailbox, { orderBy: sortKey, sortDir })
      ),
    staleTime: 5 * 60_000
  })
  const rows = (q.data ?? []).slice(0, MAX_ROWS)

  return (
    <>
      <PeekHeader
        title={t('nav.domain.mail')}
        meta={q.data !== undefined ? String(q.data.length) : undefined}
      />
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin" data-nav-peek-list="mail">
        {q.isPending ? (
          <PeekSkeleton />
        ) : rows.length === 0 ? (
          <PeekEmpty text={t('empty.state')} />
        ) : (
          rows.map((email) => (
            <EmailRow
              key={email.internal_id}
              email={email}
              selected={email.internal_id === activeId}
              onSelect={() => {
                // = 点真列表行：setActive 是邮件侧唯一桥（开对象标签 / 详情联动）。
                const title = email.subject ?? undefined
                setActive(
                  email.internal_id,
                  title !== undefined && title !== '' ? { title } : undefined
                )
                navigateToDomain(navigate, 'mail')
                onNavigate()
              }}
            />
          ))
        )}
      </div>
    </>
  )
}
