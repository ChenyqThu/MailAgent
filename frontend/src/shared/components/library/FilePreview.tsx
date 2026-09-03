// 预览面（design §2.3 动作条 + §2.4 预览矩阵；mockup C1–C8）：文件头 + 状态横幅 + 按 kind 分派
// 的正文 + 历史抽屉。
//
// 这一层只做三件事，别的都下沉给子视图：
//   ① 取行对象（`useLibraryFileQuery`，投影行走 attachment 兄弟端点，端点选择在 hooks 层）；
//   ② 按「文件在哪个根 / 是什么类型 / 解析好没有 / 还在不在」算动作条与正文形态；
//   ③ 把动作交给 `useLibraryFileActions`（文件夹行菜单与这里共用一份实现）。
//
// 🔴 三条判据不要各写各的：
//   · `projection`（投影行）—— 只读、没有 library id、没有历史，动作收窄到「另存 / 打开 / 访达」；
//   · `mountUnavailable`（挂载根拔了）—— **不读盘**，正文整段留空，只保留元信息（mockup C8）；
//   · `readonly` = 投影 ∨ 只读挂载 ∨ 挂载不可用 —— 决定编辑 / 移动 / 删除 / 另存解析版在不在。

import { useState, type ReactElement, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Clock3,
  ExternalLink,
  FileDown,
  FolderInput,
  FolderOpen,
  Pencil,
  RotateCcw,
  Sparkles,
  Trash2
} from 'lucide-react'

import type { LibraryFile, LibraryFileDetail } from '@shared/api/types/library'
import { Button } from '@shared/components/ui/button'
import { Skeleton } from '@shared/components/feedback/LoadingSkeleton'
import { formatFileSize } from '@shared/format'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'

import {
  derivedSourceId,
  displayName,
  fileTimeLabel,
  isProjection,
  libraryIconTone,
  openWithApp,
  trashDaysLeft,
  type LibraryFileRef
} from './fileMeta'
import { HistoryDrawer } from './HistoryDrawer'
import { useLibraryFileQuery, useLibraryTextQuery, useMountSummary } from './hooks'
import { HtmlPreview } from './HtmlPreview'
import { ImagePreview } from './ImagePreview'
import { MarkdownEditor, type MarkdownMode } from './MarkdownEditor'
import { OtherFilePreview } from './OtherFilePreview'
import { ParsedTextView } from './ParsedTextView'
import { FileStatusPill, Notice, Pill, SourcePill, TextStatusPill } from './parts'
import type { LibraryFileActions } from './useLibraryFileActions'

/** 不内联的两类（design §2.4 最后一行）：视频 / 音频，以及 iCloud 未下载的占位文件。
 *  其余（office / csv / text / other）一律走解析视图 —— 三种 `text_status` 的面在那里面。 */
function isNonInlineKind(file: Pick<LibraryFile, 'kind' | 'mime'>): boolean {
  if (file.kind === 'placeholder') return true
  const mime = file.mime ?? ''
  return mime.startsWith('video/') || mime.startsWith('audio/')
}

/** F2：解析版顶部的「派生自 X」回链。单向 —— 原文件那侧不显示自己被另存过（design §2.3）。 */
function DerivedFromChip({
  sourceId,
  onSelect
}: {
  sourceId: number
  onSelect(ref: LibraryFileRef): void
}): ReactElement | null {
  const { t } = useTranslation()
  const source = useLibraryFileQuery({ id: sourceId })
  if (source.isError) return null
  const name = source.data ? displayName(source.data) : '…'
  return (
    <div className="px-4 pt-3">
      <button
        type="button"
        onClick={() => onSelect({ id: sourceId })}
        className="inline-flex items-center gap-1.5 rounded-full border border-ink-border bg-ink-2 px-2.5 py-1 text-meta text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
      >
        <ExternalLink size={11} strokeWidth={2} aria-hidden className="text-ink-fg-3" />
        {t('library.preview.derivedFrom', { name })}
      </button>
    </div>
  )
}

