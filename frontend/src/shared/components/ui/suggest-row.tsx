// D7 · AI 建议值签名（跨模块复用件，原型 `cui.jsx::SuggestRow` :98-113）。
//
// 「还没落地」的视觉签名 = **虚线** + `--c-ai` 紫 + sparkles 前缀 + 逐项「采纳 / 忽略」；
// 「已是事实」的字段则是实线容器、无标记、无按钮（见通讯录身份信息区的 FieldRow）。
// 🔒 有意**不用 accent**：accent 在本仓表达「选中 / 主操作」，借去表达 AI 会抢语义（D7）。
//
// 首个消费方是通讯录画像卡的建议值区；设计规格 §3 点名它要能被事项的 Agent 提案、
// 邮件摘要的建议动作直接套用，故落在 ui/ 而不是 contacts/。

import { Check, Sparkles } from 'lucide-react'

import { cn } from '@shared/lib/cn'

export interface SuggestRowProps {
  /** 字段名（11px 弱字，在值上方）。调用方负责 i18n。 */
  label: string
  /** 建议值（13.5→body，长值折行不撑破容器）。 */
  value: string
  adoptLabel: string
  ignoreLabel: string
  /** 写入在途：两钮一起禁（🔒 §4.2 失败要能留在原位，故禁的是入口不是行）。 */
  busy?: boolean
  onAdopt(): void
  onIgnore(): void
  className?: string
}

export function SuggestRow({
  label,
  value,
  adoptLabel,
  ignoreLabel,
  busy = false,
  onAdopt,
  onIgnore,
  className
}: SuggestRowProps): React.ReactElement {
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-[var(--r-ctl)] border border-dashed border-ai/[0.38] bg-ai/[0.05] py-2 pl-[9px] pr-2.5',
        className
      )}
    >
      <Sparkles size={13} aria-hidden className="mt-0.5 shrink-0 text-ai" />
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 text-micro text-ink-fg-2">{label}</div>
        <div className="break-all text-body text-ink-fg">{value}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          disabled={busy}
          onClick={onAdopt}
          className="inline-flex items-center gap-1 rounded-[var(--r-ctl)] border border-coral/30 bg-coral/10 px-2.5 py-1 text-meta font-medium text-coral transition-colors duration-fast ease-standard hover:bg-coral/[0.17] disabled:pointer-events-none disabled:opacity-50"
        >
          <Check size={12} aria-hidden />
          {adoptLabel}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onIgnore}
          className="rounded-[var(--r-ctl)] px-2 py-1 text-meta text-ink-fg-1 transition-colors duration-fast ease-standard hover:bg-ink-fg/[0.06] disabled:pointer-events-none disabled:opacity-50"
        >
          {ignoreLabel}
        </button>
      </div>
    </div>
  )
}
