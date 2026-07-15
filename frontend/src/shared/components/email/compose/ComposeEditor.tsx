// Compose rich-text editor — TipTap v3 + classic 分组格式工具栏（epic T2）。
//
// 工具栏分组（对齐 design/editor.jsx 的 classic Toolbar）：
//   [正文/H1-3 下拉][字体][字号] | [B I U S][文字颜色][高亮] | [列表×2][引用][代码块]
//   | [链接][行内代码][图片][分割线][@] … [撤销][重做]
// 弹层：颜色/高亮 = 设计稿 swatch 色板（radix Popover, glass-pop）；链接/图片 =
// 内联输入框（Electron renderer 禁 window.prompt）。
//
// 兼容纪律（契约 D4）：ComposeEditor / ComposeFormatToolbar 导出名与 props 不变，
// ComposePanel 未切新装配（editor-extensions.ts 的 buildComposeExtensions）前也可
// 正常工作 —— 高亮按钮在无 Highlight 扩展的旧装配上回退 textStyle backgroundColor。
// The parent owns the Editor instance (so it can read getHTML() on send/save).

import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EditorContent, useEditorState, type Editor } from '@tiptap/react'
import {
  AtSign,
  Ban,
  Baseline,
  Bold,
  Check,
  ChevronDown,
  Code,
  Highlighter,
  ImagePlus,
  ImageUp,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  Redo2,
  SquareCode,
  Strikethrough,
  TextQuote,
  Underline as UnderlineIcon,
  Undo2,
  Unlink
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { toastError } from '@shared/state/toast'
import { Popover, PopoverContent, PopoverTrigger } from '@shared/components/ui/popover'

// 内联图片(data URL 直嵌正文)的单张上限 — data URL 会把字节膨胀 ~1.37×,
// 大图该走附件而不是正文内联。与粘贴图片同一下游 (data: 直存 HTML)。
const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024

function FmtBtn({
  icon,
  label,
  active,
  disabled,
  onClick
}: {
  icon: React.ReactNode
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      // onMouseDown preventDefault keeps the editor selection from being
      // stolen by the toolbar button focus.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        'folder-editor-btn',
        active && 'is-on',
        disabled && 'opacity-40 pointer-events-none'
      )}
    >
      {icon}
    </button>
  )
}

/** 分组分隔线。 */
function FmtSep(): React.ReactElement {
  return <span className="w-px h-5 bg-ink-border-soft mx-1" aria-hidden />
}

// Outlook 式预设色板（dogfood 反馈: 原设计稿 6 色太少）—— 内容色常量，非 UI
// token（写进邮件正文 inline style 的颜色值）。6 hue 列 × 浅→深 4 行 + 末行
// 中性色（清除格 + 灰阶）。
/* eslint-disable mailagent/no-raw-hex -- swatch 色板是邮件内容色常量（随正文发出），非 theme token。 */
const TEXT_COLORS: readonly string[] = [
  // 蓝        绿        黄        橙        红        紫  (浅 → 深)
  '#4DA6F0',
  '#5EC26A',
  '#F2D440',
  '#F2913D',
  '#EE6B60',
  '#B76BE0',
  '#1667C2',
  '#188A3C',
  '#D4B016',
  '#DB6B10',
  '#CC2F24',
  '#8833B8',
  '#10498C',
  '#0F6129',
  '#9C8010',
  '#A34F0C',
  '#941F17',
  '#622585',
  '#0A2B57',
  '#093D1B',
  '#6B570B',
  '#6E3508',
  '#611410',
  '#3F1857'
]
/** 末行中性色（首格是「清除」，随后 5 格）。 */
const TEXT_NEUTRALS: readonly string[] = ['#D9D9D9', '#A6A6A6', '#737373', '#404040', '#000000']
const HL_COLORS: readonly string[] = [
  // 黄        绿        蓝        粉        橙        青  (淡 → 艳)
  '#FCE7A2',
  '#C6EBCB',
  '#C9E0FB',
  '#F7CFE0',
  '#FBDCB6',
  '#C9EFEF',
  '#F8D866',
  '#9FDCAA',
  '#9CC7F7',
  '#F2A8C8',
  '#F7BE7E',
  '#9FE3E3',
  '#F5E342',
  '#6FD383',
  '#6FAEF2',
  '#EE7FB2',
  '#F5A44A',
  '#5ED3D3'
]
const HL_NEUTRALS: readonly string[] = ['#FFFFFF', '#EBEBEB', '#D6D6D6', '#BFBFBF', '#A8A8A8']
/* eslint-enable mailagent/no-raw-hex */

