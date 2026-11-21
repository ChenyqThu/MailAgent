import { useMemo } from 'react'
import { MessagePrimitive, useAuiState, type TextMessagePartProps } from '@assistant-ui/react'

import type { TurnStagePart } from '@shared/assistant/runtime/useTurnStage'
import { segmentAssistantParts } from '@shared/assistant/tools/generic/turnProcessSegments'
import { TurnProcessGroup } from '@shared/assistant/tools/generic/TurnProcessGroup'

function DefaultPlainText({ text }: TextMessagePartProps): React.JSX.Element {
  return <p style={{ whiteSpace: 'pre-line' }}>{text}</p>
}

export interface AssistantPartsProps {
  readonly components: React.ComponentProps<typeof MessagePrimitive.Parts>['components']
}

/**
 * Drop-in wrapper over `MessagePrimitive.Parts` that groups contiguous pre-answer reasoning +
 * read/search tool calls into `TurnProcessGroup` timelines while delegating simple turns straight
 * to `MessagePrimitive.Parts`.
 */
export function AssistantParts({ components }: AssistantPartsProps): React.JSX.Element {
  const parts = useAuiState((s) => s.message.parts) as readonly TurnStagePart[]

  const segments = useMemo(() => segmentAssistantParts(parts), [parts])
  const hasProcessGroup = useMemo(
    () => segments.some((seg) => seg.kind === 'process'),
    [segments]
  )

  const effectiveComponents = useMemo(() => {
    if (!components) return { Text: DefaultPlainText }
    if ('ChainOfThought' in components && components.ChainOfThought !== undefined) {
      return components
    }
    return components.Text ? components : { ...components, Text: DefaultPlainText }
  }, [components])

  if (parts.length === 0 || !hasProcessGroup) {
    return <MessagePrimitive.Parts components={components} />
  }

  return (
    <>
      {segments.map((seg) =>
        seg.kind === 'process' ? (
          <TurnProcessGroup
            key={seg.key}
            foldableIndices={seg.foldableIndices}
            hasFollowingContent={seg.hasFollowingContent}
            partComponents={effectiveComponents}
          />
        ) : (
          <MessagePrimitive.PartByIndex
            key={`part-${seg.index}`}
            index={seg.index}
            components={effectiveComponents}
          />
        )
      )}
    </>
  )
}
