// 图片预览（design §2.4；mockup C4）：原件 fetch → blob:（CSP `img-src` 不含 loopback，
// 上限沿用 `canPreviewImage` 的 25 MB / 必须有已知大小）+ `ImageLightbox`；有 OCR 文本时
// 旁边给「文字」视图 —— 那份文本同时也是 FTS 与 `library_read` 的来源。

import { useEffect, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink } from 'lucide-react'

import type { LibraryFile } from '@shared/api/types/library'
import { canPreviewImage } from '@shared/components/email/attachmentPreview'
import { ImageLightbox } from '@shared/components/email/EmailBodyFrame'
import { Button } from '@shared/components/ui/button'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { Skeleton } from '@shared/components/feedback/LoadingSkeleton'

import type { LibraryFileRef } from './fileMeta'
import { inlineUrlOf, useLibraryApi, useLibraryTextQuery } from './hooks'
import { Notice, Pill } from './parts'

type Tab = 'image' | 'text'

/** 原件 → blob: URL；卸载 / 换文件时 revoke。返回 `null` = 还没到 / 不预览，`failed` = 拉不到。 */
function useBlobUrl(url: string | null): { src: string | null; failed: boolean } {
  const [state, setState] = useState<{ url: string | null; src: string | null; failed: boolean }>({
    url,
    src: null,
    failed: false
  })
  useEffect(() => {
    if (url === null) return
    let objectUrl: string | null = null
    let cancelled = false
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status))
        return res.blob()
      })
      .then((blob) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setState({ url, src: objectUrl, failed: false })
      })
      .catch(() => {
        if (!cancelled) setState({ url, src: null, failed: true })
      })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [url])
  if (state.url !== url) return { src: null, failed: false }
  return { src: state.src, failed: state.failed }
}

interface Props {
  file: LibraryFile
  fileRef: LibraryFileRef
  onOpenExternal(): void
}

export function ImagePreview({ file, fileRef, onOpenExternal }: Props): ReactElement {
  const { t } = useTranslation()
  const api = useLibraryApi()
  const previewable =
    file.status === 'present' &&
    canPreviewImage({ content_type: file.mime, filename: file.filename, size_bytes: file.size_bytes })
  const { src, failed } = useBlobUrl(previewable ? inlineUrlOf(api, fileRef) : null)
  // OCR 文本来自索引，磁盘上的原件没了也还在（只有 `previewable` 才需要 present）。
  const text = useLibraryTextQuery(fileRef, file.text_status === 'extracted')
  const ocr = text.data?.markdown?.trim() ? text.data.markdown : null
  const [tab, setTab] = useState<Tab>('image')
  const [lightbox, setLightbox] = useState(false)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3">
      {ocr ? (
        <div className="flex items-center gap-2">
          <SegmentedControl<Tab>
            value={tab}
            onChange={setTab}
            ariaLabel={t('library.preview.imageViewAria')}
            options={[
              { value: 'image', label: t('library.preview.tabImage') },
              { value: 'text', label: t('library.preview.tabText') }
            ]}
          />
          <Pill tone="info">{t('library.preview.ocrBadge')}</Pill>
        </div>
      ) : null}
      {tab === 'text' && ocr ? (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-[var(--r-card)] border border-ink-border bg-ink-2 px-3 py-2 font-mono text-aux leading-6 text-ink-fg-1 scrollbar-thin">
          {ocr}
        </pre>
      ) : !previewable || failed ? (
        <div className="flex flex-col gap-2">
          <Notice tone="info">{t('library.preview.imageTooLarge')}</Notice>
          <div>
            <Button size="sm" variant="secondary" onClick={onOpenExternal}>
              <ExternalLink size={13} aria-hidden />
              {t('library.actions.openSystem')}
            </Button>
          </div>
        </div>
      ) : src === null ? (
        <Skeleton rows={4} className="p-2" width="1/2" />
      ) : (
        <button
          type="button"
          onClick={() => setLightbox(true)}
          className="grid min-h-0 flex-1 place-items-center overflow-hidden rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-3"
        >
          <img src={src} alt={file.filename} className="max-h-[420px] max-w-full rounded" />
        </button>
      )}
      {lightbox && src ? <ImageLightbox src={src} onClose={() => setLightbox(false)} /> : null}
    </div>
  )
}
