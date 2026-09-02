// mockup 脚手架件：状态条、场景说明、系统对话框占位、toast。
// 这些**不进主仓** —— 产品里没有「切换状态」这回事。

import * as React from 'react'
import { AlertTriangle, Info, MonitorCog } from 'lucide-react'

import { cn } from '@shared/lib/cn'

import { S } from '../strings'

/* ── 状态条 ─────────────────────────────────────────────────────── */

export interface StateGroup<T extends string> {
  label: string
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange(next: T): void
}

/** 一组互斥状态钮。场景把自己的所有状态轴摆在这里。 */
export function StateSwitch<T extends string>({
  label,
  value,
  options,
  onChange
}: StateGroup<T>): React.ReactElement {
  return (
    <div className="flex items-center gap-1.5">
      <span className="shrink-0 text-micro font-mono uppercase tracking-widest text-ink-fg-3">
        {label}
      </span>
      <div className="flex items-center gap-1 rounded-lg bg-ink-1/70 p-0.5">
        {options.map((opt) => {
          const active = opt.value === value
          return (
            <button
              key={opt.value}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(opt.value)}
              className={cn(
                'h-6 rounded-md border px-2 text-meta transition-colors duration-fast',
                active
                  ? 'border-coral/50 bg-coral/12 text-coral'
                  : 'border-transparent text-ink-fg-2 hover:border-ink-border hover:bg-ink-3'
              )}
            >
              {opt.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function StateBar({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-ink-border bg-ink-1 px-4 py-2">
      {children}
    </div>
  )
}

/** 场景标题栏（id · 名称 · design 章节）。 */
export function SceneHead({
  id,
  title,
  design,
  note
}: {
  id: string
  title: string
  design: string
  note?: string
}): React.ReactElement {
  return (
    <div className="mb-3">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-meta text-ink-fg-3">{id}</span>
        <h1 className="text-lead font-medium text-ink-fg">{title}</h1>
        <span className="font-mono text-micro text-ink-fg-3">design {design}</span>
      </div>
      {note ? (
        <p className="mt-1 max-w-3xl text-meta leading-relaxed text-ink-fg-2">{note}</p>
      ) : null}
    </div>
  )
}

/* ── 系统对话框占位 ─────────────────────────────────────────────── */

/** 触发系统级窗口（showOpenDialog / 访达 / 外部应用）的地方一律用这张卡表示。
 *  不画假的 macOS 窗口 —— 那会让 review 的人以为我们要自己做一个。 */
export function SystemDialogCard({
  action,
  detail,
  onDone,
  doneLabel = '假装用户已选好'
}: {
  action: string
  detail?: string
  onDone?: () => void
  doneLabel?: string
}): React.ReactElement {
  return (
    <div className="mk-sysdialog rounded-[var(--r-card)] p-3.5">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg border border-ink-border bg-ink-2 text-ink-fg-2">
          <MonitorCog size={15} strokeWidth={1.75} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-aux font-medium text-ink-fg">{action}</span>
            <span className="rounded-full bg-ink-4 px-2 py-0.5 text-micro text-ink-fg-2">
              {S.systemDialogPlaceholder}
            </span>
          </div>
          {detail ? <p className="mt-1 text-meta leading-relaxed text-ink-fg-3">{detail}</p> : null}
          {onDone ? (
            <button
              type="button"
              onClick={onDone}
              className="mt-2 h-7 rounded-md border border-ink-border bg-ink-2 px-2.5 text-meta text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
            >
              {doneLabel}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/* ── 说明条 ─────────────────────────────────────────────────────── */

export function Notice({
  tone = 'info',
  children
}: {
  tone?: 'info' | 'warn' | 'fail'
  children: React.ReactNode
}): React.ReactElement {
  const Icon = tone === 'info' ? Info : AlertTriangle
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-[var(--r-ctl)] border px-2.5 py-1.5 text-meta leading-relaxed',
        tone === 'info' && 'border-info/25 bg-info/[0.07] text-ink-fg-1',
        tone === 'warn' && 'border-warn/30 bg-warn/[0.07] text-ink-fg-1',
        tone === 'fail' && 'border-fail/30 bg-fail/[0.07] text-ink-fg-1'
      )}
    >
      <Icon
        size={13}
        strokeWidth={2}
        aria-hidden
        className={cn(
          'mt-0.5 shrink-0',
          tone === 'info' && 'text-info',
          tone === 'warn' && 'text-warn',
          tone === 'fail' && 'text-fail'
        )}
      />
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}

/* ── toast（深链落地 G4 要用） ──────────────────────────────────── */

export function Toast({ text, onClose }: { text: string; onClose(): void }): React.ReactElement {
  return (
    <div className="pointer-events-auto fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-[var(--r-card)] border border-ink-border bg-ink-3 px-3.5 py-2 text-aux text-ink-fg shadow-lg">
      <span>{text}</span>
      <button
        type="button"
        onClick={onClose}
        className="ml-3 text-meta text-ink-fg-3 hover:text-ink-fg"
      >
        {S.act.close}
      </button>
    </div>
  )
}

/* ── 小件 ───────────────────────────────────────────────────────── */

export function Pill({
  tone = 'ink',
  children,
  title
}: {
  tone?: 'ink' | 'accent' | 'ok' | 'warn' | 'fail' | 'info' | 'ai'
  children: React.ReactNode
  title?: string
}): React.ReactElement {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-micro font-medium',
        tone === 'ink' && 'bg-ink-4 text-ink-fg-2',
        tone === 'accent' && 'bg-coral/15 text-coral',
        tone === 'ok' && 'bg-ok/15 text-ok',
        tone === 'warn' && 'bg-warn/15 text-warn',
        tone === 'fail' && 'bg-fail/15 text-fail',
        tone === 'info' && 'bg-info/15 text-info',
        tone === 'ai' && 'bg-ai/15 text-ai'
      )}
    >
      {children}
    </span>
  )
}

/** 演示区块：给一个场景里的多张图各配一行说明。 */
export function Demo({
  title,
  hint,
  children,
  className
}: {
  title: string
  hint?: string
  children: React.ReactNode
  className?: string
}): React.ReactElement {
  return (
    <section className="mb-5">
      <div className="mb-1.5 flex items-baseline gap-2">
        <h2 className="text-aux font-medium text-ink-fg">{title}</h2>
        {hint ? <span className="text-meta text-ink-fg-3">{hint}</span> : null}
      </div>
      <div
        className={cn('rounded-[var(--r-card)] border border-ink-border bg-ink-1 p-3', className)}
      >
        {children}
      </div>
    </section>
  )
}
