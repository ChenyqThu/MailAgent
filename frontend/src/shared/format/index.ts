// Intl wrapper. DESIGN.md §16.5: macOS local TZ for display, ISO8601 with
// offset on the wire. Relative-time threshold table per §16.5 sub-section.

export function formatDate(iso: string, locale: string = 'zh-CN'): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(iso))
}

export function formatRelativeTime(iso: string, locale: string = 'zh-CN'): string {
  const target = new Date(iso).getTime()
  const now = Date.now()
  const diffMs = target - now
  const absSec = Math.abs(diffMs) / 1000
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })

  if (absSec < 60) return rtf.format(Math.round(diffMs / 1000), 'second')
  if (absSec < 3600) return rtf.format(Math.round(diffMs / 60000), 'minute')
  if (absSec < 86400) return rtf.format(Math.round(diffMs / 3600000), 'hour')
  // >24h → fall back to absolute date for clarity
  return formatDate(iso, locale)
}

export function formatFileSize(bytes: number, locale: string = 'zh-CN'): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  const fmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
  return `${fmt.format(value)} ${units[i]}`
}
