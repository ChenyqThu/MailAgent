// Email detail header presentation components extracted from EmailDetail:
// EmailDetailSubjectBar (sticky subject + 4-state inline translate controls) and
// EmailDetailMetaGrid (From/To/Cc/Date + WP4 contact chips + collapsible props).

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { ChevronDown, ExternalLink, Languages, RotateCcw } from 'lucide-react'

import { CollapsibleRegion } from '@shared/components/ui/collapsible'
import { ShimmerText } from '@shared/components/ShimmerText'
import { formatDate, formatRelativeTime } from '@shared/format'
import { cn } from '@shared/lib/cn'
import { parseAddressList, parseSender } from '@shared/lib/mail_parse'
import type { EmailDetail } from '@shared/api/types'
import type { ContactChipDto } from '@shared/api/types/contact'

import { PersonChip } from '../../contacts/PersonChip'
import { useContactNavigation } from '../../contacts/navigation'

function MetaRow({ label, value }: { label: string; value: React.ReactNode }): React.ReactElement {
  return (
    <>
      <span className="text-ink-fg-2 font-mono text-aux">{label}</span>
      <span className="text-ink-fg-1 break-words">{value}</span>
    </>
  )
}

function ExpandableValue({ text, max = 100 }: { text: string; max?: number }): React.ReactElement {
  const { t } = useTranslation()
  const [shown, setShown] = useState(false)
  if (text.length <= max) return <span className="text-ink-fg-1">{text}</span>
  return (
    <span className="text-ink-fg-1">
      {shown ? text : text.slice(0, max).trimEnd() + '… '}
      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        className={cn(
          'text-meta text-coral hover:text-coral-hover',
          'transition-colors duration-fast ml-1 align-baseline',
          'focus:outline-none focus-visible:underline'
        )}
      >
        {shown ? t('emailDetail.less') : t('emailDetail.more')}
      </button>
    </span>
  )
}

/** 收件人折叠上限（>12 折叠为前 12 + 「+n」展开钮，复用 emailDetail.more/less 词）。 */
const RECIPIENT_FOLD_LIMIT = 12

function chipContactOf(
  resolved: Record<string, ContactChipDto | null> | undefined,
  addr: string
): React.ComponentProps<typeof PersonChip>['contact'] {
  const hit = resolved?.[addr.trim().toLowerCase()]
  if (!hit) return null
  return {
    id: hit.id,
    displayName: hit.display_name,
    formalName: hit.formal_name,
    primaryEmail: hit.primary_email,
    kind: hit.kind
  }
}

/** PersonChip + 默认跳转接线（人物页 store intent + navigate('/contacts')）。
 *  🔴 useNavigate 依赖 router context，故收在这个**仅 chips 激活时才挂载**的
 *  包装组件里，不进 EmailDetail / EmailDetailMetaGrid 顶层 hooks（既有单测在无
 *  RouterProvider 下渲染 EmailDetail，顶层 useNavigate 会炸）。 */
function NavPersonChip({
  contact,
  addr,
  big
}: {
  contact: ReturnType<typeof chipContactOf>
  addr: string
  big?: boolean
}): React.ReactElement {
  const navigate = useNavigate()
  const openContact = useContactNavigation((state) => state.open)
  return (
    <PersonChip
      contact={contact}
      addr={addr}
      big={big}
      onOpen={(id) => {
        openContact(id)
        void navigate({ to: '/contacts' })
      }}
    />
  )
}

function RecipientChipsValue({
  entries,
  resolved
}: {
  entries: ReadonlyArray<{ name: string; email: string }>
  resolved: Record<string, ContactChipDto | null> | undefined
}): React.ReactElement {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? entries : entries.slice(0, RECIPIENT_FOLD_LIMIT)
  const hiddenCount = entries.length - RECIPIENT_FOLD_LIMIT
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {shown.map((entry) => (
        <NavPersonChip
          key={entry.email.toLowerCase()}
          contact={chipContactOf(resolved, entry.email)}
          addr={entry.email}
        />
      ))}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className={cn(
            'text-meta text-coral hover:text-coral-hover',
            'transition-colors duration-fast align-baseline',
            'focus:outline-none focus-visible:underline'
          )}
        >
          {expanded ? t('emailDetail.less') : `+${hiddenCount} ${t('emailDetail.more')}`}
        </button>
      )}
    </span>
  )
}

