// P4 folder CRUD (menu / inline create+rename / delete confirm with exit anim) and
// v62 per-folder pref mutations extracted from FolderPicker.

import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import type { FolderPrefPatch, FolderPrefsResult, FolderTreeNode } from '@shared/api/types'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import {
  folderPrefValue,
  useFolderPrefMap,
  type FolderPrefValue
} from '@shared/hooks/useFolderPrefs'
import { useMailApi } from '@shared/hooks/useMailApi'
import { errorMessage as toErrorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import type { useEmailFilter } from '@shared/state/email-filter'
import { useRestartStore } from '@shared/state/restart'
import { toastError, toastSuccess } from '@shared/state/toast'

import type { IconPickerAnchor } from './FolderPrefRows'
import type { EditState, ManageHandlers } from './FolderTreeRows'

interface UseFolderManageOpts {
  setExpanded: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>
  customMailbox: string | null
  setView: ReturnType<typeof useEmailFilter.getState>['setView']
  displayNameByImap: ReadonlyMap<string, string>
}

export interface FolderManageController {
  menuFor: string | null
  dismissMenu: () => void
  manage: ManageHandlers
  deleteDlgRender: boolean
  renderDeleteTarget: FolderTreeNode | null
  deleteDlgRef: React.RefObject<HTMLDivElement | null>
  deleting: boolean
  closeDelete: () => void
  confirmDelete: () => Promise<void>
  prefBusy: string | null
  iconAnchor: IconPickerAnchor | null
  prefOf: (imapName: string) => FolderPrefValue
  savePref: (imapName: string, patch: FolderPrefPatch) => Promise<void>
  openIconPicker: (e: React.MouseEvent<HTMLButtonElement>, key: string, displayName: string) => void
  closeIconPicker: () => void
}

/** Owns folder create/rename/delete flows and immediate per-folder pref writes. */
export function useFolderManage({
  setExpanded,
  customMailbox,
  setView,
  displayNameByImap
}: UseFolderManageOpts): FolderManageController {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const qc = useQueryClient()
  const markRestartRequired = useRestartStore((s) => s.markRestartRequired)

  // ── 文件夹管理 (P4) — ⋯ 菜单 / inline 输入 / 删除二次确认 ──────────────────
  const [menuFor, setMenuFor] = React.useState<string | null>(null)
  const [edit, setEdit] = React.useState<EditState | null>(null)
  const [editBusy, setEditBusy] = React.useState(false)
  const [deleteTarget, setDeleteTarget] = React.useState<FolderTreeNode | null>(null)
  const [deleting, setDeleting] = React.useState(false)
  // 退场动画期间 deleteTarget 会置 null，用 lastDeleteTarget 保留最后非 null 值供渲染
  const [lastDeleteTarget, setLastDeleteTarget] = React.useState<FolderTreeNode | null>(null)
  const renderDeleteTarget = deleteTarget ?? lastDeleteTarget
  const { shouldRender: deleteDlgRender, scopeRef: deleteDlgRef } =
    useExitAnimation<HTMLDivElement>(deleteTarget !== null, { card: '[data-anim-card]' })

  const openMenu = React.useCallback((imapName: string | null): void => {
    setMenuFor(imapName)
  }, [])

  const startCreate = React.useCallback(
    (parentImapName: string): void => {
      setMenuFor(null)
      setEdit({ mode: 'create', parentImapName, value: '' })
      // 展开父节点, 让 inline 新建行可见。
      setExpanded((prev) => {
        const next = new Set(prev)
        next.add(parentImapName)
        return next
      })
    },
    [setExpanded]
  )

  const startRename = React.useCallback((node: FolderTreeNode): void => {
    setMenuFor(null)
    setEdit({ mode: 'rename', imapName: node.imap_name, value: node.display_name })
  }, [])

  const editChange = React.useCallback((value: string): void => {
    setEdit((prev) => (prev ? { ...prev, value } : prev))
  }, [])

  const editCancel = React.useCallback((): void => {
    setEdit(null)
  }, [])

  const editSubmit = React.useCallback(async (): Promise<void> => {
    if (!edit) return
    const name = edit.value.trim()
    if (name === '') return
    setEditBusy(true)
    try {
      if (edit.mode === 'create') {
        const res = await mailApi.folder.createFolder(edit.parentImapName, name)
        if (res.restart_required) markRestartRequired(['SYNC_FOLDERS'])
        toastSuccess(
          t('settings.folder.picker.manage.createOk', {
            defaultValue: '已新建文件夹「{name}」',
            name
          })
        )
      } else {
        const res = await mailApi.folder.renameFolder(edit.imapName, name)
        if (res.restart_required) markRestartRequired(['SYNC_FOLDERS'])
        toastSuccess(
          t('settings.folder.picker.manage.renameOk', {
            defaultValue: '已重命名为「{name}」',
            name
          })
        )
      }
      setEdit(null)
      // 成功后失效共享 folder 缓存 → discover 重拉 (拿到 Exchange 真实状态 + 新计数,
      // sidebar 同步)。re-seed effect 据新 whitelist 重置选中/展开态。
      void qc.invalidateQueries({ queryKey: qk.folder.all() })
    } catch (e) {
      toastError(
        edit.mode === 'create'
          ? t('settings.folder.picker.manage.createFail', { defaultValue: '新建文件夹失败' })
          : t('settings.folder.picker.manage.renameFail', { defaultValue: '重命名失败' }),
        toErrorMessage(e)
      )
    } finally {
      setEditBusy(false)
    }
  }, [edit, mailApi, markRestartRequired, qc, t])

  const requestDelete = React.useCallback((node: FolderTreeNode): void => {
    setMenuFor(null)
    setLastDeleteTarget(node)
    setDeleteTarget(node)
  }, [])

  const confirmDelete = React.useCallback(async (): Promise<void> => {
    if (!deleteTarget) return
    const node = deleteTarget
    setDeleting(true)
    try {
      const res = await mailApi.folder.deleteFolder(node.imap_name)
      if (res.restart_required) markRestartRequired(['SYNC_FOLDERS'])
      // 删除的若是当前正在看的文件夹 → 重置到收件箱 (列表否则永久空)。
      if (customMailbox !== null && customMailbox === node.display_name) {
        setView('inbox')
      }
      setDeleteTarget(null)
      toastSuccess(
        t('settings.folder.picker.manage.deleteOk', {
          defaultValue: '已删除文件夹「{name}」',
          name: node.display_name
        })
      )
      void qc.invalidateQueries({ queryKey: qk.folder.all() })
    } catch (e) {
      setDeleteTarget(null)
      toastError(
        t('settings.folder.picker.manage.deleteFail', { defaultValue: '删除失败' }),
        `${toErrorMessage(e)} · ${t('settings.folder.picker.manage.deleteRollback', {
          defaultValue: 'Exchange 操作失败，本地文件夹树已回滚到服务器真实状态。'
        })}`
      )
      void qc.invalidateQueries({ queryKey: qk.folder.all() })
    } finally {
      setDeleting(false)
    }
  }, [deleteTarget, mailApi, markRestartRequired, customMailbox, setView, qc, t])

  const manage: ManageHandlers = {
    menuFor,
    edit,
    editBusy,
    onOpenMenu: openMenu,
    onStartCreate: startCreate,
    onStartRename: startRename,
    onRequestDelete: requestDelete,
    onEditChange: editChange,
    onEditSubmit: () => void editSubmit(),
    onEditCancel: editCancel
  }

  // ── per-folder 配置 (v62, folder_pref) — 图标 + 通知 + AI 分类 ────────────────
  // 🔴 与白名单/顺序**不共用**「保存」按钮: PUT /folder/prefs 改完立即生效。
  const prefMap = useFolderPrefMap()
  const [prefBusy, setPrefBusy] = React.useState<string | null>(null)
  const [iconAnchor, setIconAnchor] = React.useState<IconPickerAnchor | null>(null)

  const prefOf = React.useCallback(
    (imapName: string): FolderPrefValue => folderPrefValue(prefMap.get(imapName)),
    [prefMap]
  )

  const savePref = React.useCallback(
    async (imapName: string, patch: FolderPrefPatch): Promise<void> => {
      qc.setQueryData<FolderPrefsResult>(qk.folder.prefs(), (cur) => {
        if (!cur) return cur
        const i = cur.prefs.findIndex((r) => r.imap_name === imapName)
        if (i >= 0) {
          const next = cur.prefs.slice()
          next[i] = { ...cur.prefs[i]!, ...patch }
          return { prefs: next }
        }
        return {
          prefs: [
            ...cur.prefs,
            {
              imap_name: imapName,
              mailbox_label: displayNameByImap.get(imapName) ?? imapName,
              icon: null,
              notify_enabled: false,
              llm_disabled: false,
              updated_at: 0,
              ...patch
            }
          ]
        }
      })
      setPrefBusy(imapName)
      try {
        await mailApi.folder.setPref(imapName, patch)
      } catch (e) {
        toastError(
          t('settings.folder.picker.pref.saveFail', { defaultValue: '保存文件夹配置失败' }),
          toErrorMessage(e)
        )
      } finally {
        setPrefBusy(null)
        void qc.invalidateQueries({ queryKey: qk.folder.prefs() })
      }
    },
    [mailApi, qc, t, displayNameByImap]
  )

  const openIconPicker = React.useCallback(
    (e: React.MouseEvent<HTMLButtonElement>, key: string, displayName: string): void => {
      const rect = e.currentTarget.getBoundingClientRect()
      setIconAnchor((cur) => (cur?.key === key ? null : { key, displayName, rect }))
    },
    []
  )

  const dismissMenu = React.useCallback(() => setMenuFor(null), [])
  const closeDelete = React.useCallback(() => setDeleteTarget(null), [])
  const closeIconPicker = React.useCallback(() => setIconAnchor(null), [])

  return {
    menuFor,
    dismissMenu,
    manage,
    deleteDlgRender,
    renderDeleteTarget,
    deleteDlgRef,
    deleting,
    closeDelete,
    confirmDelete,
    prefBusy,
    iconAnchor,
    prefOf,
    savePref,
    openIconPicker,
    closeIconPicker
  }
}
