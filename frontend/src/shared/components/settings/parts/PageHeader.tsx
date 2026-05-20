// Sprint 18 review — Settings tab page header.
//
// Mockup-settings.html §appearance / §accounts 等每 tab 顶部都是 3 段:
//   1. text-micro mono uppercase eyebrow — 英文 GROUP 名 (国际化只译显
//      示, eyebrow 自身保持英文风格 DESIGN.md §3.3 "section header EN-only")
//   2. h1 26px font-semibold tracking-tight — 中文 / 本地化标题
//   3. text-aux ink-fg-1 introduction — 一句话说明该 tab 干嘛
//
// 抽成 parts/ 共用组件让 8 个 tab 节奏整齐 (block-rhythm = mb-7,
// 同 Section.tsx 默认 gap). Tab 文件只传 i18n key 即可.

import * as React from 'react'

import { cn } from '@shared/lib/cn'

interface PageHeaderProps {
  /** 顶部 mono uppercase eyebrow. 习惯写英文短词 (GENERAL / ACCOUNTS). */
  eyebrow: React.ReactNode
  /** 大字号本地化标题. */
  title: React.ReactNode
  /** 可选 1-2 行说明文字. */
  description?: React.ReactNode
  className?: string
}

export function PageHeader({
  eyebrow,
  title,
  description,
  className
}: PageHeaderProps): React.ReactElement {
  return (
    <header className={cn('mb-[var(--settings-block-gap,1.75rem)]', className)}>
      <div className="text-micro font-mono uppercase tracking-wider text-ink-fg-2 mb-1">
        {eyebrow}
      </div>
      <h1 className="text-[26px] leading-tight font-semibold tracking-tight text-ink-fg">
        {title}
      </h1>
      {description ? <p className="text-aux text-ink-fg-1 mt-1.5">{description}</p> : null}
    </header>
  )
}
