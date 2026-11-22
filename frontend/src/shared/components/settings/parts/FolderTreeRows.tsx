// Folder tree row, inline create/rename row, and P5 cleanup prompt UI extracted from FolderPicker.

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Folder,
  FolderPlus,
  Inbox,
  Loader2,
  Lock,
  MoreHorizontal,
  Pencil,
  Send,
  Trash2,
  X
} from 'lucide-react'

import type { FolderInfo, FolderTreeNode } from '@shared/api/types'
import { cn } from '@shared/lib/cn'

// 大文件夹阈值 — 超过则展示「较大」徽标 + 首次同步较慢提示 (照 mockup ① · §4)。
const LARGE_FOLDER_THRESHOLD = 1000

/** system folder 图标 — special_use / INBOX 用对应图标, 其余 fallback Folder。 */
function systemIcon(node: FolderInfo): React.ReactNode {
  if (node.special_use === '\\sent')
    return <Send size={15} strokeWidth={1.75} className="shrink-0 text-ink-fg-2" />
  if (node.imap_name.toUpperCase() === 'INBOX')
    return <Inbox size={15} strokeWidth={1.75} className="shrink-0 text-ink-fg-2" />
  return <Folder size={15} strokeWidth={1.75} className="shrink-0 text-ink-fg-2" />
}

// 管理操作 (P4) — inline 输入态: create(在 parent 下新建) / rename(改本节点)。
export type EditState =
  | { mode: 'create'; parentImapName: string | null; value: string }
  | { mode: 'rename'; imapName: string; value: string }

export interface ManageHandlers {
  /** 当前打开 ⋯ 菜单的 imap_name (null = 全关)。 */
  menuFor: string | null
  /** 当前 inline 编辑态 (null = 无)。 */
  edit: EditState | null
  /** 编辑提交中 (新建/重命名) 锁输入。 */
  editBusy: boolean
  onOpenMenu: (imapName: string | null) => void
  onStartCreate: (parentImapName: string) => void
  onStartRename: (node: FolderTreeNode) => void
  onRequestDelete: (node: FolderTreeNode) => void
  onEditChange: (value: string) => void
  onEditSubmit: () => void
  onEditCancel: () => void
}

// P5 — inline 清理提示 props。
export interface CleanupRowHandlers {
  /** 正在清理中的 imap_name (null = 无)。 */
  cleanupBusy: string | null
  /** 当前待确认清理的 imap_name 集合。 */
  cleanupPrompts: ReadonlySet<string>
  onCleanup: (imapName: string, displayName: string) => void
  onDismissCleanup: (imapName: string) => void
}

export interface FolderRowProps {
  node: FolderTreeNode
  depth: number
  selected: ReadonlySet<string>
  expanded: ReadonlySet<string>
  onToggleSelect: (imapName: string) => void
  onToggleExpand: (imapName: string) => void
  manage: ManageHandlers
  cleanup: CleanupRowHandlers
}

/** inline 输入行 (新建子文件夹 / 重命名)。coral ring + 勾/叉确认。 */
function InlineEditRow({
  depth,
  value,
  placeholder,
  busy,
  icon,
  onChange,
  onSubmit,
  onCancel
}: {
  depth: number
  value: string
  placeholder: string
  busy: boolean
  icon: React.ReactNode
  onChange: (v: string) => void
  onSubmit: () => void
  onCancel: () => void
}): React.ReactElement {
  const indentPx = depth * 22
  // inline 编辑刚由用户主动触发 → mount 时聚焦 + 全选 (ref+effect, 不用 autoFocus
  // 属性以满足 jsx-a11y 与 React 受控聚焦时机)。
  const inputRef = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  return (
    <div
      className="flex items-center gap-2 px-3 py-2 bg-ink-2"
      style={{ paddingLeft: `${12 + indentPx}px` }}
    >
      <span className="shrink-0 w-4 h-4" aria-hidden="true" />
      <span className="shrink-0 w-4 h-4" aria-hidden="true" />
      {icon}
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit()
          else if (e.key === 'Escape') onCancel()
        }}
        className={cn(
          'flex-1 min-w-0 px-2 py-1 rounded-md text-aux bg-ink-1 text-ink-fg',
          'border border-coral/60 outline-none focus:ring-2 focus:ring-coral/30',
          'disabled:opacity-60'
        )}
      />
      <button
        type="button"
        onClick={onSubmit}
        disabled={busy || value.trim() === ''}
        className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded text-ok hover:bg-ink-3 transition-colors duration-fast disabled:opacity-40 disabled:pointer-events-none"
      >
        {busy ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <Check size={14} strokeWidth={2.5} />
        )}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded text-ink-fg-2 hover:bg-ink-3 hover:text-ink-fg transition-colors duration-fast disabled:opacity-40"
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  )
}

