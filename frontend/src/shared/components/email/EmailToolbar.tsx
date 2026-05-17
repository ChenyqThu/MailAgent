// 48px detail toolbar · mockup-inbox.html line 854. The mockup has:
//   Back | ✦ 起草回复 (coral CTA) · 翻译 EN→中 | 已读 · 已标旗 · 归档 | 重传 · AI 重跑 | (ml-auto) Notion · ⌃/⌄/⋯
//
// Sprint 3 wires the Translate button (props-driven); Sprint 5 wires the
// remaining ghost actions via cli_runner. The Translate button cycles:
//   idle           → "翻译 EN→中"   (click → start)
//   translating    → "翻译中…"      (loading state)
//   showing trans. → "显示原文"      (toggles back to source)
//   error          → "翻译失败 · 重试" (red, click → refetch)
//
// EmailDetail owns the state machine and passes the resolved status here
// so the toolbar stays pure-presentational.

import { useTranslation } from 'react-i18next'
import {
  Archive,
  ArrowLeft,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Languages,
  MoreHorizontal,
  RefreshCcw,
  Sparkles,
  Star,
  Zap
} from 'lucide-react'

import { cn } from '@shared/lib/cn'

export type TranslateStatus = 'idle' | 'loading' | 'translated' | 'error'

interface TranslateProps {
  /** 'en' → show EN→中 pip; 'zh' → hide pip (translate to English still works
   *  via ⌥T but the toolbar headline focuses on the most common direction). */
  langIsEn: boolean
  status: TranslateStatus
  onToggle: () => void
}

interface ToolbarProps {
  translate?: TranslateProps
}

function Divider(): React.ReactElement {
  return <div className="w-px h-5 bg-ink-border mx-1 shrink-0" aria-hidden />
}

function Ghost({
  icon,
  children,
  title,
  active
}: {
  icon: React.ReactNode
  children?: React.ReactNode
  title?: string
  active?: boolean
}): React.ReactElement {
  return (
    <button
      type="button"
      disabled
      title={title}
      className={cn(
        'flex items-center gap-1.5 px-2 py-1.5 rounded-md text-aux',
        'transition-colors duration-fast',
        active ? 'text-urg' : 'text-ink-fg-1',
        'hover:text-ink-fg hover:bg-ink-4',
        'disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-fg-1'
      )}
    >
      <span className="shrink-0 grid place-items-center w-[13px] h-[13px]">{icon}</span>
      {children && <span>{children}</span>}
    </button>
  )
}

function IconOnly({ icon, title }: { icon: React.ReactNode; title?: string }): React.ReactElement {
  return (
    <button
      type="button"
      disabled
      title={title}
      className={cn(
        'text-ink-fg-2 hover:text-ink-fg p-1.5 rounded transition-colors duration-fast hover:bg-ink-4',
        'disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:bg-transparent'
      )}
    >
      {icon}
    </button>
  )
}

function TranslateButton({ langIsEn, status, onToggle }: TranslateProps): React.ReactElement {
  const { t } = useTranslation()
  const isError = status === 'error'
  const isLoading = status === 'loading'
  const isTranslated = status === 'translated'

  const label = isLoading
    ? t('translate.loading')
    : isError
      ? t('translate.failed')
      : isTranslated
        ? t('translate.showOriginal')
        : t('translate.label')

  return (
    <button
      type="button"
      onClick={onToggle}
      title={`⌥T · ${label}`}
      className={cn(
        'flex items-center gap-1.5 px-2 py-1.5 rounded-md text-aux',
        'transition-colors duration-fast',
        isError
          ? 'text-fail hover:bg-fail/10'
          : isTranslated
            ? 'text-coral bg-coral/10 hover:bg-coral/15'
            : 'text-ink-fg-1 hover:text-ink-fg hover:bg-ink-4',
        'disabled:opacity-60 disabled:cursor-not-allowed'
      )}
    >
      <span className="shrink-0 grid place-items-center w-[13px] h-[13px]">
        <Languages size={13} strokeWidth={2} className={isLoading ? 'animate-spin' : undefined} />
      </span>
      <span className="flex items-center gap-1">
        {label}
        {langIsEn && !isError && !isLoading && (
          <span
            className="lang-pip ml-0.5"
            style={{
              background: 'rgb(var(--c-accent) / 0.10)',
              borderColor: 'rgb(var(--c-accent) / 0.30)',
              color: 'rgb(var(--c-accent))'
            }}
          >
            EN→中
          </span>
        )}
      </span>
    </button>
  )
}

export function EmailToolbar({ translate }: ToolbarProps = {}): React.ReactElement {
  return (
    <header className="h-[48px] border-b border-ink-border bg-ink-3 flex items-center px-3 gap-1 shrink-0">
      <IconOnly icon={<ArrowLeft size={14} strokeWidth={2} />} title="Back (Esc)" />
      <Divider />

      {/* Primary CTA — coral fill (DESIGN.md §2.2 "one CTA per surface"). */}
      <button
        type="button"
        disabled
        title="Sprint 5"
        className={cn(
          'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md',
          'bg-coral/100 text-accent-fg text-aux font-medium',
          'hover:bg-coral-hover transition-colors duration-fast',
          'disabled:opacity-70 disabled:cursor-not-allowed'
        )}
      >
        <Sparkles size={13} strokeWidth={2} className="fill-current" />
        <span>起草回复</span>
      </button>

      {translate && <TranslateButton {...translate} />}

      <Divider />

      <Ghost icon={<CheckCheck size={13} strokeWidth={2} />} title="Mark read (R)">
        已读
      </Ghost>
      <Ghost
        icon={<Star size={13} strokeWidth={1.5} className="fill-current" />}
        title="Toggle flag (F)"
        active
      >
        已标旗
      </Ghost>
      <Ghost icon={<Archive size={13} strokeWidth={2} />} title="Archive (E)">
        归档
      </Ghost>

      <Divider />

      <Ghost icon={<RefreshCcw size={13} strokeWidth={2} />} title="Retry Notion sync">
        重传 Notion
      </Ghost>
      <Ghost icon={<Zap size={13} strokeWidth={2} />} title="Re-run AI">
        AI 重跑
      </Ghost>

      <div className="ml-auto flex items-center gap-1">
        <Ghost icon={<ExternalLink size={13} strokeWidth={2} />} title="Open in Notion">
          Notion
        </Ghost>
        <Divider />
        <IconOnly icon={<ChevronUp size={14} strokeWidth={2} />} title="Previous (K)" />
        <IconOnly icon={<ChevronDown size={14} strokeWidth={2} />} title="Next (J)" />
        <IconOnly icon={<MoreHorizontal size={14} strokeWidth={2} />} title="More" />
      </div>
    </header>
  )
}