function TranslationErrorBanner({
  errorCode,
  onRetry,
  onDismiss
}: {
  errorCode: string | null
  onRetry(): void
  onDismiss(): void
}): React.ReactElement {
  const { t } = useTranslation()
  const isNoKey = errorCode === 'E_NO_LLM_KEY'
  const isNoBody = errorCode === 'E_NO_BODY'
  return (
    <div
      className={cn(
        'mt-2 flex items-start gap-3 px-3 py-2 rounded-md',
        'text-aux text-fail border border-fail/30 bg-fail/10'
      )}
    >
      <Languages size={14} strokeWidth={2} className="shrink-0 mt-0.5" />
      <div className="flex-1">
        <div className="font-medium">
          {isNoKey
            ? t('translate.noKey')
            : isNoBody
              ? t('translate.noBody')
              : t('translate.failed')}
        </div>
        {errorCode && <div className="text-meta font-mono text-ink-fg-3 mt-1">{errorCode}</div>}
      </div>
      {!isNoKey && !isNoBody && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 px-2 py-1 rounded text-aux text-fail hover:bg-fail/15 transition-colors duration-fast inline-flex items-center gap-1"
        >
          <RotateCcw size={11} strokeWidth={2} />
          {t('translate.retry')}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 text-meta font-mono text-ink-fg-3 hover:text-ink-fg-1 px-1"
      >
        ×
      </button>
    </div>
  )
}

interface EmailDetailSubjectBarProps {
  subject: string | null | undefined
  langIsEn: boolean
  isTranslating: boolean
  hasCache: boolean
  showTranslation: boolean
  translateError: { code: string; message: string } | null
  onStartTranslate: () => void
  onToggleTranslation: () => void
  onRetranslate: () => void
  onDismissTranslateError: () => void
}

/** Sticky subject strip + 4-state inline translate trigger and error banner. */
export function EmailDetailSubjectBar({
  subject,
  langIsEn,
  isTranslating,
  hasCache,
  showTranslation,
  translateError,
  onStartTranslate,
  onToggleTranslation,
  onRetranslate,
  onDismissTranslateError
}: EmailDetailSubjectBarProps): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div
      className={cn(
        'sticky top-0 z-10',
        'backdrop-blur-2xl backdrop-saturate-150',
        'border-b border-ink-border-soft'
      )}
    >
      <div className="px-4 pt-3 pb-3">
        <div className="flex items-start gap-3">
          {langIsEn && (
            <span
              className="lang-pip mt-2 shrink-0"
              style={{ fontSize: '11px', padding: '3px 6px' }}
            >
              EN
            </span>
          )}
          <h1 className="text-subj font-semibold text-ink-fg leading-snug tracking-tight flex-1 break-words text-balance">
            {subject || t('emailRow.noSubject')}
          </h1>
        </div>

        {langIsEn && !isTranslating && (!hasCache || !showTranslation) && (
          <button
            type="button"
            onClick={hasCache ? onToggleTranslation : onStartTranslate}
            title={`⌥T · ${hasCache ? t('translate.showTranslation') : t('translate.label')}`}
            className={cn(
              'mt-2 inline-flex items-center gap-2 px-2.5 py-1.5 rounded-md',
              'text-aux text-coral border border-coral/30 bg-coral/10',
              'hover:bg-coral/15 transition-colors duration-fast'
            )}
          >
            <Languages size={13} strokeWidth={2} />
            {hasCache ? t('translate.showTranslation') : t('translate.inlineCta')}
            <kbd className="ml-0.5">⌥T</kbd>
          </button>
        )}
        {langIsEn && !isTranslating && hasCache && showTranslation && (
          <div className="mt-2 inline-flex items-center gap-2">
            <button
              type="button"
              onClick={onToggleTranslation}
              title={`⌥T · ${t('translate.showOriginal')}`}
              className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md',
                'text-aux text-ink-fg-1 border border-ink-border bg-ink-4/40',
                'hover:bg-ink-4 transition-colors duration-fast'
              )}
            >
              <Languages size={13} strokeWidth={2} />
              {t('translate.showOriginal')}
            </button>
            <button
              type="button"
              onClick={onRetranslate}
              title={t('translate.retranslate')}
              className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md',
                'text-aux text-ink-fg-2 border border-ink-border bg-transparent',
                'hover:bg-ink-4/40 hover:text-ink-fg-1 transition-colors duration-fast'
              )}
            >
              <RotateCcw size={11} strokeWidth={2} />
              {t('translate.retranslate')}
            </button>
          </div>
        )}
        {isTranslating && (
          <div className="mt-2 inline-flex items-center gap-2 text-aux text-ink-fg-2">
            <Languages size={13} strokeWidth={2} />
            <ShimmerText text={t('translate.loading')} neutral />
          </div>
        )}
        {translateError && (
          <TranslationErrorBanner
            errorCode={translateError.code}
            onRetry={() => (hasCache ? onRetranslate() : onStartTranslate())}
            onDismiss={onDismissTranslateError}
          />
        )}
      </div>
    </div>
  )
}

interface EmailDetailMetaGridProps {
  email: EmailDetail
  contactsEnabled: boolean
  resolvedContacts: Record<string, ContactChipDto | null> | undefined
}

