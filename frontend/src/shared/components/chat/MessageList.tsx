// Sprint 4 §6 — chat message list. Renders user / assistant / tool / system
// rows per DESIGN.md §6.2-§6.5. Inlines the bubble + tool-row + draft-card
// components since none of them are reused outside the panel.
//
// V1 redesign (Sprint 10 polish): DraftPreviewCard adopts the mockup's
// three-section shape (mockup-inbox.html lines 1278-1304): mono header
// strip with recipient, body region, footer button row with bg tints —
// far more visual weight than a single bordered <div> can carry.
// Assistant messages additionally render a per-message footer row
// (regenerate / copy / 转 Notion) per DESIGN.md §6.2.

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bookmark,
  Check,
  ChevronRight,
  Copy,
  Database,
  ExternalLink,
  Loader2,
  Pencil,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  Wrench,
  X
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { gsap, useGSAP, DUR } from '@shared/lib/gsap'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { toastError, toastSuccess } from '@shared/state/toast'
import { HoverTip } from '@shared/components/ui/HoverTip'
import { TranslatedBody } from '@shared/components/email/TranslatedBody'
import { useCjkMonoSwap } from '@shared/i18n/cjk-mono'
import { useMailApi } from '@shared/hooks/useMailApi'
import type { ChatMessage, ChatToolCall } from '@shared/api/types'
import type { PendingConfirmation } from '@shared/hooks/useEmailChat'
import { ConfirmToolDialog } from './ConfirmToolDialog'

/** Sprint 13 — DraftPreviewCard action wiring. AIChatPanel injects real
 *  handlers; if a panel doesn't (e.g. read-only conversation viewer), the
 *  card renders the buttons as data-disabled with a HoverTip explaining
 *  why (matches DESIGN.md §9.4 disabled treatment). */
export interface DraftHandlers {
  /** Open a Mail.app reply draft populated with `body`. AIChatPanel wires
   *  this to `mailApi.email.createDraft({ internalId, body })`. */
  onSend?: (body: string) => void | Promise<void>
  /** Re-fire the last user prompt that produced this draft. AIChatPanel
   *  wires this to `chat.retryLast` when available; null disables the
   *  button + surfaces the `chat.draftReply.toast.regenPending` hint. */
  onRegenerate?: (() => void | Promise<void>) | null
  /** Inline editor — Sprint 14 placeholder. Toast TODO until wired. */
  onEdit?: () => void
  /** Popout window — Sprint 14 decision. Toast TODO until wired. */
  onOpenInWindow?: () => void
  /** Disable send + show spinner during the IPC round-trip. */
  isSending?: boolean
  /** "to: …" header recipient. AIChatPanel resolves from email.to_addr or
   *  the parsed `from` (reply-to). */
  recipient?: string | null
}

// Sprint 14 PR B — inline editor handlers. The hook owns the truncate +
// re-stream wiring; this component just calls onEdit with the new content
// once the user commits the edit. AIChatPanel injects a real onEdit; a
// read-only viewer can leave it undefined → the edit affordance disappears
// (no hover icon, no aria entry point).
export interface UserHandlers {
  /** Commit the edit. Returns a Promise so the UI can flip the bubble
   *  back out of edit mode only after the dispatcher accepts the new
   *  content (saves users from a half-committed state on IPC failure). */
  onEdit?: (messageId: number, newContent: string) => void | Promise<void>
  /** True iff any message in the session is currently streaming. Edit
   *  is disabled while a turn is in flight — race-y to truncate from
   *  underneath the active assistant. */
  isStreaming?: boolean
}

interface Props {
  messages: ReadonlyArray<ChatMessage>
  streamingMessageId: number | null
  /** Surface area for the "regenerate" button on the last assistant message. */
  onRegenerate?: () => void
  /** Sprint 13 — wired by AIChatPanel; flows down to DraftPreviewCard. */
  draftHandlers?: DraftHandlers
  /** Sprint 14 PR B — wired by AIChatPanel; flows down to UserBubble. */
  userHandlers?: UserHandlers
  /** task 06-08-chat Bug 4 — pending tool-confirmations from the harness.
   *  The HEAD entry renders an inline authorization card at the bottom of
   *  the stream (after the streaming assistant turn). Empty = no card. */
  pendingConfirmations?: ReadonlyArray<PendingConfirmation>
  /** Authorize the head confirmation. `editedInput` carries the user's
   *  edited tool input when the edit-tier textarea was changed. */
  onConfirmTool?: (editedInput?: unknown) => Promise<void> | void
  /** Reject the head confirmation. */
  onCancelTool?: () => Promise<void> | void
}

