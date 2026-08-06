// MailAgent agent-view composer — demo-fidelity (chat-panel demo parity), Phase 8 lexical.
//
// Demo composer: a rounded shell on bg-ink-2 with a LexicalComposerInput on top (in-field @ mentions +
// / commands via ComposerTriggerPopover, inline directive chips) and an inline action row below (left:
// the "+" menu → the SHARED ModelPicker chip; right: send / cancel as round buttons). 08-04 WP6: the
// in-file AgentAttachmentButton (a "+" that opened the file picker directly) and the standalone
// connector chip both moved into the shared ComposerPlusMenu — "+" is now a real menu (attachment /
// connectors), identical on both composers. 08-04 W8: the
// former in-file AgentModelPicker + ModelVendorIcon + vendorOf were folded into
// @shared/assistant/components/ModelPicker — one component, both composers. No extended-
// thinking toggle — the agent view follows the model automatically (AgentConversation sets thinkingActive
// = thinkingSupported). @ runs an async email FTS search (custom sync-adapter + debounced fetch + isLoading
// bridge) and inserts a chip; on insert the email is added to controls.mentions so the existing send-time
// buildMentionContext resolves its body. / fires a slash command (sends a quick-action prompt). Reads
// model / attachment state from useChatComposerControls(); when no provider is mounted only send / cancel
// show (a read-only thread / bare render) — lexical input stays, the toolbar chrome drops.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, FileText, ListTodo, Mail, PenLine, Search, Square } from 'lucide-react'
import {
  ComposerPrimitive,
  ThreadPrimitive,
  unstable_defaultDirectiveFormatter,
  unstable_useSlashCommandAdapter,
  useAui,
  useAuiState,
  type Unstable_IconComponent,
  type Unstable_SlashCommand,
  type Unstable_TriggerItem
} from '@assistant-ui/react'
import { LexicalComposerInput } from '@assistant-ui/react-lexical'

import { BorderGlow } from '@shared/components/effects/BorderGlow'
import type { SearchHit, SearchResult } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { ComposerAttachmentChips } from '@shared/assistant/components/composer'
import {
  useChatComposerControls,
  type ChatComposerControls
} from '@shared/assistant/components/composerControlsContext'
import { ApprovalModePicker } from '@shared/assistant/components/ApprovalModePicker'
import { ComposerPlusMenu } from '@shared/assistant/components/ComposerPlusMenu'
import { ContextUsageRing } from '@shared/assistant/components/ContextUsageRing'
import { ModelPicker } from '@shared/assistant/components/ModelPicker'

import { AgentDirectiveChip, AgentTriggerPopover } from './AgentTriggerPopover'

// ── @ email mention adapter (async FTS search bridged into a sync trigger adapter) ───────────────
// The trigger popover takes a SYNCHRONOUS adapter (search(query) → items[]) plus a separate isLoading
// flag. We bridge async email search by: search() schedules a debounced fetch (deferred — never a
// setState during render, only a ref write + setTimeout) and returns the ref-cached items for the
// current query; the fetch setStates the results, which re-creates the adapter and re-runs search to
// return the fresh items. isLoading is driven from React state (set in the timer, cleared on settle).
const MENTION_SENTINEL = '\u0000'

/** Local mirror of @assistant-ui/core's Unstable_TriggerAdapter (not re-exported from react). */
type TriggerAdapter = {
  categories: () => readonly { readonly id: string; readonly label: string }[]
  categoryItems: (categoryId: string) => readonly Unstable_TriggerItem[]
  search: (query: string) => readonly Unstable_TriggerItem[]
}