/** swatch 色板按钮：6 列网格（hue 列 × 浅→深行）+ 末行「清除」格 + 中性色；
 *  「更多颜色」触发原生取色器。取色 input 挂在 Popover 外 —— 系统取色面板
 *  打开会让 popover 关闭, input 若在 PopoverContent 里会随之卸载, onChange
 *  永远收不到（dogfood「更多颜色点击没反应」的根因）。 */
function SwatchPopoverButton({
  icon,
  title,
  colors,
  neutrals,
  current,
  onPick,
  clearTitle,
  moreLabel
}: {
  icon: React.ReactNode
  title: string
  /** 主网格色板（6 的倍数, 按 hue 列排布）。 */
  colors: readonly string[]
  /** 末行中性色（跟在「清除」格后, ≤5 个）。 */
  neutrals: readonly string[]
  /** 当前应用色（'' = 未设置）。 */
  current: string
  /** null = 清除。 */
  onPick: (color: string | null) => void
  clearTitle: string
  moreLabel: string
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const moreInputRef = useRef<HTMLInputElement>(null)
  const pick = (c: string | null): void => {
    onPick(c)
    setOpen(false)
  }
  const swatch = (c: string): React.ReactElement => (
    <button
      key={c}
      type="button"
      title={c}
      aria-label={c}
      onClick={() => pick(c)}
      className={cn(
        'size-5 rounded-full border transition-transform duration-fast hover:scale-110',
        current.toLowerCase() === c.toLowerCase()
          ? 'border-coral ring-1 ring-coral'
          : 'border-ink-border/40'
      )}
      style={{ background: c }}
    />
  )
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            title={title}
            aria-label={title}
            onMouseDown={(e) => e.preventDefault()}
            className={cn('folder-editor-btn', current && 'is-on')}
          >
            {icon}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={6}
          onMouseDown={(e) => e.preventDefault()}
          className="w-auto p-2"
        >
          <div className="grid grid-cols-6 gap-1.5">
            {colors.map(swatch)}
            <button
              type="button"
              title={clearTitle}
              aria-label={clearTitle}
              onClick={() => pick(null)}
              className="size-5 rounded-full border border-ink-border/60 grid place-items-center text-ink-fg-3 transition-transform duration-fast hover:scale-110"
            >
              <Ban size={13} strokeWidth={1.8} />
            </button>
            {neutrals.map(swatch)}
          </div>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              moreInputRef.current?.click()
            }}
            className="mt-2 flex w-full cursor-pointer items-center justify-center rounded-md border border-ink-border/60 py-1 text-meta text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3"
          >
            {moreLabel}
          </button>
        </PopoverContent>
      </Popover>
      {/* 原生取色器载体 — 常驻挂载 (见组件头注释), sr-only 不可见但可编程 click。 */}
      <input
        ref={moreInputRef}
        type="color"
        tabIndex={-1}
        aria-hidden="true"
        defaultValue="#000000"
        className="sr-only"
        onChange={(e) => onPick(e.target.value)}
      />
    </>
  )
}

/** 下拉选项按钮: radix Popover 选项列表 (取代原生 <select> — 它的系统下拉在 Electron modal
 *  里关闭时会误关 backdrop, dogfood 反馈)。当前值显示在按钮上。 */
