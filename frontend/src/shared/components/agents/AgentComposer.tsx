// MailAgent agent-view composer — demo-fidelity (chat-panel demo parity), Phase 8 lexical.
//
// 0813: 框内堆栈（附件 chips → 输入 → 工具条）与 dropzone 收进共享的 ComposerFrame
// （@shared/assistant/components/composer）——本面此前那份 AgentAttachmentChips wrapper 已删，
// 两个 composer 的 chip 行/长高逻辑自此一份。本面只补 rounded-2xl 与两个对齐值。
//
// 0813 轮4批AE: 会话上下文 chip（当前邮件 / 当前事项）也进框 —— 它此前是整个 composer form 的
// **兄弟**（AgentThread 的 ViewportFooter 里），实测 `frame.contains(chip) === false`。现在由
// AgentThread 经 `contextChip` prop 递进来，透传成 ComposerFrame 的 leadingChips，与附件 chips
// 同处一条 flex-wrap。🔴 只改位置与容器：chip 的产地（AgentConversation 的 emailContext /
// matter 状态）、× 的语义、送出时的 injectedContext 一个字节没动。
//
// Demo composer: a rounded shell on bg-ink-2 with a LexicalComposerInput on top (in-field @ mentions +
// / commands via ComposerTriggerPopover, inline directive chips) and an inline action row below (left:
// the "+" menu → the SHARED ModelPicker chip; right: send / cancel as round buttons). 08-04 WP6: the
// in-file AgentAttachmentButton (a "+" that opened the file picker directly) and the standalone
// connector chip both moved into the shared ComposerPlusMenu — "+" is now a real menu, identical on
// both composers. 08-04 W8: the
// former in-file AgentModelPicker + ModelVendorIcon + vendorOf were folded into
// @shared/assistant/components/ModelPicker — one component, both composers. 08-05 WP-13+16b: the
// external-capability entries (connector / skill) moved on again into ComposerToolsMenu (the slider),
// the model picker moved to the RIGHT group, and an effort tier menu joined it — the agent view no
// longer just "follows the model" for thinking, it has the same explicit tier ladder as the mail
// composer. @ runs an async email FTS search (custom sync-adapter + debounced fetch + isLoading
// bridge) and inserts a chip; on insert the email is added to controls.mentions so the existing send-time
// buildMentionContext resolves its body. / fires a slash command (sends a quick-action prompt). Reads
// model / attachment state from useChatComposerControls(); when no provider is mounted only send / cancel
// show (a read-only thread / bare render) — lexical input stays, the toolbar chrome drops.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowUp,
  Bot,
  ClipboardList,
  FileText,
  ListTodo,
  Mail,
  PenLine,
  Search,
  Square
} from 'lucide-react'
import {
  ComposerPrimitive,
  ThreadPrimitive,
  unstable_useSlashCommandAdapter,
  unstable_useTriggerPopoverAriaProps,
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
import { ComposerFrame } from '@shared/assistant/components/composer'
import {
  useChatComposerControls,
  type ChatComposerControls
} from '@shared/assistant/components/composerControlsContext'
import { ApprovalModePicker } from '@shared/assistant/components/ApprovalModePicker'
import { ComposerPlusMenu } from '@shared/assistant/components/ComposerPlusMenu'
import { ComposerToolsMenu } from '@shared/assistant/components/ComposerToolsMenu'
import { ContextUsageRing } from '@shared/assistant/components/ContextUsageRing'
import { EffortPicker } from '@shared/assistant/components/EffortPicker'
import { ModelPicker } from '@shared/assistant/components/ModelPicker'

import {
  AGENT_MENTION_CATEGORY_ID,
  MATTER_MENTION_CATEGORY_ID,
  parseComposerMentionIds
} from './agentMention'
import { AgentDirectiveChip, AgentTriggerPopover } from './AgentTriggerPopover'
import { useAgentMentionAdapter } from './useAgentMentionAdapter'
import { useMatterMentionAdapter } from './useMatterMentionAdapter'

// ── @ email mention adapter (async FTS search bridged into a sync trigger adapter) ───────────────
// The trigger popover takes a SYNCHRONOUS adapter (search(query) → items[]) plus a separate isLoading
// flag. We bridge async email search by: search() schedules a debounced fetch (deferred — never a
// setState during render, only a ref write + setTimeout) and returns the ref-cached items for the
// current query; the fetch setStates the results, which re-creates the adapter and re-runs search to
// return the fresh items. isLoading is driven from React state (set in the timer, cleared on settle).
const MENTION_SENTINEL = '\u0000'
const EMAIL_MENTION_CATEGORY_ID = 'email'

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
      categoryItems: () => stateRef.current.items,
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

function AgentMentionTrigger({
  controls,
  emailMention
}: {
  controls: ChatComposerControls
  emailMention: ReturnType<typeof useEmailMentionAdapter>
}): React.JSX.Element {
  const { t } = useTranslation()
  const agentMention = useAgentMentionAdapter(controls)
  // S4 (task 08-18) — 第三组「事项」。自门控：本面不供 onAddMatterMention（事项对话）或 Matters
  // 总闸关着 → categories()/search() 恒空，`@` 与引入前逐字一致。
  const matterMention = useMatterMentionAdapter(controls)
  const adapter = useMemo<TriggerAdapter>(
    () => ({
      categories: () => [
        { id: EMAIL_MENTION_CATEGORY_ID, label: t('agentView.mention.emails') },
        ...agentMention.adapter.categories(),
        ...matterMention.adapter.categories()
      ],
      categoryItems: (categoryId: string) =>
        categoryId === EMAIL_MENTION_CATEGORY_ID
          ? emailMention.adapter.categoryItems(categoryId)
          : categoryId === MATTER_MENTION_CATEGORY_ID
            ? matterMention.adapter.categoryItems(categoryId)
            : agentMention.adapter.categoryItems(categoryId),
      search: (query: string) => [
        ...emailMention.adapter.search(query),
        ...agentMention.adapter.search(query),
        ...matterMention.adapter.search(query)
      ]
    }),
    [agentMention.adapter, emailMention.adapter, matterMention.adapter, t]
  )
  const onInserted = useCallback(
    (item: Unstable_TriggerItem): void => {
      if (item.type === 'agent') agentMention.onInserted(item)
      else if (item.type === 'matter') matterMention.onInserted(item)
      else emailMention.onInserted(item)
    },
    [agentMention, emailMention, matterMention]
  )
  return (
    <AgentTriggerPopover
      char="@"
      adapter={adapter}
      isLoading={emailMention.isLoading || agentMention.isLoading || matterMention.isLoading}
      directive={{ onInserted }}
      iconMap={{ email: Mail, agent: Bot, matter: ClipboardList }}
      fallbackIcon={(props) => <Mail {...props} />}
      loadingLabel={t('agentView.mention.loading')}
      emptyItemsLabel={(activeCategoryId) =>
        activeCategoryId === AGENT_MENTION_CATEGORY_ID
          ? t('agentView.mention.agentsEmpty')
          : activeCategoryId === MATTER_MENTION_CATEGORY_ID
            ? t('agentView.mention.mattersEmpty')
            : activeCategoryId === EMAIL_MENTION_CATEGORY_ID
              ? t('agentView.mention.empty')
              : t('agentView.mention.noMatches')
      }
      emptyCategoriesLabel={t('agentView.mention.empty')}
      renderItemIcon={(item) => (item.type === 'agent' ? agentMention.renderItemIcon(item) : null)}
    />
  )
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

// ── 工具条窄档（侧栏 / 浮窗拖窄时逐级降级） ──────────────────────────────────────────────────
// 量的是 composer 根 <form> 的宽度 = 侧栏宽度减 33（Viewport 的 px-4 共 32 + 侧栏那圈
// border-l 1；实测值，别按 32 推）：侧栏 350（AssistantChatModal 的 SIDEBAR_WIDTH_MIN）/ 360 /
// 400（默认）/ 720（MAX）对应 form 317 / 327 / 367 / 687。
//   'md'（form ≤ 367 = 侧栏 ≤ 400 默认宽）：授权档 pill 收成纯图标 —— 到这一档右组已在压模型名，
//     而授权档的信息量在图标与底色（bypass / 未知的警示色）里，文字是这一行最先该让的位置。
//   'sm'（form ≤ 327 = 侧栏 ≤ 360）：模型名再收一档，别让它把仅剩的余量吃光。
// 项目没有 container query，宽度自适应的现成范式是 ResizeObserver（量法抄 ComposerToolsMenu：
// 从自己 closest('form') 拿 composer 根）。
const NARROW_MD_MAX_W = 367
const NARROW_SM_MAX_W = 327

type NarrowTier = 'md' | 'sm'

function useNarrowTier(ref: React.RefObject<HTMLElement | null>): NarrowTier | undefined {
  const [tier, setTier] = useState<NarrowTier | undefined>(undefined)
  useLayoutEffect(() => {
    const host = ref.current?.closest('form')
    if (!host) return undefined
    const measure = (): void => {
      const w = host.getBoundingClientRect().width
      setTier(w <= NARROW_SM_MAX_W ? 'sm' : w <= NARROW_MD_MAX_W ? 'md' : undefined)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    return (): void => ro.disconnect()
  }, [ref])
  return tier
}

// ── 排队模式（task 09-03 Lane A）─────────────────────────────────────────────────────────────────
/** 「这一轮说的话进队列而不是直接发」。判据由宿主给（run 在跑 / 后台在跑 / 有待决审批）。 */
function isQueueModeActive(controls: ChatComposerControls | null): boolean {
  return controls?.queuedInputEnabled === true && controls.queueModeActive === true
}

/** 入队并清空输入。Enter 与发送键共用的是**入队动作本身**；守卫按入口不同：Enter 那条多一道
 *  trigger popover 守卫（`@` / `/` 候选列表要用 Enter 选中），点击没有这重歧义。`sendDisabled`
 *  两条路径都受约束 —— Enter 在守卫里判，键靠 `disabled` 属性。 */
function enqueueComposerText(
  aui: ReturnType<typeof useAui>,
  controls: ChatComposerControls | null
): void {
  const text = aui.composer().getState().text.trim()
  if (text === '') return
  controls?.onEnqueueQueuedInput?.(text)
  aui.composer().setText('')
}

/** Lexical 输入 + 排队模式下的 Enter 拦截。
 *
 *  🔴 单独成组件只为一件事：trigger popover 的开合态（`unstable_useTriggerPopoverAriaProps` 的
 *  `aria-expanded`）只有在 `Unstable_TriggerPopoverRoot` **内部**才读得到，而那个 Root 是
 *  AgentComposer 自己渲染的 —— 在 AgentComposer 里读恒是「没开」，`@` / `/` 候选列表用 Enter
 *  选中就会被下面的拦截吃掉。
 *
 *  拦截必须走 capture 阶段并 stopPropagation：Enter 在 Lexical 里由 contenteditable 自己的
 *  keydown 监听转成 KEY_ENTER_COMMAND，而 React 的 capture 处理器在根容器上先跑，停掉传播那条
 *  监听就收不到事件。只 preventDefault 不够 —— 库不看 defaultPrevented，且「待决审批 / 后台 run」
 *  这两档 `isRunning` 为假，库会真的把这一轮发出去。 */
function AgentComposerInput(): React.JSX.Element {
  const { t } = useTranslation()
  const aui = useAui()
  const controls = useChatComposerControls()
  const sendDisabled = controls?.sendDisabled === true
  const queueModeActive = isQueueModeActive(controls)
  const triggerPopoverOpen = unstable_useTriggerPopoverAriaProps()['aria-expanded'] === true
  // dogfood-3: placeholder 只在首次空对话(welcome 态)显示长引导文案；进入对话后底部 docked composer
  // 不再显示 placeholder（用户要求）。空线程 = thread.messages 为空（同 AgentThread 的 isNewChatView）。
  const isEmptyThread = useAuiState((s) => s.thread.messages.length === 0)
  const onKeyDownCapture = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      if (!queueModeActive || sendDisabled || triggerPopoverOpen) return
      if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
      e.preventDefault()
      e.stopPropagation()
      enqueueComposerText(aui, controls)
    },
    [aui, controls, queueModeActive, sendDisabled, triggerPopoverOpen]
  )
  return (
    <LexicalComposerInput
      directiveChip={AgentDirectiveChip}
      placeholder={isEmptyThread ? t('agentView.composer.placeholder') : ''}
      // codex r2 [D] — the Lexical Enter path calls aui.composer().send() DIRECTLY (no form
      // submit to gate), so busy turns Enter-submit off entirely.
      submitMode={sendDisabled ? 'none' : 'enter'}
      onKeyDownCapture={onKeyDownCapture}
      autoFocus
      className="scrollbar-thin relative max-h-32 min-h-[2.5rem] w-full resize-none bg-transparent px-2.5 py-1 text-body leading-snug text-ink-fg outline-none [&_.aui-lexical-input]:min-h-lh [&_.aui-lexical-input]:outline-none [&_.aui-lexical-placeholder]:pointer-events-none [&_.aui-lexical-placeholder]:absolute [&_.aui-lexical-placeholder]:left-0 [&_.aui-lexical-placeholder]:right-0 [&_.aui-lexical-placeholder]:top-0 [&_.aui-lexical-placeholder]:truncate [&_.aui-lexical-placeholder]:px-2.5 [&_.aui-lexical-placeholder]:py-1 [&_.aui-lexical-placeholder]:text-ink-fg-3"
    />
  )
}

export function AgentComposer({
  contextChip
}: {
  /** 0813 轮4批AE —— 会话上下文 chips（当前邮件 / 当前事项）。此前由 AgentThread 渲染在
   *  composer **之外**（ViewportFooter 里与 form 平级），owner 参照 Notion 要求进框；故改由
   *  本组件透传进 ComposerFrame 的 chip 行，与附件 chips 同区同换行。省略 → 与引入前逐字一致。 */
  contextChip?: React.ReactNode
} = {}): React.JSX.Element {
  const { t } = useTranslation()
  const aui = useAui()
  const controls = useChatComposerControls()
  const emailMention = useEmailMentionAdapter(controls)
  // 工具条窄档（见上）——ref 挂在工具条那一行，量的是它的 closest('form')。
  const toolbarRef = useRef<HTMLDivElement>(null)
  const narrowTier = useNarrowTier(toolbarRef)
  // codex r2 [D] — sendDisabled gates EVERY send path, not just the Send button: the Lexical
  // input's Enter calls aui.composer().send() directly (submitMode 'none' turns it off), slash
  // commands append through the thread (guarded in execute below), and the Root form gate covers
  // any residual requestSubmit.
  const sendDisabled = controls?.sendDisabled === true
  const queueModeActive = isQueueModeActive(controls)

  // Privacy guard (codex HIGH-1): the in-field @ inserts a directive chip AND records the email in
  // controls.mentions (the send-time buildMentionContext source). Lexical exposes no "directive removed"
  // callback, so a deleted chip would otherwise still send that email's body to the model. Reconcile on
  // every composer-text change: parse the current directives and drop any controls.mention whose chip is
  // gone, so a visually-removed email is never sent. The effect only REMOVES (never adds) → it can't race
  // the insert (a freshly-inserted chip is already in the text by the time this runs).
  const composerText = useAuiState((s) => s.composer.text)
  useEffect(() => {
    if (!controls) return
    const agentMentions = controls.agentMentions ?? []
    // S4 (task 08-18) — 事项 mention 接的是**同一条**对账：@ 一件事同样在 controls 里留了一条会
    // 随发送注入的记录，chip 被删而记录还在 = 用户以为撤回了引用、模型却仍收到那件事的标识。
    const matterMentions = controls.matterMentions ?? []
    if (
      controls.mentions.length === 0 &&
      agentMentions.length === 0 &&
      matterMentions.length === 0
    ) {
      return
    }
    const present = parseComposerMentionIds(composerText)
    for (const mentioned of controls.mentions) {
      if (!present.emailIds.has(mentioned.internal_id))
        controls.onRemoveMention(mentioned.internal_id)
    }
    for (const agent of agentMentions) {
      if (!present.agentIds.has(agent.id)) controls.onRemoveAgentMention?.(agent.id)
    }
    for (const matter of matterMentions) {
      if (!present.matterIds.has(matter.public_id))
        controls.onRemoveMatterMention?.(matter.public_id)
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
        {/* 🔴 `[&>.rb-border-glow-inner]:min-w-0` —— 卡是 grid、inner 是它的 grid item，默认
            `min-width:auto` = 不小于 min-content：工具条那行的 min-content（各 chip 的 max-content
            之和）于是把整张卡撑到比 form 还宽，发送按钮随之被顶出侧栏（窄宽度下 chip 里的
            truncate 一律不触发，因为根本没人逼它收缩）。这一层放开后，收缩才会传导到下面
            ComposerFrame 的 min-w-0 → 工具条 → 各 picker 包裹层的 min-w-0。 */}
        <BorderGlow
          borderRadius={16}
          glowRadius={20}
          className="w-full [&>.rb-border-glow-inner]:min-w-0"
        >
          {/* issue #61 Lane 3 (A2) — one wrapper carries BOTH file entry points: the Dropzone
              primitive owns drag&drop (handlers + data-dragging highlight), onPaste rides its
              ...rest spread for the Lexical paste wiring above.
              0813 — 这一层现在是共享的 ComposerFrame（chips 行 + 竖排堆栈 + dropzone 同源，
              见 composer.tsx）：本面只补一个 `rounded-2xl`（= BorderGlow 的 borderRadius 16，
              让 data-dragging 的底色洗跟着卡的圆角），皮肤仍在外面那张 BorderGlow 卡上。
              `mentions` 不传 —— 本面的 @ 提及是正文里的 Lexical directive chip，不走 chip 行。 */}
          <ComposerFrame
            controls={controls}
            leadingChips={contextChip}
            disabled={sendDisabled}
            onPaste={onComposerPaste}
            chipMaxWidthClass="max-w-[220px]"
            chipRowClassName="px-2.5"
            className="rounded-2xl min-w-0"
          >
            <AgentComposerInput />
            {/* 08-05 WP-13+16b — 工具条重组：左 [+][滑块][授权]、右 [环][effort][模型][发送]
                （两面同一套顺序，见 composer.tsx 文件头）。两个组都 min-w-0：320px 侧栏里
                chip 的文字要能被 truncate 压掉，否则整行会被撑出去。 */}
            {/* 🔴 `relative` = WP-22 context 明细弹层的包含块（环在右组第一位，按它自己的右缘
                锚会在 320px 窄侧栏被 overflow-hidden 裁掉；算式见 ContextUsageRing 的注释）。
                其余弹层各自有 `div.relative` 包裹，不受这层影响。 */}
            {/* `group/composer` + `data-narrow` = 窄档的唯一载体：各 picker 用
                `group-data-[narrow=…]/composer:` 自己读档，没有这层 group 的场地（邮件面
                composer）恒是宽档，与引入前逐字一致。 */}
            <div
              ref={toolbarRef}
              data-narrow={narrowTier}
              className="group/composer relative flex items-center justify-between gap-1 px-0.5"
            >
              <div className="flex min-w-0 items-center gap-0.5">
                {/* 「+」= 往这轮对话里加内容。agent 面的 @ 在正文里（Lexical directive chip），
                    所以这里**不**给 mention 项 —— 见 ComposerPlusMenu 文件头最后一段。 */}
                {controls && <ComposerPlusMenu variant="chip" />}
                {/* 滑块 = 配置这轮能用哪些外部能力（外部连接 / 技能 / 去 AI 设置）。 */}
                {controls && <ComposerToolsMenu variant="chip" />}
                {/* 07-16 — owner-global 授权模式切换 chip（Manual/Accept Edits/Bypass）。 */}
                {controls && <ApprovalModePicker variant="chip" />}
              </div>
              <div className="flex min-w-0 items-center gap-0.5">
                {/* WP-15 — 上下文占用（环 / 中性药丸 / 不渲染，见 ContextUsageRing 文件头）。 */}
                <ContextUsageRing />
                {/* 08-05 WP-16b — effort 档位（agent 面此前没有任何思考开关，跟着模型走；
                    现在与邮件面同一套档位菜单）。 */}
                {controls?.effort && <EffortPicker control={controls.effort} variant="chip" />}
                {/* 08-04 W8 — 两个 composer 共用的模型选择器（chip variant）。 */}
                {controls && <ModelPicker controls={controls} variant="chip" />}
                {/* 🔴 排队模式下 `ComposerPrimitive.Send` 一律不渲染：它是 `type="button"` 直调
                    send()（不提交 form，Root 的 onSubmit 拦不住），而排队模式有两档 isRunning 为假
                    （待决审批 / 后台 run）—— 那两档它可点且真发，会与 stash 的审批抢 run lease（409）
                    或起一条竞争 run。换成下面那颗恒显示的入队键。 */}
                {!queueModeActive && (
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
                )}
                <ThreadPrimitive.If running>
                  <ComposerPrimitive.Cancel
                    aria-label={t('chat.composer.cancel')}
                    title={t('chat.composer.cancel')}
                    className="grid size-8 shrink-0 place-items-center rounded-full bg-ink-4 text-ink-fg-1 transition-colors duration-fast hover:bg-[rgb(var(--c-accent))] hover:text-[rgb(var(--c-accent-fg))]"
                  >
                    <Square size={14} strokeWidth={2.5} className="fill-current" />
                  </ComposerPrimitive.Cancel>
                </ThreadPrimitive.If>
                {/* 排队模式的发送键（点击 = Enter 同一条入队）：恒显示、不分 isRunning，在停止键右边。
                    disabled 判据与 Enter 那条守卫同源 —— sendDisabled 在事项对话里是持续状态，
                    只挡 Enter 会变成「回车被拒、点键却入队」。 */}
                {queueModeActive && (
                  <button
                    type="button"
                    aria-label={t('chat.composer.send')}
                    title={t('chat.composer.send')}
                    disabled={sendDisabled}
                    onClick={() => enqueueComposerText(aui, controls)}
                    className="grid size-8 shrink-0 place-items-center rounded-full bg-[rgb(var(--c-accent))] text-[rgb(var(--c-accent-fg))] transition-opacity duration-fast hover:opacity-90 disabled:opacity-40"
                  >
                    <ArrowUp size={17} strokeWidth={2.5} />
                  </button>
                )}
              </div>
            </div>
          </ComposerFrame>
        </BorderGlow>

        {/* @ email mention — async FTS search → inline directive chip + controls.mentions for send context. */}
        {controls && <AgentMentionTrigger controls={controls} emailMention={emailMention} />}
        {/* / slash commands. */}
        <AgentTriggerPopover char="/" {...slash} emptyItemsLabel={t('agentView.slash.empty')} />
      </ComposerPrimitive.Root>
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  )
}
