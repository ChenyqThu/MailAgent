// 预览面的「这份资料和别的东西是什么关系」一行（dogfood 0903 owner 反馈第 2 件；
// design §9.2 最后一条「**反向**：资料库文件详情显示「关联的事项」…P2 可选」）。
//
// 只画**数据里已经有的**关联，一条都不新造：
//   · 派生自 X —— `source='derived'` 的 `source_ref` 就是原文件 id（F2，原先是独立的
//     `DerivedFromChip`，现在收进这一行，免得同一类信息分两处画）；
//   · 来源邮件 —— 投影行自带 `internal_id`；「另存到资料库」之后的库内行只剩
//     `source_ref`（= 附件 id），拿它走**既有的**只读兄弟端点 `/library/attachment/{id}`
//     回补邮件身份，不加端点；
//   · 来源会话 —— `source='chat'` 的 `source_ref` 前半段是 session id；
//   · 关联的事项 —— 反查走**既有的** `GET /matters/links/by-resource`（邮件详情的归属卡
//     用的是同一条通道），键是 `library:{id}`。
//
// 🔴 三个跳转全部复用既有导航，本组件不新造任何一条：邮件抄 `CommandPalette::activateHit`，
// 会话与事项抄 `TodaySurface` 的两条（park intent + navigate）。
// 🔴 邮件那条**不知道 mailbox** —— 库文件行上没有这个字段，所以恒落 `viewForMailbox(null)`
// 的 'all' 跨邮箱视图（而不是猜一个收件箱，猜错了行就不在列表里）。

