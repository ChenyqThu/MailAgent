// AttachmentTray — compose 附件区: 汇总行 + 缩略图卡片 grid + 空态 dropzone。
// 纯展示组件 (T3 lane) — 不接线 ComposePanel、不碰上传逻辑本身 (T5 接线时把现有
// `attachList` 状态 (ComposePanel.tsx `ComposeAttachmentChip`) 映射成 AttachmentTrayItem)。
//
// 数据模型对齐现有 attachList 状态形状 (localId/filename/size/status), 只是决定
// staged {stage_id} / 库内 {attachment_id} 走哪条 payload refs 的字段 (stageId/
// attachmentId) 是上传管线内部关心的, 纯展示层不需要, 故未带入; T5 映射时按需附加。
//
// 设计参考: docs/plans/compose-optimization-2026-07/design/attachments.jsx +
// design/compose.css `.att-*` 段。生产版: 类名用 Tailwind + v3 token (--r-ctl/--r-card),
// 图标换用项目既有 lucide-react 体系 (design demo 手写 SVG 集不引入)。
//
// i18n: T3 落地时缺口已由 T5 接线补齐 — 文案走 `compose.attachTray.*` (summary/add/
// uploading/uploadFailed/dropzoneHint) + 复用既有 `compose.attachmentRemove`,
// zh-CN / en-US 两份 locales 均有 key (ICU 单花括号插值)。

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronRight,
  File as FileIcon,
  FileArchive,
  FileCode,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Paperclip,
  Plus,
  X
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { formatFileSize } from '@shared/format'

/** 附件类型分桶 — 按扩展名判定, 参考 design/attachments.jsx `kindFromName`。 */
export type AttachmentKind = 'pdf' | 'sheet' | 'doc' | 'zip' | 'image' | 'text' | 'file'

/** 上传态。与 ComposePanel.tsx `ComposeAttachmentChip.status` 同源, 不发明新枚举。 */
export type AttachmentTrayItemStatus = 'uploading' | 'done' | 'error'

/** 展示层附件条目。字段名对齐 `ComposeAttachmentChip` (localId/filename/size/status),
 *  但不带 stageId/attachmentId — 那是上传/发送管线内部字段, 纯展示不需要。 */
export interface AttachmentTrayItem {
  /** 稳定本地 key, 对齐 ComposeAttachmentChip.localId。 */
  localId: number
  filename: string
  size: number | null
  status: AttachmentTrayItemStatus
  /** 图片缩略预览 URL (staged 文件用 `URL.createObjectURL(file)`; 库内附件若有
   *  已解出的预览通道由调用方传入, 没有则回退类型图标 — 不在此组件内新造读取接口)。
   *  非图片 kind 忽略此字段。 */
  previewUrl?: string
  /** 0-100 上传进度。现有生产上传管线只有 uploading/done/error 布尔态、无百分比 —
   *  该字段留给未来接真实进度用; status='uploading' 且此字段缺省时渲染不定态进度条。 */
  progress?: number
}

export interface AttachmentTrayProps {
  items: readonly AttachmentTrayItem[]
  /** 顶部「添加」按钮点击回调 — 由父层决定触发文件选择 (通常是隐藏 input[type=file].click())。 */
  onAdd: () => void
  /** 卡片 hover 删除钮回调, 传 item.localId。 */
  onRemove: (localId: number) => void
  className?: string
}

/** grid 卡片最小列宽 (auto-fill 轨道下限)。 */
const ATTACHMENT_CARD_MIN_WIDTH = 148
/** grid 行列间距 (Tailwind gap-2.5)。 */
const ATTACHMENT_GRID_GAP = 10
/** 单卡高度: 78px 缩略区 + 文件名行 + 大小行 + 1px 上下描边 ≈ 131px。
 *  只用于算展开态的高度上限, 与真实渲染差几 px 不影响"限高+内部滚动"的语义。 */
const ATTACHMENT_CARD_HEIGHT = 131
/** 展开态 grid 高度上限 = 两行卡片 + 一个行间距; 超出由 grid 自己内部滚动,
 *  附件再多也不会把正文/引用挤出可视区。 */
const ATTACHMENT_GRID_MAX_HEIGHT = ATTACHMENT_CARD_HEIGHT * 2 + ATTACHMENT_GRID_GAP
/** 附件数 ≤ 此值默认展开 (1-2 个只占一行, 直接看到缩略图比数字摘要有用);
 *  更多则默认折叠成一行摘要, 优先把可视区留给正文。 */
