// harness-chat lane B — the truth-driven streamed-turn status line (assistant-ui `Empty` slot).
//
// Replaces AgentWorkingIndicator (DotMatrix + ThinkingPhrases rotation). It reads the derived
// TurnStage (useTurnStage) and:
//   - renders NOTHING for idle / writing / awaiting-approval / calling-tool — the core "shimmer
//     must stop" fix (stream ended / abort / a settled tool-tail → idle; streaming text has its
//     own caret; an approval card IS the status). This closes every "永动" path in research §2.
//     阶段 0.5-① G7 added calling-tool to that list for the SAME reason: the tool card now says
//     「正在跑」itself, with a live elapsed clock — a second «正在调用 X…» line beside it was the
//     last remaining place where two components narrated one running tool.
//   - renders a single, TRUTHFUL SHIMMER phrase ONLY while the turn is actively progressing
//     (connecting / thinking) — no random rotation, the phrase matches the stage.
//   - STOPS the shimmer when the stream is stalled or errored: a STATIC (non-shimmer) line
//     («仍在等待响应…» / error), honoring "卡住/结束时 shimmer 必须停" and filling the previously-
//     missing "stream error has no banner" gap (research §3.4 / §10). The stall line keeps only a
//     subtle waiting dot-matrix (not a shimmer) so it never looks fully frozen.
//   - W3-② carries a live stopwatch on exactly the three stages it renders (connecting / thinking
//     / stalled) — "还要等多久" 是这条线唯一没答的问题；calling-tool 归工具卡自己的秒表。
//
// A zero-arg component is still assignable to EmptyMessagePartComponent (the { status } prop is
// contravariantly droppable) — status is read from the store inside useTurnStage, so the prop is
// unused. Motion: ShimmerText only for active progress (loading 三词汇 §6), no spinner on the row.

import { useTranslation } from 'react-i18next'

import { cn } from '@shared/lib/cn'
import { DotMatrix, type DotMatrixState } from '@shared/components/ui/DotMatrix'
import { ShimmerText } from '@shared/components/ShimmerText'
import { useTurnStage, type TurnStage } from '@shared/assistant/runtime/useTurnStage'
import { formatToolDuration, useToolElapsed } from '@shared/assistant/tools/generic/useToolElapsed'

const DOT_STATE: Partial<Record<TurnStage, DotMatrixState>> = {
  connecting: 'connecting',
  thinking: 'thinking',
  stalled: 'waiting',
  error: 'error'
}

/** W3-② 秒表可见的三态 = 这条线本身会渲染内容的三态。calling-tool 不在内（G7：工具卡自带秒表），
 *  error 也不在内（那是终态，旁边挂个走过的秒数只会读成「还在跑」）。 */
function isStopwatchStage(stage: TurnStage): boolean {
  return stage === 'connecting' || stage === 'thinking' || stage === 'stalled'
}

export function TurnStatusLine(): React.JSX.Element | null {
  const { t } = useTranslation()
  const { stage, stallLevel } = useTurnStage()
  // W3-② 回合级秒表（缩水版）—— 复用工具卡那口渲染器时钟，三条契约照搬：没起点就不编造 0.0s /
  // cleanup 取终值 / reduced-motion 不 tick（于是 reduce 下整条秒表不出现，而不是冻在 0.0s 骗人）。
  // 起点 = 本组件实例第一次进入可见阶段的时刻，跨阶段（thinking↔calling-tool↔stalled）不清零。
  // 🔴 已知边界：assistant-ui 的 Empty slot 不是整回合常驻 —— parts 从空变非空、或末尾 part 在
  // text/reasoning 与 tool-call 之间切换时，MessageParts 会换分支重挂这个组件（core 的
  // MessagePartsCompat: contentLength===0 → EmptyParts，否则 ConditionalEmpty）。重挂 = 新实例 =
  // 秒表从这段新的可见等待重新计时。读数因此永远是「本段可见等待已经多久」，不是回合总时长；
  // 它始终对应一段真实经过的时间，不会凭空造数。
  const elapsed = useToolElapsed(isStopwatchStage(stage))

  // Self-narrating / terminal stages render nothing (shimmer stops). calling-tool is
  // self-narrating too: the tool card owns that row (G7).
  if (
    stage === 'idle' ||
    stage === 'writing' ||
    stage === 'awaiting-approval' ||
    stage === 'calling-tool'
  ) {
    return null
  }

  // 样式对齐工具卡的耗时位（同一口时钟、同一种读法）。error 阶段 elapsed 可能已被 cleanup 冻成
  // 一个终值，所以这里再判一次 stage —— 不让终态行挂一个走过的秒数。
  const stopwatch =
    isStopwatchStage(stage) && elapsed !== null ? (
      <span
        className="shrink-0 font-mono text-meta tabular-nums text-ink-fg-3"
        title={t('chat.toolStep.duration')}
      >
        {formatToolDuration(elapsed)}
      </span>
    ) : null

  // Not actively progressing (stalled / errored) → a STATIC line, never a shimmer.
  if (stage === 'stalled' || stage === 'error') {
    const text =
      stage === 'error'
        ? t('chat.status.error')
        : t(stallLevel >= 2 ? 'chat.status.waitingLong' : 'chat.status.waiting')
    return (
      <span className="inline-flex items-center gap-2 align-middle text-ink-fg-3">
        <DotMatrix state={DOT_STATE[stage] ?? 'waiting'} aria-hidden />
        <span className={cn('text-aux', stage === 'error' && 'text-fail')}>{text}</span>
        {stopwatch}
      </span>
    )
  }

  // Actively progressing (connecting / thinking) → truthful shimmer phrase.
  const text = t('chat.status.thinking')

  return (
    <span className="inline-flex items-center gap-2 align-middle text-ink-fg-3">
      <DotMatrix state={DOT_STATE[stage] ?? 'connecting'} aria-hidden />
      <ShimmerText shiny text={text} />
      {stopwatch}
    </span>
  )
}
