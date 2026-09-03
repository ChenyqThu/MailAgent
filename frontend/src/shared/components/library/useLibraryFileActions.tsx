// 文件动作的单一实现（design §2.3 动作条；mockup C11 / C12 / C13 / G4）：用系统应用打开 / 访达显示 /
// 另存到资料库 / 移到… / 删除（→ .trash 或系统废纸篓）/ 恢复 / 立即永久删除 / 另存解析版。
// 文件夹视图的行菜单与预览面的动作条共用同一份 —— 两处各写一遍就会有两套确认框文案。
//
// 对话框由本 hook 持有，调用方把 `dialogs` 渲染一次即可。写操作成功后整域失效（树的角标、
// 文件夹列表、文件详情都会变）。F3：另存 / 另存解析版的回执恒带「打开」深链。

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import type { LibraryFile } from '@shared/api/types/library'
import { Button } from '@shared/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'
import { errorMessage } from '@shared/lib/ipcErrors'
import { toastError, toastSuccess } from '@shared/state/toast'

import { useLibraryOpenToast } from './deeplink'
import { FolderPickerDialog } from './FolderPickerDialog'
import { useInvalidateLibrary, useLibraryApi } from './hooks'
import { openLibraryTarget, openTargetOf, revealLibraryTarget } from './libraryIpc'

export interface LibraryFileActions {
  open(file: LibraryFile): void
  reveal(file: LibraryFile): void
  keep(file: LibraryFile): void
  /** 「另存到资料库」的裸入口：邮件详情的附件行没有 library 行对象，只有 attachment id +
   *  文件名。与投影行的 `keep` 走同一个选择器、同一个端点、同一句带深链的回执。 */
  keepAttachment(target: { attachmentId: number; filename: string }): void
  move(file: LibraryFile): void
  trash(file: LibraryFile): void
  restore(file: LibraryFile): void
  purge(file: LibraryFile): void
  /** 「另存解析版为 markdown」：`source='derived'`、`source_ref=原文件 id`，此后独立演化。 */
  saveParsedMarkdown(file: LibraryFile, markdown: string): void
  dialogs: ReactNode
}

export interface LibraryFileActionHandlers {
  onMoved?(file: LibraryFile): void
  onTrashed?(file: LibraryFile): void
  onRestored?(file: LibraryFile): void
  onPurged?(file: LibraryFile): void
  onKept?(file: LibraryFile): void
  onDerived?(file: LibraryFile): void
}

type Confirm = { kind: 'trash' | 'purge'; file: LibraryFile }

/** 选择器的目标已经归一成「要往哪个端点发什么」：`keep` 只需要 attachment id，`move` 只需要
 *  file id。对话框自己只吃 `{filename, path}`（`path` 仅 move 的「从 → 到」预览用得着）。 */
type PickerTarget =
  | { mode: 'keep'; attachmentId: number; filename: string; path?: string }
  | { mode: 'move'; fileId: number; filename: string; path: string; parentPath: string }

