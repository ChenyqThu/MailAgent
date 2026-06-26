// MailAgent agent-view composer — demo-fidelity (chat-panel demo parity), Phase 8 lexical.
//
// Demo composer: a rounded shell on bg-ink-2 with a LexicalComposerInput on top (in-field @ mentions +
// / commands via ComposerTriggerPopover, inline directive chips) and an inline action row below (left:
// attach "+" → model picker WITH vendor icon; right: send / cancel as round buttons). No extended-
// thinking toggle — the agent view follows the model automatically (AgentConversation sets thinkingActive
// = thinkingSupported). @ runs an async email FTS search (custom sync-adapter + debounced fetch + isLoading
// bridge) and inserts a chip; on insert the email is added to controls.mentions so the existing send-time
// buildMentionContext resolves its body. / fires a slash command (sends a quick-action prompt). Reads
// model / attachment state from useChatComposerControls(); when no provider is mounted only send / cancel
// show (a read-only thread / bare render) — lexical input stays, the toolbar chrome drops.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowUp,
  ChevronDown,
  Cpu,
  FileText,
  ListTodo,
  Mail,
  Paperclip,
  PenLine,
  Plus,
  Search,
  Square,
  X
} from 'lucide-react'
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

import { cn } from '@shared/lib/cn'
import { HoverTip } from '@shared/components/ui/HoverTip'
import type { SearchHit, SearchResult } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { formatAttachmentSize, readAttachment } from '@shared/lib/chat-attachments'
import { toastError } from '@shared/state/toast'
import {
  useChatComposerControls,
  type ChatComposerControls
} from '@shared/assistant/components/composerControls'

import { AgentDirectiveChip, AgentTriggerPopover } from './AgentTriggerPopover'

// ── vendor logo (真实厂商 logo, currentColor — 来源 assistant-ui.com/icons) ───────────────────────
type Vendor = 'anthropic' | 'openai' | 'google' | 'other'
function vendorOf(modelId: string | null): Vendor {
  const m = (modelId ?? '').toLowerCase()
  if (m.startsWith('claude')) return 'anthropic'
  if (m.startsWith('gpt') || /^o[134]/.test(m)) return 'openai'
  if (m.startsWith('gemini')) return 'google'
  return 'other'
}

/** 真实厂商 logo — 单色 `currentColor`（跟随按钮文字色，亮暗自适应）。Anthropic / OpenAI 用官方
 *  logo path（assistant-ui.com/icons）；Gemini 用其星形轮廓；其他用中性 Cpu。dogfood-2 user feedback：
 *  恢复 vendor icon（B3 误删），换成真实 logo 而非上轮的简化星芒。 */
function ModelVendorIcon({ vendor }: { vendor: Vendor }): React.JSX.Element {
  switch (vendor) {
    case 'anthropic':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className="size-3.5 shrink-0" aria-hidden>
          <path d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z" />
        </svg>
      )
    case 'openai':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className="size-3.5 shrink-0" aria-hidden>
          <path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" />
        </svg>
      )
    case 'google':
      return (
        <svg viewBox="0 0 65 65" fill="currentColor" className="size-3.5 shrink-0" aria-hidden>
          <path d="M32.447 0c.68 0 1.273.465 1.439 1.125a38.904 38.904 0 001.999 5.905c2.152 5 5.105 9.376 8.854 13.125 3.751 3.75 8.126 6.703 13.125 8.855a38.98 38.98 0 005.906 1.999c.66.166 1.124.758 1.124 1.438 0 .68-.464 1.273-1.125 1.439a38.902 38.902 0 00-5.905 1.999c-5 2.152-9.375 5.105-13.125 8.854-3.749 3.751-6.702 8.126-8.854 13.125a38.973 38.973 0 00-2 5.906 1.485 1.485 0 01-1.438 1.124c-.68 0-1.272-.464-1.438-1.125a38.913 38.913 0 00-2-5.905c-2.151-5-5.103-9.375-8.854-13.125-3.75-3.749-8.125-6.702-13.125-8.854a38.973 38.973 0 00-5.905-2A1.485 1.485 0 010 32.448c0-.68.465-1.272 1.125-1.438a38.903 38.903 0 005.905-2c5-2.151 9.376-5.104 13.125-8.854 3.75-3.749 6.703-8.125 8.855-13.125a38.972 38.972 0 001.999-5.905A1.485 1.485 0 0132.447 0z" />
        </svg>
      )
    default:
      return <Cpu size={13} strokeWidth={2} className="shrink-0 text-ink-fg-2" aria-hidden />
  }
}

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

