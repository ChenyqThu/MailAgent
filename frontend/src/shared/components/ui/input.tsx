// Sprint 18 — shadcn Input primitive.
//
// Pure HTML <input> wrapper with token-aware styling. The `type=number`
// spinner-button suppression keeps EnvField's custom step-buttons (PR D) as
// the single way to bump a numeric value — native spinners ignore i18n and
// look out-of-place on the macOS chrome.

import * as React from 'react'

import { cn } from '@shared/lib/cn'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        // input-surface (authored, index.css): light = ink-2 实底, dark = 半透
        // 墨色 — 实底在玻璃主题下是死黑块 (dogfood round 3)。
        'flex h-8 w-full rounded-md border border-ink-border input-surface px-3',
        'text-aux text-ink-fg placeholder:text-ink-fg-3',
        'transition-colors duration-fast ease-standard',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 focus-visible:border-coral/60',
        'disabled:cursor-not-allowed disabled:opacity-50',
        '[&[type=number]::-webkit-inner-spin-button]:appearance-none',
        '[&[type=number]::-webkit-outer-spin-button]:appearance-none',
        className
      )}
      {...props}
    />
  )
)
Input.displayName = 'Input'
