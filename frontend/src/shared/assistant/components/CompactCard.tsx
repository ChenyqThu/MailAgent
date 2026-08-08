import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DataMessagePartProps } from '@assistant-ui/react'
import { ChevronDown, ChevronRight } from 'lucide-react'

import type { CompactMessageMetadata } from '../../../ai-gateway/compactSelect'

interface CompactCardData {
  metadata: CompactMessageMetadata
  summary: string
}

function formatTokens(tokens: number): string {
  return tokens >= 1_000 ? `${Math.round(tokens / 100) / 10}K` : String(tokens)
}

export function CompactCard({ data }: DataMessagePartProps<CompactCardData>): React.JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const metadata = data.metadata
  return (
    <div className="w-full rounded-xl border border-[var(--hairline)] bg-ink-2 px-3 py-2 text-left normal-case tracking-normal">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="font-medium text-ink-fg">{t('chat.compact.completed')}</span>
        <span className="ml-auto text-micro text-ink-fg-3">
          #{metadata.compactedThroughMessageId} → #{metadata.firstKeptMessageId}
        </span>
      </button>
      <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-micro text-ink-fg-2">
        <span>
          {t('chat.compact.tokensBefore')}:{' '}
          {metadata.tokensBefore == null ? '—' : formatTokens(metadata.tokensBefore)}
        </span>
        <span>
          {t('chat.compact.tokensAfter')}:{' '}
          {metadata.estimatedTokensAfter == null
            ? '—'
            : formatTokens(metadata.estimatedTokensAfter)}
        </span>
        <span>
          {t('chat.compact.model')}: {metadata.model}
        </span>
        <span>
          {t('chat.compact.reason')}: {t(`chat.compact.reasonValue.${metadata.reason}`)}
        </span>
      </div>
      {expanded && (
        <pre className="scrollbar-thin mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-ink-3 p-2 font-sans text-aux text-ink-fg-1">
          {data.summary}
        </pre>
      )}
    </div>
  )
}
