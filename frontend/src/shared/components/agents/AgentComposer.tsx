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
        <span className="max-w-[130px] truncate font-mono">
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
            className="scrollbar-thin max-h-32 min-h-[2.5rem] w-full resize-none bg-transparent px-2.5 py-1.5 text-body leading-snug text-ink-fg outline-none [&_.aui-lexical-input]:outline-none [&_.aui-lexical-placeholder]:pointer-events-none [&_.aui-lexical-placeholder]:absolute [&_.aui-lexical-placeholder]:px-2.5 [&_.aui-lexical-placeholder]:py-1.5 [&_.aui-lexical-placeholder]:text-ink-fg-3"
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
