// assistant-modal P5 / Matters P6-A — 邮件与事项共用的可移除 context chip。
//
// 0812：从 AgentConversation.tsx 下沉成**零依赖叶子**。原因是收口后 AgentConversation 要 import
// 事项适配层（useMatterConversation），而后者要 import 这枚 chip —— 留在原处就是一个 import 环。
// AgentConversation 仍 re-export 它（既有 import 路径不变）。
//
// 0813 轮4批AE：这枚 chip 从「悬在 composer 外、浮在 glass-3 对话底色上」搬进了 composer 框内的
// chip 行，与附件 chip 并排。皮肤因此必须跟着换档 —— 框是 `bg-ink-2`，chip 若仍是 `bg-ink-2` 就
// 只剩一圈描边、没有填充差（亮色主题下尤甚），这正是批 AB 在**反方向**上修过的同一个坑。故对齐
// 附件 chip 的三件：`bg-ink-3` / `border-ink-border` / `rounded-md`。× 钮的 hover 底色同步抬到
// ink-4：chip 自己已经是 ink-3，`hover:bg-ink-3` 是个看不见的死 hover。
// `self-start` 一并去掉 —— 竖排 footer 里它用来防拉伸，进了 chip 行后对齐归行上的 items-center 管，
// 留着反而会让它在高一档的图片附件 chip 旁边顶到顶部。

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
    <div className="flex items-center gap-1.5 rounded-md border border-ink-border bg-ink-3 py-1 pl-2 pr-1 text-meta text-ink-fg-1">
      {icon}
      <span className="max-w-[18rem] truncate" title={label}>
        {label}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={resolvedRemoveLabel}
        title={resolvedRemoveLabel}
        className="grid size-5 shrink-0 place-items-center rounded text-ink-fg-3 transition-colors duration-fast hover:bg-ink-4 hover:text-ink-fg"
      >
        <X size={13} strokeWidth={2} />
      </button>
    </div>
  )
}