function StatusBanner({
  file,
  mountUnavailable,
  onRestore
}: {
  file: LibraryFileDetail
  mountUnavailable: boolean
  onRestore(): void
}): ReactElement | null {
  const { t } = useTranslation()
  if (mountUnavailable) {
    return (
      <div className="px-4 pt-3">
        <Notice tone="warn">{t('library.tree.mountUnavailable')}</Notice>
      </div>
    )
  }
  if (file.status === 'missing') {
    return (
      <div className="px-4 pt-3">
        <Notice tone="warn">
          <span className="font-medium">{t('library.preview.fileStatusMissing')}</span>
          <span className="ml-1.5 text-ink-fg-2">{t('library.preview.fileStatusMissingHint')}</span>
        </Notice>
      </div>
    )
  }
  if (file.status === 'trashed') {
    return (
      <div className="flex items-center gap-2 px-4 pt-3">
        <div className="min-w-0 flex-1">
          <Notice tone="info">
            {t('library.trash.fileTrashedLabel')}
            <span className="ml-1.5 text-ink-fg-2">
              {t('library.trash.fileTrashedHint', { days: trashDaysLeft(file) })}
            </span>
          </Notice>
        </div>
        <Button size="sm" variant="secondary" onClick={onRestore}>
          <RotateCcw size={13} aria-hidden />
          {t('library.trash.restoreAction')}
        </Button>
      </div>
    )
  }
  return null
}

interface ActionSpec {
  id: string
  label: string
  icon: ReactNode
  onClick(): void
  primary?: boolean
  danger?: boolean
  disabled?: boolean
}

function FileHeader({
  file,
  actions,
  onChat
}: {
  file: LibraryFileDetail
  actions: readonly ActionSpec[]
  onChat(): void
}): ReactElement {
  const { t } = useTranslation()
  const tone = libraryIconTone(file)
  const I = tone.Icon
  return (
    <header className="border-b border-ink-border px-4 py-3">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'grid size-10 shrink-0 place-items-center rounded-lg border',
            tone.bg,
            tone.border
          )}
        >
          <I size={18} strokeWidth={1.9} className={tone.text} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lead font-medium text-ink-fg">{displayName(file)}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-ink-fg-2">
            <span className="font-mono tabular-nums">
              {file.size_bytes != null ? formatFileSize(file.size_bytes) : '—'}
            </span>
            <span className="text-ink-fg-3">·</span>
            <span>{t(`library.common.kind.${file.kind}`)}</span>
            <span className="text-ink-fg-3">·</span>
            <span className="font-mono tabular-nums">{fileTimeLabel(file)}</span>
            <SourcePill file={file} />
            <TextStatusPill file={file} />
            <FileStatusPill file={file} />
          </div>
          <div className="mt-1 truncate font-mono text-micro text-ink-fg-3" title={file.path}>
            {file.path}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {actions.map((a) => (
            <Button
              key={a.id}
              size="sm"
              disabled={a.disabled}
              variant={a.primary ? 'default' : a.danger ? 'ghost' : 'secondary'}
              onClick={a.onClick}
              className={a.danger ? 'text-fail hover:bg-fail/10 hover:text-fail' : undefined}
            >
              {a.icon}
              {a.label}
            </Button>
          ))}
          <Button size="sm" variant="secondary" onClick={onChat}>
            <Sparkles size={13} aria-hidden />
            {t('library.actions.chat')}
          </Button>
        </div>
      </div>
    </header>
  )
}

export interface FilePreviewProps {
  fileRef: LibraryFileRef
  actions: LibraryFileActions
  /** F2 回链 / 深链落点：换成另一个文件。 */
  onSelectFile(ref: LibraryFileRef): void
  /** P1 只开 dock（预置 @ 提及是 P2）。 */
  onChat(file: LibraryFileDetail): void
}

