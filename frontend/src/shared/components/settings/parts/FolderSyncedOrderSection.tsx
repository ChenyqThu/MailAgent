// Built-in readonly folder reference, synced folder drag-reorder/prefs section, and delete confirm dialog.

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react'

import type { FolderPrefPatch, FolderTreeNode } from '@shared/api/types'
import {
  DragReorderList,
  type ReorderItem,
  type ReorderMessages
} from '@shared/components/ui/DragReorderList'
import type { FolderIconKey } from '@shared/components/icons'
import type { FolderPrefValue } from '@shared/hooks/useFolderPrefs'

import {
  BuiltinPrefRows,
  FolderIconButton,
  FolderIconPicker,
  PrefColumnHeader,
  PrefRowIndex,
  PrefRowName,
  PrefToggle,
  type IconPickerAnchor
} from './FolderPrefRows'

interface FolderSyncedOrderSectionProps {
  orderItems: ReorderItem[]
  onReorder: (list: ReorderItem[]) => void
  globalNotify: boolean
  globalAi: boolean
  prefOf: (imapName: string) => FolderPrefValue
  prefBusy: string | null
  savePref: (imapName: string, patch: FolderPrefPatch) => Promise<void>
  iconAnchor: IconPickerAnchor | null
  openIconPicker: (e: React.MouseEvent<HTMLButtonElement>, key: string, displayName: string) => void
  closeIconPicker: () => void
}

