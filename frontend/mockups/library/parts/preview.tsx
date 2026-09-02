// 文件预览面（design §2.3 头部动作 + §2.4 预览矩阵 + §4 版本）。
//
// 复用的真东西：
//   · `email/TranslatedBody`（Streamdown）—— markdown 只读渲染与「解析视图」共用它，
//     与 chat 是同一个渲染器（design §2.4 office 行明写「经 Streamdown 渲染」）。
//   · `ui/segmented`（解析视图 ⇄ 原件 / 图片 ⇄ 文字）
//   · `ui/button` / `ui/drawer` / `ui/dialog` / `ui/Popmenu` / `ui/separator`
//   · html 预览用 `<iframe srcdoc sandbox="allow-same-origin">`（**无** allow-scripts），
//     即 `EmailBodyFrame` 的同款姿势；这里不 import EmailBodyFrame 本体，因为它绑
//     邮件 detail 形状 + IPC 外链拦截（见 README「副本与仿制」）。
// 假的：图片是内联 SVG（mockup 里没有真文件）、PDF 原件是占位块、所有写入只改本地 state。

import * as React from 'react'
import {
  Clock3,
  ExternalLink,
  FileDown,
  FolderInput,
  FolderOpen,
  Info,
  Pencil,
  RotateCcw,
  Sparkles,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { formatFileSize } from '@shared/format'
import { Button } from '@shared/components/ui/button'
import { Drawer } from '@shared/components/ui/drawer'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { Separator } from '@shared/components/ui/separator'
import { TranslatedBody } from '@shared/components/email/TranslatedBody'

import { HISTORY, type LibFile } from '../fixtures'
import { S } from '../strings'
import {
  changedByLabel,
  creatorLabel,
  displayName,
  KIND_LABEL,
  openWithApp,
  sourceLabel,
  stripFrontmatter,
  toneOf
} from './fileMeta'
import { Notice, Pill, SystemDialogCard } from './kit'
import { TextStatusPill } from './folderView'

/* ── 假图片：内联 SVG，避免 mockup 依赖二进制资源 ─────────────────── */

export const FAKE_IMAGE = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600" viewBox="0 0 960 600">
    <rect width="960" height="600" fill="#f4f1ea"/>
    <g stroke="#2b2b2b" stroke-width="3" fill="none" stroke-linecap="round">
      <path d="M120 120 L120 480"/><path d="M120 200 L360 200"/>
      <path d="M120 300 L360 300"/><path d="M120 400 L360 400"/>
    </g>
    <g font-family="ui-sans-serif,system-ui" fill="#2b2b2b">
      <text x="120" y="90" font-size="34" font-weight="600">L4 个人 agent 节点</text>
      <text x="380" y="210" font-size="26">matters — 事项是第一类对象</text>
      <text x="380" y="310" font-size="26">calendar — 日程三源</text>
      <text x="380" y="410" font-size="26">library — 本次</text>
      <text x="120" y="540" font-size="22" fill="#a03a2a">结论：先做基座，检索留 P3</text>
    </g>
  </svg>`
)}`

/* ── 文件头（C1） ───────────────────────────────────────────────── */

export interface HeaderAction {
  id: string
  label: string
  icon?: React.ReactNode
  onClick(): void
  primary?: boolean
  danger?: boolean
  disabled?: boolean
}

export function FileHeader({
  file,
  actions,
  onChat
}: {
  file: LibFile
  actions: readonly HeaderAction[]
  onChat?(): void
}): React.ReactElement {
  const tone = toneOf(file)
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
            <span>{KIND_LABEL[file.kind]}</span>
            <span className="text-ink-fg-3">·</span>
            <span className="font-mono tabular-nums">
              {new Date(file.mtime).toLocaleString('zh-CN')}
            </span>
            <span className="text-ink-fg-3">·</span>
            <span>创建者 {creatorLabel(file)}</span>
            <Pill tone={file.source === 'mail' ? 'info' : file.source === 'agent' ? 'ai' : 'ink'}>
              {sourceLabel(file)}
            </Pill>
            <TextStatusPill file={file} />
          </div>
          {file.source_ref ? (
            <div
              className="mt-1 truncate font-mono text-micro text-ink-fg-3"
              title={file.source_ref}
            >
              {file.rel_path}
              <span className="mx-1.5">·</span>
              {file.source_ref}
            </div>
          ) : (
            <div className="mt-1 truncate font-mono text-micro text-ink-fg-3">{file.rel_path}</div>
          )}
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
          {onChat ? (
            <Button size="sm" variant="secondary" onClick={onChat}>
              <Sparkles size={13} aria-hidden />
              {S.act.chat}
            </Button>
          ) : null}
        </div>
      </div>
    </header>
  )
}

