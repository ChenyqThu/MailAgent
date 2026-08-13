import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { BriefcaseBusiness, ChevronRight } from 'lucide-react'

import type { LinkedMatterSummary } from './matterResource'
import { useMatterNavigation } from './navigation'

/**
 * G-25 —— 邮件正文顶部的归属 info 卡（设计 create.jsx:321-333）：
 * 「这封邮件属于事项 X · 整条会话已订阅」，点击跳事项。
 *
 * 两态文案按**实际订阅态**写（设计的 mock 恒写已订阅）：thread 订阅 active → 已订阅；
 * paused → 已暂停；只挂了单封（无订阅行）→ 如实说「仅关联了这封邮件」。
 * 数据 = EmailDetail 既有的归属反查通道（`GET /links/by-resource`），本组件零请求 ——
 * 列表/详情性能铁律：不许每封邮件多发独立轮询。
 */
export function MatterBelongsCard({
  entries
}: {
  entries: readonly LinkedMatterSummary[]
}): React.ReactElement | null {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const openMatter = useMatterNavigation((state) => state.open)
  const first = entries[0]
  if (!first) return null
  const subscription = first.subscription
  const subCopy =
    subscription?.sub_state === 'active'
      ? t('matters.capture.threadSubscribed')
      : subscription?.sub_state === 'paused'
        ? t('matters.capture.threadPaused')
        : t('matters.capture.singleLinked')

  return (
    <button
      type="button"
      onClick={() => {
        openMatter(first.publicId)
        void navigate({ to: '/matters' })
      }}
      className="mt-4 flex w-full items-center gap-2.5 rounded-[var(--r-card)] border border-info/25 bg-info/[0.06] px-3 py-2.5 text-left transition-colors duration-fast ease-standard hover:bg-info/[0.1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
    >
      <BriefcaseBusiness size={14} className="shrink-0 text-info" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-aux text-ink-fg">
          {t('matters.capture.belongsPrefix')} <b className="font-semibold">{first.title}</b>
          {entries.length > 1 ? (
            <span className="ml-1.5 font-mono text-micro text-ink-fg-3">+{entries.length - 1}</span>
          ) : null}
        </span>
        <span className="mt-0.5 block truncate text-meta text-ink-fg-2">{subCopy}</span>
      </span>
      <ChevronRight size={14} className="shrink-0 text-ink-fg-3" />
    </button>
  )
}
