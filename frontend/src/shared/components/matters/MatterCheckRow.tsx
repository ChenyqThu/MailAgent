import { CircleCheckBig } from 'lucide-react'

import { cn } from '@shared/lib/cn'

/**
 * 事项里的「勾选」外观单源（owner 0818 验收的 mockup `mockups/stakeholder/goal.tsx`
 * 的 `CheckRow`）：`CircleCheckBig`（勾从右上角出圈，不是 `CircleCheck`）+ 文本，
 * 未完成 `text-ink-fg-3` → 完成 `text-ok` 并轻微放大，文本转 `text-ink-fg-3` + 删除线。
 *
 * 🔴 颜色只走 token（`text-ok` / `text-ink-fg-*`），不写死绿色 —— 主题 v3 两套配色都要成立。
 *
 * 两处共用，但**可点范围不同**，不是抄漏了：
 * - 完成标志（`GoalCard`）用 `MatterCheckRow`：整行是一个 `aria-pressed` 按钮，
 *   右侧的删除钮是它的兄弟节点（`action` 槽），不嵌在按钮里。
 * - 条目行（`ItemGroup` 的 action 条目）只用 `MatterCheckToggle`：那一行里已经有
 *   改标题 / 删除 / 来源 / 展开清单四个按钮，整行做成 button 就是嵌套 button（非法）。
 *   同 `MatterContextTab::StakeholderIdentity` 的先例。
 */
function CheckMark({ done }: { done: boolean }): React.ReactElement {
  return (
    <CircleCheckBig
      size={16}
      strokeWidth={2}
      className={cn(
        'shrink-0 transition-[color,transform] duration-fast ease-standard',
        done ? 'scale-105 text-ok' : 'text-ink-fg-3'
      )}
    />
  )
}

/** 只有图标可点的形态。`label` 是这颗钮的可及名（用条目标题，一组里才分得清哪颗）。 */
export function MatterCheckToggle({
  done,
  label,
  className,
  onToggle
}: {
  done: boolean
  label: string
  className?: string
  onToggle(): void
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={done}
      aria-label={label}
      className={cn(
        'grid shrink-0 place-items-center rounded-[var(--r-ctl)] p-0.5 transition-colors duration-fast ease-standard hover:bg-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70',
        className
      )}
    >
      <CheckMark done={done} />
    </button>
  )
}

/** 整行可点的形态。`action` 落在按钮**外面**（hover 出的删除钮走 `group/check`）。 */
export function MatterCheckRow({
  done,
  text,
  disabled = false,
  onToggle,
  action
}: {
  done: boolean
  text: string
  disabled?: boolean
  onToggle(): void
  action?: React.ReactNode
}): React.ReactElement {
  return (
    <li className="group/check flex items-center gap-1">
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-pressed={done}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[var(--r-ctl)] px-2 py-2 text-left transition-colors duration-fast ease-standard hover:bg-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-50"
      >
        <CheckMark done={done} />
        <span
          className={cn(
            'min-w-0 flex-1 break-words text-body transition-colors duration-fast ease-standard',
            done ? 'text-ink-fg-3 line-through' : 'text-ink-fg-1'
          )}
        >
          {text}
        </span>
      </button>
      {action}
    </li>
  )
}
