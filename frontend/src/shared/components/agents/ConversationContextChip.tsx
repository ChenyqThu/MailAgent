// assistant-modal P5 / Matters P6-A — 邮件与事项共用的可移除 context chip。
//
// 0812：从 AgentConversation.tsx 下沉成**零依赖叶子**。原因是收口后 AgentConversation 要 import
// 事项适配层（useMatterConversation），而后者要 import 这枚 chip —— 留在原处就是一个 import 环。
// AgentConversation 仍 re-export 它（既有 import 路径不变）。

import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'

/** 移除意味着什么由调用方决定（邮件：不再注入正文；事项：不再注入事项上下文）。 */
export function ConversationContextChip({
  icon,
  label,
  removeLabel,
  onRemove
}: {
  icon: React.ReactNode
  label: string
  removeLabel?: string
  onRemove: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const resolvedRemoveLabel = removeLabel ?? t('chat.modal.removeContext')
  return (
    <div className="flex items-center gap-1.5 self-start rounded-lg border border-[var(--hairline)] bg-ink-2 py-1 pl-2 pr-1 text-meta text-ink-fg-1">
      {icon}
      <span className="max-w-[18rem] truncate" title={label}>
        {label}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={resolvedRemoveLabel}
        title={resolvedRemoveLabel}
        className="grid size-5 shrink-0 place-items-center rounded text-ink-fg-3 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
      >
        <X size={13} strokeWidth={2} />
      </button>
    </div>
  )
}
