// 解析视图（design §2.4；mockup C5 / C6）：`GET /library/file/{id}/text` 的 markdown 经 Streamdown
// 渲染（与 chat 同一渲染器）；PDF 是带页分隔的纯文本（anydoc 的 pdf lane 默认不开），走 `<pre>`；
// `text_status` 的 pending / failed / unsupported 三态各有措辞。「原件」页签在 PDF 上按原型放占位
// （原件内嵌是 P3-L2）。解析版不落 sidecar，只活在 `library_text`。

import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, FolderOpen, RotateCcw } from 'lucide-react'

import type { LibraryFile } from '@shared/api/types/library'
import { TranslatedBody } from '@shared/components/email/TranslatedBody'
import { Button } from '@shared/components/ui/button'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { Skeleton } from '@shared/components/feedback/LoadingSkeleton'
import { errorMessage } from '@shared/lib/ipcErrors'

import { openWithApp, stripFrontmatter, type LibraryFileRef } from './fileMeta'
import { useLibraryTextQuery } from './hooks'
import { FrontmatterLine } from './MarkdownEditor'
import { Notice } from './parts'

type Tab = 'parsed' | 'original'

function OpenWithButton({
  file,
  onOpen
}: {
  file: LibraryFile
  onOpen(): void
}): ReactElement {
  const { t } = useTranslation()
  const app = openWithApp(file)
  return (
    <Button size="sm" variant="secondary" onClick={onOpen}>
      <ExternalLink size={13} aria-hidden />
      {app ? t('library.actions.openWith', { app: t(`library.common.app.${app}`) }) : t('library.actions.openSystem')}
    </Button>
  )
}

/** PDF 抽取文本按 form feed 分页（pypdf 逐页拼接时用 `\f` 分隔）；没有分隔符就整段一页。 */
export function splitPdfPages(text: string): string[] {
  const pages = text.split('\f').map((p) => p.replace(/^\n+|\n+$/g, ''))
  return pages.length > 1 ? pages : [text]
}

interface Props {
  file: LibraryFile
  fileRef: LibraryFileRef
  onOpenExternal(): void
  onReveal(): void
}

