// video / 大文件 / 其他（design §2.4；mockup C7）：不内联，只给元信息 + 打开 / 访达显示。
// iCloud 未下载的占位文件（`kind='placeholder'`）多一条说明：磁盘上只有 .icloud 存根。

import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, FolderOpen } from 'lucide-react'

import type { LibraryFile } from '@shared/api/types/library'
import { Button } from '@shared/components/ui/button'
import { formatFileSize } from '@shared/format'
import { cn } from '@shared/lib/cn'

import { libraryIconTone, openWithApp } from './fileMeta'
import { Notice } from './parts'

interface Props {
  file: LibraryFile
  onOpenExternal(): void
  onReveal(): void
}

export function OtherFilePreview({ file, onOpenExternal, onReveal }: Props): ReactElement {
  const { t } = useTranslation()
  const tone = libraryIconTone(file)
  const I = tone.Icon
  const app = openWithApp(file)
  return (
    <div className="flex flex-col">
      <div className="grid min-h-[300px] flex-1 place-items-center px-4 py-6">
        <div className="text-center">
          <span
            className={cn(
              'mx-auto grid size-14 place-items-center rounded-xl border',
              tone.bg,
              tone.border
            )}
          >
            <I size={24} strokeWidth={1.7} className={tone.text} />
          </span>
          <div className="mt-3 text-aux text-ink-fg">{file.filename}</div>
          <div className="mt-0.5 font-mono text-meta tabular-nums text-ink-fg-2">
            {file.size_bytes != null ? formatFileSize(file.size_bytes) : '—'} ·{' '}
            {t(`library.common.kind.${file.kind}`)}
          </div>
          <div className="mt-1 text-meta text-ink-fg-3">{t('library.preview.noInline')}</div>
          <div className="mt-3 flex items-center justify-center gap-1.5">
            <Button size="sm" variant="secondary" onClick={onOpenExternal}>
              <ExternalLink size={13} aria-hidden />
              {app
                ? t('library.actions.openWith', { app: t(`library.common.app.${app}`) })
                : t('library.actions.openSystem')}
            </Button>
            <Button size="sm" variant="ghost" onClick={onReveal}>
              <FolderOpen size={13} aria-hidden />
              {t('library.actions.reveal')}
            </Button>
          </div>
        </div>
      </div>
      {file.kind === 'placeholder' ? (
        <div className="px-4 pb-4">
          <Notice tone="info">{t('library.preview.placeholderNotice')}</Notice>
        </div>
      ) : null}
    </div>
  )
}
