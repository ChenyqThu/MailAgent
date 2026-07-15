// Recipient chip / dropdown / detail avatar.
//
// Reuses the shared `.avatar` + `.avatar-1..6` gradient palette authored in
// index.css (§Avatar) — no new hex, no new CSS. `--avatar-size` is set inline
// so the same class scales from the 18px chip dot to the 38px detail header.
// Initials follow the compose design spec (design/data.jsx): Chinese names take
// the last two glyphs, Latin names take the first letter of the first two words.

import { cn } from '@shared/lib/cn'

const AVATAR_SLOTS = 6

// djb2 → 1..6, matching the deterministic slot picker EmailRow uses so the same
// person keeps the same colour across the list and the composer.
function avatarSlot(seed: string): number {
  let hash = 5381
  for (let i = 0; i < seed.length; i++) hash = (hash * 33) ^ seed.charCodeAt(i)
  return ((hash >>> 0) % AVATAR_SLOTS) + 1
}

/** Chinese → last 2 chars; Latin → first-letter of first two words; else first 2. */
export function contactInitials(name: string, email: string): string {
  const src = (name || email.split('@')[0] || '').trim()
  if (!src) return '?'
  if (/[一-鿿]/.test(src)) return src.slice(-2)
  const parts = src.split(/[\s.]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
  return src.slice(0, 2).toUpperCase()
}

interface Props {
  name: string
  email: string
  /** px diameter; drives `--avatar-size` + a proportional font size. */
  size?: number
}

export function RecipientAvatar({ name, email, size = 18 }: Props): React.ReactElement {
  const initials = contactInitials(name, email)
  const slot = avatarSlot(email || name || initials)
  return (
    <span
      aria-hidden
      className={cn('avatar', `avatar-${slot}`)}
      style={
        {
          ['--avatar-size' as string]: `${size}px`,
          fontSize: `${Math.max(9, Math.round(size * 0.42))}px`
        } as React.CSSProperties
      }
    >
      {initials}
    </span>
  )
}