export function ParsedTextView({ file, fileRef, onOpenExternal, onReveal }: Props): ReactElement {
  const { t } = useTranslation()
  const pdf = file.kind === 'pdf'
  // 🔴 不按 `status === 'present'` 关掉：missing / trashed 的解析文本还留在 `library_text`，
  // 仍然读得出来（mockup C8）。真正读不到的只有「挂载不可用」，那一档由 FilePreview 直接
  // 不挂载本组件（不读盘），所以这里恒开。
  const text = useLibraryTextQuery(fileRef)
  const [tab, setTab] = useState<Tab>('parsed')

  if (text.isPending) {
    return (
      <div className="px-4 py-3">
        <Skeleton rows={6} width="2/3" />
      </div>
    )
  }
  if (text.isError) {
    return (
      <div className="flex flex-col gap-3 px-4 py-3">
        <Notice tone="fail">
          {t('library.preview.loadFailed')}
          <span className="ml-1.5 text-ink-fg-3">{errorMessage(text.error)}</span>
        </Notice>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => void text.refetch()}>
            <RotateCcw size={13} aria-hidden />
            {t('library.actions.retry')}
          </Button>
          <OpenWithButton file={file} onOpen={onOpenExternal} />
        </div>
      </div>
    )
  }

  const status = text.data.text_status
  if (status === 'pending' || (status === 'extracted' && !text.data.markdown)) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3">
        <div className="grid min-h-[240px] flex-1 place-items-center rounded-[var(--r-card)] border border-ink-border bg-ink-2">
          <div className="text-center">
            <div className="text-aux text-ink-fg-1">{t('library.preview.pending')}</div>
            <div className="mt-1 text-meta text-ink-fg-3">{t('library.preview.pendingHint')}</div>
            <div className="mt-3 flex items-center justify-center gap-1.5">
              <Button size="sm" variant="secondary" onClick={() => void text.refetch()}>
                <RotateCcw size={13} aria-hidden />
                {t('library.actions.retry')}
              </Button>
              <OpenWithButton file={file} onOpen={onOpenExternal} />
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (status === 'failed' || status === 'unsupported') {
    const failed = status === 'failed'
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3">
        <Notice tone={failed ? 'fail' : 'info'}>
          {failed ? t('library.preview.failed') : t('library.preview.unsupported')}
          {failed ? <span className="ml-1 text-ink-fg-3">{t('library.preview.failedHint')}</span> : null}
        </Notice>
        <div className="grid min-h-[220px] flex-1 place-items-center rounded-[var(--r-card)] border border-ink-border bg-ink-2">
          <div className="flex items-center gap-2">
            {failed ? (
              <Button size="sm" variant="secondary" onClick={() => void text.refetch()}>
                <RotateCcw size={13} aria-hidden />
                {t('library.actions.retry')}
              </Button>
            ) : null}
            <OpenWithButton file={file} onOpen={onOpenExternal} />
            <Button size="sm" variant="ghost" onClick={onReveal}>
              <FolderOpen size={13} aria-hidden />
              {t('library.actions.reveal')}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  const markdown = text.data.markdown ?? ''
  const parsed = stripFrontmatter(markdown)
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl<Tab>
          value={tab}
          onChange={setTab}
          ariaLabel={t('library.preview.pdfViewAria')}
          options={
            pdf
              ? [
                  { value: 'parsed', label: t('library.preview.tabParsed') },
                  { value: 'original', label: t('library.preview.tabOriginal') }
                ]
              : [{ value: 'parsed', label: t('library.preview.tabParsed') }]
          }
        />
        <span className="font-mono text-micro text-ink-fg-3">
          {t('library.preview.extractor', { name: text.data.extractor ?? '—' })}
          {text.data.truncated ? ` · ${t('library.preview.truncated')}` : ''}
        </span>
        <span className="ml-auto">
          <OpenWithButton file={file} onOpen={onOpenExternal} />
        </span>
      </div>
      {text.data.stale ? <Notice tone="warn">{t('library.preview.stale')}</Notice> : null}
      {tab === 'original' ? (
        <div className="grid min-h-[320px] flex-1 place-items-center rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-6 text-center">
          <div className="max-w-md text-meta leading-relaxed text-ink-fg-3">
            {t('library.preview.pdfOriginalPlaceholder')}
          </div>
        </div>
      ) : pdf ? (
        <div className="min-h-0 flex-1 overflow-auto rounded-[var(--r-card)] border border-ink-border bg-ink-2 scrollbar-thin">
          <div className="border-b border-ink-border-soft px-3 py-1.5 text-meta text-ink-fg-3">
            {t('library.preview.pdfParsedHint')}
          </div>
          {splitPdfPages(markdown).map((page, index, pages) => (
            <div key={`page-${index}`}>
              {pages.length > 1 ? (
                <div className="px-4 pt-3 font-mono text-micro uppercase tracking-widest text-ink-fg-3">
                  {t('library.preview.pageSep', { n: index + 1 })}
                </div>
              ) : null}
              <pre className="whitespace-pre-wrap px-4 py-3 font-mono text-aux leading-6 text-ink-fg-1">
                {page}
              </pre>
            </div>
          ))}
        </div>
      ) : (
        <>
          <Notice tone="info">{t('library.preview.parsedHint')}</Notice>
          <div className="min-h-0 flex-1 overflow-auto rounded-[var(--r-card)] border border-ink-border bg-ink-2 px-4 py-3 scrollbar-thin">
            {/* F1：解析版也可能带 YAML frontmatter（另存回库再重抽的循环里就会），
                与 markdown 只读预览同口径剥掉、渲成正文上方一行元信息。 */}
            <FrontmatterLine meta={parsed.meta} />
            <TranslatedBody text={parsed.body} />
          </div>
        </>
      )}
    </div>
  )
}