/* ── 状态横幅（C8） ─────────────────────────────────────────────── */

export function FileStatusBanner({
  file,
  mountUnavailable,
  onRestore
}: {
  file: LibFile
  mountUnavailable?: boolean
  onRestore?(): void
}): React.ReactElement | null {
  if (mountUnavailable) {
    return (
      <div className="px-4 pt-3">
        <Notice tone="warn">{S.mountUnavailable}</Notice>
      </div>
    )
  }
  if (file.status === 'missing') {
    return (
      <div className="px-4 pt-3">
        <Notice tone="warn">
          <span className="font-medium">{S.fileStatus.missing}</span>
          <span className="ml-1.5 text-ink-fg-2">{S.fileStatus.missingHint}</span>
        </Notice>
      </div>
    )
  }
  if (file.status === 'trashed') {
    return (
      <div className="flex items-center gap-2 px-4 pt-3">
        <div className="min-w-0 flex-1">
          <Notice tone="info">
            {S.fileStatus.trashed}
            <span className="ml-1.5 text-ink-fg-2">
              {S.fileStatus.trashedHint(file.trashDaysLeft ?? 30)}
            </span>
          </Notice>
        </div>
        {onRestore ? (
          <Button size="sm" variant="secondary" onClick={onRestore}>
            <RotateCcw size={13} aria-hidden />
            {S.act.restore}
          </Button>
        ) : null}
      </div>
    )
  }
  return null
}

/* ── markdown（C2） ─────────────────────────────────────────────── */

export type MdMode = 'read' | 'edit' | 'conflict'

export function MarkdownPane({
  file,
  mode,
  onModeChange
}: {
  file: LibFile
  mode: MdMode
  onModeChange(next: MdMode): void
}): React.ReactElement {
  const [text, setText] = React.useState(file.body ?? '')
  const [note, setNote] = React.useState('')
  React.useEffect(() => {
    setText(file.body ?? '')
  }, [file.body])

  if (mode === 'read') {
    return (
      <div className="px-5 py-4">
        <TranslatedBody text={stripFrontmatter(file.body ?? '')} />
      </div>
    )
  }

  const editor = (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        className="min-h-[260px] flex-1 resize-y rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 font-mono text-aux leading-6 text-ink-fg outline-none transition-colors duration-fast focus-visible:border-coral/60 focus-visible:ring-2 focus-visible:ring-coral/70"
      />
      <div className="flex items-center gap-2">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={S.changeNotePlaceholder}
          aria-label={S.changeNote}
          className="h-8 min-w-0 flex-1 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2.5 text-aux text-ink-fg outline-none placeholder:text-ink-fg-3 focus-visible:border-coral/60"
        />
        <Button size="sm" variant="ghost" onClick={() => onModeChange('read')}>
          {S.act.cancel}
        </Button>
        <Button size="sm" onClick={() => onModeChange('read')}>
          {S.act.save}
        </Button>
      </div>
    </div>
  )

  if (mode === 'edit') {
    return <div className="flex min-h-0 flex-1 flex-col px-5 py-4">{editor}</div>
  }

  // 保存冲突（409）：提示 + 并排显示当前版本 + 保留我的文本 + 两个出口。
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 py-4">
      <div className="rounded-[var(--r-card)] border border-warn/35 bg-warn/[0.07] px-3 py-2">
        <div className="flex items-center gap-1.5 text-aux font-medium text-warn">
          <TriangleAlert size={14} strokeWidth={2} aria-hidden />
          {S.conflict.title}
        </div>
        <p className="mt-1 text-meta leading-relaxed text-ink-fg-1">{S.conflict.body}</p>
        <p className="mt-0.5 font-mono text-micro text-ink-fg-3">
          {S.conflict.changedBy(changedByLabel('followup-agent'))} · expected_hash{' '}
          {file.content_hash} → 5f3c81ea
        </p>
        <div className="mt-2 flex items-center gap-1.5">
          <Button size="sm" onClick={() => onModeChange('read')}>
            {S.conflict.keepMine}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onModeChange('read')}>
            {S.conflict.discard}
          </Button>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3">
        <div className="flex min-h-0 flex-col">
          <div className="mb-1 text-micro font-mono uppercase tracking-widest text-ink-fg-3">
            我的文本（未保存）
          </div>
          {editor}
        </div>
        <div className="flex min-h-0 flex-col">
          <div className="mb-1 text-micro font-mono uppercase tracking-widest text-ink-fg-3">
            当前版本（磁盘上的）
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 scrollbar-thin">
            <TranslatedBody text={stripFrontmatter(HISTORY[0]!.snapshot)} />
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── html（C3） ─────────────────────────────────────────────────── */

