import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CollapseChevron } from '@shared/components/ui/collapsible'
import { cn } from '@shared/lib/cn'

import { ELLIPSIS } from './matterTimelineModel'

/**
 * 正文块要不要给「展开全文」的字数门槛。
 *
 * 🔴 **判据是「有没有可能被 3 行 clamp 切掉」，不是「文本长不长」**，所以规则必须是
 * 「过门槛才 clamp」而不是「一律 clamp、过门槛才给按钮」：后者在窄容器下会把 80 字的
 * 正文切掉一截却不给任何展开入口 —— 那是**藏内容**。取 140 是因为详情列宽下 3 行
 * ≈ 90-130 个中文字符，留一档余量后误报（按钮点开没多出内容）远少于漏报。
 * 不用 `scrollHeight > clientHeight` 实测：happy-dom 不做布局，那条判据在单测里恒 false，
 * 等于这段逻辑没有回归网。
 */
export const NARRATIVE_CLAMP_CHARS = 140

/**
 * 「事情本身写了什么」的那一块 —— curated 进展的正文与操作日志里事件正文共用一份呈现
 * （对位设计 progress.jsx `ProgressEntry` 的 quote 块，样式换成本仓 v3 词汇）。
 *
 * 设计稿的 quote 块是「左侧 2px 彩色竖条」，这里换成本仓 v3 的发丝描边卡：① 设计里那条
 * 竖条承担的是「引文/摘自某份资料」的语气，而这块是**主内容**；② 单侧粗边在 v3「原生材质」
 * 里没有对应物。
 */
export function MatterNarrativeBody({
  text,
  truncated = false,
  compact = false
}: {
  text: string
  /** 后端截断过（不是渲染裁剪）—— 只有它为真才加省略号 + 「只是摘录」提示。 */
  truncated?: boolean
  compact?: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const clampable = text.length > NARRATIVE_CLAMP_CHARS
  return (
    <div
      data-testid="matter-narrative-body"
      className={cn(
        'mt-1.5 rounded-[var(--r-row)] border border-ink-border-soft bg-ink-1 px-2.5 py-1.5',
        compact && 'mt-1'
      )}
    >
      <p
        className={cn(
          'whitespace-pre-wrap text-ink-fg-1',
          compact ? 'text-meta leading-[1.6]' : 'text-aux leading-[1.7]',
          clampable && !open && 'line-clamp-3'
        )}
      >
        {/* 截断的省略号只在**真被后端截**时加 —— clamp 是渲染裁剪，展开就能看全，
            给它加省略号会谎称"后面还有你永远看不到的内容"。 */}
        {truncated ? `${text}${ELLIPSIS}` : text}
      </p>
      {clampable ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="mt-0.5 inline-flex items-center gap-1 rounded-[var(--r-ctl)] py-0.5 text-micro text-ink-fg-3 transition-colors duration-fast ease-standard hover:text-ink-fg-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
        >
          <CollapseChevron expanded={open} size={10} />
          {t(open ? 'matters.narrative.body.collapse' : 'matters.narrative.body.expand')}
        </button>
      ) : null}
      {truncated && (open || !clampable) ? (
        <p className="mt-0.5 text-micro text-ink-fg-3">{t('matters.narrative.body.truncated')}</p>
      ) : null}
    </div>
  )
}
