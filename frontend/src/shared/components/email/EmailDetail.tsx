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
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Languages,
  Mail,
  RotateCcw,
  Sparkles
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'
import { formatDate, formatRelativeTime } from '@shared/format'
import { parseSender } from '@shared/lib/mail_parse'
import { mapLanguage } from '@shared/lib/ai_mapping'
import { useShortcut } from '@shared/hooks/useShortcut'
import { toastError, toastSuccess } from '@shared/state/toast'

import { HoverTip } from '@shared/components/ui/HoverTip'

import { EmailBodyFrame } from './EmailBodyFrame'
import { EmailToolbar, type TranslateStatus } from './EmailToolbar'
import { TranslatedBody } from './TranslatedBody'
import { AttachmentList } from './AttachmentList'
import { ThreadBundle } from './ThreadBundle'
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

// Sprint 5 §2.2 — single pending bit per write op. Per-button enums let
// EmailToolbar disable the right control without coupling all 4 to one
// global "any write in flight" flag (user can re-run AI while a Notion
// resync is still streaming back).
type PendingMap = {
  draft: boolean
  resync: boolean
  llmRun: boolean
  read: boolean
  flag: boolean
}

const NO_PENDING: PendingMap = {
  draft: false,
  resync: false,
  llmRun: false,
  read: false,
  flag: false
}

interface WriteErrorShape {
  code?: string
  message: string
}

function asWriteError(err: unknown): WriteErrorShape {
  if (err instanceof Error) {
    return { code: (err as Error & { code?: string }).code, message: err.message }
  }
  return { message: String(err) }
}

