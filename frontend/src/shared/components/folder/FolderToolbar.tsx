// Phase C — 存档 / 草稿箱详情顶部 toolbar. Sprint 18 视觉重写 →
// ref/mockup-archive.html + mockup-drafts.html 的 .gbtn 工具栏。
//
//   archive: 移回收件箱 (ArrowLeft) + 永久删除 (Trash2, danger)
//   drafts:  编辑 (Pencil, primary) + 发送 (Send) + 删除 (Trash2, danger)
//
// 自适应密度 (仿 EmailToolbar useContainerDensity): 容器 < 640px 时按钮转
// icon-only + HoverTip 显动作名, 否则带文字标签。所有写动作只 emit callback,
// 真正的二次确认 + mutation 在父 FolderDetail。

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Loader2, Pencil, Send, Trash2 } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { HoverTip } from '@shared/components/ui/HoverTip'
import type { FolderName } from '@shared/api/types'

// 单按钮宽度阈值 — 窄于此值收成 icon-only。folder toolbar 最多 3 个按钮,
// 640px 给文字标签留足空间。
function useCompact<T extends HTMLElement>(ref: React.RefObject<T | null>): boolean {
  const [width, setWidth] = useState<number>(960)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    setWidth(node.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width)
    })
    ro.observe(node)
    return (): void => ro.disconnect()
  }, [ref])
  return width < 640
}

type GbtnTone = 'neutral' | 'primary' | 'danger'

interface GbtnProps {
  icon: React.ReactNode
  label: string
  tone?: GbtnTone
  compact: boolean
  pending?: boolean
  onClick: () => void
}

function Gbtn({
  icon,
  label,
  tone = 'neutral',
  compact,
  pending,
  onClick
}: GbtnProps): React.ReactElement {
  const disabled = pending === true
  const btn = (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={cn(
        'gbtn',
        tone === 'primary' && 'gbtn-primary',
        tone === 'danger' && 'gbtn-danger',
        compact && 'px-0 w-[30px] justify-center'
      )}
    >
      <span className="shrink-0 grid place-items-center w-[14px] h-[14px]">
        {pending ? <Loader2 size={14} strokeWidth={2} className="animate-spin" /> : icon}
      </span>
      {!compact && <span>{label}</span>}
    </button>
  )
  // icon-only 时 HoverTip 补出动作名; 有内联标签则跳过避免双重提示。
  if (compact) {
    return (
      <HoverTip text={label} side="bottom">
        {btn}
      </HoverTip>
    )
  }
  return btn
}

export interface FolderToolbarPending {
  move?: boolean
  delete?: boolean
  send?: boolean
}

interface Props {
  folder: FolderName
  /** <lg 详情覆盖列表时的"返回列表"入口（清选中）。lg:hidden，≥lg 不渲染。 */
  onBack?: () => void
  onMoveToInbox?: () => void
  onDelete?: () => void
  onEdit?: () => void
  onSend?: () => void
  pending?: FolderToolbarPending
}

export function FolderToolbar({
  folder,
  onBack,
  onMoveToInbox,
  onDelete,
  onEdit,
  onSend,
  pending
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const ref = useRef<HTMLElement>(null)
  const compact = useCompact(ref)
  const isDrafts = folder === 'drafts'

  return (
    <header
      ref={ref}
      className="h-12 shrink-0 border-b border-ink-border/60 flex items-center gap-2 px-4"
    >
      {/* <lg 返回列表 — 详情覆盖态返回入口; lg:hidden 桌面收起。archive 模式
          下方另有「移回收件箱」(同 ArrowLeft, 语义不同), 靠 HoverTip 区分。 */}
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label={t('toolbar.backToList', { defaultValue: '返回列表' })}
          className="lg:hidden shrink-0 -ml-1 p-1.5 rounded text-ink-fg-2 hover:text-ink-fg hover:bg-ink-4 transition-colors duration-fast"
        >
          <ArrowLeft size={16} strokeWidth={2} />
        </button>
      )}
      {isDrafts ? (
        <>
          {onEdit && (
            <Gbtn
              icon={<Pencil size={14} strokeWidth={1.9} />}
              label={t('folder.toolbar.edit')}
              tone="primary"
              compact={compact}
              onClick={onEdit}
            />
          )}
          {onSend && (
            <Gbtn
              icon={<Send size={14} strokeWidth={1.9} />}
              label={t('folder.toolbar.send')}
              compact={compact}
              pending={pending?.send}
              onClick={onSend}
            />
          )}
          {onDelete && (
            <Gbtn
              icon={<Trash2 size={14} strokeWidth={1.9} />}
              label={t('folder.toolbar.delete')}
              tone="danger"
              compact={compact}
              pending={pending?.delete}
              onClick={onDelete}
            />
          )}
        </>
      ) : (
        <>
          {onMoveToInbox && (
            <Gbtn
              icon={<ArrowLeft size={14} strokeWidth={1.9} />}
              label={t('folder.toolbar.moveToInbox')}
              compact={compact}
              pending={pending?.move}
              onClick={onMoveToInbox}
            />
          )}
          {onDelete && (
            <Gbtn
              icon={<Trash2 size={14} strokeWidth={1.9} />}
              label={t('folder.toolbar.deletePermanent')}
              tone="danger"
              compact={compact}
              pending={pending?.delete}
              onClick={onDelete}
            />
          )}
        </>
      )}
    </header>
  )
}
