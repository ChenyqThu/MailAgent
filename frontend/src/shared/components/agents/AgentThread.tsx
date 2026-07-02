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
import { ArrowDown, CornerDownRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@shared/lib/cn'

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
  /** dogfood-3 — dynamic follow-up suggestions for the latest completed turn (ai-sdk path). Rendered as
   *  autoSend chips above the composer in an active, idle thread. Empty / omitted → no chips. */
  followUps?: string[]
  /** @deprecated dogfood：greetings 现一律居中（浮窗 / 侧栏 / agent 视图一致），此 prop 不再生效；
   *  保留以免改动上游 AgentConversation / AssistantChatModal 的传参链。 */
  welcomeAlign?: 'center' | 'left'
  /** assistant-modal P5 — a removable context chip (the current email) rendered just above the composer.
   *  The modal passes the email chip; /sessions omits it → nothing rendered. */
  contextChip?: React.ReactNode
}

export function AgentThread({
  quickActions,
  readOnly = false,
  pendingSlot,
  onTurnComplete,
  followUps,
  contextChip
}: AgentThreadProps): React.JSX.Element {
  const isEmpty = useAuiState(isNewChatView)
  return (
    <ThreadPrimitive.Root
      className="relative isolate flex min-h-0 flex-1 flex-col glass-3 text-ink-fg"
      style={{ ['--thread-max-width' as string]: '44rem' }}
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
          <AgentWelcome />
        </AuiIf>

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
            // 渲染，故无穿透。suggestion chips 自带 bg-ink-2 pill，仅 chip 间隙露极窄消息，可接受。
            !isEmpty && 'sticky bottom-0 mt-auto'
          )}
        >
          <AgentScrollToBottom />
          {/* dogfood-3 (follow-ups) — dynamic next-question chips above the composer for the latest
              completed turn (ai-sdk only). Active + idle thread only: AuiIf hides them while running so
              stale chips never overlap a new reply, and the welcome screen owns quick-actions instead.
              autoSend (assistant-ui Suggestion) → one tap sends the question through the runtime. */}
          {!readOnly && followUps && followUps.length > 0 && (
            <AuiIf condition={(s) => s.thread.messages.length > 0 && !s.thread.isRunning}>
              <div className="flex flex-wrap gap-2">
                {followUps.map((fu, i) => (
                  <ThreadPrimitive.Suggestion
                    key={`${i}-${fu}`}
                    prompt={fu}
                    autoSend
                    className="inline-flex items-center gap-1.5 rounded-full border border-ink-border-soft bg-ink-2 px-3 py-1.5 text-aux text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3"
                  >
                    <CornerDownRight size={13} strokeWidth={1.75} className="shrink-0 text-coral" />
                    {fu}
                  </ThreadPrimitive.Suggestion>
                ))}
              </div>
            </AuiIf>
          )}
          {/* assistant-modal P5 — removable email-context chip directly above the composer (modal only;
              /sessions omits contextChip → nothing here). */}
          {!readOnly && contextChip}
          {!readOnly && <AgentComposer />}
          <AuiIf condition={isNewChatView}>
            <AuiIf condition={(s) => s.composer.isEmpty}>
              <div className="min-h-[4.5rem]">{quickActions}</div>
            </AuiIf>
          </AuiIf>
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  )
}

function AgentWelcome(): React.JSX.Element {
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
      <h1 className="relative animate-in fade-in slide-in-from-bottom-1 fill-mode-both text-2xl font-semibold text-ink-fg duration-200">
        {t('agentView.welcome')}
      </h1>
      <p className="relative mt-2 text-aux text-ink-fg-3">{t('agentView.emptyHint')}</p>
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