import { useMemo, type ReactElement, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { BriefcaseBusiness, FileText, Mail, MessagesSquare } from 'lucide-react'

import type { LibraryFile, LibraryFileDetail } from '@shared/api/types/library'
import { useMattersApi, useMattersEnabled } from '@shared/components/matters/hooks'
import { mergeMatterResourceLinkHits } from '@shared/components/matters/matterResource'
import { useMatterNavigation } from '@shared/components/matters/navigation'
import { qk } from '@shared/lib/queryKeys'
import { viewForMailbox } from '@shared/lib/mailboxSemantics'
import { useActiveEmail } from '@shared/state/active-email'
import { useEmailFilter } from '@shared/state/email-filter'
import { requestOpenAgentSession } from '@shared/state/ai-chat-panel'

import {
  chatSourceSessionId,
  derivedSourceId,
  displayName,
  libraryResourceKey,
  mailSourceAttachmentId,
  type LibraryFileRef
} from './fileMeta'
import { useLibraryFileQuery } from './hooks'

/** 一枚关联胶囊。形状沿用原先 `DerivedFromChip` 的那一枚（rounded-full + ink-2 底），
 *  所有关联共用同一种视觉，别按类型各长一个样。 */
function RelationChip({
  icon,
  children,
  title,
  testId,
  onClick
}: {
  icon: ReactNode
  children: ReactNode
  title?: string
  testId?: string
  onClick(): void
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      data-testid={testId}
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-ink-border bg-ink-2 px-2.5 py-1 text-meta text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
    >
      <span className="grid shrink-0 place-items-center text-ink-fg-3">{icon}</span>
      <span className="min-w-0 truncate">{children}</span>
    </button>
  )
}

/** 「派生自 X」。名字要多发一次行查询，所以单独成组件（条件渲染整个组件，不条件调 hook）。 */
function DerivedFromChip({
  sourceId,
  onSelect
}: {
  sourceId: number
  onSelect(ref: LibraryFileRef): void
}): ReactElement | null {
  const { t } = useTranslation()
  const source = useLibraryFileQuery({ id: sourceId })
  if (source.isError) return null
  const name = source.data ? displayName(source.data) : '…'
  return (
    <RelationChip
      icon={<FileText size={11} strokeWidth={2} aria-hidden />}
      testId="library-relation-derived"
      onClick={() => onSelect({ id: sourceId })}
    >
      {t('library.preview.derivedFrom', { name })}
    </RelationChip>
  )
}

/** 「打开来源邮件」。投影行自带邮件身份；库内 `source='mail'` 行要按附件 id 回补一次。 */
function MailSourceChip({ file }: { file: LibraryFileDetail }): ReactElement | null {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const setView = useEmailFilter((s) => s.setView)
  const setActiveEmail = useActiveEmail((s) => s.setActive)

  const attachmentId = mailSourceAttachmentId(file)
  const selfKnown = typeof file.internal_id === 'number'
  // 投影行不查（身份已在行上）；库内行才发这一次，且只在真有附件 id 时发。
  const probe = useLibraryFileQuery(!selfKnown && attachmentId !== null ? { attachmentId } : null)
  const source: Pick<LibraryFile, 'internal_id' | 'subject' | 'sender_name' | 'sender'> | null =
    selfKnown ? file : (probe.data ?? null)
  const internalId = source?.internal_id
  if (typeof internalId !== 'number') return null

  const who = source?.sender_name?.trim() || source?.sender?.trim() || ''
  const subject = source?.subject?.trim() || ''
  const label = subject || t('library.preview.sourceJumpMail')
  return (
    <RelationChip
      icon={<Mail size={11} strokeWidth={2} aria-hidden />}
      title={t('library.preview.sourceJumpMail')}
      testId="library-relation-mail"
      onClick={() => {
        // 🔴 库文件行上没有 mailbox ⇒ 恒 'all' 跨邮箱视图（猜一个的话猜错就看不见那行）。
        const view = viewForMailbox(null)
        setView(view)
        setActiveEmail(internalId, { navTarget: true })
        void navigate({ to: '/', search: { view } })
      }}
    >
      {who ? `${label} · ${who}` : label}
    </RelationChip>
  )
}

export interface FileRelationsProps {
  file: LibraryFileDetail
  /** 派生来源那一枚点了之后换成另一个文件（与 F2 回链同语义）。 */
  onSelectFile(ref: LibraryFileRef): void
}

export function FileRelations({ file, onSelectFile }: FileRelationsProps): ReactElement | null {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const mattersApi = useMattersApi()
  const mattersEnabled = useMattersEnabled()
  const openMatter = useMatterNavigation((s) => s.open)

  const derivedFrom = derivedSourceId(file)
  const chatSessionId = chatSourceSessionId(file)

  // 反查：这份资料被哪些事项挂着。投影行没有 library id ⇒ 不可能被挂，也就不发请求。
  const lookupKeys = useMemo(
    () => (file.id === null ? [] : [libraryResourceKey(file.id)]),
    [file.id]
  )
  const linksQuery = useQuery({
    queryKey: qk.matters.resourceLookup('mailagent', lookupKeys),
    queryFn: () => mattersApi.lookupResourceLinks('mailagent', lookupKeys),
    enabled: mattersEnabled && lookupKeys.length > 0,
    staleTime: 10_000
  })
  const matters = useMemo(
    () => mergeMatterResourceLinkHits(linksQuery.data, lookupKeys),
    [linksQuery.data, lookupKeys]
  )

  const hasAny =
    derivedFrom !== null ||
    chatSessionId !== null ||
    matters.length > 0 ||
    typeof file.internal_id === 'number' ||
    mailSourceAttachmentId(file) !== null
  if (!hasAny) return null

  return (
    <div data-testid="library-relations" className="flex flex-wrap items-center gap-1.5 px-4 pt-3">
      {derivedFrom !== null ? (
        <DerivedFromChip sourceId={derivedFrom} onSelect={onSelectFile} />
      ) : null}
      <MailSourceChip file={file} />
      {chatSessionId !== null ? (
        <RelationChip
          icon={<MessagesSquare size={11} strokeWidth={2} aria-hidden />}
          testId="library-relation-chat"
          onClick={() => {
            requestOpenAgentSession(chatSessionId)
            void navigate({ to: '/sessions' })
          }}
        >
          {t('library.preview.sourceJumpChat')}
        </RelationChip>
      ) : null}
      {matters.length > 0 ? (
        <span className="text-meta text-ink-fg-3">{t('library.preview.relatedMatters')}</span>
      ) : null}
      {matters.map((matter) => (
        <RelationChip
          key={matter.publicId}
          icon={<BriefcaseBusiness size={11} strokeWidth={2} aria-hidden />}
          testId="library-relation-matter"
          onClick={() => {
            openMatter(matter.publicId)
            void navigate({ to: '/matters' })
          }}
        >
          {matter.title}
        </RelationChip>
      ))}
    </div>
  )
}
