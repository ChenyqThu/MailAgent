// dogfood-3 — Sources part renderer for the assistant-ui MessagePrimitive.Parts `Source` slot. AI SDK
// emits source-url / source-document parts (e.g. from web-search-style tools); each renders here as a
// compact pill that links out. 邮件 agent 当前工具走 tool-call 卡片(ToolTraceCard)不产 source part →
// 此区在邮件场景通常是空的(标准就位，接 web 搜索类工具才有数据)。assistant-ui passes the raw part, whose
// field shape varies by source type, so url/title are read DEFENSIVELY and nothing renders without a url.

import type { SourceMessagePartComponent } from '@assistant-ui/react'
import { ExternalLink } from 'lucide-react'

/** Best-effort hostname (sans leading www.) for the secondary label; undefined on an unparseable URL. */
function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return undefined
  }
}

export const SourcePart: SourceMessagePartComponent = (part) => {
  // SourceMessagePart fields vary by source type (url vs document); read url/title defensively.
  const p = part as { url?: unknown; title?: unknown }
  const url = typeof p.url === 'string' && p.url.length > 0 ? p.url : undefined
  if (!url) return null
  const title = typeof p.title === 'string' && p.title.length > 0 ? p.title : undefined
  const host = safeHost(url)
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="my-1 mr-1.5 inline-flex max-w-[18rem] items-center gap-1.5 rounded-full border border-ink-border-soft bg-ink-2 px-2.5 py-1 text-meta text-ink-fg-1 no-underline transition-opacity duration-fast hover:opacity-80"
    >
      <ExternalLink size={11} strokeWidth={2} className="shrink-0 text-ink-fg-3" />
      <span className="truncate">{title ?? host ?? url}</span>
      {title && host && <span className="shrink-0 text-ink-fg-3">· {host}</span>}
    </a>
  )
}