/** Built-in readonly folders + synced custom folders drag-reorder & per-folder prefs. */
export function FolderSyncedOrderSection({
  orderItems,
  onReorder,
  globalNotify,
  globalAi,
  prefOf,
  prefBusy,
  savePref,
  iconAnchor,
  openIconPicker,
  closeIconPicker
}: FolderSyncedOrderSectionProps): React.ReactElement | null {
  const { t } = useTranslation()
  const handleReorder = onReorder
  const setIconAnchor = (v: IconPickerAnchor | null): void => {
    if (v === null) closeIconPicker()
  }

  const reorderMessages = React.useMemo<ReorderMessages>(
    () => ({
      listLabel: t('settings.folder.picker.order.listLabel', {
        defaultValue: '已同步文件夹顺序，可重排'
      }),
      grip: (label, pos, count, grabbed) =>
        grabbed
          ? t('settings.folder.picker.order.gripGrabbed', {
              defaultValue: '调整「{label}」的顺序，第 {pos} 位，共 {count} 项，已抓起',
              label,
              pos,
              count
            })
          : t('settings.folder.picker.order.grip', {
              defaultValue: '调整「{label}」的顺序，第 {pos} 位，共 {count} 项',
              label,
              pos,
              count
            }),
      grabbed: (label, pos, count) =>
        t('settings.folder.picker.order.grabbed', {
          defaultValue:
            '已抓起「{label}」，第 {pos} 位，共 {count} 项。方向键移动，空格放下，Esc 取消。',
          label,
          pos,
          count
        }),
      dropped: (label, pos, count) =>
        t('settings.folder.picker.order.dropped', {
          defaultValue: '「{label}」已放至第 {pos} 位，共 {count} 项。',
          label,
          pos,
          count
        }),
      moved: (label, pos, count) =>
        t('settings.folder.picker.order.moved', {
          defaultValue: '「{label}」已移至第 {pos} 位，共 {count} 项。',
          label,
          pos,
          count
        }),
      cancelled: (label) =>
        t('settings.folder.picker.order.cancelled', {
          defaultValue: '已取消调序，「{label}」回到原位。',
          label
        })
    }),
    [t]
  )

  if (orderItems.length === 0) return null
  return (
    <>
      {/* 内建邮箱 (只读参照) — 位置固定、不可移除、图标不可换、两个 per-folder
              开关对它们**不生效** (后端 gate 先判 is_custom_folder_mailbox)。列在这里
              是为了看清自定义文件夹接在它们后面。 */}
      {orderItems.length > 0 ? (
        <div className="px-3 py-2.5 border-t border-ink-border-soft">
          <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-aux font-medium text-ink-fg">
              {t('settings.folder.picker.pref.builtinTitle', { defaultValue: '内建邮箱' })}
            </span>
            <span className="rounded-[3px] border border-ink-border px-1 py-px text-micro text-ink-fg-2">
              {t('settings.folder.picker.pref.builtinReadonly', { defaultValue: '只读' })}
            </span>
            <span className="text-meta text-ink-fg-2">
              {t('settings.folder.picker.pref.builtinHint', {
                defaultValue: '顺序固定、不能移除、图标不可换'
              })}
            </span>
          </div>
          <PrefColumnHeader globalNotify={globalNotify} globalAi={globalAi} />
          <BuiltinPrefRows />
          <p className="mt-1.5 text-meta leading-relaxed text-ink-fg-3">
            {t('settings.folder.picker.pref.builtinNote', {
              defaultValue:
                '两个开关这里画的是「—」而不是「关」：后端两个 gate 都先判标准邮箱并直接跳过，内建行不受 per-folder 开关约束。'
            })}
          </p>
        </div>
      ) : null}
      {/* 已同步文件夹 (排序 task + per-folder 配置) — 数组序 = 侧边栏显示顺序 */}
      {orderItems.length > 0 ? (
        <div className="px-3 py-2.5 border-t border-ink-border-soft">
          <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-aux font-medium text-ink-fg">
              {t('settings.folder.picker.order.title', {
                defaultValue: '已同步文件夹'
              })}
            </span>
            <span className="text-meta text-ink-fg-2">
              {t('settings.folder.picker.order.hint', {
                defaultValue: '拖拽调顺序，点图标换图标，两个开关逐个文件夹配'
              })}
            </span>
          </div>
          <p className="mb-2 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2.5 py-2 text-meta leading-relaxed text-ink-fg-2">
            {t('settings.folder.picker.pref.archiveNote', {
              defaultValue:
                '「存档」若在名单里也归这一段：后端 STANDARD_MAILBOXES 有意不含它，两个 per-folder 开关对它逐字生效，所以它拿的是真开关而不是「—」。'
            })}
          </p>
          <PrefColumnHeader globalNotify={globalNotify} globalAi={globalAi} />
          <DragReorderList
            items={orderItems}
            onReorder={handleReorder}
            messages={reorderMessages}
            rowClassName="py-2 pr-3"
            renderItem={(item, index) => {
              const pref = prefOf(item.id)
              return (
                <span className="group/row flex min-w-0 items-center gap-2.5">
                  <FolderIconButton
                    icon={pref.icon}
                    name={item.label}
                    open={iconAnchor?.key === item.id}
                    onOpen={(e) => openIconPicker(e, item.id, item.label)}
                  />
                  <PrefRowName label={item.label} imapName={item.id} />
                  <PrefToggle
                    kind="notify"
                    on={pref.notify}
                    folderName={item.label}
                    globalOff={!globalNotify}
                    disabled={prefBusy === item.id}
                    onChange={(v) => void savePref(item.id, { notify_enabled: v })}
                  />
                  <PrefToggle
                    kind="ai"
                    on={pref.ai}
                    folderName={item.label}
                    globalOff={!globalAi}
                    disabled={prefBusy === item.id}
                    // 🔴 UI 的「AI 分类」与落库列 llm_disabled 反向。
                    onChange={(v) => void savePref(item.id, { llm_disabled: !v })}
                  />
                  <PrefRowIndex index={index} />
                </span>
              )
            }}
          />
          <p className="mt-1.5 text-meta leading-relaxed text-ink-fg-3">
            {t('settings.folder.picker.pref.defaultsHint', {
              defaultValue:
                '图标与两个开关改完立即生效，不需要重启同步服务；新加入的文件夹缺省是「通知 关 · AI 开」。'
            })}
          </p>
        </div>
      ) : null}
      {iconAnchor ? (
        <FolderIconPicker
          anchor={iconAnchor}
          value={prefOf(iconAnchor.key).icon}
          onPick={(key: FolderIconKey) => {
            void savePref(iconAnchor.key, { icon: key })
            setIconAnchor(null)
          }}
          // 「恢复默认」= 清空 icon 列 → 走 patch 的 `icon: null`。
          onReset={() => {
            void savePref(iconAnchor.key, { icon: null })
            setIconAnchor(null)
          }}
          onClose={() => setIconAnchor(null)}
        />
      ) : null}
    </>
  )
}

