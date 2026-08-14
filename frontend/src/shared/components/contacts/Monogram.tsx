// 通讯录 Monogram（设计 D10 修正稿）：
// 人 = 圆形 `hsl(h 62% 42% / .16)` 底 + 同色 1px 内描边 + 同色字；色相 =
// hueOf(主邮箱) 8 档哈希（主邮箱做锚点 → 合并/改名不跳色）。
// 机器人 / 群发列表 = 虚线圆角方块 + 图标、无色相（“不担人格”的形状区分）。
// initials 复用 recipient-avatar 的 contactInitials（中文取后 2 字，小尺寸下收窄
// 成单字——见 personName.ts 的 INITIALS_SINGLE_GLYPH_MAX_SIZE）；裸邮箱取
// local-part 前 2 字符（D8）。⚠️ 不复用 `.avatar-1..6` 色板（规格不同）。

import { Bot, Megaphone } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { contactInitials } from '@shared/lib/personName'
import type { ContactKind } from '@shared/api/types/contact'

import { hueOf } from './monogramColor'

interface MonogramProps {
  displayName: string | null
  /** 主邮箱 —— 色相锚点（合并/改名不跳色）。 */
  primaryEmail: string | null
  kind: ContactKind
  /** px 直径。 */
  size?: number
  /** 已隐藏的记录整体压暗（原型 `cui.jsx::Monogram` 的 `dim` → opacity .6）。 */
  dim?: boolean
  className?: string
}

export function Monogram({
  displayName,
  primaryEmail,
  kind,
  size = 32,
  dim,
  className
}: MonogramProps): React.ReactElement {
  if (kind !== 'person') {
    // 原型：虚线圆角方块 + `ink-fg/0.04` 底 + `ink-fg-2` 字色 + 图标 0.5×size；
    // 圆角 size≥30 走行档(9)、更小走控件档(8)。
    return (
      <span
        aria-hidden
        className={cn(
          'inline-flex shrink-0 items-center justify-center border border-dashed',
          'border-ink-border bg-ink-fg/[0.04] text-ink-fg-2',
          size >= 30 ? 'rounded-[var(--r-row)]' : 'rounded-[var(--r-ctl)]',
          className
        )}
        style={{ width: size, height: size, opacity: dim ? 0.6 : undefined }}
      >
        {kind === 'robot' ? (
          <Bot size={Math.round(size * 0.5)} />
        ) : (
          <Megaphone size={Math.round(size * 0.5)} />
        )}
      </span>
    )
  }
  const hue = hueOf(primaryEmail ?? displayName ?? '?')
  const tone = `hsl(${hue} 62% 42%)`
  const initials = contactInitials(displayName ?? '', primaryEmail ?? '', size)
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold',
        className
      )}
      style={{
        width: size,
        height: size,
        color: tone,
        background: `hsl(${hue} 62% 42% / 0.16)`,
        boxShadow: `inset 0 0 0 1px hsl(${hue} 62% 42% / 0.28)`,
        fontSize: Math.max(10, Math.round(size * 0.4)),
        letterSpacing: '-0.02em',
        opacity: dim ? 0.6 : undefined
      }}
    >
      {initials}
    </span>
  )
}