function useEmailMentionAdapter(controls: ChatComposerControls | null): {
  adapter: TriggerAdapter
  isLoading: boolean
  onInserted: (item: Unstable_TriggerItem) => void
} {
  const mailApi = useMailApi()
  const [items, setItems] = useState<readonly Unstable_TriggerItem[]>([])
  const [loading, setLoading] = useState(false)
  // Latest query + its resolved items (ref so search() can read/clear synchronously without setState).
  const stateRef = useRef<{ query: string; items: readonly Unstable_TriggerItem[] }>({
    query: MENTION_SENTINEL,
    items: []
  })
  const hitsRef = useRef<Map<string, SearchHit>>(new Map())
  const seqRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchNow = useCallback(
    (q: string) => {
      const seq = ++seqRef.current
      setLoading(true)
      void mailApi.email
        .search({ query: q, limit: 8 })
        .then((res: SearchResult) => {
          if (seq !== seqRef.current) return
          const mapped = res.items.map((h) => {
            const id = `email-${h.internal_id}`
            hitsRef.current.set(id, h)
            return {
              id,
              type: 'email',
              label: h.subject || `#${h.internal_id}`,
              description: h.sender ?? undefined,
              metadata: { icon: 'email', internalId: h.internal_id }
            } satisfies Unstable_TriggerItem
          })
          stateRef.current = { query: q, items: mapped }
          setItems(mapped)
        })
        .catch(() => {
          if (seq !== seqRef.current) return
          stateRef.current = { query: q, items: [] }
          setItems([])
        })
        .finally(() => {
          if (seq === seqRef.current) setLoading(false)
        })
    },
    [mailApi]
  )

  // Recreated whenever results change so the popover re-reads fresh items after a fetch settles.
  const adapter = useMemo<TriggerAdapter>(
    () => ({
      categories: () => [],
      categoryItems: () => [],
      search: (query: string) => {
        if (query === MENTION_SENTINEL) return []
        if (query !== stateRef.current.query) {
          // New query — clear stale items + invalidate any in-flight fetch (seq bump) so a late
          // response for the OLD query can't repopulate stale results, even when the query is cleared
          // and no new fetch starts. Then (re)schedule the debounced fetch.
          stateRef.current = { query, items: [] }
          seqRef.current += 1
          if (timerRef.current) clearTimeout(timerRef.current)
          if (query.trim().length > 0) {
            timerRef.current = setTimeout(() => fetchNow(query), 180)
          }
        }
        return stateRef.current.items
      }
    }),
    // `items` participates so a settled fetch re-creates the adapter → the popover re-reads fresh
    // items (search() itself reads stateRef, so eslint flags items as unused — the re-creation is the point).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fetchNow, items]
  )

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    []
  )

  const onInserted = useCallback(
    (item: Unstable_TriggerItem) => {
      const hit = hitsRef.current.get(item.id)
      if (hit) controls?.onAddMention(hit)
    },
    [controls]
  )

  return { adapter, isLoading: loading, onInserted }
}

// ── / slash commands (send a representative quick-action prompt) ─────────────────────────────────
const SLASH_DEFS: ReadonlyArray<{ id: string; labelKey: string; promptKey: string; icon: string }> =
  [
    {
      id: 'summarize',
      labelKey: 'agentView.quickActions.summarize.label',
      promptKey: 'agentView.quickActions.summarize.options.unread',
      icon: 'summarize'
    },
    {
      id: 'draft',
      labelKey: 'agentView.quickActions.draft.label',
      promptKey: 'agentView.quickActions.draft.options.followup',
      icon: 'draft'
    },
    {
      id: 'search',
      labelKey: 'agentView.quickActions.search.label',
      promptKey: 'agentView.quickActions.search.options.unanswered',
      icon: 'search'
    },
    {
      id: 'todo',
      labelKey: 'agentView.quickActions.todo.label',
      promptKey: 'agentView.quickActions.todo.options.needReply',
      icon: 'todo'
    }
  ]

const SLASH_ICONS: Record<string, Unstable_IconComponent> = {
  summarize: (props) => <FileText {...props} />,
  draft: (props) => <PenLine {...props} />,
  search: (props) => <Search {...props} />,
  todo: (props) => <ListTodo {...props} />
}

// ── attachment chip stack (mentions now live in-field as directive chips) ────────────────────────
// issue #61 Lane 3 (A2): chips render from the assistant-ui COMPOSER state (the adapter's pending
// attachments), so "+", paste and drop all get the same visible feedback. The chip itself is the
// SHARED ComposerAttachmentChips (email panel + this one) — this surface only keeps its own wrapper
// (px-1 pt-1) and the wider chip cap; the previous byte-for-byte copy is exactly how the two drifted.
function AgentAttachmentChips(): React.JSX.Element | null {
  const attachmentCount = useAuiState((s) => s.composer.attachments.length)
  if (attachmentCount === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 px-1 pt-1">
      <ComposerAttachmentChips chipMaxWidthClass="max-w-[220px]" />
    </div>
  )
}

