// Phase C — 存档 / 草稿箱两栏壳 (list + detail), 仿 InboxLayout 的 chrome
// (TitleBar + Sidebar + 中栏 list + detail 列 + StatusBar)。
//
// 单一 FolderLayout 同时服务 /archive 和 /drafts (folder prop 区分)。本地
// state 管:
//   - selectedId: 当前选中的 folder_email id (切 route 时组件 remount 自动重置)
//   - editor: 草稿编辑态 ({mode:'new'} 新建 / {mode:'edit', draft} 编辑 / null)
//
// editor 非 null 时 detail 列渲染 DraftEditor, 否则渲染 FolderDetail。

import { useCallback, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { useMailApi } from '@shared/hooks/useMailApi'
import { toastError, toastSuccess } from '@shared/state/toast'
import { useTranslation } from 'react-i18next'
import type { FolderEmailDetail, FolderName } from '@shared/api/types'

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

  // 手动同步 — FolderList 顶部「同步」按钮调. mutation onSuccess invalidate
  // 当前 folder 列表 (worker SSE 也会推 folder.synced, 双保险)。
  const syncMut = useMutation({
    mutationFn: () => mailApi.folder.syncNow(folder, true),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['folder', folder] })
      toastSuccess(t('folder.toast.syncOk'))
    },
    onError: (err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err))
      const code = (e as Error & { code?: string }).code
      toastError(t('folder.toast.syncFail'), code ? `${code} · ${e.message}` : e.message)
    }
  })

  const handleSelect = useCallback((id: number) => {
    setEditor(null)
    setSelectedId(id)
  }, [])

  const handleNewDraft = useCallback(() => {
    setEditor({ mode: 'new' })
  }, [])

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
          onNewDraft={folder === 'drafts' ? handleNewDraft : undefined}
          onSync={() => syncMut.mutate()}
          syncing={syncMut.isPending}
        />
        {editor !== null ? (
          <DraftEditor draft={editor.mode === 'edit' ? editor.draft : null} onClose={closeEditor} />
        ) : (
          <FolderDetail
            folder={folder}
            id={selectedId}
            onEdit={folder === 'drafts' ? (id) => void handleEdit(id) : undefined}
          />
        )}
      </div>
      <StatusBar />
    </div>
  )
}
