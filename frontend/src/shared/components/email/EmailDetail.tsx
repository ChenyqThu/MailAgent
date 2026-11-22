// DESIGN.md §5 + mockup-inbox.html line 850+. flex-1 detail column with
// bg-ink-3 (one tier brighter than EmailList's ink-2). Vertical structure:
//   - 48px EmailToolbar
//   - scroll container (scrollbar-thin) with sticky subject, meta grid,
//     matter/meeting cards, AI fields, thread attachments, body iframe, attachments.

import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { ArrowLeft, Mail } from 'lucide-react'

import { gsap, useGSAP, DUR } from '@shared/lib/gsap'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { useMailApi } from '@shared/hooks/useMailApi'
import { parseAddressList, parseSender } from '@shared/lib/mail_parse'
import { isDraftsMailbox } from '@shared/lib/mailboxSemantics'
import { calendarUiEnabled, detectUiPlatform } from '@shared/lib/mailBackend'
import { qk } from '@shared/lib/queryKeys'
import { mapLanguage } from '@shared/lib/ai_mapping'
import { useIsBelowLg } from '@shared/hooks/useMediaQuery'
import { useActiveEmail } from '@shared/state/active-email'
import { canOpenDetachedWindow, useDetachedMode } from '@shared/state/detached-mode'
import { useTogglePin } from '@shared/hooks/usePinnedSync'
import { usePinned } from '@shared/state/pinned'
import { startChatWithPrompt } from '@shared/state/ai-chat-panel'
import { ShimmerText } from '@shared/components/ShimmerText'

import { EmailBodyFrame } from './EmailBodyFrame'
import { EmailToolbar } from './EmailToolbar'
import { AttachmentList } from './AttachmentList'
import { ThreadAttachmentBar } from './ThreadAttachmentBar'
import { AIFieldsBlock } from '../ai/AIFieldsBlock'
import { MeetingInviteCard } from '../calendar/MeetingInviteCard'
import {
  buildMatterResourceLookupKeys,
  deriveMatterLinkButtonState,
  mergeMatterResourceLinkHits
} from '../matters/matterResource'
import { useMattersApi, useMattersEnabled } from '../matters/hooks'
import { useContactsApi, useContactsEnabled } from '../contacts/hooks'
import { MatterBelongsCard } from '../matters/MatterBelongsCard'
import { MatterLinkPopover } from '../matters/MatterLinkPopover'
import { CustomAgentDrawer } from '../agents/CustomAgentDrawer'
import { useTriggerV2Enabled } from '../agents/hooks'
import { ComposePanel, ComposePanelInner } from './compose/ComposePanel'
import { useEmailDetailTranslation } from './detail/useEmailDetailTranslation'
import { useEmailDetailActions } from './detail/useEmailDetailActions'
import { useEmailTabSync } from './detail/useEmailTabSync'
import { EmailDetailMetaGrid, EmailDetailSubjectBar } from './detail/EmailDetailHeader'

interface Props {
  internalId: number | null
}

function EmptyShell({ children }: { children: React.ReactNode }): React.ReactElement {
  // <lg 详情覆盖列表时，loading / error 等空态分支没有 EmailToolbar 的返回按钮，
  // 这里自带返回入口防止窄屏卡死。
  const { t } = useTranslation()
  const belowLg = useIsBelowLg()
  const activeId = useActiveEmail((s) => s.activeInternalId)
  const setActive = useActiveEmail((s) => s.setActive)
  return (
    <main
      aria-label="inbox-main"
      className="relative flex-1 min-w-0 bg-ink-3 flex items-center justify-center"
    >
      {belowLg && activeId !== null && (
        <button
          type="button"
          onClick={() => setActive(null)}
          aria-label={t('toolbar.backToList', { defaultValue: '返回列表' })}
          className="lg:hidden absolute top-2 left-2 inline-flex items-center justify-center w-8 h-8 rounded-md text-ink-fg-2 hover:text-ink-fg hover:bg-ink-4 transition-colors duration-fast"
        >
          <ArrowLeft size={16} strokeWidth={2} />
        </button>
      )}
      {children}
    </main>
  )
}

