// shadcn-style cn() — Tailwind class merger that survives conflicts (e.g.
// `cn('px-2', 'px-4')` → 'px-4', not 'px-2 px-4'). Standard primitive used by
// every shadcn-ui component; lives at @shared/lib/cn so renderer + web share.
//
// 🔴 extendTailwindMerge 注册自定义 fontSize 刻度 (tailwind.config.ts:
// micro/meta/aux/body/lead/subj)。这些不在 twMerge 默认 font-size 表里, 默认
// twMerge 会把它们和自定义 text-color (text-ink-fg-*/text-coral/… 也是 `text-`
// 前缀) 当成同一个冲突组, 只保留最后一个 → 形如 `cn('… text-micro … text-ink-fg-1')`
// (字号在前、颜色在后) 会被静默丢掉字号, 元素回退继承父级字号 (偏大)。把自定义字号
// 注册进 font-size group, twMerge 才能把「字号」与「文字颜色」正确分到两组、各自保留。
// (实证: 修复前 `text-micro … text-ink-fg-1` → 丢 text-micro; 修复后两者都在。)

import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['micro', 'meta', 'aux', 'body', 'lead', 'subj'] }]
    }
  }
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