export function EmailDetail({ internalId }: Props): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const queryClient = useQueryClient()
  const [showTranslation, setShowTranslation] = useState(false)
  const [pending, setPending] = useState<PendingMap>(NO_PENDING)
  const [propsExpanded, setPropsExpanded] = useState(false)
  const [lastInternalId, setLastInternalId] = useState<number | null>(internalId)
  // React 19 "Adjusting state on prop change" pattern (react.dev/learn/you-might-not-need-an-effect):
  // resetting derived state on a prop transition is a render-time concern,
  // not an effect concern.
  if (lastInternalId !== internalId) {
    setLastInternalId(internalId)
    setShowTranslation(false)
    setPending(NO_PENDING)
    setPropsExpanded(false)
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

  // Sprint 13 round 6 — thread count query removed alongside the
  // Thread meta-row + sidebar. AIChatPanel still has its own
  // listByThread call for the Ctx chips; TanStack Query dedupes per
  // key so re-introducing here is cheap should Sprint 14 need it.

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

  // ---- Sprint 5 §2.2 — write action handlers --------------------------------
  //
  // Each handler:
  //   1. flips the per-button `pending` bit
  //   2. fires the mailApi.* IPC + awaits its envelope
  //   3. invalidates the `['email', id]` / `['email', id, 'ai']` queries on
  //      success so the panel re-reads fresh data
  //   4. surfaces success/error toast with i18n strings
  //
  // We don't toggle the pending bit back on a stale internalId — the
  // setPending(NO_PENDING) reset on prop change covers that.

  const handleCreateDraft = useCallback(async (): Promise<void> => {
    if (internalId === null) return
    setPending((p) => ({ ...p, draft: true }))
    try {
      await mailApi.email.createDraft({ internalId })
      toastSuccess(t('toolbarToast.draftOk'))
    } catch (err) {
      const e = asWriteError(err)
      const key =
        e.code === 'E_AUTOMATION_DENIED'
          ? 'toolbarToast.draftFailAuto'
          : e.code === 'E_MAIL_NOT_RUNNING'
            ? 'toolbarToast.draftFailMail'
            : e.code === 'E_NO_MAILBOX' || e.code === 'E_NOT_FOUND'
              ? 'toolbarToast.draftFailNoBin'
              : 'toolbarToast.draftFailGeneric'
      toastError(t(key), e.code ? `${e.code} · ${e.message}` : e.message)
    } finally {
      setPending((p) => ({ ...p, draft: false }))
    }
  }, [internalId, mailApi, t])

  const handleResync = useCallback(
    async ({ dryRun }: { dryRun: boolean }): Promise<void> => {
      if (internalId === null) return
      setPending((p) => ({ ...p, resync: true }))
      try {
        await mailApi.email.resync(internalId, { dryRun, replaceExisting: !dryRun })
        toastSuccess(t(dryRun ? 'toolbarToast.resyncOkDry' : 'toolbarToast.resyncOk'))
        if (!dryRun) {
          await queryClient.invalidateQueries({ queryKey: ['email', internalId] })
          await queryClient.invalidateQueries({ queryKey: ['email', internalId, 'ai'] })
        }
      } catch (err) {
        const e = asWriteError(err)
        const key =
          e.code === 'E_AUTH'
            ? 'toolbarToast.resyncFailAuth'
            : e.code === 'E_PM2_RUNNING' || e.code === 'E_PM2_CONFLICT'
              ? 'toolbarToast.resyncFailPm2'
              : 'toolbarToast.resyncFailGeneric'
        toastError(t(key), e.code ? `${e.code} · ${e.message}` : e.message)
      } finally {
        setPending((p) => ({ ...p, resync: false }))
      }
    },
    [internalId, mailApi, queryClient, t]
  )

  const handleLlmRun = useCallback(async (): Promise<void> => {
    if (internalId === null) return
    setPending((p) => ({ ...p, llmRun: true }))
    try {
      await mailApi.llm.run(internalId, { force: true })
      toastSuccess(t('toolbarToast.llmOk'))
      await queryClient.invalidateQueries({ queryKey: ['email', internalId, 'ai'] })
    } catch (err) {
      const e = asWriteError(err)
      toastError(t('toolbarToast.llmFailGeneric'), e.code ? `${e.code} · ${e.message}` : e.message)
    } finally {
      setPending((p) => ({ ...p, llmRun: false }))
    }
  }, [internalId, mailApi, queryClient, t])

  const handleToggleRead = useCallback(
    async (currentIsRead: boolean): Promise<void> => {
      if (internalId === null) return
      setPending((p) => ({ ...p, read: true }))
      try {
        await mailApi.notion.updateFlag(internalId, { isRead: !currentIsRead })
        toastSuccess(t('toolbarToast.flagOk'))
        await queryClient.invalidateQueries({ queryKey: ['email', internalId] })
        await queryClient.invalidateQueries({ queryKey: ['email', internalId, 'ai'] })
      } catch (err) {
        const e = asWriteError(err)
        toastError(
          t('toolbarToast.flagFailGeneric'),
          e.code ? `${e.code} · ${e.message}` : e.message
        )
      } finally {
        setPending((p) => ({ ...p, read: false }))
      }
    },
    [internalId, mailApi, queryClient, t]
  )

  const handleToggleFlag = useCallback(
    async (currentIsFlagged: boolean): Promise<void> => {
      if (internalId === null) return
      setPending((p) => ({ ...p, flag: true }))
      try {
        await mailApi.notion.updateFlag(internalId, { isFlagged: !currentIsFlagged })
        toastSuccess(t('toolbarToast.flagOk'))
        await queryClient.invalidateQueries({ queryKey: ['email', internalId] })
        await queryClient.invalidateQueries({ queryKey: ['email', internalId, 'ai'] })
      } catch (err) {
        const e = asWriteError(err)
        toastError(
          t('toolbarToast.flagFailGeneric'),
          e.code ? `${e.code} · ${e.message}` : e.message
        )
      } finally {
        setPending((p) => ({ ...p, flag: false }))
      }
    },
    [internalId, mailApi, queryClient, t]
  )

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
  // Sprint 13 — AttachmentList now owns the inline / derived filter so it
  // can surface derived-from children inline as "→ pdf · 142 KB" chips
  // instead of cluttering the grid with sibling tiles. We just hand it
  // the full list.
  const allAttachments = email.attachments ?? []

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
    // mockup L2036 — `<section class="glass-3 flex-1 min-w-0 flex flex-col">`.
    // Previous `bg-ink-3` was a solid ink, not the Liquid Glass surface; that's
    // what the user flagged as "正文背景没统一 mockup 毛玻璃风格". `.glass-3`
    // (authored in index.css) layers a translucent ink-3 on top of the
    // wallpaper + backdrop-filter blur(40px).
    <main aria-label="inbox-main" className="flex-1 min-w-0 glass-3 flex flex-col min-h-0">
      <EmailToolbar
        translate={{
          langIsEn,
          status: translateStatus,
          onToggle: toggleTranslation
        }}
        onCreateDraft={handleCreateDraft}
        draftState={{ pending: pending.draft }}
        onResync={handleResync}
        resyncState={{ pending: pending.resync }}
        onLlmRun={handleLlmRun}
        llmRunState={{ pending: pending.llmRun }}
        onToggleRead={() => void handleToggleRead(email.is_read)}
        isRead={email.is_read}
        readState={{ pending: pending.read }}
        onToggleFlag={() => void handleToggleFlag(email.is_flagged)}
        isFlagged={email.is_flagged}
        flagState={{ pending: pending.flag }}
        isImportant={email.is_important === true}
        notionUrl={email.notion_url}
      />

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {/* Sprint 13 round 7 user feedback: "email detail 的宽度不设上
            限". The mockup pinned the detail column to `max-w-[820px]` so
            text would not span a 1600px monitor, but the user prefers
            the full toolbar width. Body is still constrained by the iframe
            host width, so reading-line length on very wide screens is
            mediated by the email content itself.

            Sprint 13 round 8 — round 7 took the user's "现在是冻结元数据
            和 AI Fields" line as a feature request and wrapped meta +
            AIFields in `position: sticky`. It read as a description of
            (perceived) current behaviour instead; the sticky strip ate
            so much vertical space that the body became un-scrollable.
            Reverted to natural single-column flow. AI Fields精简 (7
            cells) stays — that part of round 7 is fine. */}
        <div className="px-8 py-6">
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
                'mt-2 inline-flex items-center gap-2 px-2.5 py-1.5 rounded-md',
                'text-aux text-coral border border-coral/30 bg-coral/10',
                'hover:bg-coral/15 transition-colors duration-fast'
              )}
            >
              <Languages size={13} strokeWidth={2} />
              {t('translate.inlineCta')}
              <kbd className="ml-0.5">⌥T</kbd>
            </button>
          )}

          {/* Meta grid — Sprint 13 round 8 user feedback "属性折叠没实现":
              round 7 only put Cc into the collapsed section, so when the
              email had no Cc the toggle never appeared.  Round 8 widens
              `morePropsRows` to also carry Mailbox / internal_id /
              message_id so the chevron is reliably present and the
              "hidden by default" affordance the user asked for is real.
              From/To/Date stay visible at all times. */}
          {(() => {
            const morePropsRows: { label: string; value: React.ReactNode }[] = []
            if (email.cc_addr && email.cc_addr.length > 0) {
              morePropsRows.push({ label: 'Cc', value: email.cc_addr })
            }
            if (email.mailbox) {
              morePropsRows.push({
                label: 'Mailbox',
                value: (
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-coral/100" />
                    {email.mailbox}
                  </span>
                )
              })
            }
            morePropsRows.push({
              label: 'internal_id',
              value: <span className="font-mono text-meta">{email.internal_id}</span>
            })
            if (email.message_id) {
              morePropsRows.push({
                label: 'message_id',
                value: <span className="font-mono text-meta break-all">{email.message_id}</span>
              })
            }
            return (
              <>
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
                  <MetaRow
                    label="To"
                    value={
                      email.to_addr && email.to_addr.length > 0 ? (
                        <span className="text-ink-fg-1">{email.to_addr}</span>
                      ) : (
                        <span className="text-ink-fg-3">—</span>
                      )
                    }
                  />
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
                  {propsExpanded &&
                    morePropsRows.map((row) => (
                      <MetaRow key={row.label} label={row.label} value={row.value} />
                    ))}
                </dl>
                {morePropsRows.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setPropsExpanded((v) => !v)}
                    className={cn(
                      'mt-2 inline-flex items-center gap-1 text-meta text-ink-fg-2',
                      'hover:text-ink-fg-1 transition-colors duration-fast',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-coral/40 rounded'
                    )}
                    aria-expanded={propsExpanded}
                  >
                    {propsExpanded ? (
                      <>
                        <ChevronUp size={11} strokeWidth={2} />
                        {t('emailDetail.fewerProps')}
                      </>
                    ) : (
                      <>
                        <ChevronDown size={11} strokeWidth={2} />
                        {t('emailDetail.moreProps', { n: morePropsRows.length })}
                      </>
                    )}
                  </button>
                )}
              </>
            )
          })()}

          {/* AI Fields */}
          {ai && (
            <div className="mt-6">
              <AIFieldsBlock fields={ai} />
            </div>
          )}

          {/* Sprint 13 round 6 user feedback: thread sidebar removed.
              Outlook-style "older messages collapsed under the latest"
              treatment is Sprint 14 — see NOTES.md 2026-05-20. */}

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

          {/* Attachments — AttachmentList renders null when no visible
              originals exist, so the wrapper div would leave a blank
              `mt-8` if we kept it unconditional. Gate on the unfiltered
              count first (cheap) then let the component pick what to show. */}
          {allAttachments.length > 0 && (
            <div className="mt-8">
              <AttachmentList attachments={allAttachments} />
            </div>
          )}

          {/* Sprint 14 主菜 — ThreadBundle. Outlook-style 同线程邮件
              折叠区: 把同 thread_id 的早期邮件按 date_received DESC 列在
              主面板下方, 默认折叠仅显发件人 / 主题 / 时间, 点击展开嵌入
              mini EmailBodyFrame. 当前 active 邮件不重复显示 (主面板已有).
              thread_id null 或者无 sibling → ThreadBundle 返回 null. */}
          {email.thread_id && (
            <div className="mt-8">
              <ThreadBundle threadId={email.thread_id} currentInternalId={email.internal_id} />
            </div>
          )}

          {/* Footer — Sprint 13 round 7 user feedback: "ID 之类的字段可
              以直接隐藏 (一般不用)". The internal_id + message_id mono
              blob lived on the left of this row; gone. Power users can
              still pull them via `mailagent -o json email get <id>` or
              the toolbar Notion link. Right side keeps "查看原文 .eml"
              (Sprint 14 待 CLI wiring) and "在 Notion 打开 ↗". */}
          <div className="mt-8 pt-5 border-t border-ink-border-soft flex items-center justify-end text-aux">
            <div className="flex items-center gap-3">
              {/* View source (.eml) — backend has `mailagent debug
                  email-source <id>` but no IPC wrapper yet. Sprint 14
                  will land it; for now HoverTip explains the gap so the
                  affordance is discoverable without being a lie. */}
              <HoverTip text={t('emailDetail.viewSourceBlocked')} side="top">
                <button
                  type="button"
                  disabled
                  data-disabled=""
                  tabIndex={-1}
                  className={cn(
                    'text-aux text-ink-fg-3 opacity-50 cursor-not-allowed',
                    'transition-colors duration-fast'
                  )}
                  onClick={() => toastSuccess(t('emailDetail.viewSourceBlocked'))}
                >
                  {t('emailDetail.viewSource')}
                </button>
              </HoverTip>
              {email.notion_url && (
                <>
                  <span className="text-ink-fg-3">·</span>
                  <a
                    href={email.notion_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-aux text-coral hover:text-coral-hover transition-colors duration-fast inline-flex items-center gap-1"
                  >
                    {t('toolbar.openNotion')}
                    <ExternalLink size={12} strokeWidth={2} />
                  </a>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}
