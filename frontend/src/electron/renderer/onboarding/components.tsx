// Onboarding shared primitives — ported from docs/packaging/onboarding/components.jsx
// to production TSX. All visuals come from token-backed scoped classes (.ob …) in
// onboarding.css + Tailwind utilities; no new colors are introduced.
//
// Notable changes from the JSX prototype:
//   - MacWindow → OnboardingShell: NO fake mac chrome / traffic lights / JS scaling.
//     The real BrowserWindow uses titleBarStyle:'hiddenInset' so the OS draws the
//     traffic lights; we just render a 38px drag titlebar + body.
//   - TopStepper dropped (rail layout only).

/* eslint-disable react-refresh/only-export-components -- shared primitives module
   intentionally co-exports ICON_PATHS + types alongside components (same pattern as
   shared/router-instance.tsx); HMR fast-refresh isn't relevant to the onboarding shell. */

import type { CSSProperties, ReactNode } from 'react'

/* ─── Icon set (single-stroke, currentColor) ─────────────────────────────── */
export const ICON_PATHS: Record<string, string> = {
  check: 'M20 6 9 17l-5-5',
  x: 'M18 6 6 18M6 6l12 12',
  arrowRight: 'M5 12h14M13 5l7 7-7 7',
  arrowLeft: 'M19 12H5M11 19l-7-7 7-7',
  spark: 'M12 2 14.4 9.6 22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  mail: 'M3 5h18v14H3zM3 6l9 7 9-7',
  database:
    'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  refresh: 'M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5',
  external: 'M15 3h6v6M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 0 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 0 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
  alert:
    'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  info: 'M12 16v-4M12 8h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
  download: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  archive: 'M3 5h18v4H3zM5 9v10h14V9M9 13h6',
  plug: 'M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5',
  bell: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  calendar: 'M3 5h18v16H3zM3 9h18M8 3v4M16 3v4',
  brain:
    'M9 3a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 1 5 3 3 0 0 0 5 1V4a3 3 0 0 0-1-1zM15 3a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-1 5 3 3 0 0 1-5 1',
  rocket:
    'M5 13c-1.5 1.3-2 5-2 5s3.7-.5 5-2M12 15l-3-3a13 13 0 0 1 8-9 13 13 0 0 1-1 8 13 13 0 0 1-4 4zM15 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  clock: 'M12 7v5l3 2M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
  key: 'M14 7a4 4 0 1 1-4 4M10 11l-7 7v3h3l1-1h2v-2h2l2-2',
  server: 'M3 4h18v6H3zM3 14h18v6H3zM7 7h.01M7 17h.01',
  fileWarn: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 3v5h5M12 12v3M12 18h.01',
  pause: 'M8 5v14M16 5v14',
  layers: 'M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  chevron: 'M9 18l6-6-6-6',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4z',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5 5h14l3 7v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6z'
}

export type IconName = keyof typeof ICON_PATHS | string

export interface IconProps {
  name: IconName
  size?: number
  sw?: number
  fill?: boolean
  style?: CSSProperties
  cls?: string
}

export function Icon({
  name,
  size = 16,
  sw = 2,
  fill = false,
  style,
  cls
}: IconProps): React.JSX.Element {
  const d = ICON_PATHS[name] ?? ''
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cls}
      fill={fill ? 'currentColor' : 'none'}
      stroke={fill ? 'none' : 'currentColor'}
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
    >
      {d
        .split('M')
        .filter(Boolean)
        .map((seg, i) => (
          <path key={i} d={'M' + seg} />
        ))}
    </svg>
  )
}

/* ─── OnboardingShell — real-window outer frame (no fake chrome) ──────────── */
export interface OnboardingShellProps {
  title: string
  accentDot?: boolean
  children: ReactNode
}

export function OnboardingShell({
  title,
  accentDot = true,
  children
}: OnboardingShellProps): React.JSX.Element {
  return (
    <div className="ob">
      <div className="ob-titlebar">
        <span className="ob-title">
          {accentDot && (
            <span style={{ color: 'rgb(var(--c-accent))', display: 'inline-flex' }}>
              <Icon name="spark" size={12} fill />
            </span>
          )}
          {title}
        </span>
      </div>
      <div className="ob-body">{children}</div>
    </div>
  )
}

/* ─── Step rail (left) ────────────────────────────────────────────────────── */
export interface StepDef {
  key: string
  label: string
}

export interface StepRailProps {
  steps: StepDef[]
  current: number
  brand?: string
}

export function StepRail({
  steps,
  current,
  brand = 'MailAgent'
}: StepRailProps): React.JSX.Element {
  return (
    <div className="step-rail">
      <div className="flex items-center gap-2.5 px-2.5 mb-5">
        <span
          className="grid place-items-center w-7 h-7 rounded-md shrink-0"
          style={{ background: 'rgb(var(--c-accent))', color: 'rgb(var(--c-accent-fg))' }}
        >
          <Icon name="spark" size={15} fill />
        </span>
        <div>
          <div className="text-[14px] font-semibold leading-none text-ink-fg">{brand}</div>
          <div className="text-[11px] font-mono text-ink-fg-2 mt-1">设置向导</div>
        </div>
      </div>
      <div className="flex-1">
        {steps.map((s, i) => {
          const state = i < current ? 'done' : i === current ? 'active' : ''
          return (
            <div key={s.key}>
              <div className={`step-item ${state}`}>
                <span className="dot">
                  {i < current ? <Icon name="check" size={12} sw={3} /> : i + 1}
                </span>
                <span className="lbl">{s.label}</span>
              </div>
              {i < steps.length - 1 && (
                <div className={`step-connector ${i < current ? 'filled' : ''}`} />
              )}
            </div>
          )
        })}
      </div>
      <div className="px-2.5 pt-3 mt-auto">
        <div className="text-[11px] font-mono text-ink-fg-3 leading-relaxed">
          ~/Library/Application&nbsp;Support/MailAgent
        </div>
      </div>
    </div>
  )
}

