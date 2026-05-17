// DESIGN.md §3 + §5 — flex-1 detail column. Sprint 2 ships:
//   - Toolbar (UI shell only — Sprint 5 wires the actions)
//   - Email header (subject / sender block / metadata grid)
//   - Sandboxed iframe rendering DOMPurify-cleaned HTML body
//     (inline cid: images rewritten to file:// via attachment:localPath)
//   - <AIFieldsBlock> 3×8 grid
//   - Attachment list (non-inline only, excludes derived siblings for clarity)
//
// Empty state (no `internalId`): centered hint instead of blank.

import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { useMailApi } from '@shared/hooks/useMailApi'
import { formatDate } from '@shared/format'

import { EmailBodyFrame } from './EmailBodyFrame'
import { EmailToolbar } from './EmailToolbar'
import { AttachmentList } from './AttachmentList'
import { AIFieldsBlock } from '../ai/AIFieldsBlock'

interface Props {
  internalId: number | null
}

export function EmailDetail({ internalId }: Props): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()

  const detailQ = useQuery({
    queryKey: ['email', internalId],
    queryFn: () => mailApi.email.get(internalId as number),
    enabled: internalId !== null
  })

  const aiQ = useQuery({
    queryKey: ['email', internalId, 'ai'],
    queryFn: () => mailApi.email.aiFields(internalId as number),
    enabled: internalId !== null
  })

  if (internalId === null) {
    return (
      <main
        aria-label="inbox-main"
        className="flex-1 min-w-0 bg-ink-2 flex items-center justify-center"
      >
        <div className="text-aux text-ink-fg-2">{t('empty.state')}</div>
      </main>
    )
  }

  if (detailQ.isLoading) {
    return (
      <main
        aria-label="inbox-main"
        className="flex-1 min-w-0 bg-ink-2 flex items-center justify-center"
      >
        <div className="text-aux text-ink-fg-2 animate-pulse">Loading…</div>
      </main>
    )
  }

  if (detailQ.isError || !detailQ.data) {
    return (
      <main
        aria-label="inbox-main"
        className="flex-1 min-w-0 bg-ink-2 flex items-center justify-center"
      >
        <div className="text-aux text-fail">
          {detailQ.error instanceof Error ? detailQ.error.message : 'Email not found.'}
        </div>
      </main>
    )
  }

  const email = detailQ.data
  const ai = aiQ.data ?? null
  const visibleAttachments = (email.attachments ?? []).filter(
    (a) => !a.is_inline && a.derived_from === null
  )

  return (
    <main aria-label="inbox-main" className="flex-1 min-w-0 bg-ink-2 flex flex-col min-h-0">
      <EmailToolbar />

      <div className="flex-1 overflow-y-auto px-8 py-6 min-w-0">
        {/* Subject + sender block */}
        <h1 className="text-subj font-semibold tracking-tight text-ink-fg break-words">
          {email.subject || '(no subject)'}
        </h1>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-aux">
          <dt className="text-ink-fg-3 font-mono text-meta uppercase tracking-wide">From</dt>
          <dd className="text-ink-fg">
            {email.sender_name ? `${email.sender_name} · ` : ''}
            <span className="text-ink-fg-1">{email.sender}</span>
          </dd>
          <dt className="text-ink-fg-3 font-mono text-meta uppercase tracking-wide">To</dt>
          <dd className="text-ink-fg-1 break-words">{email.to_addr}</dd>
          {email.cc_addr && email.cc_addr.length > 0 && (
            <>
              <dt className="text-ink-fg-3 font-mono text-meta uppercase tracking-wide">Cc</dt>
              <dd className="text-ink-fg-1 break-words">{email.cc_addr}</dd>
            </>
          )}
          {email.date_received && (
            <>
              <dt className="text-ink-fg-3 font-mono text-meta uppercase tracking-wide">Date</dt>
              <dd className="text-ink-fg-1 font-mono text-meta tabular-nums">
                {formatDate(email.date_received)}
              </dd>
            </>
          )}
        </dl>

        {/* Body */}
        <div className="mt-6 border-t border-ink-border-soft pt-6">
          <EmailBodyFrame internalId={email.internal_id} attachments={email.attachments ?? []} />
        </div>

        {/* AI Fields */}
        {ai && (
          <div className="mt-8">
            <AIFieldsBlock fields={ai} />
          </div>
        )}

        {/* Attachments — only show the user-visible set */}
        {visibleAttachments.length > 0 && (
          <div className="mt-8">
            <AttachmentList attachments={visibleAttachments} />
          </div>
        )}
      </div>
    </main>
  )
}
