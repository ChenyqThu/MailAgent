// HTML 预览（design §2.6，owner 09-03 拍板「就当在浏览器里打开」）：iframe 指向 `libpreview://`，
// 脚本 / 样式照常执行、不过 DOMPurify、不裁剪内容。
//
// 🔴 sandbox **绝不加 `allow-same-origin`**：与 `allow-scripts` 同给等于没有沙箱。没有它，
// 页面拿到的是不透明源 —— 碰不到 app 的 DOM / storage / 本机 token。

import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import type { LibraryFile } from '@shared/api/types/library'
import { buildLibraryPreviewUrl } from '@shared/libraryIpcContract'

import { previewPathOf } from './fileMeta'
import { Notice } from './parts'

export const HTML_PREVIEW_SANDBOX = 'allow-scripts allow-popups allow-forms allow-modals'

export function HtmlPreview({ file }: { file: LibraryFile }): ReactElement {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 py-3">
      <Notice tone="info">{t('library.preview.htmlNotice')}</Notice>
      <div className="min-h-[320px] flex-1 overflow-hidden rounded-[var(--r-card)] border border-ink-border bg-white">
        <iframe
          title={file.filename}
          src={buildLibraryPreviewUrl(previewPathOf(file))}
          sandbox={HTML_PREVIEW_SANDBOX}
          className="h-full min-h-[320px] w-full"
        />
      </div>
    </div>
  )
}
