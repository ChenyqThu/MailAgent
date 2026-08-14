// PersonChip（通讯录 WP4 · wiki 互链入口，cdemo.jsx L7-29 的实装）。两态：
//   · 在库 = pill 按钮：Monogram(18 / big 22) + 姓名 + hover 才显的 ArrowRight
//     （11px accent 色）+ hover accent 边框/淡底；点击 = 打开人物页（onOpen 由
//     调用方接 useContactNavigation + navigate）。
//   · 不在库 = 不可点 <span>：mono 12px + 1px dashed 边框 + ink-fg-3，--r-ctl 档
//     圆角；title 明说「不为它建占位记录」（WP4 红线：不建 stub）。
// props 吃散字段不吃 dto（镜像 Monogram 惯例）；样式 tailwind + v3 token，
// hover 过渡走既有 transition-colors tween 惯例（§10 禁 spring）。

import { ArrowRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { ContactKind } from '@shared/api/types/contact'
import { cn } from '@shared/lib/cn'

import { Monogram } from './Monogram'

interface PersonChipContact {
  id: number
  displayName: string | null
  nameEn: string | null
  primaryEmail: string | null
  kind: ContactKind
}

interface PersonChipProps {
  /** null = 地址不在通讯录（渲染虚线不可点态）。 */
  contact: PersonChipContact | null
  /** 原始地址 —— 不在库态的展示文本；在库态只作姓名兜底。 */
  addr: string
  big?: boolean
  onOpen?(id: number): void
}

export function PersonChip({ contact, addr, big, onOpen }: PersonChipProps): React.ReactElement {
  const { t } = useTranslation()
  if (contact === null) {
    return (
      <span
        title={t('contacts.chip.notInDirectory')}
        className={cn(
          'inline-flex items-center gap-1 rounded-[var(--r-ctl)] border border-dashed',
          'border-ink-border px-1.5 py-0.5 font-mono text-meta text-ink-fg-3'
        )}
      >
        {addr}
      </span>
    )
  }
  const name = contact.displayName || contact.nameEn || contact.primaryEmail || addr
  return (
    <button
      type="button"
      onClick={onOpen ? () => onOpen(contact.id) : undefined}
      title={t('contacts.chip.open', { name })}
      className={cn(
        'group/chip inline-flex items-center rounded-full border border-ink-border',
        'bg-ink-fg/[0.03] transition-colors duration-fast ease-standard',
        'hover:border-coral/35 hover:bg-coral/[0.08]',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-coral/70',
        big ? 'gap-1.5 py-[3px] pl-1 pr-2' : 'gap-1 py-0.5 pl-[3px] pr-[7px]'
      )}
    >
      <Monogram
        displayName={contact.displayName}
        primaryEmail={contact.primaryEmail}
        kind={contact.kind}
        size={big ? 22 : 18}
      />
      <span className={cn('text-ink-fg', big ? 'text-aux' : 'text-meta')}>{name}</span>
      <ArrowRight
        size={11}
        strokeWidth={2}
        aria-hidden
        className="hidden text-coral group-hover/chip:inline group-focus-visible/chip:inline"
      />
    </button>
  )
}
