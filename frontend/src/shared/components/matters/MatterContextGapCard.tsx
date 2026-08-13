// Matters MVP P3 (lane ③) — 上下文缺口卡 (design 附录 C, 消息区 warn card).
//
// P6-A 起**真的会渲染**（P3 时它只有单测一个消费者 —— D10 写好了组件却刻意不接假触发路径）。
// 触发点是 `useMatterConversation`：`chipTarget !== null && hasContextGap` 时挂在 composer 上方
// 那一格里。判据 `hasContextGap`（`useMatterContextSnapshot.ts`）是两条**或**关系：
//   · `matter.waiting_context !== null` —— 事项显式声明「在等外部输入」，与资料多少正交；
//   · `resource_counts.linked_resources === 0` —— 后端另发的计数（旧后端不发时 fail-soft
//     退回旧投影判据 `resources.length === 0`）。
// 🔴 判据看的是 `resource_counts` 而**不是** `payload.resources.length`：后者只含 pinned 或
// 未确认的建议，用它会构成自噬循环（用户把建议逐条确认 → 可见数归零 → 弹「缺上下文」→
// 外扩灌垃圾），越配合越被灌。
//
// `onExpand` 现在是一次**显式声明**的外扩检索（`discoverResourceSuggestions` 带
// `expandReason: 'context_gap'`），不再是旧检索范围 Segmented 的那个 scope-switch —— 那个控件
// 已下线。语义不变的部分：扩大搜索触达面这件事必须是用户按下去的、且在服务端留痕，
// 这张卡不许成为第二条不留痕的放宽路径。

import { useTranslation } from 'react-i18next'
import { HelpCircle } from 'lucide-react'

export function MatterContextGapCard({
  onExpand,
  disabled = false,
  suggestedCount = null,
  suppressedCount = 0
}: {
  onExpand(): void
  disabled?: boolean
  suggestedCount?: number | null
  suppressedCount?: number
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div
      data-testid="matter-context-gap"
      className="mt-2 flex items-center gap-2 rounded-lg border border-warn/25 bg-warn/[0.07] px-2.5 py-2"
    >
      <HelpCircle size={13} strokeWidth={2} className="shrink-0 text-warn" />
      <span className="min-w-0 flex-1">
        <span className="block text-aux text-ink-fg-1">{t('matters.chat.gap.title')}</span>
        {suggestedCount === null ? null : (
          <span className="mt-0.5 block text-meta text-ink-fg-3">
            {t('matters.chat.gap.result', { count: suggestedCount })}
            {suppressedCount > 0
              ? ` · ${t('matters.chat.gap.suppressed', { count: suppressedCount })}`
              : null}
          </span>
        )}
      </span>
      {suggestedCount === null ? (
        <button
          type="button"
          disabled={disabled}
          onClick={onExpand}
          className="shrink-0 rounded-[var(--r-ctl)] border border-ink-border px-2 py-1 text-meta text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3 disabled:opacity-50"
        >
          {disabled ? t('matters.chat.gap.expanding') : t('matters.chat.gap.expand')}
        </button>
      ) : null}
    </div>
  )
}