interface FolderDeleteConfirmDialogProps {
  open: boolean
  target: FolderTreeNode | null
  scopeRef: React.RefObject<HTMLDivElement | null>
  deleting: boolean
  onCancel: () => void
  onConfirm: () => Promise<void>
}

/** P4 folder delete confirmation dialog (Exchange + local copy warning). */
export function FolderDeleteConfirmDialog({
  open,
  target,
  scopeRef,
  deleting,
  onCancel,
  onConfirm
}: FolderDeleteConfirmDialogProps): React.ReactElement | null {
  const { t } = useTranslation()
  if (!open || !target) return null
  const renderDeleteTarget = target
  const deleteDlgRef = scopeRef
  const setDeleteTarget = (v: FolderTreeNode | null): void => {
    if (v === null) onCancel()
  }
  const confirmDelete = onConfirm
  return (
    <div
      ref={deleteDlgRef}
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4"
      role="dialog"
      aria-modal="true"
    >
      <div
        data-anim-card
        className="w-full max-w-md rounded-xl border border-ink-border bg-ink-1 shadow-md overflow-hidden"
      >
        <div className="px-5 pt-5 pb-4">
          <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-fail/12 text-fail mb-3">
            <Trash2 size={18} strokeWidth={1.75} />
          </div>
          <h3 className="text-aux font-semibold text-ink-fg">
            {t('settings.folder.picker.manage.deleteTitle', {
              defaultValue: '删除文件夹「{name}」？',
              name: renderDeleteTarget.display_name
            })}
          </h3>
          <p className="text-meta text-ink-fg-1 mt-2 leading-relaxed">
            {typeof renderDeleteTarget.message_count === 'number'
              ? t('settings.folder.picker.manage.deleteBodyWithCount', {
                  defaultValue:
                    '将删除 Exchange 上的该文件夹，以及本地已同步的 {count} 封邮件副本。此操作不可撤销。',
                  count: renderDeleteTarget.message_count
                })
              : t('settings.folder.picker.manage.deleteBody', {
                  defaultValue:
                    '将删除 Exchange 上的该文件夹，以及本地已同步的邮件副本。此操作不可撤销。'
                })}
          </p>
          <div className="mt-3 flex items-start gap-2 rounded-md bg-warn/10 px-3 py-2 text-[12px] text-ink-fg-1 leading-relaxed">
            <AlertTriangle size={14} strokeWidth={2} className="shrink-0 mt-0.5 text-warn" />
            <span>
              {t('settings.folder.picker.manage.deleteWarn', {
                defaultValue:
                  '该文件夹在 Outlook 规则中可能仍被引用；删除后相关规则会失效。Notion 已归档页面不受影响。'
              })}
            </span>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2.5 px-5 py-3 border-t border-ink-border-soft bg-ink-2">
          <button
            type="button"
            onClick={() => setDeleteTarget(null)}
            disabled={deleting}
            className="inline-flex items-center px-3 py-1 rounded-md text-aux text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg transition-colors duration-fast disabled:opacity-50"
          >
            {t('settings.folder.picker.manage.cancel', { defaultValue: '取消' })}
          </button>
          <button
            type="button"
            onClick={() => void confirmDelete()}
            disabled={deleting}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-aux text-on-fail bg-fail hover:bg-fail/90 transition-colors duration-fast disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {deleting ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Trash2 size={13} strokeWidth={2} />
            )}
            {deleting
              ? t('settings.folder.picker.manage.deleting', { defaultValue: '删除中…' })
              : t('settings.folder.picker.manage.deleteConfirm', {
                  defaultValue: '删除文件夹'
                })}
          </button>
        </div>
      </div>
    </div>
  )
}