/** From / To / Cc / Date metadata grid + collapsible technical properties. */
export function EmailDetailMetaGrid({
  email,
  contactsEnabled,
  resolvedContacts
}: EmailDetailMetaGridProps): React.ReactElement {
  const { t } = useTranslation()
  const [propsExpanded, setPropsExpanded] = useState(false)
  const morePropsId = useId()

  const fromParsed = parseSender(email.sender)
  const fromName = email.sender_name || fromParsed.name
  const fromAddr = fromParsed.email || email.sender
  const chipsActive = contactsEnabled && resolvedContacts !== undefined
  const toEntries = chipsActive ? parseAddressList(email.to_addr) : []
  const ccEntries = chipsActive ? parseAddressList(email.cc_addr ?? null) : []
  const fromChip = chipsActive ? chipContactOf(resolvedContacts, fromAddr) : null

  const morePropsRows: { label: string; value: React.ReactNode }[] = [
    ...(email.mailbox
      ? [
          {
            label: 'Mailbox',
            value: (
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-coral/100" />
                {email.mailbox}
              </span>
            )
          }
        ]
      : []),
    {
      label: 'internal_id',
      value: <span className="font-mono text-aux -ml-px">{email.internal_id}</span>
    },
    ...(email.message_id
      ? [
          {
            label: 'message_id',
            value: <span className="font-mono text-aux break-all -ml-px">{email.message_id}</span>
          }
        ]
      : []),
    ...(email.notion_url
      ? [
          {
            label: 'Notion URL',
            value: (
              <a
                href={email.notion_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-coral hover:text-coral-hover transition-colors duration-fast break-all"
              >
                {email.notion_url}
                <ExternalLink size={11} strokeWidth={2} />
              </a>
            )
          }
        ]
      : [])
  ]

  return (
    <>
      <dl className="mt-1 grid grid-cols-[96px_1fr] gap-y-1.5 gap-x-3 text-aux">
        <MetaRow
          label="From"
          value={
            chipsActive && fromChip !== null ? (
              <span className="flex flex-wrap items-center gap-1.5">
                <NavPersonChip big contact={fromChip} addr={fromAddr} />
                <span className="font-mono text-ink-fg-2">{fromAddr}</span>
              </span>
            ) : chipsActive && fromAddr.includes('@') ? (
              <span className="flex flex-wrap items-center gap-1.5">
                {fromName && <span className="font-medium text-ink-fg">{fromName}</span>}
                <PersonChip contact={null} addr={fromAddr} />
              </span>
            ) : (
              <>
                {fromName && <span className="font-medium text-ink-fg">{fromName}</span>}
                {fromName && fromAddr && <span className="text-ink-fg-2"> · </span>}
                <span className="text-ink-fg-2">{fromAddr}</span>
              </>
            )
          }
        />
        <MetaRow
          label="To"
          value={
            chipsActive && toEntries.length > 0 ? (
              <RecipientChipsValue
                key={`to-${email.internal_id}`}
                entries={toEntries}
                resolved={resolvedContacts}
              />
            ) : email.to_addr && email.to_addr.length > 0 ? (
              <ExpandableValue text={email.to_addr} />
            ) : (
              <span className="text-ink-fg-3">—</span>
            )
          }
        />
        {email.cc_addr && email.cc_addr.length > 0 && (
          <MetaRow
            label="Cc"
            value={
              chipsActive && ccEntries.length > 0 ? (
                <RecipientChipsValue
                  key={`cc-${email.internal_id}`}
                  entries={ccEntries}
                  resolved={resolvedContacts}
                />
              ) : (
                <ExpandableValue text={email.cc_addr} />
              )
            }
          />
        )}
        {email.date_received && (
          <MetaRow
            label="Date"
            value={
              <span className="font-mono text-aux">
                {formatDate(email.date_received)}
                <span className="text-ink-fg-2"> · {formatRelativeTime(email.date_received)}</span>
              </span>
            }
          />
        )}
      </dl>

      {morePropsRows.length > 0 && (
        <>
          <CollapsibleRegion expanded={propsExpanded} id={morePropsId}>
            <dl className="mt-1.5 grid grid-cols-[96px_1fr] gap-y-1.5 gap-x-3 text-aux">
              {morePropsRows.map((row) => (
                <MetaRow key={row.label} label={row.label} value={row.value} />
              ))}
            </dl>
          </CollapsibleRegion>

          <button
            type="button"
            onClick={() => setPropsExpanded((v) => !v)}
            className={cn(
              'mt-1.5 inline-flex items-center gap-1 text-meta text-ink-fg-2',
              'hover:text-ink-fg-1 transition-colors duration-fast',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 rounded'
            )}
            aria-expanded={propsExpanded}
            aria-controls={morePropsId}
          >
            <ChevronDown
              size={12}
              strokeWidth={2}
              className={cn(
                'transition-transform duration-base ease-standard',
                'motion-reduce:transition-none',
                propsExpanded && 'rotate-180'
              )}
            />
            {propsExpanded
              ? t('emailDetail.fewerProps')
              : t('emailDetail.moreProps', { n: morePropsRows.length })}
          </button>
        </>
      )}
    </>
  )
}