const AUTO_EXPAND_MAX_ITEMS = 2

/** 图标 + 角标色元数据。色值暂沿用 design KIND_META 的 hex —— TODO: token 化
 *  (design/compose-handoff.md §7: 「附件角标色 KIND_META 是例外, 可后续 token 化」)。 */
/* eslint-disable mailagent/no-raw-hex -- KIND_META 角标色是契约 D4 明示的暂存例外 (附件类型内容色, 非 theme token), 待后续 token 化。 */
const KIND_META: Record<AttachmentKind, { Icon: typeof FileText; color: string }> = {
  pdf: { Icon: FileText, color: '#E5654B' },
  sheet: { Icon: FileSpreadsheet, color: '#5DBA8C' },
  doc: { Icon: FileText, color: '#4A78E5' },
  zip: { Icon: FileArchive, color: '#E59B4A' },
  image: { Icon: ImageIcon, color: '#9C7AE0' },
  text: { Icon: FileCode, color: '#7A8090' },
  file: { Icon: FileIcon, color: '#7A8090' }
}
/* eslint-enable mailagent/no-raw-hex */

/** 按扩展名判定附件类型桶 — 逐字对齐 design/attachments.jsx `kindFromName`。 */
// eslint-disable-next-line react-refresh/only-export-components -- 附件类型判定纯函数与展示组件同源 (ComposePanel 接线复用: staged 图片 previewUrl 判定), 拆文件反而割裂 KIND_META 语义。
export function kindFromName(name: string): AttachmentKind {
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  if (ext === 'pdf') return 'pdf'
  if (['xls', 'xlsx', 'csv', 'numbers'].includes(ext)) return 'sheet'
  if (['doc', 'docx', 'pages', 'ppt', 'pptx', 'key'].includes(ext)) return 'doc'
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'zip'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic', 'bmp'].includes(ext)) return 'image'
  if (['txt', 'md', 'log', 'json'].includes(ext)) return 'text'
  return 'file'
}

/** 扩展名角标文案 — 大写、截取前 4 位 (对齐 design `extLabel`)。 */
function extLabel(name: string): string {
  return (name.split('.').pop() ?? '').toUpperCase().slice(0, 4)
}