export function EmailDetail({ internalId }: Props): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const mattersApi = useMattersApi()
  const mattersEnabled = useMattersEnabled()
  const triggerV2Enabled = useTriggerV2Enabled()
  const isDetachedWindow = useDetachedMode((s) => s.isDetached)
  const [matterMenuOpen, setMatterMenuOpen] = useState(false)
  const [followupOpen, setFollowupOpen] = useState(false)
  const matterAnchorRef = useRef<HTMLDivElement | null>(null)
  const togglePin = useTogglePin()
  const isPinned = usePinned((s) => (internalId !== null ? s.isPinned(internalId) : false))

  // 切邮件时收起捕获浮层与跟进 Agent 抽屉（锚定/预填的都是上一封）。
  const [lastInternalId, setLastInternalId] = useState<number | null>(internalId)
  if (lastInternalId !== internalId) {
    setLastInternalId(internalId)
    setMatterMenuOpen(false)
    setFollowupOpen(false)
  }

  // 切邮件时用 keepPreviousData 让上一封 detail/ai 继续显示直到新数据到达，避免闪 Loading 态。
  const detailQ = useQuery({
    queryKey: qk.email.detail(internalId),
    queryFn: () => mailApi.email.get(internalId as number),
    enabled: internalId !== null,
    staleTime: 30_000,
    placeholderData: keepPreviousData
  })

  const aiQ = useQuery({
    queryKey: qk.email.ai(internalId),
    queryFn: () => mailApi.email.aiFields(internalId as number),
    enabled: internalId !== null,
    staleTime: 30_000,
    placeholderData: keepPreviousData
  })
  const ai = aiQ.data ?? null
  const langRaw = ai?.labels_raw?.language
  const langIsEn = mapLanguage(typeof langRaw === 'string' ? langRaw : null) === 'en'

  const matterLookupKeys = useMemo(
    () => buildMatterResourceLookupKeys(internalId, detailQ.data?.thread_id),
    [detailQ.data?.thread_id, internalId]
  )
  const matterLookupQ = useQuery({
    queryKey: qk.matters.resourceLookup('mailagent', matterLookupKeys),
    queryFn: () => mattersApi.lookupResourceLinks('mailagent', matterLookupKeys),
    enabled:
      mattersEnabled &&
      detailQ.data !== null &&
      detailQ.data !== undefined &&
      matterLookupKeys.length > 0,
    staleTime: 10_000
  })
  const linkedMatters = useMemo(
    () => mergeMatterResourceLinkHits(matterLookupQ.data, matterLookupKeys),
    [matterLookupKeys, matterLookupQ.data]
  )
  const matterLinkState = deriveMatterLinkButtonState(linkedMatters.length)

  const matterThreadQ = useQuery({
    queryKey: qk.email.thread(detailQ.data?.thread_id ?? null),
    queryFn: () => mailApi.email.listByThread(detailQ.data?.thread_id ?? null),
    enabled: mattersEnabled && Boolean(detailQ.data?.thread_id),
    staleTime: 30_000
  })

  const { enabled: contactsEnabled } = useContactsEnabled()
  const contactsApi = useContactsApi()
  const resolveAddresses = useMemo(() => {
    const data = detailQ.data
    if (!data) return [] as string[]
    const out = new Set<string>()
    const senderEmail = parseSender(data.sender).email
    if (senderEmail.includes('@')) out.add(senderEmail.trim().toLowerCase())
    for (const entry of [
      ...parseAddressList(data.to_addr),
      ...parseAddressList(data.cc_addr ?? null)
    ]) {
      if (entry.email.includes('@')) out.add(entry.email.trim().toLowerCase())
    }
    return [...out].sort()
  }, [detailQ.data])
  const contactResolveQ = useQuery({
    queryKey: qk.contacts.resolve(resolveAddresses),
    queryFn: () => contactsApi.resolve(resolveAddresses),
    enabled: contactsEnabled && resolveAddresses.length > 0,
    staleTime: 30_000
  })
  const resolvedContacts = contactResolveQ.data?.items

  const translation = useEmailDetailTranslation({ internalId, langIsEn })
  const actions = useEmailDetailActions({ internalId, detailData: detailQ.data })
  const bodyScopeRef = useRef<HTMLDivElement>(null)
  const tabSync = useEmailTabSync({
    internalId,
    detailData: detailQ.data,
    detailIsSuccess: detailQ.isSuccess,
    detailIsPlaceholderData: detailQ.isPlaceholderData,
    bodyScopeRef
  })

  // B1 — compose overlay 进/退场.
  const { shouldRender: composeShouldRender, scopeRef: composeScopeRef } =
    useExitAnimation<HTMLDivElement>(tabSync.composeOpenHere, {
      backdrop: false,
      from: { autoAlpha: 0, y: 20 }
    })

  // B2 — 切邮件时正文内容区交叉淡入 (fromTo 终点恒 1, 防快速连切中途值累积).
  const reduceMotion = useReducedMotion()
  useGSAP(
    () => {
      if (reduceMotion) return
      const el = bodyScopeRef.current
      if (!el) return
      gsap.fromTo(el, { autoAlpha: 0 }, { autoAlpha: 1, duration: DUR.fast, overwrite: 'auto' })
    },
    { dependencies: [internalId, reduceMotion], scope: bodyScopeRef }
  )

  const handleAiResearchMatter = useCallback((): void => {
    if (internalId === null) return
    setMatterMenuOpen(false)
    startChatWithPrompt(t('toolbar.createMatterPrompt'), internalId)
  }, [internalId, t])

  if (internalId === null) {
    return (
      <EmptyShell>
        <div className="text-aux text-center text-ink-fg-2">
          <Mail size={28} strokeWidth={1.5} className="inline-block opacity-30 mb-2" />
          <div>{t('empty.state')}</div>
        </div>
      </EmptyShell>
    )
  }

  if (detailQ.isLoading) {
    return (
      <EmptyShell>
        <ShimmerText text={t('emailDetail.loading')} neutral className="text-aux" />
      </EmptyShell>
    )
  }

  // task 08-20 draft-save C-1: replace 保存删旧草稿导致 404 时凭 stale data 落进 draft-edit 分支。
  if (!detailQ.data || (detailQ.isError && !isDraftsMailbox(detailQ.data.mailbox))) {
    return (
      <EmptyShell>
        <div className="text-aux text-fail">
          {detailQ.error instanceof Error ? detailQ.error.message : 'Email not found.'}
        </div>
      </EmptyShell>
    )
  }

  const email = detailQ.data

  if (isDraftsMailbox(email.mailbox)) {
    return (
      <ComposePanelInner
        key={`draft-${email.internal_id}`}
        internalId={email.internal_id}
        mode="draft-edit"
        onClose={tabSync.handleDraftEditClose}
        guardRef={tabSync.draftEditGuardRef}
        initialTabDraft={tabSync.composeTabDraft}
      />
    )
  }

  const allAttachments = email.attachments ?? []

  return (
    <main aria-label="inbox-main" className="relative flex-1 min-w-0 glass-3 flex flex-col min-h-0">
      {composeShouldRender && (
        <div ref={composeScopeRef} className="absolute inset-0 z-20 flex flex-col bg-ink-3">
          <ComposePanel
            snapshotRef={tabSync.composeSnapshotRef}
            initialTabDraft={tabSync.composeTabDraft}
            guardRef={tabSync.overlayGuardRef}
          />
        </div>
      )}
      <EmailToolbar
        onBack={() => actions.setActive(null)}
        translate={{
          langIsEn,
          status: translation.translateStatus,
          onToggle: translation.hasCache
            ? translation.toggleTranslation
            : translation.startTranslate
        }}
        onOpenCompose={tabSync.handleOpenCompose}
        onResync={actions.handleResync}
        resyncState={{ pending: actions.pending.resync }}
        onLlmRun={actions.handleLlmRun}
        matter={
          mattersEnabled
            ? {
                count: linkedMatters.length,
                state: matterLinkState,
                open: matterMenuOpen,
                onToggle: () => setMatterMenuOpen((value) => !value),
                anchorRef: matterAnchorRef,
                popover: (
                  <MatterLinkPopover
                    open={matterMenuOpen}
                    anchorRef={matterAnchorRef}
                    source={{
                      internalId: email.internal_id,
                      threadId: email.thread_id ?? null,
                      subject: email.subject,
                      sender: email.sender_name || email.sender,
                      receivedAt: email.date_received ?? null,
                      threadCount: Math.max(1, matterThreadQ.data?.length ?? 1)
                    }}
                    onAiResearch={handleAiResearchMatter}
                    onCreateFollowupAgent={
                      triggerV2Enabled &&
                      (email.thread_id || email.message_id?.replace(/^<|>$/g, ''))
                        ? () => {
                            setMatterMenuOpen(false)
                            setFollowupOpen(true)
                          }
                        : undefined
                    }
                    onClose={() => setMatterMenuOpen(false)}
                  />
                )
              }
            : undefined
        }
        llmRunState={{ pending: actions.pending.llmRun }}
        onToggleRead={() => void actions.handleToggleRead(email.is_read)}
        isRead={email.is_read}
        readState={{ pending: actions.pending.read }}
        onToggleFlag={() => void actions.handleToggleFlag(email.is_flagged)}
        isFlagged={email.is_flagged}
        flagState={{ pending: actions.pending.flag }}
        onTogglePin={() => {
          if (internalId !== null) void togglePin(internalId)
        }}
        isPinned={isPinned}
        isImportant={email.is_important === true}
        notionUrl={email.notion_url}
        onOpenDetached={
          canOpenDetachedWindow() && !isDetachedWindow
            ? () => mailApi.email.openDetached(email.internal_id)
            : undefined
        }
        onArchive={actions.handleArchive}
        archiveState={{ pending: actions.pending.archive }}
        onDelete={() => void actions.handleDelete()}
        deleteState={{ pending: actions.pending.delete }}
        onPrev={actions.onPrev}
        onNext={actions.onNext}
      />
      <CustomAgentDrawer
        cfg={null}
        open={followupOpen}
        create
        initial={{
          title: `${t('toolbar.followupAgent')}: ${(email.subject || '').slice(0, 48)}`,
          trigger: {
            enabled: false,
            kind: 'email_filter',
            thread_ids: [email.thread_id || email.message_id?.replace(/^<|>$/g, '') || '']
          }
        }}
        onClose={() => setFollowupOpen(false)}
      />

      <div
        ref={bodyScopeRef}
        className="flex-1 overflow-y-auto scrollbar-thin"
        onScroll={(e) => {
          tabSync.handleBodyScroll(e.currentTarget.scrollTop)
        }}
      >
        <EmailDetailSubjectBar
          subject={email.subject}
          langIsEn={langIsEn}
          isTranslating={translation.isTranslating}
          hasCache={translation.hasCache}
          showTranslation={translation.showTranslation}
          translateError={translation.translateError}
          onStartTranslate={translation.startTranslate}
          onToggleTranslation={translation.toggleTranslation}
          onRetranslate={translation.retranslate}
          onDismissTranslateError={translation.dismissTranslateError}
        />

        <div className="px-4 pt-4 pb-6">
          <EmailDetailMetaGrid
            key={internalId}
            email={email}
            contactsEnabled={contactsEnabled}
            resolvedContacts={resolvedContacts}
          />

          {mattersEnabled && linkedMatters.length > 0 ? (
            <MatterBelongsCard entries={linkedMatters} />
          ) : null}

          {calendarUiEnabled(detectUiPlatform()) && (
            <MeetingInviteCard internalId={email.internal_id} />
          )}

          {ai && !isDraftsMailbox(email.mailbox) && (
            <div className="mt-6">
              <AIFieldsBlock fields={ai} internalId={email.internal_id} />
            </div>
          )}

          <ThreadAttachmentBar
            threadId={email.thread_id ?? null}
            activeInternalId={email.internal_id}
            activeSenderName={email.sender_name ?? null}
            activeSender={email.sender}
            activeDate={email.date_received ?? null}
            activeAttachments={allAttachments}
          />

          <div className="mt-7">
            <EmailBodyFrame
              internalId={email.internal_id}
              attachments={email.attachments ?? []}
              translations={translation.activeSegments}
            />
          </div>

          {allAttachments.length > 0 && (
            <div className="mt-8">
              <AttachmentList attachments={allAttachments} />
            </div>
          )}
        </div>
      </div>
    </main>
  )
}