export function AgentComposer(): React.JSX.Element {
  const { t } = useTranslation()
  const aui = useAui()
  const controls = useChatComposerControls()
  const mention = useEmailMentionAdapter(controls)
  // codex r2 [D] — sendDisabled gates EVERY send path, not just the Send button: the Lexical
  // input's Enter calls aui.composer().send() directly (submitMode 'none' turns it off), slash
  // commands append through the thread (guarded in execute below), and the Root form gate covers
  // any residual requestSubmit.
  const sendDisabled = controls?.sendDisabled === true

  // Privacy guard (codex HIGH-1): the in-field @ inserts a directive chip AND records the email in
  // controls.mentions (the send-time buildMentionContext source). Lexical exposes no "directive removed"
  // callback, so a deleted chip would otherwise still send that email's body to the model. Reconcile on
  // every composer-text change: parse the current directives and drop any controls.mention whose chip is
  // gone, so a visually-removed email is never sent. The effect only REMOVES (never adds) → it can't race
  // the insert (a freshly-inserted chip is already in the text by the time this runs).
  const composerText = useAuiState((s) => s.composer.text)
  // dogfood-3: placeholder 只在首次空对话(welcome 态)显示长引导文案；进入对话后底部 docked composer
  // 不再显示 placeholder（用户要求）。空线程 = thread.messages 为空（同 AgentThread 的 isNewChatView）。
  const isEmptyThread = useAuiState((s) => s.thread.messages.length === 0)
  useEffect(() => {
    if (!controls || controls.mentions.length === 0) return
    const present = new Set<number>()
    for (const seg of unstable_defaultDirectiveFormatter.parse(composerText)) {
      if (seg.kind === 'mention') {
        const m = /^email-(\d+)$/.exec(seg.id)
        if (m) present.add(Number(m[1]))
      }
    }
    for (const mentioned of controls.mentions) {
      if (!present.has(mentioned.internal_id)) controls.onRemoveMention(mentioned.internal_id)
    }
  }, [composerText, controls])

  // / slash commands — each sends a representative quick-action prompt through the active runtime.
  // codex r2 [D] — execute is busy-gated: a slash command appends straight through the thread
  // (bypassing the form), so it must honour the same sendDisabled fence as Enter/Send.
  const slashCommands = useMemo<Unstable_SlashCommand[]>(
    () =>
      SLASH_DEFS.map((d) => ({
        id: d.id,
        label: t(d.labelKey),
        icon: d.icon,
        execute: () => {
          if (sendDisabled) return
          const thread = aui.thread()
          if (thread.getState().isRunning) return
          thread.append({
            content: [{ type: 'text', text: t(d.promptKey) }],
            runConfig: aui.composer().getState().runConfig
          })
        }
      })),
    [t, aui, sendDisabled]
  )
  const slash = unstable_useSlashCommandAdapter({
    commands: slashCommands,
    iconMap: SLASH_ICONS,
    fallbackIcon: (props) => <FileText {...props} />,
    removeOnExecute: true
  })

  // issue #61 Lane 3 (A2) — paste→attachment wiring for the Lexical input. Unlike the email
  // composer's ComposerPrimitive.Input, @assistant-ui/react-lexical has NO built-in paste handler
  // (the whole package never calls addAttachment), so a pasted screenshot silently vanished
  // (owner's真机复现). Mirror the built-in handler's semantics on the wrapper: clipboard files +
  // attachments capability → route every file into composer.addAttachment (→ the MailAgent
  // adapter). Lexical's own native paste listener runs first (it lives on the contenteditable,
  // React delegates at the root), so any co-pasted TEXT is still inserted — files-only pastes
  // have no text to lose. The adapter owns failure toasts.
  const onComposerPaste = useCallback(
    (e: React.ClipboardEvent): void => {
      const files = Array.from(e.clipboardData?.files ?? [])
      if (files.length === 0) return
      if (!aui.thread().getState().capabilities.attachments) return
      e.preventDefault()
      for (const file of files) {
        void aui
          .composer()
          .addAttachment(file)
          .catch(() => {
            /* adapter add() already toasted */
          })
      }
    },
    [aui]
  )

  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      {/* codex r2 [D] — the Root gate blocks any residual form submit while busy (radix
          composeEventHandlers skips assistant-ui's send when defaultPrevented). */}
      <ComposerPrimitive.Root
        onSubmit={(e) => {
          if (sendDisabled) e.preventDefault()
        }}
        className="relative flex w-full flex-col"
      >
        {/* AI 对话框 — reactbits 官方 BorderGlow 包裹（卡片自带 bg/border/圆角 + hover mesh 彩虹边框 +
            edge-light 辉光环；inner 容器只提供 flex + 内边距，去掉旧 shell 的 bg/rounded/accent 描边以免
            双层）。glowRadius 20（< 官方 40）控外扩，避免窄浮窗里 edge-light 撑出横向滚动条。 */}
        <BorderGlow borderRadius={16} glowRadius={20} className="w-full">
          {/* issue #61 Lane 3 (A2) — one wrapper carries BOTH file entry points: the Dropzone
              primitive owns drag&drop (handlers + data-dragging highlight), onPaste rides its
              ...rest spread for the Lexical paste wiring above. */}
          <ComposerPrimitive.AttachmentDropzone
            disabled={sendDisabled}
            onPaste={onComposerPaste}
            className="flex w-full flex-col gap-1.5 rounded-2xl p-2 transition-colors duration-fast data-[dragging=true]:bg-coral/5"
          >
            <AgentAttachmentChips />
            <LexicalComposerInput
              directiveChip={AgentDirectiveChip}
              placeholder={isEmptyThread ? t('agentView.composer.placeholder') : ''}
              // codex r2 [D] — the Lexical Enter path calls aui.composer().send() DIRECTLY (no form
              // submit to gate), so busy turns Enter-submit off entirely.
              submitMode={sendDisabled ? 'none' : 'enter'}
              autoFocus
              className="scrollbar-thin relative max-h-32 min-h-[2.5rem] w-full resize-none bg-transparent px-2.5 py-1 text-body leading-snug text-ink-fg outline-none [&_.aui-lexical-input]:min-h-lh [&_.aui-lexical-input]:outline-none [&_.aui-lexical-placeholder]:pointer-events-none [&_.aui-lexical-placeholder]:absolute [&_.aui-lexical-placeholder]:left-0 [&_.aui-lexical-placeholder]:right-0 [&_.aui-lexical-placeholder]:top-0 [&_.aui-lexical-placeholder]:truncate [&_.aui-lexical-placeholder]:px-2.5 [&_.aui-lexical-placeholder]:py-1 [&_.aui-lexical-placeholder]:text-ink-fg-3"
            />
            <div className="flex items-center justify-between gap-1 px-0.5">
              <div className="flex items-center gap-0.5">
                {/* 08-04 WP6 — 「+」不再是「直开文件选择器」的伪装钮，而是真菜单：
                    附件 + 外部连接（两面同一组件，见 ComposerPlusMenu 文件头）。 */}
                {controls && <ComposerPlusMenu variant="chip" />}
                {/* 08-04 W8 — 两个 composer 共用的模型选择器（chip variant）。 */}
                {controls && <ModelPicker controls={controls} variant="chip" />}
                {/* 07-16 — owner-global 授权模式切换 chip（Manual/Accept Edits/Bypass）。 */}
                {controls && <ApprovalModePicker variant="chip" />}
              </div>
              <div className="flex items-center">
                {/* WP-15 — 上下文占用（环 / 中性药丸 / 不渲染，见 ContextUsageRing 文件头）。 */}
                <ContextUsageRing />
                <ThreadPrimitive.If running={false}>
                  <ComposerPrimitive.Send
                    aria-label={t('chat.composer.send')}
                    title={t('chat.composer.send')}
                    // P1-2 — an approval decide holds the session's run lease; sending would 409.
                    disabled={sendDisabled}
                    className="grid size-8 shrink-0 place-items-center rounded-full bg-[rgb(var(--c-accent))] text-[rgb(var(--c-accent-fg))] transition-opacity duration-fast hover:opacity-90 disabled:opacity-40"
                  >
                    <ArrowUp size={17} strokeWidth={2.5} />
                  </ComposerPrimitive.Send>
                </ThreadPrimitive.If>
                <ThreadPrimitive.If running>
                  <ComposerPrimitive.Cancel
                    aria-label={t('chat.composer.cancel')}
                    title={t('chat.composer.cancel')}
                    className="grid size-8 shrink-0 place-items-center rounded-full bg-ink-4 text-ink-fg-1 transition-colors duration-fast hover:bg-[rgb(var(--c-accent))] hover:text-[rgb(var(--c-accent-fg))]"
                  >
                    <Square size={14} strokeWidth={2.5} className="fill-current" />
                  </ComposerPrimitive.Cancel>
                </ThreadPrimitive.If>
              </div>
            </div>
          </ComposerPrimitive.AttachmentDropzone>
        </BorderGlow>

        {/* @ email mention — async FTS search → inline directive chip + controls.mentions for send context. */}
        {controls && (
          <AgentTriggerPopover
            char="@"
            adapter={mention.adapter}
            isLoading={mention.isLoading}
            directive={{ onInserted: mention.onInserted }}
            fallbackIcon={(props) => <Mail {...props} />}
            loadingLabel={t('agentView.mention.loading')}
            emptyItemsLabel={t('agentView.mention.empty')}
          />
        )}
        {/* / slash commands. */}
        <AgentTriggerPopover char="/" {...slash} emptyItemsLabel={t('agentView.slash.empty')} />
      </ComposerPrimitive.Root>
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  )
}
