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

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowUp,
  ChevronDown,
  Cpu,
  FileText,
  ListTodo,
  Mail,
  PenLine,
  Plus,
  Search,
  Square
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
import { BorderGlow } from '@shared/components/effects/BorderGlow'
import type { SearchHit, SearchResult } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { ComposerAttachmentChips } from '@shared/assistant/components/composer'
import {
  useChatComposerControls,
  type ChatComposerControls
} from '@shared/assistant/components/composerControls'
import { ApprovalModePicker } from '@shared/assistant/components/ApprovalModePicker'

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

/* eslint-disable mailagent/no-raw-hex -- 厂商品牌色 logo：各家官方品牌色本就是 hex，非设计 token */
/** 真实厂商 logo — 各家官方品牌色（dogfood-3：用户要各模型自己的 icon + 各自颜色，非单色）。
 *  Claude = simpleicons 官方 sunburst（品牌橙 #D97757）；OpenAI = 官方 logo 单色 currentColor
 *  （亮黑暗白 —— OpenAI 无彩色 logo，单色正是它的品牌特征）；Gemini = 官方 sunburst + 蓝紫线性
 *  渐变（#4893FC→#969DFF→#BD99FE，gradient id 走 useId 避免多实例撞 id）；其他用中性 Cpu。 */
function ModelVendorIcon({ vendor }: { vendor: Vendor }): React.JSX.Element {
  const gradId = useId()
  switch (vendor) {
    case 'anthropic':
      return (
        <svg viewBox="0 0 24 24" fill="#D97757" className="size-4 shrink-0" aria-hidden>
          <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
        </svg>
      )
    case 'openai':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className="size-4 shrink-0" aria-hidden>
          <path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" />
        </svg>
      )
    case 'google':
      return (
        <svg viewBox="0 0 65 65" className="size-4 shrink-0" aria-hidden>
          <defs>
            <linearGradient
              id={gradId}
              x1="6"
              y1="59"
              x2="59"
              y2="6"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor="#4893FC" />
              <stop offset="0.5" stopColor="#969DFF" />
              <stop offset="1" stopColor="#BD99FE" />
            </linearGradient>
          </defs>
          <path
            fill={`url(#${gradId})`}
            d="M32.447 0c.68 0 1.273.465 1.439 1.125a38.904 38.904 0 001.999 5.905c2.152 5 5.105 9.376 8.854 13.125 3.751 3.75 8.126 6.703 13.125 8.855a38.98 38.98 0 005.906 1.999c.66.166 1.124.758 1.124 1.438 0 .68-.464 1.273-1.125 1.439a38.902 38.902 0 00-5.905 1.999c-5 2.152-9.375 5.105-13.125 8.854-3.749 3.751-6.702 8.126-8.854 13.125a38.973 38.973 0 00-2 5.906 1.485 1.485 0 01-1.438 1.124c-.68 0-1.272-.464-1.438-1.125a38.913 38.913 0 00-2-5.905c-2.151-5-5.103-9.375-8.854-13.125-3.75-3.749-8.125-6.702-13.125-8.854a38.973 38.973 0 00-5.905-2A1.485 1.485 0 010 32.448c0-.68.465-1.272 1.125-1.438a38.903 38.903 0 005.905-2c5-2.151 9.376-5.104 13.125-8.854 3.75-3.749 6.703-8.125 8.855-13.125a38.972 38.972 0 001.999-5.905A1.485 1.485 0 0132.447 0z"
          />
        </svg>
      )
    default:
      return <Cpu size={15} strokeWidth={2} className="shrink-0 text-ink-fg-2" aria-hidden />
  }
}
/* eslint-enable mailagent/no-raw-hex */

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
// issue #61 Lane 3 (A2): picked files route through composer.addAttachment → the MailAgent
// AttachmentAdapter (images → bounded file parts; text/binary → panel injectedContext path), the
// same pipeline the paste/drop wiring below uses. The adapter owns failure toasts.
function AgentAttachmentButton(): React.JSX.Element {
  const { t } = useTranslation()
  const aui = useAui()
  const inputRef = useRef<HTMLInputElement>(null)
  const onPick = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return
    for (const file of Array.from(files)) {
      await aui
        .composer()
        .addAttachment(file)
        .catch(() => {
          /* adapter add() already toasted */
        })
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
          // 主题 v3 C8/批 4: 紧凑菜单档 rounded-lg(8) → token 化 --r-ctl
          className="glass-pop absolute bottom-full left-0 z-50 mb-1.5 min-w-[190px] rounded-[var(--r-ctl)] py-1 shadow-md"
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
                {controls && <AgentAttachmentButton />}
                {controls && <AgentModelPicker controls={controls} />}
                {/* 07-16 — owner-global 授权模式切换 chip（Manual/Accept Edits/Bypass）。 */}
                {controls && <ApprovalModePicker variant="chip" />}
              </div>
              <div className="flex items-center">
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