// ── attachment ("+") ─────────────────────────────────────────────────────────────
function AgentAttachmentButton({
  controls
}: {
  controls: ChatComposerControls
}): React.JSX.Element {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const onPick = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return
    for (const file of Array.from(files)) {
      try {
        controls.onAddAttachment(await readAttachment(file))
      } catch {
        toastError(t('chat.attachment.readFailed', { defaultValue: 'Could not read attachment' }))
      }
    }
  }
  return (
    <>
      <HoverTip text={t('chat.composer.attach')} side="top">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          aria-label={t('chat.composer.attach')}
          className="grid size-7 shrink-0 place-items-center rounded-full text-ink-fg-2 transition-colors duration-fast hover:bg-ink-4 hover:text-ink-fg"
        >
          <Plus size={17} strokeWidth={2} />
        </button>
      </HoverTip>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void onPick(e.target.files)
          e.target.value = ''
        }}
      />
    </>
  )
}

// ── model picker (vendor icon) ───────────────────────────────────────────────────
function AgentModelPicker({
  controls
}: {
  controls: ChatComposerControls
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return (): void => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  if (controls.availableModels.length === 0) return null
  const disabled = controls.modelPickerDisabled
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        aria-label={t('chat.composer.model')}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          'flex h-7 items-center gap-1.5 rounded-full px-2 text-meta font-medium transition-colors duration-fast',
          disabled
            ? 'cursor-not-allowed text-ink-fg-3 opacity-50'
            : open
              ? 'bg-coral/10 text-coral'
              : 'text-ink-fg-2 hover:bg-ink-4 hover:text-ink-fg'
        )}
      >
        <ModelVendorIcon vendor={vendorOf(controls.model)} />
        <span className="max-w-[118px] truncate font-mono">
          {controls.model ?? t('chat.composer.model')}
        </span>
        <ChevronDown size={13} strokeWidth={2} className="shrink-0 opacity-60" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t('chat.composer.model')}
          className="glass-pop absolute bottom-full left-0 z-50 mb-1.5 min-w-[190px] rounded-lg py-1 shadow-md"
        >
          {controls.availableModels.map((m) => {
            const active = m === controls.model
            return (
              <button
                key={m}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  controls.onModelChange(m)
                  setOpen(false)
                }}
                className={cn(
                  'flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left text-meta font-mono transition-colors duration-fast',
                  active
                    ? 'bg-coral/10 text-coral'
                    : 'text-ink-fg-1 hover:bg-ink-4 hover:text-ink-fg'
                )}
              >
                <ModelVendorIcon vendor={vendorOf(m)} />
                <span className="truncate">{m}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── attachment chip stack (mentions now live in-field as directive chips) ────────────────────────
function AgentAttachmentChips({
  controls
}: {
  controls: ChatComposerControls
}): React.JSX.Element | null {
  if (controls.attachments.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 px-1 pt-1">
      {controls.attachments.map((a) => (
        <span
          key={`a-${a.id}`}
          className="inline-flex max-w-[220px] items-center gap-1 rounded-md border border-ink-border bg-ink-3 px-2 py-1 text-meta text-ink-fg-1"
        >
          <Paperclip size={11} strokeWidth={2} className="shrink-0 text-ink-fg-3" />
          <span className="truncate">{a.filename}</span>
          <span className="shrink-0 font-mono text-micro text-ink-fg-3">
            {formatAttachmentSize(a.sizeBytes)}
          </span>
          <button
            type="button"
            onClick={() => controls.onRemoveAttachment(a.id)}
            aria-label="remove"
            className="shrink-0 text-ink-fg-3 hover:text-ink-fg"
          >
            <X size={11} strokeWidth={2.5} />
          </button>
        </span>
      ))}
    </div>
  )
}

export function AgentComposer(): React.JSX.Element {
  const { t } = useTranslation()
  const aui = useAui()
  const controls = useChatComposerControls()
  const mention = useEmailMentionAdapter(controls)

  // Privacy guard (codex HIGH-1): the in-field @ inserts a directive chip AND records the email in
  // controls.mentions (the send-time buildMentionContext source). Lexical exposes no "directive removed"
  // callback, so a deleted chip would otherwise still send that email's body to the model. Reconcile on
  // every composer-text change: parse the current directives and drop any controls.mention whose chip is
  // gone, so a visually-removed email is never sent. The effect only REMOVES (never adds) → it can't race
  // the insert (a freshly-inserted chip is already in the text by the time this runs).
  const composerText = useAuiState((s) => s.composer.text)
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
  const slashCommands = useMemo<Unstable_SlashCommand[]>(
    () =>
      SLASH_DEFS.map((d) => ({
        id: d.id,
        label: t(d.labelKey),
        icon: d.icon,
        execute: () => {
          const thread = aui.thread()
          if (thread.getState().isRunning) return
          thread.append({
            content: [{ type: 'text', text: t(d.promptKey) }],
            runConfig: aui.composer().getState().runConfig
          })
        }
      })),
    [t, aui]
  )
  const slash = unstable_useSlashCommandAdapter({
    commands: slashCommands,
    iconMap: SLASH_ICONS,
    fallbackIcon: (props) => <FileText {...props} />,
    removeOnExecute: true
  })

  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.Root className="relative flex w-full flex-col">
        <div className="flex w-full flex-col gap-1.5 rounded-2xl border border-[var(--hairline)] bg-ink-2 p-2 shadow-[0_4px_16px_-8px_rgba(0,0,0,0.18),0_1px_2px_rgba(0,0,0,0.06)] transition-[border-color,box-shadow] duration-fast focus-within:border-[rgb(var(--c-accent))]">
          {controls && <AgentAttachmentChips controls={controls} />}
          <LexicalComposerInput
            directiveChip={AgentDirectiveChip}
            placeholder={t('agentView.composer.placeholder')}
            autoFocus
            className="scrollbar-thin max-h-32 min-h-[2.5rem] w-full resize-none bg-transparent px-2.5 py-1.5 text-body leading-snug text-ink-fg outline-none [&_.aui-lexical-input]:outline-none [&_.aui-lexical-placeholder]:pointer-events-none [&_.aui-lexical-placeholder]:absolute [&_.aui-lexical-placeholder]:left-0 [&_.aui-lexical-placeholder]:right-0 [&_.aui-lexical-placeholder]:top-0 [&_.aui-lexical-placeholder]:truncate [&_.aui-lexical-placeholder]:px-2.5 [&_.aui-lexical-placeholder]:py-1.5 [&_.aui-lexical-placeholder]:text-ink-fg-3"
          />
          <div className="flex items-center justify-between gap-1 px-0.5">
            <div className="flex items-center gap-0.5">
              {controls && <AgentAttachmentButton controls={controls} />}
              {controls && <AgentModelPicker controls={controls} />}
            </div>
            <div className="flex items-center">
              <ThreadPrimitive.If running={false}>
                <ComposerPrimitive.Send
                  aria-label={t('chat.composer.send')}
                  title={t('chat.composer.send')}
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
        </div>

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
