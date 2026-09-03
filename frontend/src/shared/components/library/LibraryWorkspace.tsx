// 资料库域的页面外壳（design §2.1 / §2.3 / §9.5；mockup A1 + B + C）：左树 = 本域的二级栏，
// 右内容区 = 文件夹视图或预览面，右侧 dock 挂 AI chat。
//
// 🔴 只导出组件，**不注册路由** —— `libraryRoute` / `LibraryLayout` / registry 那一串是
// P1-L8（导航接入）的活，那条 lane 单独一个 commit，revert 即整域消失。
//
// 深链 `/library?file={id}`（design §9.5）在这里落地：进域 + 逐层展开所在文件夹 + 选中文件；
// 文件 missing / trashed 时进域并 toast。参数从 `location.href` 里读，不用 `useSearch({from})`
// —— 那个字面量要等 L8 注册完路由才存在（见 deeplink.ts）。

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { useRouterState } from '@tanstack/react-router'
import { FolderTree } from 'lucide-react'

import type { LibraryFile } from '@shared/api/types/library'
import { AssistantChatDock } from '@shared/assistant/modal/AssistantChatDock'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { PageFrame } from '@shared/components/layout/PageFrame'
import { TRASH_SLUG } from '@shared/libraryConstants'
import { useAIChatPanel } from '@shared/state/ai-chat-panel'
import { useLibraryTree } from '@shared/state/library-tree'
import { useMainBreadcrumb } from '@shared/state/main-breadcrumb'
import type { MainPage } from '@shared/state/tab-workspace'
import { toastInfo } from '@shared/state/toast'

import { parseLibraryFileParam } from './deeplink'
import { isProjection, refKey, refOf, type LibraryFileRef } from './fileMeta'
import { FilePreview } from './FilePreview'
import { FolderView } from './FolderView'
import { useLibraryApi, useLibraryTreeQuery, useLibraryUpload } from './hooks'
import { LibraryTreePanel, rootLabelKey } from './LibraryTreePanel'
import { revealLibraryTarget } from './libraryIpc'
import { useLibraryFileActions } from './useLibraryFileActions'

/** 🔴 `'library'` 要等 P1-L8 把它加进 `NavDomain` 才是合法的 `MainPage`。断言只是那条 lane
 *  落地前的桥：`useMainBreadcrumb` 自带 `mainPage === page` 守卫，域不存在时它一次都不写。
 *  L8 合并后这一行可以直接删掉（字面量本身就成立）。 */
const LIBRARY_MAIN_PAGE = 'library' as MainPage

/** 两列几何抄 ContactsWorkspace：树列宽读 `--app-second-w`（nav shell 按域记忆的那份），
 *  内容列 `minmax(430px,1fr)`，窄窗塌成单列。 */
const WORKSPACE_GRID_CLASS =
  'grid h-full min-h-0 grid-cols-[var(--app-second-w,336px)_minmax(430px,1fr)] max-[860px]:grid-cols-1'

