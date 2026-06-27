// MailAgent agent-view message renderers — demo-fidelity layout (chat-panel demo parity).
//
// Demo paradigm, distinct from the email panel's bubble pair (assistant/components/message.tsx):
//   - Assistant: bubble-LESS, full-width prose centered in a 44rem column (reads better for long
//     agent replies + tool cards) with a hover Copy/Reload action bar in a height-reserved footer
//     (-mb / min-h prevents the layout jumping when the bar fades in). Parts reuse
//     getAssistantPartComponents() (text → Streamdown, reasoning → collapsible, tools → ToolTraceCard
//     + A2UI by_name) PLUS a working indicator on the Empty slot — a shimmer line while a streamed
//     reply has no content yet (the "thinking" moment before the first token).
//   - User: right-aligned subtle bubble (bg-ink-3), demo-neutral (not the accent fill).
// EditComposer / SystemMessage reuse the shared renderers (no demo-specific layout needed in Phase 7).
// Independent from the right pane: the runtime is provider-based (no singleton), so these render
// safely inside the same AssistantRuntimeProvider that AgentConversation mounts.

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ComposerPrimitive, MessagePrimitive } from '@assistant-ui/react'

import { DotMatrix } from '@shared/components/ui/DotMatrix'
import { MessageTiming } from '@shared/assistant/components/MessageTiming'
import { ThinkingPhrases } from '@shared/components/chat/ThinkingPhrases'
import { getAssistantPartComponents } from '@shared/assistant/tools/registerToolUIs'
import { AssistantActionBar, UserActionBar } from '@shared/assistant/components/action-bar'

// SystemMessage reuses the shared renderer; EditComposer is demo-fidelity in-place (defined below).
export { SystemMessage } from '@shared/assistant/components/message'

/** Working indicator — assistant-ui renders the Empty part slot while a (streaming) assistant message
 *  has no content yet (the pre-first-token moment); once a part streams in, Empty is replaced by the
 *  real content. dogfood-3: DotMatrix「connecting」点阵动画（demo idiom）+ 轮换流光短句 ThinkingPhrases
 *  （复用 chat 面板的 i18n chat.thinkingPhrases 轮播 + ShimmerText 字形流光）—— 用户要的「动态 icon +
 *  多句轮换 shimmer」，取代 dogfood-2 的静态单句。 */
function AgentWorkingIndicator(): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-2 align-middle text-ink-fg-3">
      <DotMatrix state="connecting" aria-hidden />
      <ThinkingPhrases />
    </span>
  )
}

export function AgentUserMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="group mx-auto flex w-full max-w-[var(--thread-max-width)] flex-col items-end">
      <div className="relative max-w-[80%]">
        <div className="rounded-2xl rounded-br-md border border-[var(--hairline)] bg-ink-3 px-3.5 py-2 text-body leading-relaxed text-ink-fg">
          <MessagePrimitive.Parts />
        </div>
        {/* edit 按钮悬浮在气泡左侧外(demo idiom：absolute -translate-x-full)，hover 才出现(dogfood-2)。 */}
        <div className="absolute left-0 top-1/2 -translate-x-full -translate-y-1/2 pr-2">
          <UserActionBar />
        </div>
      </div>
    </MessagePrimitive.Root>
  )
}

export function AgentAssistantMessage(): React.JSX.Element {
  // flag-aware part components (generic ToolTraceCard always; A2UI by_name when MAILAGENT_A2UI_TOOL_CARDS
  // is on) + a working-indicator Empty slot. Memoized once per mount so the reference stays stable.
  const partComponents = useMemo(
    () => ({ ...getAssistantPartComponents(), Empty: AgentWorkingIndicator }),
    []
  )
  return (
    <MessagePrimitive.Root className="group relative mx-auto w-full max-w-[var(--thread-max-width)]">
      <div className="min-w-0 px-1 text-body leading-relaxed text-ink-fg">
        <MessagePrimitive.Parts components={partComponents} />
      </div>
      {/* dogfood round-7 — footer：copy/reload + 「答复时间」badge 现在同在 ONE ActionBarPrimitive.Root 内
          （MessageTiming 作为 trailing 传入）→ 与按钮共享 items-center 对齐（不再偏上几 px）+ 共享 opacity
          gating（最新常显、非最新 hover 才显，hover 行为一致）。-mb-7 + min-h-7 预留固定高度 → 不跳动。 */}
      <div className="-mb-7 ml-1 flex min-h-7 items-center pr-1">
        <AssistantActionBar inlineOnHover trailing={<MessageTiming />} />
      </div>
    </MessagePrimitive.Root>
  )
}

/** dogfood-3 — demo-fidelity 原位编辑（取代 re-export 的 shared EditComposer，后者无 MessagePrimitive.Root
 *  包裹 + self-end 导致编辑框脱离消息原位、跑到顶部）。复刻 demo base.tsx:898：MessagePrimitive.Root
 *  包裹让 assistant-ui 在该 user message 的原位渲染编辑框；内部 ComposerPrimitive ml-auto max-w-[85%]
 *  右对齐成气泡形态（与 AgentUserMessage 对齐）+ footer 取消/更新。re-stream 走 runtime 的 onEdit
 *  适配器（与 shared EditComposer 同一条链路），仅布局换成原位 demo 形态。 */
export function EditComposer(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <MessagePrimitive.Root className="mx-auto flex w-full max-w-[var(--thread-max-width)] flex-col px-2">
      <ComposerPrimitive.Root className="ml-auto flex w-full max-w-[85%] flex-col rounded-2xl border border-[var(--hairline)] bg-ink-2 shadow-[0_4px_16px_-8px_rgba(0,0,0,0.18),0_1px_2px_rgba(0,0,0,0.06)]">
        <ComposerPrimitive.Input
          autoFocus
          className="scrollbar-thin max-h-40 min-h-14 w-full resize-none bg-transparent px-4 pb-1 pt-3 text-body leading-relaxed text-ink-fg outline-none"
        />
        <div className="mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel className="h-8 rounded-full px-3.5 text-meta font-medium text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3">
            {t('chat.composer.cancel', { defaultValue: 'Cancel' })}
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send className="h-8 rounded-full bg-[rgb(var(--c-accent))] px-3.5 text-meta font-medium text-[rgb(var(--c-accent-fg))] transition-opacity duration-fast hover:opacity-90 disabled:opacity-40">
            {t('chat.message.update', { defaultValue: 'Update' })}
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  )
}