function OptionPopoverButton({
  title,
  currentLabel,
  options,
  value,
  onSelect
}: {
  title: string
  currentLabel: string
  options: ReadonlyArray<{ value: string; label: string }>
  value: string
  onSelect: (value: string) => void
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={title}
          aria-label={title}
          onMouseDown={(e) => e.preventDefault()}
          className="flex h-7 max-w-[92px] items-center gap-1 rounded-md border border-ink-border/60 bg-ink-2/50 px-1.5 text-[11px] text-ink-fg-2 transition-colors duration-fast hover:bg-ink-2"
        >
          <span className="truncate">{currentLabel}</span>
          <ChevronDown size={12} strokeWidth={2} className="shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        onMouseDown={(e) => e.preventDefault()}
        className="w-40 p-1"
        role="listbox"
        aria-label={title}
      >
        {options.map((o) => (
          <button
            key={o.value || 'default'}
            type="button"
            role="option"
            aria-selected={o.value === value}
            onClick={() => {
              onSelect(o.value)
              setOpen(false)
            }}
            className={cn(
              'flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-aux transition-colors duration-fast hover:bg-ink-3',
              o.value === value ? 'text-coral' : 'text-ink-fg-1'
            )}
          >
            <span className="truncate">{o.label}</span>
            {o.value === value && <Check size={13} strokeWidth={2.5} className="shrink-0" />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

/** 内联输入弹框（链接/图片共用）— 浮在工具栏上方，Enter 应用 / Esc 关闭。 */
function InlineInputBox({
  value,
  placeholder,
  applyLabel,
  onChange,
  onApply,
  onClose,
  extra
}: {
  value: string
  placeholder: string
  applyLabel: string
  onChange: (v: string) => void
  onApply: () => void
  onClose: () => void
  extra?: React.ReactNode
}): React.ReactElement {
  return (
    <div className="absolute bottom-full left-3 mb-1.5 z-20 flex items-center gap-1 rounded-lg border border-ink-border bg-ink-1 p-1.5 shadow-md">
      <input
        autoFocus
        type="url"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // stopPropagation: 否则 Esc/Enter 冒泡到 ComposePanel 的 window 级 keydown
          // (Escape 会关掉整个撰写框) —— codex review MEDIUM。
          if (e.key === 'Enter') {
            e.preventDefault()
            e.stopPropagation()
            onApply()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          }
        }}
        className="h-7 w-60 rounded-md bg-ink-2/60 border border-ink-border/60 px-2 text-xs text-ink-fg-1 focus:outline-none focus:border-accent/60"
      />
      <button
        type="button"
        title={applyLabel}
        aria-label={applyLabel}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onApply}
        className="folder-editor-btn"
      >
        <Check size={13} strokeWidth={2.5} />
      </button>
      {extra}
    </div>
  )
}

const HEADING_LEVELS = [1, 2, 3] as const

export function ComposeFormatToolbar({ editor }: { editor: Editor }): React.ReactElement {
  const { t } = useTranslation()
  // 链接/图片受控内联弹框 (window.prompt 在 Electron renderer 被禁用)。
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkValue, setLinkValue] = useState('')
  const [imageOpen, setImageOpen] = useState(false)
  const [imageValue, setImageValue] = useState('')
  // 字体/字号选项 (value = CSS; '' = 清除回默认)。label 走 i18n。
  const fontFamilies: Array<{ key: string; value: string }> = [
    { key: 'fontDefault', value: '' },
    { key: 'fontSystem', value: 'system-ui, -apple-system, sans-serif' },
    { key: 'fontSerif', value: "Georgia, 'Times New Roman', serif" },
    { key: 'fontMono', value: "ui-monospace, 'SF Mono', monospace" }
  ]
  // 12-30px（design/editor.jsx FONT_SIZES），'' = 默认。
  const fontSizes = ['', '12px', '13px', '14px', '16px', '18px', '24px', '30px']
  // 兼容闸：旧装配（ComposePanel 未切 buildComposeExtensions 前）无 Highlight 扩展，
  // 高亮按钮回退 textStyle backgroundColor（#9 dogfood 旧行为），T5 切换后走真高亮 mark。
  const hasHighlight = editor.extensionManager.extensions.some((ext) => ext.name === 'highlight')

  // TipTap v3: useEditor 默认不每 transaction 重渲染 → editor.isActive/getAttributes 非
  // 响应式, 工具栏高亮/当前值不跟随光标。useEditorState 订阅快照。
  const fmt = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e?.isActive('bold') ?? false,
      italic: e?.isActive('italic') ?? false,
      underline: e?.isActive('underline') ?? false,
      strike: e?.isActive('strike') ?? false,
      bulletList: e?.isActive('bulletList') ?? false,
      orderedList: e?.isActive('orderedList') ?? false,
      blockquote: e?.isActive('blockquote') ?? false,
      codeBlock: e?.isActive('codeBlock') ?? false,
      link: e?.isActive('link') ?? false,
      code: e?.isActive('code') ?? false,
      heading: (HEADING_LEVELS.find((l) => e?.isActive('heading', { level: l })) ?? 0) as
        | 0
        | 1
        | 2
        | 3,
      fontFamily: (e?.getAttributes('textStyle').fontFamily as string | undefined) ?? '',
      fontSize: (e?.getAttributes('textStyle').fontSize as string | undefined) ?? '',
      color: (e?.getAttributes('textStyle').color as string | undefined) ?? '',
      highlight:
        (e?.getAttributes('highlight').color as string | undefined) ??
        (e?.getAttributes('textStyle').backgroundColor as string | undefined) ??
        '',
      canUndo: e?.can().undo() ?? false,
      canRedo: e?.can().redo() ?? false
    })
  }) ?? {
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    bulletList: false,
    orderedList: false,
    blockquote: false,
    codeBlock: false,
    link: false,
    code: false,
    heading: 0 as const,
    fontFamily: '',
    fontSize: '',
    color: '',
    highlight: '',
    canUndo: false,
    canRedo: false
  }

  const openLinkDialog = useCallback(() => {
    const prev = editor.getAttributes('link').href as string | undefined
    setLinkValue(prev && prev.length > 0 ? prev : 'https://')
    setLinkOpen(true)
  }, [editor])
  const applyLink = useCallback(() => {
    const url = linkValue.trim()
    setLinkOpen(false)
    // 空 / 占位 https:// → 视作清除 (给选中文本去链); 否则给选中文本加 link。
    if (url === '' || url === 'https://') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      return
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
  }, [editor, linkValue])
  const removeLink = useCallback(() => {
    setLinkOpen(false)
    editor.chain().focus().extendMarkRange('link').unsetLink().run()
  }, [editor])

  const applyImage = useCallback(() => {
    const url = imageValue.trim()
    setImageOpen(false)
    setImageValue('')
    if (url === '' || url === 'https://') return
    editor.chain().focus().setImage({ src: url }).run()
  }, [editor, imageValue])

  // 从文件插入内联图 — FileReader → data URL → setImage。与粘贴图片同一
  // 下游 (data: 直嵌正文 HTML), 超上限提示走附件。
  const imageFileRef = useRef<HTMLInputElement>(null)
  const insertImageFile = useCallback(
    (file: File | undefined) => {
      setImageOpen(false)
      setImageValue('')
      if (!file) return
      if (file.size > MAX_INLINE_IMAGE_BYTES) {
        toastError(t('compose.editor.imageTooLarge', { name: file.name, max: 4 }))
        return
      }
      const reader = new FileReader()
      reader.onload = () => {
        const src = typeof reader.result === 'string' ? reader.result : ''
        if (src) editor.chain().focus().setImage({ src }).run()
      }
      reader.readAsDataURL(file)
    },
    [editor, t]
  )

  /** 高亮（multicolor）— 无 Highlight 扩展时回退 textStyle backgroundColor。 */
  const applyHighlight = useCallback(
    (color: string | null) => {
      const chain = editor.chain().focus()
      if (hasHighlight) {
        ;(color ? chain.setHighlight({ color }) : chain.unsetHighlight()).run()
      } else {
        ;(color ? chain.setBackgroundColor(color) : chain.unsetBackgroundColor()).run()
      }
    },
    [editor, hasHighlight]
  )

  /** @ 按钮 — 光标前是非空白字符时补一个空格（Suggestion 默认只认空白前缀触发）。 */
  const insertMentionTrigger = useCallback(() => {
    const { from } = editor.state.selection
    const before = from > 0 ? editor.state.doc.textBetween(Math.max(0, from - 1), from) : ''
    const needsSpace = before.length > 0 && !/\s/.test(before)
    editor
      .chain()
      .focus()
      .insertContent(needsSpace ? ' @' : '@')
      .run()
  }, [editor])

  return (
    <div className="relative border-t border-ink-border/60 bg-ink-2/40 px-3 py-2 flex items-center gap-1.5 shrink-0 flex-wrap">
      {/* ── 组 1: 正文/标题 + 字体 + 字号 ─────────────────────────── */}
      <OptionPopoverButton
        title={t('compose.editor.headingStyle')}
        value={fmt.heading === 0 ? '' : String(fmt.heading)}
        currentLabel={
          fmt.heading === 0
            ? t('compose.editor.paragraph')
            : t(`compose.editor.heading${fmt.heading}`)
        }
        options={[
          { value: '', label: t('compose.editor.paragraph') },
          ...HEADING_LEVELS.map((l) => ({
            value: String(l),
            label: t(`compose.editor.heading${l}`)
          }))
        ]}
        onSelect={(v) => {
          if (v === '') editor.chain().focus().setParagraph().run()
          else
            editor
              .chain()
              .focus()
              .setHeading({ level: Number(v) as 1 | 2 | 3 })
              .run()
        }}
      />
      <OptionPopoverButton
        title={t('compose.editor.fontFamily')}
        value={fmt.fontFamily}
        currentLabel={t(
          `compose.editor.${fontFamilies.find((f) => f.value === fmt.fontFamily)?.key ?? 'fontDefault'}`
        )}
        options={fontFamilies.map((f) => ({
          value: f.value,
          label: t(`compose.editor.${f.key}`)
        }))}
        onSelect={(v) => {
          if (v) editor.chain().focus().setFontFamily(v).run()
          else editor.chain().focus().unsetFontFamily().run()
        }}
      />
      <OptionPopoverButton
        title={t('compose.editor.fontSize')}
        value={fmt.fontSize}
        currentLabel={
          fmt.fontSize ? fmt.fontSize.replace('px', '') : t('compose.editor.fontDefault')
        }
        options={fontSizes.map((s) => ({
          value: s,
          label: s ? s.replace('px', '') : t('compose.editor.fontDefault')
        }))}
        onSelect={(v) => {
          if (v) editor.chain().focus().setFontSize(v).run()
          else editor.chain().focus().unsetFontSize().run()
        }}
      />
      <FmtSep />
      {/* ── 组 2: B/I/U/S + 颜色 + 高亮 ──────────────────────────── */}
      <FmtBtn
        icon={<Bold size={13} strokeWidth={2.5} />}
        label={t('compose.editor.bold')}
        active={fmt.bold}
        onClick={() => editor.chain().focus().toggleBold().run()}
      />
      <FmtBtn
        icon={<Italic size={13} strokeWidth={2} />}
        label={t('compose.editor.italic')}
        active={fmt.italic}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      />
      <FmtBtn
        icon={<UnderlineIcon size={13} strokeWidth={2} />}
        label={t('compose.editor.underline')}
        active={fmt.underline}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      />
      <FmtBtn
        icon={<Strikethrough size={13} strokeWidth={2} />}
        label={t('compose.editor.strike')}
        active={fmt.strike}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      />
      <SwatchPopoverButton
        title={t('compose.editor.textColor')}
        icon={<Baseline size={13} strokeWidth={2} style={{ color: fmt.color || undefined }} />}
        colors={TEXT_COLORS}
        neutrals={TEXT_NEUTRALS}
        current={fmt.color}
        clearTitle={t('compose.editor.colorDefault')}
        moreLabel={t('compose.editor.moreColor')}
        onPick={(c) => {
          if (c) editor.chain().focus().setColor(c).run()
          else editor.chain().focus().unsetColor().run()
        }}
      />
      <SwatchPopoverButton
        title={t('compose.editor.highlight')}
        icon={
          <Highlighter size={13} strokeWidth={2} style={{ color: fmt.highlight || undefined }} />
        }
        colors={HL_COLORS}
        neutrals={HL_NEUTRALS}
        current={fmt.highlight}
        clearTitle={t('compose.editor.highlightNone')}
        moreLabel={t('compose.editor.moreColor')}
        onPick={applyHighlight}
      />
      <FmtSep />
      {/* ── 组 3: 列表 + 引用 + 代码块 ───────────────────────────── */}
      <FmtBtn
        icon={<List size={13} strokeWidth={2} />}
        label={t('compose.editor.bulletList')}
        active={fmt.bulletList}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      />
      <FmtBtn
        icon={<ListOrdered size={13} strokeWidth={2} />}
        label={t('compose.editor.orderedList')}
        active={fmt.orderedList}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      />
      <FmtBtn
        icon={<TextQuote size={13} strokeWidth={2} />}
        label={t('compose.editor.blockquote')}
        active={fmt.blockquote}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      />
      <FmtBtn
        icon={<SquareCode size={13} strokeWidth={2} />}
        label={t('compose.editor.codeBlock')}
        active={fmt.codeBlock}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
      />
      <FmtBtn
        icon={<Code size={13} strokeWidth={2} />}
        label={t('compose.editor.code')}
        active={fmt.code}
        onClick={() => editor.chain().focus().toggleCode().run()}
      />
      <FmtSep />
      {/* ── 组 4: 链接 + 图片 + 分割线 + @ ───────────────────────── */}
      <FmtBtn
        icon={<Link2 size={13} strokeWidth={2} />}
        label={t('compose.editor.link')}
        active={fmt.link || linkOpen}
        onClick={() => (linkOpen ? setLinkOpen(false) : openLinkDialog())}
      />
      <FmtBtn
        icon={<ImagePlus size={13} strokeWidth={2} />}
        label={t('compose.editor.image')}
        active={imageOpen}
        onClick={() => {
          setLinkOpen(false)
          setImageOpen((v) => !v)
        }}
      />
      <FmtBtn
        icon={<Minus size={13} strokeWidth={2} />}
        label={t('compose.editor.divider')}
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
      />
      <FmtBtn
        icon={<AtSign size={13} strokeWidth={2} />}
        label={t('compose.editor.mention')}
        onClick={insertMentionTrigger}
      />
      <div className="flex-1" aria-hidden />
      {/* ── 组 5: 撤销/重做 ──────────────────────────────────────── */}
      <FmtBtn
        icon={<Undo2 size={13} strokeWidth={2} />}
        label={t('compose.editor.undo')}
        disabled={!fmt.canUndo}
        onClick={() => editor.chain().focus().undo().run()}
      />
      <FmtBtn
        icon={<Redo2 size={13} strokeWidth={2} />}
        label={t('compose.editor.redo')}
        disabled={!fmt.canRedo}
        onClick={() => editor.chain().focus().redo().run()}
      />

      {/* 链接输入弹框 — Enter 应用 / Esc 取消; 有链接时显移除。 */}
      {linkOpen && (
        <InlineInputBox
          value={linkValue}
          placeholder={t('compose.editor.linkUrl')}
          applyLabel={t('compose.editor.linkApply')}
          onChange={setLinkValue}
          onApply={applyLink}
          onClose={() => setLinkOpen(false)}
          extra={
            fmt.link ? (
              <button
                type="button"
                title={t('compose.editor.linkRemove')}
                aria-label={t('compose.editor.linkRemove')}
                onMouseDown={(e) => e.preventDefault()}
                onClick={removeLink}
                className="folder-editor-btn"
              >
                <Unlink size={13} strokeWidth={2} />
              </button>
            ) : undefined
          }
        />
      )}
      {/* 图片 URL 输入弹框 — 插入内联图（上传附件走附件条，不在此处）;
          extra 按钮 = 从本地文件选图 (data URL 内联, 与粘贴同下游)。 */}
      {imageOpen && (
        <InlineInputBox
          value={imageValue}
          placeholder={t('compose.editor.imageUrl')}
          applyLabel={t('compose.editor.imageApply')}
          onChange={setImageValue}
          onApply={applyImage}
          onClose={() => setImageOpen(false)}
          extra={
            <button
              type="button"
              title={t('compose.editor.imageFromFile')}
              aria-label={t('compose.editor.imageFromFile')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => imageFileRef.current?.click()}
              className="folder-editor-btn"
            >
              <ImageUp size={13} strokeWidth={2} />
            </button>
          }
        />
      )}
      {/* 从文件插图的载体 input — 常驻挂载 (弹框关掉后系统文件对话框的 onChange
          仍要能送达), 选完清 value 让同一文件可重复选择。 */}
      <input
        ref={imageFileRef}
        type="file"
        accept="image/*"
        hidden
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          insertImageFile(e.currentTarget.files?.[0])
          e.currentTarget.value = ''
        }}
      />
    </div>
  )
}

export function ComposeEditor({ editor }: { editor: Editor | null }): React.ReactElement {
  const { t } = useTranslation()
  // TipTap v3: editor.isEmpty 非响应式 (useEditor 默认不每 transaction 重渲染) →
  // 输入后 placeholder 不消失。useEditorState 订阅, isEmpty 变化时重渲染。
  const isEmpty =
    useEditorState({ editor, selector: ({ editor: e }) => e?.isEmpty ?? true }) ?? true
  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin">
      {/* 正文用满宽 + 24px 内边距 (旧 px-10=40px + max-w-760 居中导致大段留白, 观感
          像"缩进很多"); 去掉宽度上限让正文铺满 compose 列, 与 Outlook 撰写区一致。 */}
      <div className="relative px-6 pt-6 pb-10">
        {isEmpty && (
          <div
            aria-hidden
            className="pointer-events-none absolute left-6 top-6 text-body text-ink-fg-3"
          >
            {t('compose.editor.bodyPlaceholder')}
          </div>
        )}
        <EditorContent
          editor={editor}
          className="folder-draft-editor text-ink-fg-1 text-body leading-relaxed"
        />
      </div>
    </div>
  )
}