/* ─── Form field ──────────────────────────────────────────────────────────── */
export interface FieldProps {
  label?: ReactNode
  icon?: IconName
  required?: boolean
  hint?: ReactNode
  error?: ReactNode
  warn?: ReactNode
  children: ReactNode
}

export function Field({
  label,
  icon,
  required,
  hint,
  error,
  warn,
  children
}: FieldProps): React.JSX.Element {
  return (
    <div>
      {label && (
        <div className="fld-label">
          {icon && (
            <span className="text-ink-fg-2">
              <Icon name={icon} size={14} />
            </span>
          )}
          {label}
          {required && <span className="req-star">*</span>}
        </div>
      )}
      {children}
      {error && (
        <div className="fld-err">
          <Icon name="alert" size={13} /> {error}
        </div>
      )}
      {warn && !error && (
        <div className="fld-warn">
          <Icon name="alert" size={13} /> {warn}
        </div>
      )}
      {hint && !error && !warn && <div className="fld-hint">{hint}</div>}
    </div>
  )
}

/* ─── Multi-select chips ──────────────────────────────────────────────────── */
export interface ChipSelectProps {
  options: string[]
  value: string[]
  onChange: (next: string[]) => void
}

export function ChipSelect({ options, value, onChange }: ChipSelectProps): React.JSX.Element {
  const toggle = (v: string): void => {
    if (value.includes(v)) onChange(value.filter((x) => x !== v))
    else onChange([...value, v])
  }
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => {
        const on = value.includes(o)
        return (
          <button
            key={o}
            className={`chip-sel ${on ? 'on' : ''}`}
            onClick={() => toggle(o)}
            type="button"
          >
            {on && (
              <span className="ck">
                <Icon name="check" size={13} sw={3} />
              </span>
            )}
            {o}
          </button>
        )
      })}
    </div>
  )
}

/* ─── Toggle switch ───────────────────────────────────────────────────────── */
export interface ToggleProps {
  on: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}

export function Toggle({ on, onChange, disabled }: ToggleProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={`sw ${on ? 'on' : ''}`}
      disabled={disabled}
      onClick={() => !disabled && onChange(!on)}
      aria-checked={on}
      role="switch"
    />
  )
}

/* ─── Progress bar ────────────────────────────────────────────────────────── */
export interface ProgressBarProps {
  value?: number
  indeterminate?: boolean
}

export function ProgressBar({ value = 0, indeterminate }: ProgressBarProps): React.JSX.Element {
  return (
    <div className="pbar">
      <div
        className={`pbar-fill ${indeterminate ? 'indeterminate' : ''}`}
        style={{ width: indeterminate ? undefined : `${value}%` }}
      />
    </div>
  )
}

/* ─── Banner ──────────────────────────────────────────────────────────────── */
export type BannerKind = 'info' | 'warn' | 'fail' | 'accent'

export interface BannerProps {
  kind?: BannerKind
  icon?: IconName
  children: ReactNode
}

export function Banner({ kind = 'info', icon, children }: BannerProps): React.JSX.Element {
  const ic =
    icon ??
    (kind === 'fail' ? 'alert' : kind === 'warn' ? 'alert' : kind === 'accent' ? 'spark' : 'info')
  const col =
    kind === 'fail'
      ? 'var(--c-fail)'
      : kind === 'warn'
        ? 'var(--c-warn)'
        : kind === 'accent'
          ? 'var(--c-accent)'
          : 'var(--c-info)'
  return (
    <div className={`banner banner-${kind}`}>
      <span style={{ color: `rgb(${col})`, flexShrink: 0, marginTop: 1 }}>
        <Icon name={ic} size={16} fill={ic === 'spark'} />
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/* ─── Footer nav ──────────────────────────────────────────────────────────── */
export interface WizFooterProps {
  onBack?: (() => void) | null
  onNext?: (() => void) | null
  nextLabel?: string
  backLabel?: string
  nextDisabled?: boolean
  nextIcon?: IconName | null
  busy?: boolean
  left?: ReactNode
  secondary?: ReactNode
}

export function WizFooter({
  onBack,
  onNext,
  nextLabel = '下一步',
  backLabel = '上一步',
  nextDisabled,
  nextIcon = 'arrowRight',
  busy,
  left,
  secondary
}: WizFooterProps): React.JSX.Element {
  return (
    <div className="wiz-footer">
      {onBack ? (
        <button className="btn-sec" onClick={onBack}>
          <Icon name="arrowLeft" size={14} /> {backLabel}
        </button>
      ) : (
        <span />
      )}
      {left}
      <div className="ml-auto flex items-center gap-2.5">
        {secondary}
        {onNext && (
          <button className="btn-primary" onClick={onNext} disabled={nextDisabled || busy}>
            {busy ? <Icon name="refresh" size={14} cls="spin" /> : null}
            {nextLabel}
            {!busy && nextIcon && <Icon name={nextIcon} size={14} />}
          </button>
        )}
      </div>
    </div>
  )
}