export function HtmlPane({ file }: { file: LibFile }): React.ReactElement {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 py-3">
      <Notice tone="info">{S.preview.htmlSandbox}</Notice>
      <div className="min-h-[320px] flex-1 overflow-hidden rounded-[var(--r-card)] border border-ink-border bg-white">
        {/* 无脚本沙箱：与 EmailBodyFrame 同款（sandbox 不含 allow-scripts）。 */}
        <iframe
          title={file.filename}
          sandbox="allow-same-origin"
          className="h-full min-h-[320px] w-full"
          srcDoc={`<!doctype html><meta charset="utf-8"><style>body{font:14px/1.7 -apple-system,system-ui,sans-serif;color:#1a1d22;margin:20px}a{color:#c14a30}h1{font-size:22px}h2{font-size:17px;margin-top:20px}</style>${file.body ?? ''}`}
        />
      </div>
    </div>
  )
}

/* ── 图片（C4） ─────────────────────────────────────────────────── */

export function ImagePane({
  file,
  onLightbox
}: {
  file: LibFile
  onLightbox(): void
}): React.ReactElement {
  const hasOcr = file.text_status === 'extracted' && Boolean(file.body)
  const [tab, setTab] = React.useState<'image' | 'text'>('image')

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3">
      {hasOcr ? (
        <div className="flex items-center gap-2">
          <SegmentedControl
            value={tab}
            onChange={setTab}
            ariaLabel="图片视图"
            options={[
              { value: 'image', label: S.preview.image },
              { value: 'text', label: S.preview.text }
            ]}
          />
          <Pill tone="info">{S.preview.ocrBadge}</Pill>
        </div>
      ) : null}
      {tab === 'image' ? (
        <button
          type="button"
          onClick={onLightbox}
          className="grid min-h-0 flex-1 place-items-center overflow-hidden rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-3"
        >
          <img src={FAKE_IMAGE} alt={file.filename} className="max-h-[420px] max-w-full rounded" />
        </button>
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-[var(--r-card)] border border-ink-border bg-ink-2 px-3 py-2 font-mono text-aux leading-6 text-ink-fg-1 scrollbar-thin">
          {file.body}
        </pre>
      )}
    </div>
  )
}

export function Lightbox({ onClose }: { onClose(): void }): React.ReactElement {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-8"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <img src={FAKE_IMAGE} alt="" className="max-h-full max-w-full rounded-lg" />
      <button
        type="button"
        aria-label={S.act.close}
        onClick={onClose}
        className="absolute right-5 top-5 grid size-8 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20"
      >
        <X size={16} aria-hidden />
      </button>
    </div>
  )
}

/* ── PDF（C5） ──────────────────────────────────────────────────── */

