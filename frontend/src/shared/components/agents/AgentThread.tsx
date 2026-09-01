// MailAgent agent-view thread — demo-fidelity layout (chat-panel demo parity).
//
// Demo Thread paradigm: a SINGLE scroll viewport holding the welcome heading, the message column
// (44rem, centered), AND the composer in a sticky ViewportFooter. Empty state → the viewport is
// justify-center so welcome + composer sit vertically centered ("new chat"); after the first turn the
// footer docks to the bottom (sticky) and messages scroll above it. A floating ScrollToBottom appears
// when scrolled up; quick-action chips show below the composer only while the thread is empty.
// Built on the same headless ThreadPrimitive as the right pane but a SEPARATE component (independent
// demo styling) — it renders inside the same AssistantRuntimeProvider (no singleton, safe).

import { useEffect, useRef, lazy, Suspense } from 'react'

import { AuiIf, ThreadPrimitive, useAuiState, type AssistantState } from '@assistant-ui/react'
import { ArrowDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@shared/lib/cn'
import { ThreadReadOnlyContext } from '@shared/assistant/components/threadReadOnlyContext'

const AgentStrandsBackdrop = lazy(() =>
  import('@shared/components/effects/AgentStrandsBackdrop').then((m) => ({
    default: m.AgentStrandsBackdrop
  }))
)

import { AgentComposer } from './AgentComposer'
import {
  AgentAssistantMessage,
  AgentUserMessage,
  EditComposer,
  SystemMessage
} from './AgentMessage'

const THREAD_MESSAGE_COMPONENTS = {
  UserMessage: AgentUserMessage,
  AssistantMessage: AgentAssistantMessage,
  EditComposer,
  SystemMessage
}

// New-chat view = no messages yet → center the composer + show welcome / suggestions.
const isNewChatView = (s: AssistantState): boolean => s.thread.messages.length === 0

interface AgentThreadProps {
  /** Quick-action chips rendered below the composer while the thread is empty (AgentQuickActions). */
  quickActions?: React.ReactNode
  /** Read-only history (retired notion-agent / degraded ai-sdk) — suppress the composer. */
  readOnly?: boolean
  /** Legacy pending-confirmation ConfirmToolDialog (custom-api fallback), scrolls with the stream. */
  pendingSlot?: React.ReactNode
  /** Phase 10b — fires on the running→idle edge after an assistant reply (a turn just completed). The
   *  parent (ai-sdk path only) uses it to trigger configurable LLM auto-title. Omitted → no watcher. */
  onTurnComplete?: () => void
  /** @deprecated dogfood：greetings 现一律居中（浮窗 / 侧栏 / agent 视图一致），此 prop 不再生效；
   *  保留以免改动上游 AgentConversation / AssistantChatModal 的传参链。 */
  welcomeAlign?: 'center' | 'left'
  /** assistant-modal P5 — removable context chips（当前邮件 / 当前事项）。0813 轮4批AE 起它们
   *  渲染在 **composer 框内**（本组件只透传给 AgentComposer，见下方注释）。邮件 chip 只有浮窗/
   *  抽屉侧栏会给（它们把 activeEmailId 传进 AgentConversation）；事项 chip 在 /sessions 也可能
   *  出现（历史里选中一个事项会话）。都没有 → 宿主传 null → chip 行整个不渲染。 */
  contextChip?: React.ReactNode
  /** composer 上方的常驻带（sticky ViewportFooter 内，跟着 composer 走、不随消息流滚走）。
   *  WP-14 时它装的是运行条；0813 轮 5 运行条整条退役（实时叙述搬进消息流的回合头像行），这里
   *  现在只剩事项控件 / 输入队列条这类「贴着输入框」的东西。各自门控，省略即字节级现状。 */
  runStatusSlot?: React.ReactNode
  /** Matters G-20 — 事项对话的空态标题/副标题（设计稿："the empty state names the matter"）。
   *  省略 → 通用 greetings 一字不变。
   *  P4b — `icon`（团队对话：Agent Logo，渲染在标题上方）；省略 → 无图，现状。 */
  welcomeOverride?: { title: string; hint: string; icon?: React.ReactNode }
  /** task 08-27 P4a — 消息流**最前**的插槽（viewport 内、随流滚动）。执行记录视图用它挂
   *  前端合成的「⚡自动触发」气泡（真实首条 user 消息是 4-7KB 任务契约 prompt，已被摘掉，
   *  见 team/runTranscript.ts）。省略 = 字节级现状。 */
  headerSlot?: React.ReactNode
  /** 消息列宽度 = `--thread-max-width` 的值；默认 44rem（全部 chat 视图现状）。团队页的
   *  执行详情面板在宽窗口下能到 ~1500px，44rem 的列两侧各空 ~400px，故那一处传更宽的值。
   *  🔴 变量定义在下面 Root 的 inline style 上 —— 从外层包一层 CSS 变量覆盖**无效**
   *  （内层 inline 恒赢），只能走这个 prop。 */
  maxWidth?: string
}

export function AgentThread({
  quickActions,
  readOnly = false,
  pendingSlot,
  onTurnComplete,
  contextChip,
  runStatusSlot,
  welcomeOverride,
  headerSlot,
  maxWidth = '44rem'
}: AgentThreadProps): React.JSX.Element {
  const isEmpty = useAuiState(isNewChatView)
  return (
    // 0804 dogfood 1d — ThreadReadOnlyContext carries `readOnly` down to the per-message
    // FollowupSuggestions mounted inside AgentAssistantMessage (AgentMessage.tsx); the
    // thread-level chip row + its own `!readOnly &&` gate that used to live here are gone.
    <ThreadReadOnlyContext.Provider value={readOnly}>
      <ThreadPrimitive.Root
        className="relative isolate flex min-h-0 flex-1 flex-col glass-3 text-ink-fg"
        style={{ ['--thread-max-width' as string]: maxWidth }}
      >
        {onTurnComplete && <TurnCompleteWatcher onComplete={onTurnComplete} />}
        {/* dogfood round-7 — turnAnchor="top"：发送后用户消息钉到视口顶部、回复向下铺开，不再每个 chunk 瞬跳追底
          （旧 bottom-anchor 的 resize-follow 硬编码 scrollToBottom("instant") → "滚动生硬/跳变"）。这也实现了
          用户之前 deferred 的"首条消息上移 + 聚焦阅读"。scroll-smooth 给余下的 auto 滚动（ScrollToBottom 按钮）补平滑。 */}
        <ThreadPrimitive.Viewport
          turnAnchor="top"
          className={cn(
            // overflow-x-hidden 显式钉死横轴：overflow-y-auto 会把未声明的 overflow-x 隐式当 auto，
            // 窄浮窗/抽屉里 composer 的 edge-light 外扩（inset:-glow）+ strands banner 任何溢出都会触发
            // 横向滚动条（dogfood 反馈）。显式 hidden 根治，且裁掉的只是远端很淡的外发光。
            'scrollbar-thin relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto scroll-smooth px-4 pt-4',
            // 空态：welcome + composer 整组垂直居中（"new chat"）。Strands 现是 AgentWelcome 文案上方的
            // 独立装饰块（跟随 greetings，无需适配各容器尺寸），composer 在原居中位置不下移。
            isEmpty && 'justify-center'
          )}
        >
          <AuiIf condition={isNewChatView}>
            <AgentWelcome override={welcomeOverride} />
          </AuiIf>

          {/* 执行记录的合成触发气泡等「消息流最前」内容；空态一并隐藏（同下方消息列纪律）。 */}
          {headerSlot != null && <div className={cn(isEmpty && 'hidden')}>{headerSlot}</div>}
          {/* 空态显式 hidden（不靠 :empty —— assistant-ui 可能渲染空节点使 :empty 失效，残留 mb-10
            占位把 welcome 和 composer 撑开、破坏整组居中观感）。有消息时正常显示。 */}
          <div className={cn('mb-10 flex flex-col gap-y-5', isEmpty && 'hidden')}>
            <ThreadPrimitive.Messages components={THREAD_MESSAGE_COMPONENTS} />
          </div>
          {pendingSlot}

          <ThreadPrimitive.ViewportFooter
            className={cn(
              'relative mx-auto flex w-full max-w-[var(--thread-max-width)] flex-col gap-3 pb-3',
              // 空态：footer 不铺底色，让 Strands 氛围背景在 composer 周围连续透出。
              // 有消息：sticky docked 到底部。dogfood 反馈：进对话/出 suggestions 后叠一层
              // bg-ink-1 会与 composer 自带的 bg-ink-2 圆角卡形成双层「底色框」→ 去掉不铺底色，
              // 让 composer 卡像空态一样悬浮。composer 卡本身不透明（BorderGlow --rb-card-bg
              // = ink-2）已遮挡其正后方滚动的消息；composer 在 footer 最底、pb-3 之上，其下无消息
              // 渲染，故无穿透。（0804 dogfood 1d 起 footer 里已无 suggestion chips —— 追问 chips
              // 搬进了最后一条助手消息的尾部，随消息流一起滚动。）
              !isEmpty && 'sticky bottom-0 mt-auto'
            )}
          >
            <AgentScrollToBottom />
            {/* composer 上方的常驻带（事项控件等），各自门控。 */}
            {runStatusSlot}
            {/* assistant-modal P5 — removable context chips（当前邮件 / 当前事项）。
              0813 轮4批AE：它们**不再**渲染在这里 —— owner 参照 Notion 要求上下文 chip 与附件
              chip 同处对话框内，故整块下沉给 AgentComposer → ComposerFrame 的 chip 行。这里只
              负责把宿主给的节点传下去；`readOnly` 时 composer 整个不渲染，chip 也随之消失，
              与下沉前同义。 */}
            {!readOnly && <AgentComposer contextChip={contextChip} />}
            <AuiIf condition={isNewChatView}>
              <AuiIf condition={(s) => s.composer.isEmpty}>
                <div className="min-h-[4.5rem]">{quickActions}</div>
              </AuiIf>
            </AuiIf>
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </ThreadReadOnlyContext.Provider>
  )
}

function AgentWelcome({
  override
}: {
  /** 事项对话把标题换成事项标题（用户内容，不进 i18n）。省略 → 通用 greetings。
   *  P4b：团队对话另带 icon（Agent Logo，标题上方）。 */
  override?: { title: string; hint: string; icon?: React.ReactNode }
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="relative mx-auto mb-6 flex min-h-[16rem] w-full max-w-[var(--thread-max-width)] flex-col items-center justify-end px-4 pb-4 text-center">
      {/* Strands 作 greetings 背景：absolute 脱流铺满容器（容器 min-h 给足高度让丝线饱满舒展），
          文案 justify-end 贴容器底部。#1 dogfood 修后：canvas 用 CSS z-index:-1 沉到 SC 背景层
          （index.css .agent-strands-banner），h1/p 只保留 relative（无 z-index），不再持有
          stacking context → ViewportFooter（含 AgentComposer 弹层）靠 DOM 后序自然盖住文案，
          不会被 h1 z-10 压入其 stacking context 之下。仅 isNewChatView 渲染 → 首条消息后卸载
          Strands canvas（零持续 GPU）。 */}
      <Suspense fallback={null}>
        <div className="agent-strands-banner pointer-events-none absolute inset-y-0 left-1/2 w-full max-w-[30rem] -translate-x-1/2 overflow-hidden">
          <AgentStrandsBackdrop />
        </div>
      </Suspense>
      {/* #1 dogfood: z-10 已移到 .agent-strands-banner { z-index:-1 }，由
          负 z-index 把丝线沉到底层，文案无需再持 z-10 stacking context。
          保留 relative 供 animate-in transform 用。 */}
      {/* P4b — 团队对话的 Agent Logo（owner 拍板改横排：头像 + 标题同一行，
          排程提示另起一行）。无 icon（主 Agent 默认态 / 事项对话）→ 走原竖排。 */}
      {override?.icon != null ? (
        <>
          <div
            className="relative flex animate-in items-center gap-2.5 fade-in slide-in-from-bottom-1 fill-mode-both duration-200"
            data-welcome-agent-row
          >
            <span className="shrink-0" data-welcome-agent-icon>
              {override.icon}
            </span>
            <h1 className="min-w-0 text-balance text-2xl font-semibold text-ink-fg">
              {override.title}
            </h1>
          </div>
          <p className="relative mt-2 text-aux text-ink-fg-3">{override.hint}</p>
        </>
      ) : (
        <>
          <h1 className="relative animate-in fade-in slide-in-from-bottom-1 fill-mode-both text-balance text-2xl font-semibold text-ink-fg duration-200">
            {override?.title ?? t('agentView.welcome')}
          </h1>
          <p className="relative mt-2 text-aux text-ink-fg-3">
            {override?.hint ?? t('agentView.emptyHint')}
          </p>
        </>
      )}
    </div>
  )
}

/** Phase 10b — fires `onComplete` on the running→idle edge once an assistant reply exists (a turn just
 *  completed). Renders nothing; lives inside the runtime provider so it can read thread state. The
 *  parent dedups per session, so firing every turn is harmless (the gateway is idempotent on an
 *  already-titled session). */
function TurnCompleteWatcher({ onComplete }: { onComplete: () => void }): null {
  const isRunning = useAuiState((s) => s.thread.isRunning)
  const hasAssistant = useAuiState((s) => s.thread.messages.some((m) => m.role === 'assistant'))
  const prevRunningRef = useRef(isRunning)
  useEffect(() => {
    // running→idle edge with an assistant reply = a turn just completed. onComplete is in deps (the
    // parent memoizes it); a changing identity re-runs the effect but can't false-fire — prevRunning
    // already equals isRunning by then, so the edge condition is false.
    if (prevRunningRef.current && !isRunning && hasAssistant) onComplete()
    prevRunningRef.current = isRunning
  }, [isRunning, hasAssistant, onComplete])
  return null
}

function AgentScrollToBottom(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <button
        type="button"
        aria-label={t('agentView.scrollToBottom')}
        className="absolute -top-12 left-1/2 z-10 grid size-9 -translate-x-1/2 place-items-center rounded-full border border-[var(--hairline)] bg-ink-2 text-ink-fg-1 shadow-md transition-colors duration-fast hover:bg-ink-3 disabled:invisible"
      >
        <ArrowDown size={16} strokeWidth={2} />
      </button>
    </ThreadPrimitive.ScrollToBottom>
  )
}
