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
//
// A zero-arg component is still assignable to EmptyMessagePartComponent (the { status } prop is
// contravariantly droppable) — status is read from the store inside useTurnStage, so the prop is
// unused. Motion: ShimmerText only for active progress (loading 三词汇 §6), no spinner on the row.

import { useTranslation } from 'react-i18next'

import { cn } from '@shared/lib/cn'
import { DotMatrix, type DotMatrixState } from '@shared/components/ui/DotMatrix'
import { ShimmerText } from '@shared/components/ShimmerText'
import { useTurnStage, type TurnStage } from '@shared/assistant/runtime/useTurnStage'

const DOT_STATE: Partial<Record<TurnStage, DotMatrixState>> = {
  connecting: 'connecting',
  thinking: 'thinking',
  stalled: 'waiting',
  error: 'error'
}

export function TurnStatusLine(): React.JSX.Element | null {
  const { t } = useTranslation()
  const { stage, stallLevel } = useTurnStage()

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
      </span>
    )
  }

  // Actively progressing (connecting / thinking) → truthful shimmer phrase.
  const text = t('chat.status.thinking')

  return (
    <span className="inline-flex items-center gap-2 align-middle text-ink-fg-3">
      <DotMatrix state={DOT_STATE[stage] ?? 'connecting'} aria-hidden />
      <ShimmerText shiny text={text} />
    </span>
  )
}