const DRAFT_REPLY_MARKER = /^\s*(?:#+\s*)?DRAFT REPLY\b/i

interface ToolPayload {
  name?: string
  args?: unknown
  status?: 'running' | 'ok' | 'error'
  durationMs?: number
  detail?: string
}

function parseToolContent(content: string): ToolPayload | null {
  try {
    return JSON.parse(content) as ToolPayload
  } catch {
    return null
  }
}

function formatMs(ms: number | undefined): string {
  if (!ms || ms < 0) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function ToolCallRow({ payload }: { payload: ToolPayload }): React.ReactElement {
  const { t } = useTranslation()
  const status = payload.status ?? 'ok'
  const statusLabel = t(`chat.toolCall.${status}`)
  const dotKlass = status === 'running' ? 'dot-run' : status === 'error' ? 'dot-err' : 'dot-ok'
  // Sprint 12 — use the authored .ai-tool-row recipe in index.css so the
  // monospace pill matches mockup-inbox.html lines 2360-2380 verbatim.
  return (
    <div className="ai-tool-row" title={payload.detail ?? undefined}>
      <span className={dotKlass} aria-label={statusLabel} />
      <span className="arrow">→</span>
      <span>{payload.name ?? 'tool'}</span>
      {payload.durationMs !== undefined && (
        <span className="text-ink-fg-3">· {formatMs(payload.durationMs)}</span>
      )}
    </div>
  )
}

function DraftPreviewCard({
  content,
  recipient,
  handlers,
  isStreaming
}: {
  content: string
  recipient?: string | null
  handlers?: DraftHandlers
  /** True while the assistant message is still streaming chunks; send is
   *  blocked until the draft body settles to avoid creating a partial draft. */
  isStreaming: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  // Strip the DRAFT REPLY header before piping into TranslatedBody so the
  // marker only shows in the card chrome, not twice.
  const body = content
    .replace(DRAFT_REPLY_MARKER, '')
    .replace(/^[#:\s]+/m, '')
    .trim()

  const onSend = handlers?.onSend
  const onRegenerate = handlers?.onRegenerate
  const onEdit = handlers?.onEdit
  const onOpenInWindow = handlers?.onOpenInWindow
  const isSending = handlers?.isSending === true

  // Sprint 14 PR I — inline editor for the AI-drafted reply. Users can
  // tweak the body before opening a Mail.app draft; useful when the AI
  // got the tone close but the user wants to swap a phrase. editedBody
  // resets to the cleaned `body` every time `body` changes (new draft
  // turn) but only while editing is false, so an in-progress edit
  // survives a no-op rerender.
  const [editing, setEditing] = useState(false)
  const [editedBody, setEditedBody] = useState(body)
  const [lastBody, setLastBody] = useState(body)
  if (body !== lastBody) {
    setLastBody(body)
    if (!editing) setEditedBody(body)
  }
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    if (editing) editTextareaRef.current?.focus()
  }, [editing])

  // Phase 2 §4.5 — DraftPreviewCard 是 AI 的重点输出, 入场给一个克制的强调序列:
  // card 整体 autoAlpha+y, 然后 header→footer 极轻微 stagger. 绝对时间锚点让
  // header/footer 与 card 入场重叠 (而非串行追加), 总时长收在 card 的 DUR.base
  // 内: card 0→0.22, header 0.04→0.16, footer 0.08→0.20 (≤ DUR.slow 380ms).
  // 不给内部字段逐条动画. reduced-motion 短路.
  const cardScopeRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const footerRef = useRef<HTMLDivElement>(null)
  const reduceMotion = useReducedMotion()
  useGSAP(
    () => {
      if (reduceMotion) return
      const card = cardScopeRef.current
      if (!card) return
      const tl = gsap.timeline()
      tl.from(card, { autoAlpha: 0, y: 8, duration: DUR.base }, 0)
      if (headerRef.current) tl.from(headerRef.current, { autoAlpha: 0, duration: DUR.fast }, 0.04)
      if (footerRef.current) tl.from(footerRef.current, { autoAlpha: 0, duration: DUR.fast }, 0.08)
    },
    { scope: cardScopeRef }
  )

  // What we'll actually send. When editing, the live `editedBody` wins —
  // pressing Send while in edit mode commits the changes implicitly.
  const finalBody = editing ? editedBody : body

  // Send is only enabled once the stream finishes (otherwise the draft body
  // would be truncated mid-sentence). Backend has no partial-send semantics.
  const sendDisabled = !onSend || isStreaming || isSending || finalBody.trim().length === 0
  // Regenerate piggybacks on chat.retryLast — if that's null (no failed
  // input on file, or no chat instance), surface a HoverTip explanation.
  const regenDisabled = !onRegenerate || isStreaming || isSending
  // Sprint 14 PR I — onEdit is now the "enter edit mode" trigger; the
  // actual inline editor lives entirely in this component. Parent sets
  // onEdit to a callable (even a noop) to opt-in; the toast pending
  // copy is still surfaced when onEdit is undefined for read-only chat
  // viewers.
  const editTipKey = onEdit
    ? editing
      ? 'chat.draftReply.exitEdit'
      : 'chat.draftReply.edit'
    : 'chat.draftReply.toast.editPending'
  const popoutTipKey = onOpenInWindow
    ? 'chat.draftReply.openInWindow'
    : 'chat.draftReply.toast.popoutPending'
  const regenTipKey = regenDisabled
    ? 'chat.draftReply.toast.regenPending'
    : 'chat.draftReply.regenerate'
  const sendTipKey = isStreaming
    ? 'chat.status.streaming'
    : isSending
      ? 'chat.draftReply.sending'
      : !onSend
        ? 'chat.draftReply.toast.sendFailNoBin'
        : editing
          ? 'chat.draftReply.sendEdited'
          : 'chat.draftReply.send'

  // Sprint 12 — .draft-card recipe (coral ring + faint glow + glass bg)
  // lives in index.css so the chrome reads as the AI's headline output.
  return (
    <div ref={cardScopeRef} className="draft-card my-2">
      {/* Header — mono "DRAFT REPLY" caption + recipient */}
      <div
        ref={headerRef}
        className={cn(
          'px-3 py-2 border-b border-ink-border-soft bg-ink-2/40',
          'flex items-center justify-between'
        )}
      >
        <div className="flex items-center gap-1.5">
          <Sparkles size={11} strokeWidth={0} className="fill-coral text-coral" />
          <span className="text-meta font-mono uppercase tracking-wider text-ink-fg-1">
            {/* mockup hard-codes EN "Draft Reply" — keep the chrome caption
                English-mono regardless of locale so the 12px floor is on-spec */}
            DRAFT REPLY
          </span>
        </div>
        <span className="text-meta font-mono text-ink-fg-2 truncate max-w-[180px]">
          {recipient ? `to: ${recipient}` : 'to: —'}
        </span>
      </div>

      {/* Body — Sprint 14 PR I — flip to a textarea when the user clicks
          Edit. The textarea inherits the same coral focus-ring as the
          composer so the affordance is consistent. Closing edit mode is
          implicit on Send (uses editedBody) or via the same edit button
          (toggle off → revert to read-only TranslatedBody). */}
      <div className="px-3 py-2.5 text-aux text-ink-fg space-y-2 bg-ink-3">
        {editing ? (
          <textarea
            ref={editTextareaRef}
            value={editedBody}
            onChange={(e) => setEditedBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                setEditedBody(body)
                setEditing(false)
              }
            }}
            rows={6}
            aria-label={t('chat.draftReply.edit')}
            className={cn(
              'w-full resize-y bg-ink-2 text-ink-fg text-aux leading-snug',
              'min-h-[120px] max-h-[400px] px-2 py-1.5 rounded',
              'ring-1 ring-c-accent/40 focus:ring-c-accent focus:outline-none'
            )}
          />
        ) : (
          <TranslatedBody text={body} streaming={isStreaming} />
        )}
      </div>

      {/* Footer — coral primary action + secondary text buttons. Each button
          is HoverTip-wrapped so the disabled-reason or shortcut is always
          one cursor-rest away. */}
      <div
        ref={footerRef}
        className={cn(
          'px-3 py-2 border-t border-ink-border-soft bg-ink-2/40',
          'flex items-center gap-2'
        )}
      >
        <HoverTip text={t(sendTipKey)} side="top">
          <button
            type="button"
            onClick={
              onSend
                ? () => {
                    void onSend(finalBody)
                    // Exiting edit mode after send keeps the chip-stack
                    // mental model tidy — the draft is "shipped", no
                    // reason to keep showing an editable surface.
                    if (editing) setEditing(false)
                  }
                : undefined
            }
            disabled={sendDisabled}
            aria-label={t('chat.draftReply.send')}
            data-disabled={sendDisabled ? '' : undefined}
            tabIndex={sendDisabled ? -1 : 0}
            className={cn(
              'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded',
              'text-aux text-accent-fg bg-coral/100 hover:bg-coral-hover',
              'transition-colors duration-fast',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            )}
          >
            {isSending ? (
              <Loader2 size={11} strokeWidth={2.5} className="animate-spin" />
            ) : (
              <Send size={11} strokeWidth={2.5} />
            )}
            {isSending ? t('chat.draftReply.sending') : t('chat.draftReply.send')}
          </button>
        </HoverTip>

        <HoverTip text={t(regenTipKey)} side="top">
          <button
            type="button"
            onClick={onRegenerate ? () => void onRegenerate() : undefined}
            disabled={regenDisabled}
            aria-label={t('chat.draftReply.regenerate')}
            data-disabled={regenDisabled ? '' : undefined}
            tabIndex={regenDisabled ? -1 : 0}
            className={cn(
              'inline-flex items-center gap-1.5 px-2 py-1.5 rounded text-aux',
              'text-ink-fg-1 hover:text-ink-fg hover:bg-ink-4',
              'transition-colors duration-fast',
              'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-fg-1'
            )}
          >
            <RotateCcw size={11} strokeWidth={2} />
            {t('chat.draftReply.regenerate')}
          </button>
        </HoverTip>

        <HoverTip text={t(editTipKey)} side="top">
          <button
            type="button"
            onClick={
              onEdit
                ? () => {
                    if (editing) {
                      // Cancel — revert + leave edit mode without
                      // touching the user's draft text on the next turn.
                      setEditedBody(body)
                      setEditing(false)
                    } else {
                      setEditing(true)
                      onEdit()
                    }
                  }
                : undefined
            }
            disabled={!onEdit}
            aria-label={editing ? t('chat.draftReply.exitEdit') : t('chat.draftReply.edit')}
            aria-pressed={editing}
            data-disabled={!onEdit ? '' : undefined}
            tabIndex={!onEdit ? -1 : 0}
            className={cn(
              'inline-flex items-center px-2 py-1.5 rounded text-aux',
              editing
                ? 'text-c-accent bg-c-accent/10 hover:bg-c-accent/15'
                : 'text-ink-fg-1 hover:text-ink-fg hover:bg-ink-4',
              'transition-colors duration-fast',
              'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-fg-1'
            )}
          >
            {editing ? t('chat.draftReply.exitEdit') : t('chat.draftReply.edit')}
          </button>
        </HoverTip>

        <HoverTip text={t(popoutTipKey)} side="top" className="ml-auto">
          <button
            type="button"
            onClick={onOpenInWindow ?? undefined}
            disabled={!onOpenInWindow}
            aria-label={t('chat.draftReply.openInWindow')}
            data-disabled={!onOpenInWindow ? '' : undefined}
            tabIndex={!onOpenInWindow ? -1 : 0}
            className={cn(
              'inline-flex items-center px-2 py-1.5 rounded text-aux',
              'text-ink-fg-2 hover:text-ink-fg hover:bg-ink-4',
              'transition-colors duration-fast',
              'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-fg-2'
            )}
          >
            <ExternalLink size={11} strokeWidth={2} />
          </button>
        </HoverTip>
      </div>
    </div>
  )
}

interface UserBubbleProps {
  messageId: number
  content: string
  handlers?: UserHandlers
}

function UserBubble({ messageId, content, handlers }: UserBubbleProps): React.ReactElement {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(content)
  const [committing, setCommitting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Sprint 14 PR B — draft state is only meaningful while editing; on
  // exit (cancel/save) we don't care that draft drifts from content,
  // because the read-only branch below never reads draft. enterEdit()
  // resets draft to the current `content` at click time, so we don't
  // need a useEffect to keep them in sync — that would also trip the
  // react-hooks/no-set-state-in-effect lint per Sprint 18 review.

  // Auto-focus + select on entering edit mode; the user can either
  // type to replace or arrow-key to refine.
  useEffect(() => {
    if (!editing) return
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [editing])

  const onEdit = handlers?.onEdit
  const sessionStreaming = handlers?.isStreaming === true
  const canEdit = onEdit !== undefined && !sessionStreaming
  const canSave = canEdit && draft.trim().length > 0 && draft !== content && !committing

  function enterEdit(): void {
    if (!canEdit) return
    setDraft(content)
    setEditing(true)
  }

  function cancelEdit(): void {
    setDraft(content)
    setEditing(false)
  }

  async function commitEdit(): Promise<void> {
    if (!canSave || !onEdit) return
    setCommitting(true)
    try {
      await onEdit(messageId, draft)
      setEditing(false)
    } catch {
      // Hook surfaces the failure via its `error` slot; keep the editor
      // open so the user doesn't lose their typing on a transient IPC
      // failure (the AIChatPanel banner explains what went wrong).
    } finally {
      setCommitting(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    // ⌘↩ commits (matches Composer's send shortcut) — Escape cancels.
    // Plain Enter is left untouched so users can insert newlines inside
    // a multi-line edit; the prompt is freeform text, not a single-line
    // input.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void commitEdit()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      cancelEdit()
    }
  }

  if (editing) {
    return (
      <div className="flex flex-col items-end gap-1.5">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          aria-label={t('chat.message.editing')}
          className={cn(
            'w-[85%] max-w-[85%] rounded-lg rounded-br-sm px-3 py-2',
            'bg-ink-3 text-ink-fg text-body leading-snug resize-y min-h-[60px] max-h-40',
            'ring-1 ring-c-accent/40 focus:ring-c-accent focus:outline-none'
          )}
        />
        <div className="flex items-center gap-1 text-meta font-mono text-ink-fg-2">
          <button
            type="button"
            onClick={cancelEdit}
            aria-label={t('chat.message.cancel')}
            disabled={committing}
            className={cn(
              'inline-flex items-center gap-1 px-2 py-0.5 rounded',
              'hover:text-ink-fg hover:bg-ink-3 transition-colors duration-fast',
              committing && 'opacity-50 cursor-not-allowed'
            )}
          >
            <X size={11} strokeWidth={2} />
            {t('chat.message.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void commitEdit()}
            aria-label={t('chat.message.save')}
            disabled={!canSave}
            className={cn(
              'inline-flex items-center gap-1 px-2 py-0.5 rounded',
              'transition-colors duration-fast',
              canSave ? 'text-c-accent hover:bg-c-accent/15' : 'text-ink-fg-3 cursor-not-allowed'
            )}
          >
            {committing ? (
              <Loader2 size={11} strokeWidth={2} className="animate-spin" />
            ) : (
              <Check size={11} strokeWidth={2} />
            )}
            {t('chat.message.save')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex justify-end group">
      {/* Edit affordance — hover-only chip to the left of the bubble.
          group/group-hover keeps the icon out of the layout flow until
          the user actually mouses over the message. Disabled with a
          HoverTip when the session is streaming so we don't visually
          suggest editing is OK and then silently no-op. */}
      {onEdit !== undefined && (
        <HoverTip
          text={sessionStreaming ? t('chat.message.editBlocked') : t('chat.message.edit')}
          side="top"
        >
          <button
            type="button"
            onClick={enterEdit}
            disabled={!canEdit}
            aria-label={t('chat.message.edit')}
            className={cn(
              'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
              'transition-opacity duration-fast',
              'self-center mr-1 p-1 rounded',
              canEdit
                ? 'text-ink-fg-2 hover:text-ink-fg hover:bg-ink-3'
                : 'text-ink-fg-3 cursor-not-allowed'
            )}
          >
            <Pencil size={11} strokeWidth={2} />
          </button>
        </HoverTip>
      )}
      <div
        className={cn(
          'max-w-[85%] rounded-lg rounded-br-sm px-3 py-2',
          'bg-ink-4 text-ink-fg text-body whitespace-pre-wrap break-words leading-snug'
        )}
      >
        {content}
      </div>
    </div>
  )
}

// Sprint 19 P1-C — module-level cache for chat.kosAvailable. The button
// gate is the same answer for every assistant bubble in the app session
// (driven by main-process env), so we resolve the IPC once and share the
// promise across all AssistantMessageFooter mounts instead of one call per
// message. null = not yet fetched.
let _kosAvailablePromise: Promise<boolean> | null = null

function fetchKosAvailable(api: ReturnType<typeof useMailApi>): Promise<boolean> {
  if (_kosAvailablePromise === null) {
    _kosAvailablePromise = api.chat.kosAvailable().catch(() => false)
  }
  return _kosAvailablePromise
}

/** Resolve "is the [✨ 保存到 KOS] action available" once on mount. Returns
 *  false until resolved so the button never flashes before we know KOS is
 *  configured. */
function useKosAvailable(): boolean {
  const mailApi = useMailApi()
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    let cancelled = false
    void fetchKosAvailable(mailApi).then((v) => {
      if (!cancelled) setAvailable(v)
    })
    return (): void => {
      cancelled = true
    }
  }, [mailApi])
  return available
}

function AssistantMessageFooter({
  messageId,
  content
}: {
  messageId: number
  content: string
}): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  // Sprint 19 P1-C — wired to real chat:saveToKos IPC. Copy 接通
  // navigator.clipboard.writeText(content). Regenerate / toNotion 仍是
  // V1 placeholders 走 toast "即将上线" 直到 IPC 接通.
  const [saveBusy, setSaveBusy] = useState(false)
  // Sprint 19 P1-C — only show [✨ 保存到 KOS] when KOS is configured
  // (KOS_MCP_BASE + OAuth creds). Renderer can't read env, so this rides
  // a cached chat.kosAvailable IPC.
  const kosAvailable = useKosAvailable()
  const soon = (): void => {
    toastSuccess(t('shortcutHelp.soon'))
  }
  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(content)
      toastSuccess(t('chat.messageActions.copyOk'))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toastError(t('chat.messageActions.copyFail'), msg)
    }
  }
  const onSaveToKos = async (): Promise<void> => {
    if (saveBusy) return
    setSaveBusy(true)
    try {
      const r = await mailApi.chat.saveToKos({ messageId })
      // Detail = slug so user sees where it landed (debuggable);
      // backend may return server-canonicalized slug different from
      // the default we computed if name normalization happened.
      toastSuccess(t('chat.messageActions.saveToKosOk'), r.slug)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toastError(t('chat.messageActions.saveToKosFail'), msg)
    } finally {
      setSaveBusy(false)
    }
  }
  return (
    <div className="flex items-center gap-2 pt-1 text-meta font-mono text-ink-fg-2">
      <button
        type="button"
        onClick={soon}
        className="inline-flex items-center gap-1 hover:text-ink-fg transition-colors duration-fast"
      >
        <RotateCcw size={11} strokeWidth={2} />
        {t('chat.draftReply.regenerate')}
      </button>
      <span className="text-ink-fg-3">·</span>
      <button
        type="button"
        onClick={onCopy}
        className="inline-flex items-center gap-1 hover:text-ink-fg transition-colors duration-fast"
        aria-label={t('chat.messageActions.copy')}
      >
        <Copy size={11} strokeWidth={2} />
        {t('chat.messageActions.copy')}
      </button>
      <span className="text-ink-fg-3">·</span>
      <button
        type="button"
        onClick={soon}
        className="inline-flex items-center gap-1 hover:text-ink-fg transition-colors duration-fast"
      >
        <Bookmark size={11} strokeWidth={2} />
        {t('chat.messageActions.toNotion')}
      </button>
      {kosAvailable && (
        <>
          <span className="text-ink-fg-3">·</span>
          <button
            type="button"
            onClick={onSaveToKos}
            disabled={saveBusy}
            className={cn(
              'inline-flex items-center gap-1 hover:text-ink-fg transition-colors duration-fast',
              saveBusy && 'opacity-50 cursor-wait'
            )}
            aria-label={t('chat.messageActions.saveToKos')}
          >
            <Sparkles size={11} strokeWidth={2} />
            {t('chat.messageActions.saveToKos')}
          </button>
        </>
      )}
    </div>
  )
}

// Sprint 20 — tool-call chip 升级（Claude Code 风）。每个 chat_tool_call 渲染成
// 一张可展开卡：工具图标 + 工具名 + 参数预览 + 状态/耗时 + KOS 徽标，展开看
// 参数 / 命中结果 JSON。数据来自 listToolCalls(messageId)（ChatToolCall）。
// Streaming 期间 skip 避免抖动（tool_call event 触发 listMessages refresh →
// 本组件 unmount→remount）。移植自 ~/Downloads/agents/chat-tab.jsx ToolCallChip。

/** tool_name → lucide 图标元素。KOS 工具用 Database，搜索类用 Search，其余 Wrench。
 *  返回 ReactElement（而非组件引用）以避开 react-hooks/static-components —— 这里是
 *  从固定的 3 个 lucide 组件里**选择**，不是 render 期创建新组件。 */
function toolIconEl(name: string, size = 11): React.ReactElement {
  if (name.startsWith('kos_')) return <Database size={size} strokeWidth={2} />
  if (name.includes('search') || name.includes('find'))
    return <Search size={size} strokeWidth={2} />
  return <Wrench size={size} strokeWidth={2} />
}

/** 从 input_json 提取一个代表性参数值做行内预览（首个非空字符串，否则首个数字）。 */
function toolInputPreview(json: string): string {
  try {
    const o = JSON.parse(json) as Record<string, unknown>
    if (o && typeof o === 'object') {
      for (const v of Object.values(o)) {
        if (typeof v === 'string' && v.trim()) return v.length > 48 ? `${v.slice(0, 48)}…` : v
      }
      for (const v of Object.values(o)) {
        if (typeof v === 'number') return String(v)
      }
    }
  } catch {
    /* 非 JSON / 空 → 无预览 */
  }
  return ''
}

function ToolCallChip({ call }: { call: ChatToolCall }): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const isKos = call.tool_name.startsWith('kos_')
  const running =
    call.status === 'running' || call.status === 'pending' || call.status === 'confirmed'
  const err = call.status === 'error' || call.status === 'canceled'
  const inputEffective = call.user_edited_input_json ?? call.input_json
  const preview = toolInputPreview(inputEffective)

  return (
    <div className="rounded-md border border-ink-border-soft bg-ink-2/40 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 w-full px-2.5 py-1.5 text-left hover:bg-ink-fg/[0.03] transition-colors duration-fast"
        aria-expanded={open}
      >
        <span
          className="grid place-items-center w-[18px] h-[18px] rounded shrink-0"
          style={{ background: 'rgb(var(--c-ai) / 0.12)', color: 'rgb(var(--c-ai))' }}
        >
          {toolIconEl(call.tool_name)}
        </span>
        <span className="text-meta font-mono text-ink-fg shrink-0">{call.tool_name}</span>
        {preview && (
          <span className="text-meta text-ink-fg-2 truncate min-w-0" title={preview}>
            {preview}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {running ? (
            <Loader2 size={11} strokeWidth={2} className="text-coral animate-spin" />
          ) : (
            <>
              {err ? (
                <X size={11} strokeWidth={2.5} className="text-fail" />
              ) : (
                <Check size={11} strokeWidth={2.5} className="text-ok" />
              )}
              {call.duration_ms !== null && (
                <span className="text-micro font-mono text-ink-fg-3 tabular-nums">
                  {formatMs(call.duration_ms)}
                </span>
              )}
            </>
          )}
        </span>
        <ChevronRight
          size={12}
          className={cn(
            'shrink-0 text-ink-fg-3 transition-transform duration-fast',
            open && 'rotate-90'
          )}
        />
      </button>
      {/* 展开走纯 CSS grid-template-rows 0fr→1fr（§4.1：能 grid-rows 不上 GSAP；
          也避开 MessageList 内 bubble/DraftCard GSAP 冲突）。内容常驻挂载双向过渡；
          reduced-motion 走 motion-reduce 去过渡。 */}
      <div
        aria-hidden={!open}
        className="grid transition-[grid-template-rows] duration-base ease-standard motion-reduce:transition-none"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <div className="px-2.5 pb-2.5 pt-1 space-y-2 border-t border-ink-border-soft">
            <div className="flex items-center gap-2 pt-1">
              <span className="text-micro font-mono text-ink-fg-2">{call.tool_name}</span>
              {isKos && (
                <span
                  className="text-micro font-mono px-1.5 py-px rounded"
                  style={{
                    color: 'rgb(var(--c-ai))',
                    background: 'rgb(var(--c-ai) / 0.12)',
                    border: '1px solid rgb(var(--c-ai) / 0.22)'
                  }}
                >
                  KOS
                </span>
              )}
            </div>
            <div>
              <div className="text-ink-fg-3 text-micro mb-0.5 font-mono uppercase tracking-wide">
                {t('chat.toolCalls.input')}
                {call.user_edited_input_json !== null && (
                  <span className="ml-1 text-coral">({t('chat.toolCalls.userEdited')})</span>
                )}
              </div>
              <pre className="text-micro font-mono bg-ink-1 rounded px-2 py-1 overflow-x-auto whitespace-pre-wrap break-words scrollbar-thin">
                {inputEffective}
              </pre>
            </div>
            {call.output_json !== null ? (
              <div>
                <div className="text-ink-fg-3 text-micro mb-0.5 font-mono uppercase tracking-wide">
                  {t('chat.toolCalls.output')}
                </div>
                <pre className="text-micro font-mono bg-ink-1 rounded px-2 py-1 overflow-x-auto overflow-y-auto max-h-48 whitespace-pre-wrap break-words scrollbar-thin">
                  {call.output_json}
                </pre>
              </div>
            ) : (
              running && (
                <div className="text-micro font-mono text-ink-fg-3">
                  {t('chat.toolCall.running')}…
                </div>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function ToolCallAuditRow({
  messageId,
  isStreaming
}: {
  messageId: number
  isStreaming: boolean
}): React.ReactElement | null {
  const mailApi = useMailApi()
  const [calls, setCalls] = useState<ChatToolCall[]>([])

  useEffect(() => {
    if (isStreaming) return
    let cancelled = false
    void (async () => {
      try {
        const rows = await mailApi.chat.listToolCalls(messageId)
        if (!cancelled) setCalls(rows)
      } catch {
        // 静默 — audit 拉不到只是 dogfood 体验降级, 不阻塞 chat
      }
    })()
    return (): void => {
      cancelled = true
    }
  }, [messageId, isStreaming, mailApi])

  if (calls.length === 0) return null

  return (
    <div className="space-y-1">
      {calls.map((c) => (
        <ToolCallChip key={c.id} call={c} />
      ))}
    </div>
  )
}

function AssistantBubble({
  message,
  isStreaming,
  draftHandlers
}: {
  message: ChatMessage
  isStreaming: boolean
  draftHandlers?: DraftHandlers
}): React.ReactElement {
  const { t } = useTranslation()
  // Empty + streaming: render the thinking pulse instead of an empty bubble.
  if (message.content.length === 0 && isStreaming) {
    return (
      <div className="flex items-center gap-2 py-1 text-aux text-ink-fg-2">
        <Loader2 size={12} strokeWidth={2} className="animate-spin" />
        <span>{t('chat.status.thinking')}</span>
      </div>
    )
  }
  if (message.status === 'error') {
    return (
      <div
        className={cn(
          'flex items-start gap-2 rounded-md p-3',
          'border border-fail/30 bg-fail/10 text-aux text-fail'
        )}
      >
        <X size={13} strokeWidth={2} className="shrink-0 mt-0.5" />
        <div className="flex-1">
          <div className="font-medium">{t('chat.status.error')}</div>
          {message.error_message && (
            <div className="text-meta font-mono text-ink-fg-3 mt-1">{message.error_message}</div>
          )}
        </div>
      </div>
    )
  }

  // Sprint 13 fix — header reads real ChatMessage fields (model / cost_usd /
  // token counts) instead of a stale `metadata.model` object that was never
  // populated. mockup L2351-2357 + L2447-2452: "Notion Agent · Jarvis · 2.4s
  // · $0.0034" / "Notion Agent · drafting…  ·  1.1s · streaming".
  const model = message.model
  const costUsd = message.cost_usd
  const totalTokens =
    (message.tokens_input ?? 0) + (message.tokens_output ?? 0) > 0
      ? (message.tokens_input ?? 0) + (message.tokens_output ?? 0)
      : null
  const showHeader = Boolean(model || isStreaming)
  const headerMeta = (
    <>
      {/* Sprint 13 — Loader2 spinner during streaming (mockup L2448 path
          shape), Sparkles ✦ when complete (mockup L2353). Mixing a star
          icon with `animate-spin` reads as a glitch rather than progress. */}
      {isStreaming ? (
        <Loader2 size={11} strokeWidth={2.5} className="text-coral shrink-0 animate-spin" />
      ) : (
        <Sparkles size={11} strokeWidth={0} className="text-coral fill-coral shrink-0" />
      )}
      <span>{isStreaming ? t('chat.status.streaming') : (model ?? 'AI')}</span>
      {totalTokens !== null && (
        <>
          <span className="text-ink-fg-3">·</span>
          <span className="tabular-nums">{totalTokens.toLocaleString()}t</span>
        </>
      )}
      {costUsd !== null && costUsd > 0 && (
        <>
          <span className="text-ink-fg-3">·</span>
          <span className="tabular-nums">${costUsd.toFixed(4)}</span>
        </>
      )}
    </>
  )

  if (DRAFT_REPLY_MARKER.test(message.content)) {
    return (
      <div className="space-y-2">
        {showHeader && (
          <div className="flex items-center gap-1.5 text-meta font-mono text-ink-fg-2">
            {headerMeta}
          </div>
        )}
        <DraftPreviewCard
          content={message.content}
          recipient={draftHandlers?.recipient ?? null}
          handlers={draftHandlers}
          isStreaming={isStreaming}
        />
        <ToolCallAuditRow messageId={message.id} isStreaming={isStreaming} />
        {!isStreaming && (
          <AssistantMessageFooter messageId={message.id} content={message.content} />
        )}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {showHeader && (
        <div className="flex items-center gap-1.5 text-meta font-mono text-ink-fg-2">
          {headerMeta}
        </div>
      )}
      <div className="text-body text-ink-fg leading-relaxed">
        {/* Streamdown 的 caret="block" 在文末 inline 渲染打字光标 (依赖 isAnimating
            =streaming); 不再叠加外部 cursor-blink span, 避免双光标。 */}
        <TranslatedBody text={message.content || ' '} streaming={isStreaming} />
      </div>
      <ToolCallAuditRow messageId={message.id} isStreaming={isStreaming} />
      {!isStreaming && <AssistantMessageFooter messageId={message.id} content={message.content} />}
    </div>
  )
}

// Phase 2 §6.2 — 新消息气泡入场. 只对*真正新增*的消息播一次入场, 排除:
// ① 历史会话加载 (首次渲染时一批旧消息已在 messages 里, 不应逐条动);
// ② streaming chunk 更新 (流式追加 token 不是新气泡, 同一 id 只播一次).
// 父组件用 seen-set 判定: 首渲染把全部已有 id seed 进集合 (animate=false),
// 之后任何不在集合里的 id 即新增 (animate=true). reduced-motion 短路.
function MessageRow({
  animate,
  className,
  children
}: {
  animate: boolean
  className: string
  children: React.ReactNode
}): React.ReactElement {
  const rowRef = useRef<HTMLDivElement>(null)
  const reduceMotion = useReducedMotion()
  useGSAP(
    () => {
      if (!animate || reduceMotion) return
      const el = rowRef.current
      if (!el) return
      gsap.from(el, { autoAlpha: 0, y: 8, duration: DUR.base, overwrite: 'auto' })
    },
    { scope: rowRef }
  )
  return (
    <div ref={rowRef} className={className}>
      {children}
    </div>
  )
}

// Long-thread truncation cap. The dispatcher feeds the full message
// history to the backend (so multi-turn context is preserved), but the
// renderer only paints the last N — anything older becomes a system
// divider "已截断早期 X 条" / "earlier X truncated" pill. Sprint 4
// state machine #1 (REVIEW-LOG C-04 carry-forward).
const MAX_RENDERED_MESSAGES = 40

/** Distance from the bottom edge (px) at which we still consider the user
 *  "reading the latest" — within this band a new chunk will auto-scroll;
 *  past it (user scrolled up to re-read) we leave them alone. Sprint 4
 *  review (opus L carry-forward). */
const AUTO_SCROLL_BAND_PX = 80

export function MessageList({
  messages,
  streamingMessageId,
  draftHandlers,
  userHandlers,
  pendingConfirmations,
  onConfirmTool,
  onCancelTool
}: Props): React.ReactElement {
  const { t } = useTranslation()
  // (opus M) CJK-safe class for the truncated / system divider strings —
  // both resolve to Chinese under zh-CN locale and would otherwise render
  // at the 11px mono floor that DESIGN.md §14 #2 forbids.
  const dividerKlass = useCjkMonoSwap('text-micro font-mono uppercase tracking-wider')
  const containerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Phase 2 §6.2 — 入场判定. initialIds 在首渲染 seed 当时全部已有的 messageId
  // (lazy useState initializer, 只算一次, 后续永不变); 凡不在其中的 id 即首渲染
  // 之后才出现的新气泡 → 该 row animate=true. 历史会话首批旧消息全在 seed 里 →
  // animate=false, 不逐条动. 同一 id 的 row 按 key 只挂载一次, 而 MessageRow 的
  // useGSAP 默认 deps=[] 只在挂载那一刻读 animate → 流式 chunk 追加 token 不会重播.
  // 用 state 读取保持纯渲染 (render-safe), 不在 render 期触碰 ref.current
  // (React 19 react-hooks/refs: 渲染期读 ref 是反模式, 可能读到 stale 值).
  const [initialIds] = useState<Set<number>>(() => new Set(messages.map((m) => m.id)))
  const isNew = (id: number): boolean => !initialIds.has(id)

  // Scroll to bottom on new content — but only if the user is already
  // near the bottom. Otherwise an auto-scroll during streaming would
  // hijack manual reading of earlier turns.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight
    if (distance > AUTO_SCROLL_BAND_PX) return
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [messages])

  const total = messages.length
  const truncated = Math.max(0, total - MAX_RENDERED_MESSAGES)
  // Sprint 4 review (codex low): the truncation divider itself counts
  // toward the visible cap — keep total rendered elements ≤ MAX_RENDERED_MESSAGES.
  const sliceSize = truncated > 0 ? MAX_RENDERED_MESSAGES - 1 : MAX_RENDERED_MESSAGES
  const visible = total > sliceSize ? messages.slice(-sliceSize) : messages

  const rendered: React.ReactElement[] = []
  if (truncated > 0) {
    rendered.push(
      <div key="__truncated__" className="px-3 py-2 text-center">
        <span className={cn(dividerKlass, 'text-ink-fg-3')}>
          {t('chat.truncated', { n: truncated })}
        </span>
      </div>
    )
  }
  for (const m of visible) {
    if (m.role === 'user') {
      rendered.push(
        <MessageRow key={m.id} animate={isNew(m.id)} className="px-3">
          <UserBubble messageId={m.id} content={m.content} handlers={userHandlers} />
        </MessageRow>
      )
    } else if (m.role === 'assistant') {
      rendered.push(
        <MessageRow key={m.id} animate={isNew(m.id)} className="px-3">
          <AssistantBubble
            message={m}
            isStreaming={m.id === streamingMessageId}
            draftHandlers={draftHandlers}
          />
        </MessageRow>
      )
    } else if (m.role === 'tool') {
      const payload = parseToolContent(m.content)
      if (payload) {
        rendered.push(
          <div key={m.id} className="px-3">
            <ToolCallRow payload={payload} />
          </div>
        )
      }
    } else if (m.role === 'system') {
      // Sprint 12 — flanked-hairline divider per mockup-inbox.html line 2337.
      rendered.push(
        <div key={m.id} className="px-3 py-1 flex items-center gap-2">
          <div className="flex-1 h-px bg-ink-border-soft" />
          <span className={cn(dividerKlass, 'text-ink-fg-3 shrink-0')}>{m.content}</span>
          <div className="flex-1 h-px bg-ink-border-soft" />
        </div>
      )
    }
  }

  return (
    <div
      ref={containerRef}
      // Bug 3 (task 06-08-chat) — min-w-0 lets wide tool-output <pre> blocks
      // scroll/wrap inside the fixed 360px drawer instead of forcing this
      // flex item to its content's min-content width (the flex `min-width:auto`
      // default), which otherwise stretches the whole <aside> past 360px.
      className="flex-1 min-h-0 min-w-0 overflow-y-auto scrollbar-thin space-y-3 py-3"
    >
      {rendered}
      {/* Bug 4 (task 06-08-chat) — inline tool-confirmation card at the
          bottom of the stream (after the streaming assistant turn). The
          harness blocks on this while dispatching a write-class tool, so
          the streaming assistant is the last row → the card reads as "the
          AI wants to run X, please authorize" right where it belongs.
          px-3 matches the message rows; the card itself is min-w-0 + w-full
          so it stays inside the 360px drawer. */}
      {pendingConfirmations && pendingConfirmations.length > 0 && (
        <div className="px-3">
          <ConfirmToolDialog
            key={pendingConfirmations[0].toolUseId}
            pending={pendingConfirmations[0]}
            onConfirm={(editedInput) => onConfirmTool?.(editedInput)}
            onCancel={() => onCancelTool?.()}
          />
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  )
}
