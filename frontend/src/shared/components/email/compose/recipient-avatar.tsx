// Recipient chip / dropdown / detail avatar.
//
// Reuses the shared `.avatar` + `.avatar-1..6` gradient palette authored in
// index.css (§Avatar) — no new hex, no new CSS. `--avatar-size` is set inline
// so the same class scales from the 18px chip dot to the 38px detail header.
// Initials follow the compose design spec (design/data.jsx): Chinese names take
// the last two glyphs, Latin names take the first letter of the first two words.

import { cn } from '@shared/lib/cn'
import { contactInitials } from '@shared/lib/personName'

const AVATAR_SLOTS = 6

// djb2 → 1..6, matching the deterministic slot picker EmailRow uses so the same
// person keeps the same colour across the list and the composer.
function avatarSlot(seed: string): number {
  let hash = 5381
  for (let i = 0; i < seed.length; i++) hash = (hash * 33) ^ seed.charCodeAt(i)
  return ((hash >>> 0) % AVATAR_SLOTS) + 1
}

// initials（Chinese → last 2 chars; Latin → first two word initials）口径下沉
// @shared/lib/personName —— 通讯录 Monogram（WP2）复用同一份，react-refresh 规则
// 不许组件文件兼职导出工具函数。⚠️ 色板 `.avatar-1..6` 不外借 —— 通讯录 D10 是
// 8 档 hue 环 + 固定亮饱和，规格不同。

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