export function useLibraryFileActions(handlers: LibraryFileActionHandlers = {}): LibraryFileActions {
  const { t } = useTranslation()
  const api = useLibraryApi()
  const invalidate = useInvalidateLibrary()
  const openToast = useLibraryOpenToast()
  const [picker, setPicker] = useState<PickerTarget | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [busy, setBusy] = useState(false)

  const open = useCallback(
    (file: LibraryFile): void => {
      const target = openTargetOf(file)
      if (!target) return
      void openLibraryTarget(target).then((result) => {
        if (!result.ok) toastError(t('library.toast.openFailed'), result.message)
      })
    },
    [t]
  )

  const reveal = useCallback(
    (file: LibraryFile): void => {
      const target = openTargetOf(file)
      if (!target) return
      void revealLibraryTarget(target).then((result) => {
        if (!result.ok) toastError(t('library.toast.openFailed'), result.message)
      })
    },
    [t]
  )

  const runPicker = useCallback(
    async (targetPath: string): Promise<void> => {
      if (!picker) return
      setBusy(true)
      try {
        if (picker.mode === 'keep') {
          const kept = await api.keepAttachment(picker.attachmentId, targetPath)
          await invalidate.all()
          setPicker(null)
          // F3：回执恒带一个「打开」深链 —— 没有去处的回执一律视为缺陷（design §9.5）。
          if (kept.id !== null) openToast(t('library.toast.keptTo', { path: kept.path }), kept.id)
          handlers.onKept?.(kept)
        } else {
          const moved = await api.moveFile(picker.fileId, targetPath)
          await invalidate.all()
          setPicker(null)
          toastSuccess(t('library.toast.movedTo', { folder: targetPath }))
          handlers.onMoved?.(moved)
        }
      } catch (err) {
        toastError(t('library.toast.actionFailed'), errorMessage(err))
      } finally {
        setBusy(false)
      }
    },
    [api, handlers, invalidate, openToast, picker, t]
  )

  const runConfirm = useCallback(async (): Promise<void> => {
    const { kind, file } = confirm ?? {}
    const id = file?.id
    if (kind === undefined || file === undefined || id == null) return
    setBusy(true)
    try {
      if (kind === 'trash') {
        await api.trashFile(id)
        await invalidate.all()
        setConfirm(null)
        toastSuccess(
          t(file.mount_id > 0 ? 'library.trash.deletedToastMount' : 'library.trash.deletedToastLibrary')
        )
        handlers.onTrashed?.(file)
      } else {
        await api.purgeFile(id)
        await invalidate.all()
        setConfirm(null)
        handlers.onPurged?.(file)
      }
    } catch (err) {
      toastError(t('library.toast.actionFailed'), errorMessage(err))
    } finally {
      setBusy(false)
    }
  }, [api, confirm, handlers, invalidate, t])

  const restore = useCallback(
    (file: LibraryFile): void => {
      if (file.id === null) return
      const id = file.id
      void (async () => {
        try {
          const restored = await api.restoreFile(id)
          await invalidate.all()
          toastSuccess(t('library.trash.restoredToast'))
          handlers.onRestored?.(restored)
        } catch (err) {
          toastError(t('library.toast.actionFailed'), errorMessage(err))
        }
      })()
    },
    [api, handlers, invalidate, t]
  )

  const saveParsedMarkdown = useCallback(
    (file: LibraryFile, markdown: string): void => {
      if (file.id === null) return
      const id = file.id
      const dot = file.filename.lastIndexOf('.')
      const stem = dot > 0 ? file.filename.slice(0, dot) : file.filename
      void (async () => {
        try {
          const derived = await api.createTextFile({
            parent_path: file.parent_path,
            filename: t('library.preview.derivedFilename', { stem }),
            content: markdown,
            source: 'derived',
            source_ref: String(id)
          })
          await invalidate.all()
          if (derived.id !== null) {
            openToast(t('library.toast.derivedSaved', { path: derived.path }), derived.id)
          }
          handlers.onDerived?.(derived)
        } catch (err) {
          toastError(t('library.toast.actionFailed'), errorMessage(err))
        }
      })()
    },
    [api, handlers, invalidate, openToast, t]
  )

  const dialogs = (
    <>
      {picker ? (
        <FolderPickerDialog
          open
          onOpenChange={(next) => {
            if (!next) setPicker(null)
          }}
          mode={picker.mode}
          file={picker}
          disabledPaths={picker.mode === 'move' ? [picker.parentPath] : []}
          busy={busy}
          onConfirm={(target) => void runPicker(target)}
        />
      ) : null}
      <Dialog
        open={confirm !== null}
        onOpenChange={(next) => {
          if (!next) setConfirm(null)
        }}
      >
        {confirm ? (
          <DialogContent className="w-[480px]">
            <DialogHeader>
              <DialogTitle>
                {confirm.kind === 'purge'
                  ? t('library.trash.deleteForeverConfirmTitle', { name: confirm.file.filename })
                  : confirm.file.mount_id > 0
                    ? t('library.trash.deleteConfirmTitleMount')
                    : t('library.trash.deleteConfirmTitleLibrary')}
              </DialogTitle>
              <DialogDescription>
                {confirm.kind === 'purge'
                  ? t('library.trash.deleteForeverConfirmBody')
                  : confirm.file.mount_id > 0
                    ? t('library.trash.deleteConfirmBodyMount')
                    : t('library.trash.deleteConfirmBodyLibrary', { name: confirm.file.filename })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
                {t('library.actions.cancel')}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => void runConfirm()}
              >
                {confirm.kind === 'purge'
                  ? t('library.trash.deleteForeverConfirm')
                  : t('library.actions.delete')}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  )

  return useMemo(
    () => ({
      open,
      reveal,
      keep: (file) => {
        if (typeof file.attachment_id !== 'number') return
        setPicker({
          mode: 'keep',
          attachmentId: file.attachment_id,
          filename: file.filename,
          path: file.path
        })
      },
      keepAttachment: (target) => setPicker({ mode: 'keep', ...target }),
      move: (file) => {
        if (file.id === null) return
        setPicker({
          mode: 'move',
          fileId: file.id,
          filename: file.filename,
          path: file.path,
          parentPath: file.parent_path
        })
      },
      trash: (file) => setConfirm({ kind: 'trash', file }),
      restore,
      purge: (file) => setConfirm({ kind: 'purge', file }),
      saveParsedMarkdown,
      dialogs
    }),
    [dialogs, open, restore, reveal, saveParsedMarkdown]
  )
}
