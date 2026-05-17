// DESIGN.md §5 + mockup-inbox.html line 850+. flex-1 detail column with
// bg-ink-3 (one tier brighter than EmailList's ink-2). Vertical structure:
//   - 48px EmailToolbar
//   - scroll container (scrollbar-thin) with max-w-[820px] inner:
//       - subject block with EN lang pip + monospace inline code
//       - one-tap translate banner (Sprint 3 wires the click)
//       - From/To/Date/Mailbox/Thread meta grid (80px label col)
//       - AIFieldsBlock 3×8 (V1) bordered + header strip
//       - mail-body content (DOMPurified iframe)
//       - Attachments 2-col grid
//       - Footer (internal_id + Notion link)

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, Languages, Mail, RotateCcw, Sparkles } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'
import { formatDate, formatRelativeTime } from '@shared/format'
import { parseSender } from '@shared/lib/mail_parse'
import { mapLanguage } from '@shared/lib/ai_mapping'
import { useShortcut } from '@shared/hooks/useShortcut'

import { EmailBodyFrame } from './EmailBodyFrame'
import { EmailToolbar, type TranslateStatus } from './EmailToolbar'
import { TranslatedBody } from './TranslatedBody'
import { ThreadSidebar } from './ThreadSidebar'
import { AttachmentList } from './AttachmentList'
import { AIFieldsBlock } from '../ai/AIFieldsBlock'

interface Props {
  internalId: number | null
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }): React.ReactElement {
  return (
    <>
      <span className="text-ink-fg-2 font-mono text-meta">{label}</span>
      <span className="text-ink-fg-1 break-words">{value}</span>
    </>
  )
}

// ---- translation UI views --------------------------------------------------