export function PdfPane({
  file,
  originalAvailable
}: {
  file: LibFile
  originalAvailable: boolean
}): React.ReactElement {
  const [tab, setTab] = React.useState<'parsed' | 'original'>('parsed')
  React.useEffect(() => {
    if (!originalAvailable) setTab('parsed')
  }, [originalAvailable])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        {originalAvailable ? (
          <SegmentedControl
            value={tab}
            onChange={setTab}
            ariaLabel="PDF 视图"
            options={[
              { value: 'parsed', label: S.preview.parsed },
              { value: 'original', label: S.preview.original }
            ]}
          />
        ) : null}
        <span className="font-mono text-micro text-ink-fg-3">
          extractor {file.extractor ?? 'pypdf'}
          {file.truncated ? ' · 已截断（256 KB 上限）' : ''}
        </span>
        {!originalAvailable ? (
          <Button size="sm" variant="secondary" className="ml-auto">
            <ExternalLink size={13} aria-hidden />
            {S.act.openWith('系统阅读器')}
          </Button>
        ) : null}
      </div>

      {!originalAvailable ? <Notice tone="warn">{S.preview.originalUnavailable}</Notice> : null}

      {tab === 'parsed' ? (
        <div className="min-h-0 flex-1 overflow-auto rounded-[var(--r-card)] border border-ink-border bg-ink-2 scrollbar-thin">
          <div className="border-b border-ink-border-soft px-3 py-1.5 text-meta text-ink-fg-3">
            {S.preview.pdfParsedHint}
          </div>
          <pre className="whitespace-pre-wrap px-4 py-3 font-mono text-aux leading-6 text-ink-fg-1">
            {file.body}
          </pre>
        </div>
      ) : (
        <div className="grid min-h-[320px] flex-1 place-items-center rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-6 text-center">
          <div>
            <div className="text-aux text-ink-fg-1">
              PDF 原件内嵌（P1 内 PoC，design §2.4 / L10）
            </div>
            <div className="mt-1 max-w-md text-meta leading-relaxed text-ink-fg-3">
              顺序：iframe → loopback{' '}
              <code className="font-mono">/api/library/file/&#123;id&#125;/inline</code> + CSP
              frame-src + plugins:true → 独立窗口 → pdf.js。PoC 不通则本页只剩解析视图。
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ── office / csv（C6） ─────────────────────────────────────────── */

export function OfficePane({
  file,
  onRetry
}: {
  file: LibFile
  onRetry?(): void
}): React.ReactElement {
  const app = openWithApp(file) ?? '系统应用'

  if (file.text_status === 'pending') {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3">
        <div className="grid min-h-[240px] flex-1 place-items-center rounded-[var(--r-card)] border border-ink-border bg-ink-2">
          <div className="text-center">
            <div className="text-aux text-ink-fg-1">{S.preview.pending}</div>
            <div className="mt-1 text-meta text-ink-fg-3">
              打开就会触发抽取；抽好后这里换成解析视图。
            </div>
            <Button size="sm" variant="secondary" className="mt-3">
              <ExternalLink size={13} aria-hidden />
              {S.act.openWith(app)}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (file.text_status === 'failed' || file.text_status === 'unsupported') {
    const failed = file.text_status === 'failed'
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3">
        <Notice tone={failed ? 'fail' : 'info'}>
          {failed ? S.preview.failed : S.preview.unsupported}
          {failed ? '（anydoc 与原生 extractor 都没成功）' : ''}
        </Notice>
        <div className="grid min-h-[220px] flex-1 place-items-center rounded-[var(--r-card)] border border-ink-border bg-ink-2">
          <div className="flex items-center gap-2">
            {failed && onRetry ? (
              <Button size="sm" variant="secondary" onClick={onRetry}>
                <RotateCcw size={13} aria-hidden />
                {S.act.retry}
              </Button>
            ) : null}
            <Button size="sm" variant="secondary">
              <ExternalLink size={13} aria-hidden />
              {S.act.openWith(app)}
            </Button>
            <Button size="sm" variant="ghost">
              <FolderOpen size={13} aria-hidden />
              {S.act.reveal}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          value="parsed"
          onChange={() => undefined}
          ariaLabel="视图"
          options={[{ value: 'parsed', label: S.preview.parsed }]}
        />
        <span className="font-mono text-micro text-ink-fg-3">
          extractor {file.extractor ?? 'anydoc'}
        </span>
        <Button size="sm" variant="secondary" className="ml-auto">
          <ExternalLink size={13} aria-hidden />
          {S.preview.original} · {S.act.openWith(app)}
        </Button>
      </div>
      <Notice tone="info">{S.preview.parsedHint}</Notice>
      <div className="min-h-0 flex-1 overflow-auto rounded-[var(--r-card)] border border-ink-border bg-ink-2 px-4 py-3 scrollbar-thin">
        <TranslatedBody text={file.body ?? ''} />
      </div>
    </div>
  )
}

/* ── video / 大文件 / other（C7） ───────────────────────────────── */

export function OtherPane({ file }: { file: LibFile }): React.ReactElement {
  const app = openWithApp(file) ?? '系统应用'
  const tone = toneOf(file)
  const I = tone.Icon
  return (
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
          {KIND_LABEL[file.kind]}
        </div>
        <div className="mt-1 text-meta text-ink-fg-3">{S.preview.noInline}</div>
        <div className="mt-3 flex items-center justify-center gap-1.5">
          <Button size="sm" variant="secondary">
            <ExternalLink size={13} aria-hidden />
            {S.act.openWith(app)}
          </Button>
          <Button size="sm" variant="ghost">
            <FolderOpen size={13} aria-hidden />
            {S.act.reveal}
          </Button>
        </div>
      </div>
    </div>
  )
}

/* ── 历史（C9） ─────────────────────────────────────────────────── */

export function HistoryDrawer({
  open,
  onOpenChange,
  file
}: {
  open: boolean
  onOpenChange(v: boolean): void
  file: LibFile
}): React.ReactElement {
  const [snapshotId, setSnapshotId] = React.useState<number | null>(null)
  const [confirmId, setConfirmId] = React.useState<number | null>(null)
  const snapshot = HISTORY.find((h) => h.id === snapshotId)

  return (
    <Drawer open={open} onOpenChange={onOpenChange} ariaLabel="版本历史" width={560}>
      <div className="flex h-full flex-col bg-ink-1">
        <div className="flex h-[41px] shrink-0 items-center gap-2 border-b border-ink-border px-4">
          <Clock3 size={14} strokeWidth={1.9} aria-hidden className="text-ink-fg-2" />
          <span className="flex-1 truncate text-body font-medium text-ink-fg">
            {S.act.history} · {file.filename}
          </span>
          <button
            type="button"
            aria-label={S.act.close}
            onClick={() => onOpenChange(false)}
            className="grid size-7 place-items-center rounded text-ink-fg-3 hover:bg-ink-3 hover:text-ink-fg"
          >
            <X size={14} aria-hidden />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          <div className="px-4 py-2 text-meta text-ink-fg-3">
            每文件保留最近 50 条快照；全库快照总量 20 MB，超出按最旧裁（design §1.2）。
          </div>
          {HISTORY.map((h) => (
            <div key={h.id} className="border-b border-ink-border-soft px-4 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-meta tabular-nums text-ink-fg-2">
                  {new Date(h.created_at).toLocaleString('zh-CN')}
                </span>
                <Pill
                  tone={
                    h.changed_by === 'user' ? 'ink' : h.changed_by === 'external' ? 'warn' : 'ai'
                  }
                >
                  {changedByLabel(h.changed_by)}
                </Pill>
                <span className="font-mono text-micro tabular-nums text-ink-fg-3">
                  {formatFileSize(h.size_bytes)}
                  {h.delta !== 0 ? (
                    <span className={h.delta > 0 ? 'ml-1 text-ok' : 'ml-1 text-fail'}>
                      {h.delta > 0 ? '+' : ''}
                      {h.delta} B
                    </span>
                  ) : null}
                </span>
                <span className="ml-auto flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSnapshotId(snapshotId === h.id ? null : h.id)}
                  >
                    {S.act.viewSnapshot}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setConfirmId(h.id)}>
                    {S.act.rollback}
                  </Button>
                </span>
              </div>
              <div className="mt-0.5 text-meta text-ink-fg-1">
                {h.change_note ?? (
                  <span className="text-ink-fg-3">
                    （无变更说明 —— 应用之外的改动，打开时对账补记）
                  </span>
                )}
              </div>
              {snapshotId === h.id ? (
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 font-mono text-micro leading-5 text-ink-fg-1 scrollbar-thin">
                  {snapshot?.snapshot || '（空文件）'}
                </pre>
              ) : null}
            </div>
          ))}
        </div>

        {confirmId != null ? (
          <div className="shrink-0 border-t border-ink-border bg-ink-2 px-4 py-3">
            <div className="flex items-start gap-2">
              <Info size={14} className="mt-0.5 shrink-0 text-info" aria-hidden />
              <div className="min-w-0 flex-1 text-meta leading-relaxed text-ink-fg-1">
                回滚 = 用这份快照做一次**普通写入**（走同一道 CAS 校验，也会新记一条历史）。
                当前内容不会丢。
              </div>
            </div>
            <div className="mt-2 flex justify-end gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setConfirmId(null)}>
                {S.act.cancel}
              </Button>
              <Button size="sm" onClick={() => setConfirmId(null)}>
                {S.act.confirm}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Drawer>
  )
}

/* ── 关联的事项 + 来源跳转（C10） ───────────────────────────────── */

export function RelatedBlock({ file }: { file: LibFile }): React.ReactElement | null {
  const hasMatters = (file.matters?.length ?? 0) > 0
  const hasSource = file.source === 'mail' || file.source === 'chat'
  if (!hasMatters && !hasSource) return null
  return (
    <div className="border-t border-ink-border px-4 py-3">
      {hasMatters ? (
        <div className="mb-2">
          <div className="mb-1 text-micro font-mono uppercase tracking-widest text-ink-fg-3">
            {S.relatedMatters}
            <span className="ml-1.5 normal-case tracking-normal text-ink-fg-3">
              （反查 resource → matter_resource；design §9.2 标 P2 可选）
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {file.matters?.map((m) => (
              <button
                key={m}
                type="button"
                className="rounded-full border border-ink-border bg-ink-2 px-2.5 py-1 text-meta text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {hasSource ? (
        <Button size="sm" variant="secondary">
          <ExternalLink size={13} aria-hidden />
          {file.source === 'mail' ? S.sourceJump.mail : S.sourceJump.chat}
        </Button>
      ) : null}
    </div>
  )
}

/* ── 文件夹选择对话框的内容（C11 / C12 / G2 共用） ───────────────── */

export const PICKER_TARGETS: readonly string[] = [
  'my-docs',
  'my-docs/合同',
  'my-docs/产品',
  'my-docs/产品/定价',
  'agent-docs',
  'agent-docs/notes',
  'agent-docs/sources',
  'agent-docs/reports',
  '@工作区',
  '@工作区/2026-Q3',
  '@工作区/招投标'
]

export function FolderPicker({
  value,
  onChange,
  disabledPrefixes = []
}: {
  value: string
  onChange(v: string): void
  disabledPrefixes?: readonly string[]
}): React.ReactElement {
  return (
    <div className="max-h-64 overflow-y-auto rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 p-1 scrollbar-thin">
      {PICKER_TARGETS.map((p) => {
        const disabled = disabledPrefixes.some((d) => p === d || p.startsWith(`${d}/`))
        const depth = p.split('/').length - 1
        return (
          <button
            key={p}
            type="button"
            disabled={disabled}
            onClick={() => onChange(p)}
            style={{ paddingLeft: 8 + depth * 16 }}
            className={cn(
              'row relative flex h-[28px] w-full items-center gap-2 rounded-[var(--r-ctl)] pr-2 text-left text-aux transition-colors duration-fast',
              value === p
                ? 'row-selected acc-select font-medium text-ink-fg'
                : 'text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg',
              disabled && 'cursor-not-allowed opacity-40'
            )}
          >
            <FolderInput
              size={12}
              strokeWidth={1.9}
              aria-hidden
              className="shrink-0 text-ink-fg-3"
            />
            <span className="min-w-0 flex-1 truncate">{p.split('/').pop()}</span>
            <span className="shrink-0 font-mono text-micro text-ink-fg-3">{p}</span>
          </button>
        )
      })}
    </div>
  )
}

/* ── 导出常用的图标，供 scenes 组装头部动作 ───────────────────── */
export const ActIcon = {
  edit: <Pencil size={13} aria-hidden />,
  open: <ExternalLink size={13} aria-hidden />,
  reveal: <FolderOpen size={13} aria-hidden />,
  keep: <FileDown size={13} aria-hidden />,
  move: <FolderInput size={13} aria-hidden />,
  del: <Trash2 size={13} aria-hidden />,
  history: <Clock3 size={13} aria-hidden />
}

export { Separator as PreviewSeparator, SystemDialogCard }
