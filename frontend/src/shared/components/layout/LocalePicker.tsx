// Sprint 11 V1.4 — DESIGN.md §2.10 / §2.11 — TitleBar Locale picker.
//
// Two-locale toggle. Click switches zh-CN ↔ en-US via i18next; persisted
// via i18next-browser-language-detector's localStorage cache. We also
// broadcast `appearance:locale` over IPC so the Island fork can update
// its own UI in lockstep (same pattern as theme/accent broadcasts in
// appearance.ts).

import { useTranslation } from 'react-i18next'
import { Globe } from 'lucide-react'

import { cn } from '@shared/lib/cn'

type Locale = 'zh-CN' | 'en-US'

interface RendererIPC {
  electron?: {
    ipcRenderer?: {
      send: (channel: string, ...args: unknown[]) => void
    }
  }
}

function broadcastLocale(next: Locale): void {
  if (typeof window === 'undefined') return
  const w = window as unknown as RendererIPC
  w.electron?.ipcRenderer?.send('appearance:locale', next)
}

export function LocalePicker(): React.ReactElement {
  const { t, i18n } = useTranslation()
  const current = (i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN') as Locale
  const display = current === 'zh-CN' ? '中文' : 'English'

  const onClick = (): void => {
    const next: Locale = current === 'zh-CN' ? 'en-US' : 'zh-CN'
    void i18n.changeLanguage(next)
    broadcastLocale(next)
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={t('titleBar.locale.tooltip')}
      aria-label={t('titleBar.locale.aria')}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      className={cn(
        'group flex items-center gap-1.5 px-1.5 py-0.5 rounded',
        'hover:bg-ink-3 hover:text-ink-fg-1 active:bg-ink-4 transition-colors duration-fast'
      )}
    >
      <Globe size={11} strokeWidth={2} />
      <span className="group-hover:text-ink-fg">{display}</span>
    </button>
  )
}