function TranslationView({
  status,
  errorCode,
  translated,
  onRetry,
  onDismiss
}: {
  status: TranslateStatus
  errorCode: string | null
  translated: string | null
  onRetry(): void
  onDismiss(): void
}): React.ReactElement {
  const { t } = useTranslation()
  if (status === 'loading' || (status === 'translated' && translated === null)) {
    return (
      <div className="flex items-center gap-2 text-aux text-ink-fg-2 animate-pulse py-6">
        <Languages size={13} strokeWidth={2} className="animate-spin" />
        <span>{t('translate.loading')}</span>
      </div>
    )
  }
  if (status === 'error') {
    const isNoKey = errorCode === 'E_NO_LLM_KEY'
    const isNoBody = errorCode === 'E_NO_BODY'
    return (
      <div
        className={cn(
          'flex items-start gap-3 px-4 py-3 rounded-md',
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
  // status === 'translated'
  return (
    <div>
      <div className="mb-3 flex items-center gap-2 text-aux text-coral">
        <Sparkles size={13} strokeWidth={2} />
        <span className="font-medium">{t('translate.banner')}</span>
        <button
          type="button"
          onClick={onDismiss}
          className="ml-auto px-2 py-1 rounded text-meta font-mono text-ink-fg-2 hover:text-ink-fg hover:bg-ink-4 transition-colors duration-fast"
        >
          {t('translate.showOriginal')}
        </button>
      </div>
      <TranslatedBody text={translated ?? ''} />
    </div>
  )
}

function EmptyShell({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <main
      aria-label="inbox-main"
      className="flex-1 min-w-0 bg-ink-3 flex items-center justify-center"
    >
      {children}
    </main>
  )
}

export function EmailDetail({ internalId }: Props): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const [showTranslation, setShowTranslation] = useState(false)
  const [lastInternalId, setLastInternalId] = useState<number | null>(internalId)
  // React 19 "Adjusting state on prop change" pattern (react.dev/learn/you-might-not-need-an-effect):
  // resetting derived state on a prop transition is a render-time concern,
  // not an effect concern.
  if (lastInternalId !== internalId) {
    setLastInternalId(internalId)
    setShowTranslation(false)
  }

  // The cleanup is a real side-effect (renderer → main IPC), so it stays
  // in an effect. No setState in the body — only the unmount-time abort.
  useEffect(() => {
    const prior = internalId
    return () => {
      if (prior !== null) mailApi.ai.abortTranslate(prior)
    }
  }, [internalId, mailApi])

  const detailQ = useQuery({
    queryKey: ['email', internalId],
    queryFn: () => mailApi.email.get(internalId as number),
    enabled: internalId !== null,
    staleTime: 30_000
  })

  const aiQ = useQuery({
    queryKey: ['email', internalId, 'ai'],
    queryFn: () => mailApi.email.aiFields(internalId as number),
    enabled: internalId !== null,
    staleTime: 30_000
  })

  const translationQ = useQuery({
    queryKey: ['email', internalId, 'translation', 'zh'],
    queryFn: () => mailApi.ai.translate(internalId as number, 'zh'),
    enabled: showTranslation && internalId !== null,
    staleTime: Infinity,
    // LLM errors shouldn't auto-retry — surface the failure UI and let
    // the user hit "重试" deliberately (avoids burning quota on a stuck key).
    retry: false
  })

  // Toggle / dismiss helpers (codex review M-2): hiding the panel should
  // also kill the in-flight LLM request so a slow response isn't still
  // tying up a CRS slot in the background. `abortTranslate` is a no-op
  // when nothing is in flight, so calling it on the false→true edge too
  // is harmless.
  const toggleTranslation = useCallback(() => {
    if (internalId === null) return
    setShowTranslation((prev) => {
      if (prev) mailApi.ai.abortTranslate(internalId)
      return !prev
    })
  }, [internalId, mailApi])

  const dismissTranslation = useCallback(() => {
    if (internalId !== null) mailApi.ai.abortTranslate(internalId)
    setShowTranslation(false)
  }, [internalId, mailApi])

  // ⌥T toggle. `useShortcut` short-circuits in editable contexts so typing
  // "t" in an input doesn't fire (DESIGN.md §9.5).
  useShortcut('alt+t', toggleTranslation)

  if (internalId === null) {
    return (
      <EmptyShell>
        <div className="text-aux text-ink-fg-2">
          <Mail size={28} strokeWidth={1.5} className="inline-block opacity-30 mb-2" />
          <div>{t('empty.state')}</div>
        </div>
      </EmptyShell>
    )
  }

  if (detailQ.isLoading) {
    return (
      <EmptyShell>
        <div className="text-aux text-ink-fg-2 animate-pulse">Loading…</div>
      </EmptyShell>
    )
  }

  if (detailQ.isError || !detailQ.data) {
    return (
      <EmptyShell>
        <div className="text-aux text-fail">
          {detailQ.error instanceof Error ? detailQ.error.message : 'Email not found.'}
        </div>
      </EmptyShell>
    )
  }

  const email = detailQ.data
  const ai = aiQ.data ?? null
  const fromParsed = parseSender(email.sender)
  const fromName = email.sender_name || fromParsed.name
  const fromAddr = fromParsed.email || email.sender
  // Route through mapLanguage so the EN pip survives LLM enum drift
  // ("English" / "en" / "en-US" all resolve to 'en'). NOTES 2026-05-17 #7.
  const langRaw = ai?.labels_raw?.language
  const langIsEn = mapLanguage(typeof langRaw === 'string' ? langRaw : null) === 'en'
  const visibleAttachments = (email.attachments ?? []).filter(
    (a) => !a.is_inline && a.derived_from === null
  )

  // Translate state → toolbar prop derivation.
  const translateError = translationQ.error as (Error & { code?: string }) | null
  const translateStatus: TranslateStatus = !showTranslation
    ? 'idle'
    : translationQ.isError
      ? 'error'
      : translationQ.isLoading || translationQ.isFetching
        ? 'loading'
        : translationQ.data
          ? 'translated'
          : 'loading'

  return (
    <main aria-label="inbox-main" className="flex-1 min-w-0 bg-ink-3 flex flex-col min-h-0">
      <EmailToolbar
        translate={{
          langIsEn,
          status: translateStatus,
          onToggle: toggleTranslation
        }}
      />

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="px-8 py-6 max-w-[820px] mx-auto">
          {/* Subject block — EN lang pip + tracking-tight headline */}
          <div className="flex items-start gap-3 mb-1.5">
            {langIsEn && (
              <span
                className="lang-pip mt-2 shrink-0"
                style={{ fontSize: '11px', padding: '3px 6px' }}
              >
                EN
              </span>
            )}
            <h1 className="text-subj font-semibold text-ink-fg leading-snug tracking-tight flex-1 break-words">
              {email.subject || '(no subject)'}
            </h1>
          </div>

          {/* One-tap inline translate — visible only when LLM tagged the
              email as English AND we're not already showing the translation. */}
          {langIsEn && !showTranslation && (
            <button
              type="button"
              onClick={() => setShowTranslation(true)}
              title={`⌥T · ${t('translate.label')}`}
              className={cn(
                'mb-5 inline-flex items-center gap-2 px-2.5 py-1.5 rounded-md',
                'text-aux text-coral border border-coral/30 bg-coral/10',
                'hover:bg-coral/15 transition-colors duration-fast'
              )}
            >
              <Languages size={13} strokeWidth={2} />
              {t('translate.inlineCta')}
              <kbd className="ml-0.5">⌥T</kbd>
            </button>
          )}

          {/* Meta grid — 80px label column, mockup-faithful */}
          <dl className="mt-1 grid grid-cols-[80px_1fr] gap-y-1.5 gap-x-3 text-aux">
            <MetaRow
              label="From"
              value={
                <>
                  {fromName && <span className="font-medium text-ink-fg">{fromName}</span>}
                  {fromName && fromAddr && <span className="text-ink-fg-2"> · </span>}
                  <span className="text-ink-fg-2">{fromAddr}</span>
                </>
              }
            />
            <MetaRow label="To" value={email.to_addr || '—'} />
            {email.cc_addr && email.cc_addr.length > 0 && (
              <MetaRow label="Cc" value={email.cc_addr} />
            )}
            {email.date_received && (
              <MetaRow
                label="Date"
                value={
                  <span className="font-mono text-meta">
                    {formatDate(email.date_received)}
                    <span className="text-ink-fg-2">
                      {' '}
                      · {formatRelativeTime(email.date_received)}
                    </span>
                  </span>
                }
              />
            )}
            <MetaRow
              label="Mailbox"
              value={
                <span className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-coral/100" />
                  {email.mailbox || '—'}
                </span>
              }
            />
            {email.notion_url && (
              <MetaRow
                label="Notion"
                value={
                  <a
                    href={email.notion_url}
                    className="text-coral hover:text-coral-hover inline-flex items-center gap-1"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    在 Notion 打开
                    <ExternalLink size={11} strokeWidth={2} />
                  </a>
                }
              />
            )}
            <MetaRow
              label="ID"
              value={
                <span className="font-mono text-meta text-ink-fg-2">
                  internal_id {email.internal_id}
                  {email.message_id && (
                    <span className="ml-2">· msg {email.message_id.slice(1, 9)}…</span>
                  )}
                </span>
              }
            />
          </dl>

          {/* AI Fields */}
          {ai && (
            <div className="mt-6">
              <AIFieldsBlock fields={ai} />
            </div>
          )}

          {/* Thread sidebar — silent when thread_id is null. */}
          {email.thread_id && (
            <div className="mt-6">
              <ThreadSidebar threadId={email.thread_id} currentInternalId={email.internal_id} />
            </div>
          )}

          {/* Body — original sandboxed iframe OR translated markdown.
              Toggled via EmailToolbar / ⌥T / inline translate banner. */}
          <div className="mt-7">
            {showTranslation ? (
              <TranslationView
                status={translateStatus}
                errorCode={translateError?.code ?? null}
                translated={translationQ.data?.translated ?? null}
                onRetry={() => translationQ.refetch()}
                onDismiss={dismissTranslation}
              />
            ) : (
              <EmailBodyFrame
                internalId={email.internal_id}
                attachments={email.attachments ?? []}
              />
            )}
          </div>

          {/* Attachments */}
          {visibleAttachments.length > 0 && (
            <div className="mt-8">
              <AttachmentList attachments={visibleAttachments} />
            </div>
          )}

          {/* Footer */}
          <div className="mt-8 pt-5 border-t border-ink-border-soft flex items-center justify-between text-aux">
            <div className="text-meta font-mono text-ink-fg-2">
              <Sparkles size={11} strokeWidth={2} className="inline-block mr-1 text-info" />
              Sprint 2 detail · functional view
            </div>
            {email.notion_url && (
              <a
                href={email.notion_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-aux text-coral hover:text-coral-hover transition-colors duration-fast inline-flex items-center gap-1"
              >
                在 Notion 打开
                <ExternalLink size={12} strokeWidth={2} />
              </a>
            )}
          </div>
        </div>
      </div>
    </main>
  )
}