export function LibraryWorkspace(): ReactElement {
  const { t } = useTranslation()
  const api = useLibraryApi()
  const upload = useLibraryUpload()

  const expanded = useLibraryTree((s) => s.expanded)
  const selectedPath = useLibraryTree((s) => s.selectedPath)
  const selectedFileId = useLibraryTree((s) => s.selectedFileId)
  const selectFolder = useLibraryTree((s) => s.selectFolder)
  const selectFile = useLibraryTree((s) => s.selectFile)
  const revealPath = useLibraryTree((s) => s.revealPath)
  const setExpanded = useLibraryTree((s) => s.setExpanded)

  // 投影行没有 library id（`id: null`），store 的 `selectedFileId` 装不下它 —— 另存一份
  // attachment 寻址。两者互斥：选中哪一种就把另一种清掉。
  const [attachmentRef, setAttachmentRef] = useState<LibraryFileRef | null>(null)
  const fileRef: LibraryFileRef | null =
    selectedFileId !== null ? { id: selectedFileId } : attachmentRef

  const path = selectedPath ?? 'my-docs'
  // 当前文件夹落在哪个挂载根下（`mount.path` 恒 `@<label>`）—— ro / 不可用两档决定内容区
  // 有没有写动作。库内四根 `mount_id = 0`，找不到即库根，恒可写。
  const tree = useLibraryTreeQuery()
  const mount =
    tree.data?.mounts.find((m) => path === m.path || path.startsWith(`${m.path}/`)) ?? null
  const breadcrumb = path
    .split('/')
    .map((seg, index) => (index === 0 ? t(rootLabelKey(seg)) : seg))
    .join(' / ')
  useMainBreadcrumb(LIBRARY_MAIN_PAGE, breadcrumb)

  const openFile = useCallback(
    (file: Pick<LibraryFile, 'id' | 'attachment_id'>): void => {
      const ref = refOf(file)
      if (ref === null) return
      if ('id' in ref) {
        setAttachmentRef(null)
        selectFile(ref.id)
      } else {
        selectFile(null)
        setAttachmentRef(ref)
      }
    },
    [selectFile]
  )

  const selectRef = useCallback(
    (ref: LibraryFileRef): void => {
      if ('id' in ref) {
        setAttachmentRef(null)
        selectFile(ref.id)
      } else {
        selectFile(null)
        setAttachmentRef(ref)
      }
    },
    [selectFile]
  )

  const openFolder = useCallback(
    (next: string): void => {
      setAttachmentRef(null)
      selectFolder(next)
      setExpanded(next, true)
    },
    [selectFolder, setExpanded]
  )

  const clearSelection = useCallback((): void => {
    selectFile(null)
    setAttachmentRef(null)
  }, [selectFile])

  const actions = useLibraryFileActions({
    // 删除之后那份预览指向的行已经进了废纸篓：回到文件夹视图，别停在一个死引用上。
    // 移动 / 另存 / 另存解析版则相反 —— 新落点就是用户下一步想看的东西，直接跟过去。
    onTrashed: clearSelection,
    onPurged: clearSelection,
    onMoved: (moved) => openFile(moved),
    onKept: (kept) => openFile(kept),
    onDerived: (derived) => openFile(derived)
  })

  // ── 深链落地（design §9.5）────────────────────────────────────────────────
  const href = useRouterState({ select: (s) => s.location.href })
  const deepLinkId = parseLibraryFileParam(href)
  const consumed = useRef<number | null>(null)
  useEffect(() => {
    if (deepLinkId === null || consumed.current === deepLinkId) return
    consumed.current = deepLinkId
    let cancelled = false
    void (async () => {
      try {
        const file = await api.file(deepLinkId)
        if (cancelled) return
        if (file.status === 'missing') {
          toastInfo(t('library.deeplink.missingToast'))
          return
        }
        if (file.status === 'trashed') {
          // 废纸篓里的文件仍然可选中 —— 但要先把用户送到废纸篓，否则他看到的是一个
          // 「不在任何文件夹里」的预览面。
          revealPath(TRASH_SLUG)
          toastInfo(t('library.deeplink.trashedToast'))
        } else {
          revealPath(file.parent_path)
        }
        setAttachmentRef(null)
        selectFile(deepLinkId)
      } catch {
        if (!cancelled) toastInfo(t('library.deeplink.missingToast'))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [api, deepLinkId, revealPath, selectFile, t])

  // 「新建 markdown」：直接落一个空文件再进编辑态 —— P1 不做命名对话框（文件名可在
  // 「移到…」里改，重命名是 P2）。
  const newMarkdown = useCallback(
    (folderPath: string): void => {
      void (async () => {
        try {
          const created = await api.createTextFile({
            parent_path: folderPath,
            filename: t('library.tree.menu.newMarkdown') + '.md',
            content: ''
          })
          openFolder(folderPath)
          openFile(created)
        } catch {
          toastInfo(t('library.folder.loadFailed'))
        }
      })()
    },
    [api, openFile, openFolder, t]
  )

  const projection = isProjection({ path })
  const trash = path === TRASH_SLUG || path.startsWith(`${TRASH_SLUG}/`)
  const readonly =
    projection || trash || (mount !== null && (mount.mode === 'ro' || mount.status !== 'ok'))

  return (
    <PageFrame
      ariaLabel="library"
      mainClassName="flex-1 min-w-0 overflow-hidden"
      rightDock={<AssistantChatDock />}
    >
      <div className={WORKSPACE_GRID_CLASS}>
        <div className="nav-second-col flex-col border-r border-ink-border" data-nav-second>
          <div className="nav-second-col-inner min-h-0 flex-1 flex-col">
            <LibraryTreePanel
              selectedPath={selectedPath}
              expanded={expanded}
              onSelectFolder={openFolder}
              onExpandedChange={(next) => {
                for (const p of next) if (!expanded.has(p)) setExpanded(p, true)
                for (const p of expanded) if (!next.includes(p)) setExpanded(p, false)
              }}
              onNewMarkdown={newMarkdown}
              onImportFiles={(folderPath, files) => {
                openFolder(folderPath)
                void upload(folderPath, files)
              }}
              onReveal={(folderPath) => void revealLibraryTarget({ kind: 'folder', path: folderPath })}
            />
          </div>
        </div>
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
          {fileRef !== null ? (
            <FilePreview
              // 换文件 = 换实例：编辑态草稿 / 冲突态 / 历史抽屉都是「这一个文件」的局部状态，
              // 跨文件保留下来就会把 A 的未保存文本带进 B 的编辑框。
              key={refKey(fileRef)}
              fileRef={fileRef}
              actions={actions}
              onSelectFile={selectRef}
              onChat={() => useAIChatPanel.getState().openChatModal()}
            />
          ) : selectedPath !== null ? (
            <FolderView
              path={path}
              readonly={readonly}
              trash={trash}
              actions={actions}
              onOpenFile={openFile}
              onDropFiles={(files) => void upload(path, files)}
            />
          ) : (
            <EmptyState
              icon={<FolderTree size={20} strokeWidth={1.8} aria-hidden />}
              title={t('library.empty.folderTitle')}
              hint={t('library.empty.folderHint')}
            />
          )}
        </div>
      </div>
      {actions.dialogs}
    </PageFrame>
  )
}
