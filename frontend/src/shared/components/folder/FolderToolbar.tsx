// Phase C — 存档 / 草稿箱详情顶部 toolbar. 精简版 EmailToolbar: 复用
// GhostBtn 的视觉原语 (本地 FolderGhostBtn, EmailToolbar 没 export), 套
// ink token / coral, HoverTip 显示动作。
//
//   archive: 移回收件箱 (ArrowLeft) + 永久删除 (Trash2)
//   drafts:  编辑 (Pencil) + 发送 (Send) + 删除 (Trash2)
//
// 所有写动作只 emit callback, 真正的二次确认 + mutation 在父 FolderDetail。

import { useTranslation } from 'react-i18next'
import { ArrowLeft, Loader2, Pencil, Send, Trash2 } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { HoverTip } from '@shared/components/ui/HoverTip'
import type { FolderName } from '@shared/api/types'

interface FolderGhostBtnProps {
  icon: React.ReactNode
  label: string
  /** coral 强调 (危险 / 主操作); 否则中性 ink. */
  tone?: 'neutral' | 'coral'
  pending?: boolean
  onClick: () => void
}

function FolderGhostBtn({
  icon,
  label,
  tone = 'neutral',
  pending,
  onClick
}: FolderGhostBtnProps): React.ReactElement {
  const disabled = pending === true
  return (
    <HoverTip text={label} side="bottom">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className={cn(
          'flex items-center gap-1.5 px-2 py-1.5 rounded-md text-aux',
          'transition-colors duration-fast',
          tone === 'coral'
            ? 'text-coral hover:text-coral-hover hover:bg-coral/10'
            : 'text-ink-fg-1 hover:text-ink-fg hover:bg-ink-4',
          'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent'
        )}
      >
        <span className="shrink-0 grid place-items-center w-[13px] h-[13px]">
          {pending ? <Loader2 size={13} strokeWidth={2} className="animate-spin" /> : icon}
        </span>
      </button>
    </HoverTip>
  )
}

export interface FolderToolbarPending {
  move?: boolean
  delete?: boolean
  send?: boolean
}

interface Props {
  folder: FolderName
  onMoveToInbox?: () => void
  onDelete?: () => void
  onEdit?: () => void
  onSend?: () => void
  pending?: FolderToolbarPending
}

export function FolderToolbar({
  folder,
  onMoveToInbox,
  onDelete,
  onEdit,
  onSend,
  pending
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const isDrafts = folder === 'drafts'

  return (
    <header className="h-11 border-b border-ink-border-soft glass-2 flex items-center px-3 gap-1 shrink-0">
      {isDrafts ? (
        <>
          {onEdit && (
            <FolderGhostBtn
              icon={<Pencil size={13} strokeWidth={2} />}
              label={t('folder.toolbar.edit')}
              onClick={onEdit}
            />
          )}
          {onSend && (
            <FolderGhostBtn
              icon={<Send size={13} strokeWidth={2} />}
              label={t('folder.toolbar.send')}
              tone="coral"
              pending={pending?.send}
              onClick={onSend}
            />
          )}
          {onDelete && (
            <FolderGhostBtn
              icon={<Trash2 size={13} strokeWidth={2} />}
              label={t('folder.toolbar.delete')}
              pending={pending?.delete}
              onClick={onDelete}
            />
          )}
        </>
      ) : (
        <>
          {onMoveToInbox && (
            <FolderGhostBtn
              icon={<ArrowLeft size={13} strokeWidth={2} />}
              label={t('folder.toolbar.moveToInbox')}
              pending={pending?.move}
              onClick={onMoveToInbox}
            />
          )}
          {onDelete && (
            <FolderGhostBtn
              icon={<Trash2 size={13} strokeWidth={2} />}
              label={t('folder.toolbar.deletePermanent')}
              tone="coral"
              pending={pending?.delete}
              onClick={onDelete}
            />
          )}
        </>
      )}
    </header>
  )
}