export function FilePreview({
  fileRef,
  actions,
  onSelectFile,
  onChat
}: FilePreviewProps): ReactElement {
  const { t } = useTranslation()
  const detail = useLibraryFileQuery(fileRef)
  const [mode, setMode] = useState<MarkdownMode>('read')
  const [history, setHistory] = useState(false)
  const file = detail.data ?? null
  const mount = useMountSummary(file?.mount_id ?? 0)
  // 「另存解析版」在头部，正文在 ParsedTextView —— 同一个 query key，TanStack 只发一次请求。
  const text = useLibraryTextQuery(fileRef, file !== null && file.kind !== 'markdown')

  if (detail.isPending) {
    return (
      <div className="p-4">
        <Skeleton rows={8} width="2/3" />
      </div>
    )
  }
  if (detail.isError || file === null) {
    return (
      <div className="p-4">
        <Notice tone="fail">
          {t('library.preview.loadFailed')}
          <span className="ml-1.5 text-ink-fg-3">{errorMessage(detail.error)}</span>
        </Notice>
      </div>
    )
  }

  const projection = isProjection(file)
  const mountUnavailable = mount !== null && mount.status !== 'ok'
  const readonly = projection || mountUnavailable || (mount !== null && mount.mode === 'ro')
  const present = file.status === 'present'
  const app = openWithApp(file)
  const derivedFrom = derivedSourceId(file)
  const parsedMarkdown = text.data?.markdown ?? null

  const specs: ActionSpec[] = []
  if (file.kind === 'markdown' && !readonly && present) {
    specs.push({
      id: 'edit',
      label: t('library.actions.edit'),
      icon: <Pencil size={13} aria-hidden />,
      primary: mode === 'read',
      onClick: () => setMode(mode === 'edit' ? 'read' : 'edit')
    })
  }
  specs.push({
    id: 'open',
    label: app ? t('library.actions.openWith', { app: t(`library.common.app.${app}`) }) : t('library.actions.openSystem'),
    icon: <ExternalLink size={13} aria-hidden />,
    disabled: !present || mountUnavailable,
    onClick: () => actions.open(file)
  })
  if (!projection) {
    specs.push({
      id: 'reveal',
      label: t('library.actions.reveal'),
      icon: <FolderOpen size={13} aria-hidden />,
      disabled: !present || mountUnavailable,
      onClick: () => actions.reveal(file)
    })
  }
  if (projection) {
    specs.push({
      id: 'keep',
      label: t('library.actions.keepToLibrary'),
      icon: <FileDown size={13} aria-hidden />,
      primary: true,
      disabled: !present,
      onClick: () => actions.keep(file)
    })
  }
  if (file.kind !== 'markdown' && !readonly && parsedMarkdown !== null) {
    specs.push({
      id: 'savemd',
      label: t('library.actions.saveParsedMd'),
      icon: <FileDown size={13} aria-hidden />,
      onClick: () => actions.saveParsedMarkdown(file, parsedMarkdown)
    })
  }
  if (!readonly && file.status !== 'trashed') {
    specs.push({
      id: 'move',
      label: t('library.actions.moveTo'),
      icon: <FolderInput size={13} aria-hidden />,
      onClick: () => actions.move(file)
    })
    specs.push({
      id: 'delete',
      label: t('library.actions.delete'),
      icon: <Trash2 size={13} aria-hidden />,
      danger: true,
      onClick: () => actions.trash(file)
    })
  }
  if (file.id !== null) {
    specs.push({
      id: 'history',
      label: t('library.actions.history'),
      icon: <Clock3 size={13} aria-hidden />,
      onClick: () => setHistory(true)
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FileHeader file={file} actions={specs} onChat={() => onChat(file)} />
      <StatusBanner
        file={file}
        mountUnavailable={mountUnavailable}
        onRestore={() => actions.restore(file)}
      />
      {derivedFrom !== null ? (
        <DerivedFromChip sourceId={derivedFrom} onSelect={onSelectFile} />
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-thin">
        {mountUnavailable ? (
          // 挂载不可用 = 一次盘都不读；元信息与历史仍在（design §8.2）。
          <div className="grid flex-1 place-items-center px-6 py-10 text-center text-meta text-ink-fg-3">
            {t('library.preview.noInline')}
          </div>
        ) : file.kind === 'markdown' ? (
          <MarkdownEditor file={file} mode={readonly ? 'read' : mode} onModeChange={setMode} />
        ) : file.kind === 'html' ? (
          <HtmlPreview file={file} />
        ) : file.kind === 'image' ? (
          <ImagePreview file={file} fileRef={fileRef} onOpenExternal={() => actions.open(file)} />
        ) : isNonInlineKind(file) ? (
          <OtherFilePreview
            file={file}
            onOpenExternal={() => actions.open(file)}
            onReveal={() => actions.reveal(file)}
          />
        ) : (
          <ParsedTextView
            file={file}
            fileRef={fileRef}
            onOpenExternal={() => actions.open(file)}
            onReveal={() => actions.reveal(file)}
          />
        )}
      </div>
      {file.id !== null ? (
        <HistoryDrawer open={history} onOpenChange={setHistory} file={file} />
      ) : null}
      {projection && present ? (
        <div className="shrink-0 border-t border-ink-border px-4 py-2">
          <Pill tone="info">{t('library.tree.readonlyRoot')}</Pill>
        </div>
      ) : null}
    </div>
  )
}
