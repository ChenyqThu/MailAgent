// Phase C — 存档 / 草稿箱两栏壳 (list + detail), 仿 InboxLayout 的 chrome
// (TitleBar + Sidebar + 中栏 list + detail 列 + StatusBar)。
//
// 单一 FolderLayout 同时服务 /archive 和 /drafts (folder prop 区分)。本地
// state 管:
//   - selectedId: 当前选中的 folder_email id (切 route 时组件 remount 自动重置)
//   - editor: 草稿编辑态 ({mode:'new'} 新建 / {mode:'edit', draft} 编辑 / null)
//   - rowDeleteId: 行 hover 浮动删除的待确认 id (Sprint 18 mockup .fr-delete)
//
// editor 非 null 时 detail 列渲染 DraftEditor, 否则渲染 FolderDetail。
// 行删除走与 FolderDetail 相同的 mailApi.folder.deleteMsg + invalidate
// (['folder', folder]) + 同套 toast key, 只是把确认 dialog 提到 layout 层,
// 这样 hover 删除按钮不必进 detail 即可删除。

import { useCallback, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { useMailApi } from '@shared/hooks/useMailApi'
import { toastError, toastSuccess } from '@shared/state/toast'
import { useTranslation } from 'react-i18next'
import type { FolderEmailDetail, FolderName } from '@shared/api/types'

import { ConfirmDialog } from '../folder/ConfirmDialog'
import { FolderDetail } from '../folder/FolderDetail'
import { FolderList } from '../folder/FolderList'
import { DraftEditor } from '../folder/DraftEditor'
import { TitleBar } from './TitleBar'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'

interface Props {
  folder: FolderName
}

type EditorState = { mode: 'new' } | { mode: 'edit'; draft: FolderEmailDetail } | null

export function FolderLayout({ folder }: Props): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [editor, setEditor] = useState<EditorState>(null)
  const [rowDeleteId, setRowDeleteId] = useState<number | null>(null)
  const isDrafts = folder === 'drafts'

  const invalidateList = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['folder', folder] }),
    [queryClient, folder]
  )

  // 手动同步 — FolderList 顶部「同步」按钮调. mutation onSuccess invalidate
  // 当前 folder 列表 (worker SSE 也会推 folder.synced, 双保险)。
  const syncMut = useMutation({
    mutationFn: () => mailApi.folder.syncNow(folder, true),
    onSuccess: async () => {
      await invalidateList()
      toastSuccess(t('folder.toast.syncOk'))
    },
    onError: (err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err))
      const code = (e as Error & { code?: string }).code
      toastError(t('folder.toast.syncFail'), code ? `${code} · ${e.message}` : e.message)
    }
  })

  // 行 hover 浮动删除 — 复用 FolderDetail 同套 deleteMsg 调用 + invalidate +
  // toast key, 仅把确认 dialog 提到 layout 层。
  const rowDeleteMut = useMutation({
    mutationFn: (id: number) => mailApi.folder.deleteMsg(id),
    onSuccess: async (_data, id) => {
      await invalidateList()
      // 删的恰好是当前选中的 → 清空 detail
      setSelectedId((cur) => (cur === id ? null : cur))
      toastSuccess(t('folder.toast.deleteOk'))
    },
    onError: (err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err))
      const code = (e as Error & { code?: string }).code
      toastError(t('folder.toast.deleteFail'), code ? `${code} · ${e.message}` : e.message)
    }
  })

  const handleSelect = useCallback((id: number) => {
    setEditor(null)
    setSelectedId(id)
  }, [])

  const handleNewDraft = useCallback(() => {
    setEditor({ mode: 'new' })
  }, [])

  const handleRequestDelete = useCallback((id: number) => {
    setRowDeleteId(id)
  }, [])

  const confirmRowDelete = useCallback(() => {
    if (rowDeleteId === null) return
    rowDeleteMut.mutate(rowDeleteId)
    setRowDeleteId(null)
  }, [rowDeleteId, rowDeleteMut])

  // 编辑草稿 — 先拉详情 (含 body_html) 再开 editor。FolderDetail 已经 query
  // 过 ['folder-email', id], 这里直接读 cache, miss 才 fetch。
  const handleEdit = useCallback(
    async (id: number) => {
      const cached = queryClient.getQueryData<FolderEmailDetail | null>(['folder-email', id])
      let draft = cached ?? null
      if (!draft) {
        draft = await queryClient.fetchQuery({
          queryKey: ['folder-email', id],
          queryFn: () => mailApi.folder.get(id)
        })
      }
      if (draft) setEditor({ mode: 'edit', draft })
    },
    [queryClient, mailApi]
  )

  const closeEditor = useCallback(() => setEditor(null), [])

  return (
    <div className="flex flex-col h-full text-ink-fg">
      <TitleBar />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <FolderList
          folder={folder}
          activeId={selectedId}
          onSelect={handleSelect}
          onNewDraft={isDrafts ? handleNewDraft : undefined}
          onSync={() => syncMut.mutate()}
          syncing={syncMut.isPending}
          onRequestDelete={handleRequestDelete}
        />
        {editor !== null ? (
          <DraftEditor draft={editor.mode === 'edit' ? editor.draft : null} onClose={closeEditor} />
        ) : (
          <FolderDetail
            folder={folder}
            id={selectedId}
            onEdit={isDrafts ? (id) => void handleEdit(id) : undefined}
          />
        )}
      </div>
      <StatusBar />

      {/* 行 hover 删除确认 — 与 detail toolbar 删除同套 mutation, 仅入口不同 */}
      <ConfirmDialog
        open={rowDeleteId !== null}
        kind={isDrafts ? 'deleteDraft' : 'delete'}
        danger
        title={isDrafts ? t('folder.confirm.deleteDraftTitle') : t('folder.confirm.deleteTitle')}
        body={isDrafts ? t('folder.confirm.deleteDraftRow') : t('folder.confirm.deleteRow')}
        confirmLabel={
          isDrafts ? t('folder.confirm.confirmDeleteDraft') : t('folder.confirm.confirmDelete')
        }
        cancelLabel={t('folder.confirm.cancel')}
        pending={rowDeleteMut.isPending}
        onConfirm={confirmRowDelete}
        onCancel={() => setRowDeleteId(null)}
      />
    </div>
  )
}