function AttachCard({
  item,
  onRemove
}: {
  item: AttachmentTrayItem
  onRemove: (localId: number) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const kind = kindFromName(item.filename)
  const meta = KIND_META[kind]
  const Icon = meta.Icon
  const uploading = item.status === 'uploading'
  const pct = uploading ? (item.progress ?? null) : null

  return (
    <div
      className={cn(
        'group relative rounded-[var(--r-card)] border overflow-hidden transition-colors duration-fast',
        item.status === 'error'
          ? 'border-fail/40 bg-fail/5'
          : 'border-ink-border-soft bg-ink-fg/[0.02] hover:border-ink-border'
      )}
      title={
        item.status === 'error'
          ? `${item.filename} · ${t('compose.attachTray.uploadFailed')}`
          : item.filename
      }
      data-kind={kind}
      data-status={item.status}
    >
      <div className="relative h-[78px] grid place-items-center bg-ink-fg/[0.03] overflow-hidden">
        {kind === 'image' && item.previewUrl ? (
          <img src={item.previewUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <span
            className="flex flex-col items-center justify-center gap-1 w-[52px] h-[52px] rounded-[var(--r-ctl)]"
            style={{
              color: meta.color,
              background: `color-mix(in srgb, ${meta.color} 14%, transparent)`
            }}
          >
            <Icon size={22} strokeWidth={1.8} />
            <span
              className="text-[9px] font-bold font-mono tracking-wide"
              style={{ color: meta.color }}
            >
              {extLabel(item.filename)}
            </span>
          </span>
        )}

        <button
          type="button"
          aria-label={t('compose.attachmentRemove', { name: item.filename })}
          onClick={() => onRemove(item.localId)}
          className={cn(
            'absolute top-1.5 right-1.5 w-5 h-5 rounded-full grid place-items-center',
            'bg-[rgb(10_12_18_/_0.55)] text-white opacity-0 group-hover:opacity-100',
            'hover:bg-fail transition-opacity duration-fast'
          )}
        >
          <X size={12} strokeWidth={2.6} />
        </button>

        {uploading && (
          <div
            className="absolute left-0 right-0 bottom-0 h-[3px] bg-ink-fg/[0.12]"
            role="progressbar"
            aria-label={`${item.filename} · ${t('compose.attachTray.uploading')}`}
            {...(pct != null
              ? { 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }
              : {})}
          >
            <span
              className={cn('block h-full bg-coral/100', pct == null && 'w-2/5 animate-pulse')}
              style={pct != null ? { width: `${pct}%` } : undefined}
            />
          </div>
        )}
      </div>

      <div className="px-[9px] pt-[7px] pb-0.5 text-aux font-medium whitespace-nowrap overflow-hidden text-ellipsis text-ink-fg">
        {item.filename}
      </div>
      <div className="px-[9px] pb-2 text-meta font-mono text-ink-fg-2">
        {item.size != null ? formatFileSize(item.size) : ''}
        {uploading ? ` · ${t('compose.attachTray.uploading')}` : ''}
      </div>
    </div>
  )
}

/** 汇总行 + 缩略图卡片 grid。空数组渲染 null (空态由父层决定是否套 AttachmentDropzone)。 */
export function AttachmentTray({
  items,
  onAdd,
  onRemove,
  className
}: AttachmentTrayProps): React.ReactElement | null {
  const { t } = useTranslation()
  const totalSize = useMemo(() => items.reduce((sum, it) => sum + (it.size ?? 0), 0), [items])
  // 有上传中/失败的条目 = 用户刚挑了文件 → 展开: 进度条和失败态藏在折叠摘要后面
  // 等于没有。draft-edit / forward 异步 hydrate 出来的原附件一进来就是 done,
  // 不触发这条, 仍按条数走默认 (多附件默认折叠, 把可视区留给正文)。
  const hasPendingItem = items.some((it) => it.status !== 'done')
  const [isExpanded, setExpanded] = useState(
    hasPendingItem || items.length <= AUTO_EXPAND_MAX_ITEMS
  )
  // 上传态**粘住**展开: 传完就自动收起会让刚加的附件在眼前消失。渲染期调整自己的
  // state 是 React 官方的「上游变化时同步 state」写法 (立即重跑本组件且不落屏),
  // 比 useEffect 少一帧, 也不踩 set-state-in-effect。
  const [sawPendingItem, setSawPendingItem] = useState(hasPendingItem)
  if (hasPendingItem !== sawPendingItem) {
    setSawPendingItem(hasPendingItem)
    if (hasPendingItem) setExpanded(true)
  }
  if (items.length === 0) return null

  return (
    <div className={cn('px-[22px] py-2', className)}>
      <div className="flex items-center justify-between">
        {/* 摘要行即折叠开关 (chevron + N 个附件 · 总大小), 与同面板引用块的
            disclosure 同构 —— 折叠态只剩这一行, 正文永远有空间。 */}
        <button
          type="button"
          aria-expanded={isExpanded}
          onClick={() => setExpanded(!isExpanded)}
          className="inline-flex items-center gap-[7px] text-meta font-mono text-ink-fg-2 py-[5px] pr-2 rounded-[var(--r-ctl)] hover:text-ink-fg transition-colors duration-fast"
        >
          <ChevronRight
            size={12}
            strokeWidth={2}
            className={`transition-transform duration-fast ${isExpanded ? 'rotate-90' : ''}`}
          />
          <Paperclip size={13} strokeWidth={2} />
          {t('compose.attachTray.summary', { n: items.length, size: formatFileSize(totalSize) })}
        </button>
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex items-center gap-[5px] text-meta text-coral px-2.5 py-[5px] rounded-[var(--r-ctl)] hover:bg-coral/10 transition-colors duration-fast"
        >
          <Plus size={13} strokeWidth={2} />
          {t('compose.attachTray.add')}
        </button>
      </div>
      {isExpanded && (
        <div
          data-testid="attachment-tray-grid"
          className="grid gap-2.5 mt-2.5 overflow-y-auto scrollbar-thin"
          style={{
            gridTemplateColumns: `repeat(auto-fill, minmax(${ATTACHMENT_CARD_MIN_WIDTH}px, 1fr))`,
            maxHeight: ATTACHMENT_GRID_MAX_HEIGHT
          }}
        >
          {items.map((it) => (
            <AttachCard key={it.localId} item={it} onRemove={onRemove} />
          ))}
        </div>
      )}
    </div>
  )
}

// (原空态 AttachmentDropzone 已移除 — dogfood 反馈: 顶部已有附件入口且整窗可
//  拖拽落文件, 底部空态占位冗余。)