/** 单行 + 递归子节点。系统文件夹: lock 灰态不可选; 自定义: checkbox + count + 大徽标
 *  + 行尾 ⋯ 管理菜单 (P4, hover 显)。 */
export function FolderRow({
  node,
  depth,
  selected,
  expanded,
  onToggleSelect,
  onToggleExpand,
  manage,
  cleanup
}: FolderRowProps): React.ReactElement {
  const { t } = useTranslation()
  const hasChildren = node.children.length > 0
  const isOpen = expanded.has(node.imap_name)
  const isChecked = selected.has(node.imap_name)
  const isLarge = (node.message_count ?? 0) > LARGE_FOLDER_THRESHOLD
  // 缩进: 22px / 层 (照 mockup f-ind 宽度)。chevron 占位让叶子与父对齐。
  const indentPx = depth * 22

  const isRenaming = manage.edit?.mode === 'rename' && manage.edit.imapName === node.imap_name
  const isCreatingHere =
    manage.edit?.mode === 'create' && manage.edit.parentImapName === node.imap_name
  const menuOpen = manage.menuFor === node.imap_name

  // 重命名态: 整行替换为 inline 输入 (预填当前名)。
  if (isRenaming && manage.edit) {
    return (
      <InlineEditRow
        depth={depth}
        value={manage.edit.value}
        placeholder={t('settings.folder.picker.manage.renamePlaceholder', {
          defaultValue: '文件夹名称'
        })}
        busy={manage.editBusy}
        icon={<Pencil size={15} strokeWidth={1.75} className="shrink-0 text-coral" />}
        onChange={manage.onEditChange}
        onSubmit={manage.onEditSubmit}
        onCancel={manage.onEditCancel}
      />
    )
  }

  return (
    <>
      <div
        className={cn(
          'group/frow relative flex items-center gap-2 px-3 py-2 transition-colors duration-fast',
          node.is_system ? 'opacity-70' : 'hover:bg-ink-3'
        )}
        style={{ paddingLeft: `${12 + indentPx}px` }}
      >
        {/* checkbox / lock */}
        {node.is_system ? (
          <span
            className="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-[4px] bg-ink-3 border border-ink-border-soft text-ink-fg-3"
            title={t('settings.folder.picker.systemLockTip', {
              defaultValue: '系统文件夹 · 始终同步'
            })}
          >
            <Lock size={9} strokeWidth={2} />
          </span>
        ) : (
          <button
            type="button"
            role="checkbox"
            aria-checked={isChecked}
            aria-label={node.display_name}
            onClick={() => onToggleSelect(node.imap_name)}
            className={cn(
              'shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-[4px] border transition-colors duration-fast',
              isChecked
                ? 'bg-coral/100 border-coral text-accent-fg'
                : 'bg-transparent border-ink-border hover:border-ink-fg-2'
            )}
          >
            {isChecked ? (
              <svg
                viewBox="0 0 24 24"
                className="w-3 h-3"
                fill="none"
                stroke="currentColor"
                strokeWidth={3}
              >
                <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : null}
          </button>
        )}

        {/* expand chevron (有子才可点, 叶子占位对齐) */}
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggleExpand(node.imap_name)}
            aria-label={
              isOpen
                ? t('settings.folder.picker.collapse', { defaultValue: '收起' })
                : t('settings.folder.picker.expand', { defaultValue: '展开' })
            }
            aria-expanded={isOpen}
            className="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded text-ink-fg-2 hover:text-ink-fg hover:bg-ink-3 transition-colors duration-fast"
          >
            <ChevronRight
              size={13}
              strokeWidth={2}
              className={cn('transition-transform duration-fast', isOpen && 'rotate-90')}
            />
          </button>
        ) : (
          <span className="shrink-0 w-4 h-4" aria-hidden="true" />
        )}

        {/* folder icon */}
        {node.is_system ? (
          systemIcon(node)
        ) : (
          <Folder size={15} strokeWidth={1.75} className="shrink-0 text-ink-fg-2" />
        )}

        {/* name */}
        <span className="flex-1 min-w-0 truncate text-aux text-ink-fg">{node.display_name}</span>

        {/* count (mono) */}
        {typeof node.message_count === 'number' ? (
          <span className="shrink-0 text-meta font-mono tabular-nums text-ink-fg-2">
            {node.message_count.toLocaleString('en-US')}
          </span>
        ) : null}

        {/* large badge */}
        {isLarge && !node.is_system ? (
          <span
            className="shrink-0 inline-flex items-center gap-1 px-1.5 py-px rounded text-[10px] font-mono bg-warn/15 text-warn"
            title={t('settings.folder.picker.largeTip', {
              defaultValue: '超过 1000 封，首次同步可能较慢'
            })}
          >
            <AlertTriangle size={10} strokeWidth={2} />
            {t('settings.folder.picker.large', { defaultValue: '较大' })}
          </span>
        ) : null}

        {/* system state label */}
        {node.is_system ? (
          <span className="shrink-0 text-meta text-ink-fg-3">
            {t('settings.folder.picker.systemState', { defaultValue: '系统 · 始终同步' })}
          </span>
        ) : null}

        {/* ⋯ 管理菜单 (P4) — hover 显 (菜单打开时常驻); 系统文件夹禁用 + tooltip。 */}
        <button
          type="button"
          aria-label={t('settings.folder.picker.manage.menuLabel', { defaultValue: '管理文件夹' })}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={node.is_system}
          title={
            node.is_system
              ? t('settings.folder.picker.manage.systemHint', {
                  defaultValue: '系统文件夹不可修改'
                })
              : undefined
          }
          onClick={() => manage.onOpenMenu(menuOpen ? null : node.imap_name)}
          className={cn(
            'shrink-0 inline-flex items-center justify-center w-6 h-6 rounded transition-colors duration-fast',
            node.is_system
              ? 'opacity-40 cursor-not-allowed text-ink-fg-3'
              : cn(
                  'text-ink-fg-2 hover:bg-ink-4 hover:text-ink-fg',
                  menuOpen ? 'bg-ink-4 text-ink-fg' : 'opacity-0 group-hover/frow:opacity-100'
                )
          )}
        >
          <MoreHorizontal size={15} strokeWidth={2} />
        </button>

        {/* 菜单 popup — 仅自定义文件夹。新建子文件夹 / 重命名 / 删除。 */}
        {menuOpen && !node.is_system ? (
          <div
            role="menu"
            className="absolute right-2 top-9 z-20 min-w-40 py-1 rounded-md border border-ink-border bg-ink-1 shadow-md"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => manage.onStartCreate(node.imap_name)}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 text-meta text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg transition-colors duration-fast"
            >
              <FolderPlus size={13} strokeWidth={1.75} className="shrink-0 text-ink-fg-2" />
              {t('settings.folder.picker.manage.newChild', { defaultValue: '新建子文件夹' })}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => manage.onStartRename(node)}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 text-meta text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg transition-colors duration-fast"
            >
              <Pencil size={13} strokeWidth={1.75} className="shrink-0 text-ink-fg-2" />
              {t('settings.folder.picker.manage.rename', { defaultValue: '重命名' })}
            </button>
            <div className="my-1 h-px bg-ink-border-soft" />
            <button
              type="button"
              role="menuitem"
              onClick={() => manage.onRequestDelete(node)}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 text-meta text-fail hover:bg-fail/10 transition-colors duration-fast"
            >
              <Trash2 size={13} strokeWidth={1.75} className="shrink-0" />
              {t('settings.folder.picker.manage.delete', { defaultValue: '删除' })}
            </button>
          </div>
        ) : null}
      </div>

      {hasChildren && isOpen
        ? node.children.map((child) => (
            <FolderRow
              key={child.imap_name}
              node={child}
              depth={depth + 1}
              selected={selected}
              expanded={expanded}
              onToggleSelect={onToggleSelect}
              onToggleExpand={onToggleExpand}
              manage={manage}
              cleanup={cleanup}
            />
          ))
        : null}

      {/* inline 新建子文件夹行 — 在本节点的子列表末尾 (depth+1)。 */}
      {isCreatingHere && manage.edit ? (
        <InlineEditRow
          depth={depth + 1}
          value={manage.edit.value}
          placeholder={t('settings.folder.picker.manage.newChildPlaceholder', {
            defaultValue: '子文件夹名称'
          })}
          busy={manage.editBusy}
          icon={<FolderPlus size={15} strokeWidth={1.75} className="shrink-0 text-coral" />}
          onChange={manage.onEditChange}
          onSubmit={manage.onEditSubmit}
          onCancel={manage.onEditCancel}
        />
      ) : null}

      {/* P5 — 本地副本清理提示。仅自定义文件夹 + 有 pending 清理请求时渲染。 */}
      {!node.is_system && cleanup.cleanupPrompts.has(node.imap_name) ? (
        <div
          className="flex items-center gap-2 px-3 py-1.5 bg-ink-2 border-t border-ink-border-soft/50"
          style={{ paddingLeft: `${12 + depth * 22 + 24}px` }}
          role="group"
          aria-label={t('settings.folder.picker.manage.cleanupPrompt', {
            defaultValue: '也清理本地副本？'
          })}
        >
          <AlertTriangle size={12} strokeWidth={2} className="shrink-0 text-warn" />
          <span className="text-meta text-ink-fg-2 flex-1 min-w-0 truncate">
            {typeof node.message_count === 'number' && node.message_count > 0
              ? t('settings.folder.picker.manage.cleanupHint', {
                  defaultValue: '仅删本地已同步的 {count} 封副本，不删 Exchange 文件夹/邮件',
                  count: node.message_count
                })
              : t('settings.folder.picker.manage.cleanupHintNoCount', {
                  defaultValue: '仅删本地已同步副本，不删 Exchange 文件夹/邮件'
                })}
          </span>
          <button
            type="button"
            onClick={() => cleanup.onDismissCleanup(node.imap_name)}
            disabled={cleanup.cleanupBusy === node.imap_name}
            className="shrink-0 inline-flex items-center px-2 py-0.5 rounded text-meta text-ink-fg-1 hover:bg-ink-3 transition-colors duration-fast disabled:opacity-40"
          >
            {t('settings.folder.picker.manage.cleanupKeep', { defaultValue: '保留' })}
          </button>
          <button
            type="button"
            onClick={() => cleanup.onCleanup(node.imap_name, node.display_name)}
            disabled={cleanup.cleanupBusy === node.imap_name}
            className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded text-meta text-ink-fg bg-warn/20 hover:bg-warn/30 transition-colors duration-fast disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {cleanup.cleanupBusy === node.imap_name ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <Trash2 size={11} strokeWidth={2} />
            )}
            {cleanup.cleanupBusy === node.imap_name
              ? t('settings.folder.picker.manage.cleanupBusy', { defaultValue: '清理中…' })
              : t('settings.folder.picker.manage.cleanupDo', { defaultValue: '清理' })}
          </button>
        </div>
      ) : null}
    </>
  )
}
