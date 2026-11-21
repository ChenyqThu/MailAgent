import { useEffect, useState } from 'react'

const FILLER_PREFIX_RE = /^(?:好的|嗯|让我想想|首先|(?:okay|ok|let me|sure|hmm|i will|i'll)\b)/i
const TRAILING_PUNCT_RE = /[:：。.;；，,]+$/

function cleanHeading(raw: string): string | null {
  const cleaned = raw.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().replace(TRAILING_PUNCT_RE, '').trim()
  return cleaned.length >= 2 ? cleaned : null
}

/**
 * Layer 3 live reasoning heading extraction:
 * Prefers explicit markdown headings (`**Bold**` or `### Heading`) scanning bottom-up so the most
 * recent thinking section wins. Avoids surfacing half-streamed unclosed bold markers or filler.
 */
export function extractReasoningHeading(text: string | undefined): string | null {
  if (!text) return null
  const trimmed = text.trim()
  if (trimmed.length < 2) return null

  const lines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return null

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!
    const boldMatch = /^\*\*([^*\n]{2,48})\*\*/.exec(line)
    if (boldMatch?.[1]) {
      const cleaned = cleanHeading(boldMatch[1])
      if (cleaned) return cleaned
    }
    const mdHeadingMatch = /^#{1,4}\s+([^\n]{2,48})$/.exec(line)
    if (mdHeadingMatch?.[1]) {
      const cleaned = cleanHeading(mdHeadingMatch[1])
      if (cleaned) return cleaned
    }
  }

  const first = lines[0]!
  // Wait for closing markdown bold delimiter before falling back to raw line text.
  if (first.startsWith('**')) return null
  if (first.length >= 4 && first.length <= 36 && !FILLER_PREFIX_RE.test(first)) {
    return cleanHeading(first)
  }

  return null
}

/**
 * Throttle rapid heading changes while thinking streams, surfacing the very first clear heading
 * immediately and pacing subsequent transitions via `intervalMs`.
 */
export function useThrottledReasoningHeading(
  text: string | undefined,
  active: boolean,
  intervalMs = 600
): string | null {
  const candidate = active ? extractReasoningHeading(text) : null
  const [throttled, setThrottled] = useState<string | null>(candidate)
  const [prevActive, setPrevActive] = useState(active)
  if (prevActive !== active) {
    setPrevActive(active)
    setThrottled(candidate)
  } else if (active && throttled === null && candidate !== null) {
    setThrottled(candidate)
  }

  useEffect(() => {
    if (!active || candidate === throttled) return undefined
    const id = window.setTimeout(() => {
      setThrottled(candidate)
    }, intervalMs)
    return (): void => window.clearTimeout(id)
  }, [active, candidate, throttled, intervalMs])

  return active ? (throttled ?? candidate) : null
}
