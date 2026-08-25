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
// task 08-25 —— CTA 从「授权扩检索」换成**让事项 agent 去找**。owner：关键词命中式的资料
// 推荐「置信度非常低，反而徒增烦恼」，那条确定性扫描链（`discoverResourceSuggestions`）
// 已整条退役。卡就渲染在事项对话里，所以按钮做的事是往这场对话递一条指令 —— 检索与判断
// 由有 LLM 能力的 agent 做，关联仍走 `matter_resource_mutate` 的既有审批闸。

import { useTranslation } from 'react-i18next'
import { HelpCircle } from 'lucide-react'

export function MatterContextGapCard({
  onAsk,
  disabled = false
}: {
  /** 把「帮我找找相关邮件和资料」递给这场对话里的事项 agent。 */
  onAsk(): void
  disabled?: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div
      data-testid="matter-context-gap"
      className="mt-2 flex items-center gap-2 rounded-lg border border-warn/25 bg-warn/[0.07] px-2.5 py-2"
    >
      <HelpCircle size={13} strokeWidth={2} className="shrink-0 text-warn" />
      <span className="min-w-0 flex-1 text-aux text-ink-fg-1">{t('matters.chat.gap.title')}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={onAsk}
        className="shrink-0 rounded-[var(--r-ctl)] border border-ink-border px-2 py-1 text-meta text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3 disabled:opacity-50"
      >
        {t('matters.chat.gap.ask')}
      </button>
    </div>
  )
}
