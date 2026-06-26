// Compose rich-text editor — TipTap v3 + format toolbar.
//
// Mirrors the folder DraftEditor's editor recipe verbatim (StarterKit v3
// bundles Bold/Italic/Strike/Underline/Link/Code/BulletList/OrderedList;
// Link `openOnClick` disabled in-editor). Reuses the `.folder-editor-btn` +
// `.folder-draft-editor` CSS tokens (index.css §Composer). The parent owns
// the Editor instance (so it can read getHTML() on send/save) and passes it
// down; this file renders the surface + toolbar only.

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EditorContent, useEditorState, type Editor } from '@tiptap/react'
import {
  Baseline,
  Bold,
  Check,
  ChevronDown,
  Code,
  Highlighter,
  Italic,
  Link2,
  List,
  ListOrdered,
  Strikethrough,
  Underline as UnderlineIcon,
  Unlink
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { Popover, PopoverContent, PopoverTrigger } from '@shared/components/ui/popover'

function FmtBtn({
  icon,
  label,
  active,
  onClick
}: {
  icon: React.ReactNode
  label: string
  active?: boolean
  onClick: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      // onMouseDown preventDefault keeps the editor selection from being
      // stolen by the toolbar button focus.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn('folder-editor-btn', active && 'is-on')}
    >
      {icon}
    </button>
  )
}

// #9 dogfood — 固定色盘 (取代原生 input[type=color] 系统色轮)。6 列 × 5 行: 4 行彩色 (色相×明度)
// + 1 行灰阶 (白→黑)。点格子即应用; 「更多颜色」回退到原生取色器兜底自定义色。用 radix Popover
// (React, 无系统弹窗) → 不再触发 ComposeNewModal backdrop 的误关 (原生 select/color 的系统弹窗
// 关闭时 click 落到 backdrop 会关整个撰写框, dogfood 反馈)。
/* eslint-disable mailagent/no-raw-hex -- 固定色盘的品牌色集，本质是 hex 常量（非 theme token，类似厂商色）。 */
const COLOR_PALETTE: readonly string[] = [
  '#5b9bf3',
  '#5cb85c',
  '#f5d142',
  '#f0962e',
  '#ef6c5a',
  '#c45cd6',
  '#2d7fe0',
  '#2e9e4f',
  '#e6c419',
  '#e07c1c',
  '#dc4533',
  '#9a3fb0',
  '#1f5fa8',
  '#1f6b35',
  '#b89a16',
  '#b85d18',
  '#a82a20',
  '#6e2a82',
  '#163d68',
  '#16401f',
  '#8a7011',
  '#8a4212',
  '#7a1a12',
  '#421a52',
  '#ffffff',
  '#cfcfcf',
  '#9a9a9a',
  '#666666',
  '#333333',
  '#000000'
]
// fmt selector / fallback 的默认显示色 (TipTap textStyle 缺省时回退值，非 UI token)。
const DEFAULT_TEXT_COLOR = '#1a1a1a'
const DEFAULT_BG_COLOR = '#fde68a'
/* eslint-enable mailagent/no-raw-hex */

/** 固定色盘按钮: 图标反映当前色; popover 内 6×5 格 + 「更多颜色」原生兜底。onMouseDown preventDefault
 *  保住编辑器选区 (否则点工具栏会抢走选区, setColor 作用到空选区)。 */
function ColorPaletteButton({
  icon,
  title,
  current,
  onPick,
  moreLabel
}: {
  icon: React.ReactNode
  title: string
  current: string
  onPick: (color: string) => void
  moreLabel: string
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
          className="folder-editor-btn"
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
          {COLOR_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              title={c}
              onClick={() => {
                onPick(c)
                setOpen(false)
              }}
              className={cn(
                'size-5 rounded-full border transition-transform duration-fast hover:scale-110',
                current.toLowerCase() === c.toLowerCase()
                  ? 'border-coral ring-1 ring-coral'
                  : 'border-ink-border/40'
              )}
              style={{ background: c }}
            />
          ))}
        </div>
        <label className="mt-2 flex cursor-pointer items-center justify-center rounded-md border border-ink-border/60 py-1.5 text-meta text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3">
          {moreLabel}
          <input
            type="color"
            className="sr-only"
            onChange={(e) => {
              onPick(e.target.value)
              setOpen(false)
            }}
          />
        </label>
      </PopoverContent>
    </Popover>
  )
}

/** 字体 / 字号选择: radix Popover 选项列表 (取代原生 <select> — 它的系统下拉在 Electron modal 里
 *  关闭时会误关 backdrop, dogfood 反馈)。当前值显示在按钮上, 选项点击在 PopoverContent 内不冒泡。 */
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
      >
        {options.map((o) => (
          <button
            key={o.value || 'default'}
            type="button"
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

export function ComposeFormatToolbar({ editor }: { editor: Editor }): React.ReactElement {
  const { t } = useTranslation()
  // #9 外链改受控弹框 (window.prompt 在 Electron renderer 被禁用 → 旧实现点了 no-op)。
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkValue, setLinkValue] = useState('')
  // #9 字体/字号选项 (value = CSS; '' = 清除回默认)。label 走 i18n。
  const fontFamilies: Array<{ key: string; value: string }> = [
    { key: 'fontDefault', value: '' },
    { key: 'fontSystem', value: 'system-ui, -apple-system, sans-serif' },
    { key: 'fontSerif', value: "Georgia, 'Times New Roman', serif" },
    { key: 'fontMono', value: "ui-monospace, 'SF Mono', monospace" }
  ]
  const fontSizes = ['', '12px', '14px', '16px', '18px', '24px']
  // TipTap v3: useEditor 默认不每 transaction 重渲染 → editor.isActive/getAttributes 非
  // 响应式, 工具栏高亮/当前值不跟随光标。useEditorState 订阅快照 (含 #9 textStyle 属性)。
  const fmt = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e?.isActive('bold') ?? false,
      italic: e?.isActive('italic') ?? false,
      underline: e?.isActive('underline') ?? false,
      strike: e?.isActive('strike') ?? false,
      bulletList: e?.isActive('bulletList') ?? false,
      orderedList: e?.isActive('orderedList') ?? false,
      link: e?.isActive('link') ?? false,
      code: e?.isActive('code') ?? false,
      fontFamily: (e?.getAttributes('textStyle').fontFamily as string | undefined) ?? '',
      fontSize: (e?.getAttributes('textStyle').fontSize as string | undefined) ?? '',
      color: (e?.getAttributes('textStyle').color as string | undefined) ?? DEFAULT_TEXT_COLOR,
      backgroundColor:
        (e?.getAttributes('textStyle').backgroundColor as string | undefined) ?? DEFAULT_BG_COLOR
    })
  }) ?? {
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    bulletList: false,
    orderedList: false,
    link: false,
    code: false,
    fontFamily: '',
    fontSize: '',
    color: DEFAULT_TEXT_COLOR,
    backgroundColor: DEFAULT_BG_COLOR
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

  return (
    <div className="relative border-t border-ink-border/60 bg-ink-2/40 px-3 py-2 flex items-center gap-1.5 shrink-0 flex-wrap">
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
      <span className="w-px h-5 bg-ink-border-soft mx-1" aria-hidden />
      {/* #9 字体 — OptionPopoverButton (取代原生 select，避免系统下拉关闭误关 modal)。 */}
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
      {/* #9 字号 — OptionPopoverButton (取代原生 select)。 */}
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
      {/* #9 字体颜色 — 固定色盘 (setColor); icon 反映当前色。 */}
      <ColorPaletteButton
        title={t('compose.editor.textColor')}
        icon={<Baseline size={13} strokeWidth={2} style={{ color: fmt.color }} />}
        current={fmt.color}
        onPick={(c) => editor.chain().focus().setColor(c).run()}
        moreLabel={t('compose.editor.moreColor')}
      />
      {/* #9 字体底色 — 固定色盘 (setBackgroundColor); icon 反映当前底色。 */}
      <ColorPaletteButton
        title={t('compose.editor.bgColor')}
        icon={<Highlighter size={13} strokeWidth={2} style={{ color: fmt.backgroundColor }} />}
        current={fmt.backgroundColor}
        onPick={(c) => editor.chain().focus().setBackgroundColor(c).run()}
        moreLabel={t('compose.editor.moreColor')}
      />
      <span className="w-px h-5 bg-ink-border-soft mx-1" aria-hidden />
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
      <span className="w-px h-5 bg-ink-border-soft mx-1" aria-hidden />
      {/* #9 外链 — 点击弹受控输入框 (取代被 Electron 禁用的 window.prompt)。 */}
      <FmtBtn
        icon={<Link2 size={13} strokeWidth={2} />}
        label={t('compose.editor.link')}
        active={fmt.link || linkOpen}
        onClick={() => (linkOpen ? setLinkOpen(false) : openLinkDialog())}
      />
      <FmtBtn
        icon={<Code size={13} strokeWidth={2} />}
        label={t('compose.editor.code')}
        active={fmt.code}
        onClick={() => editor.chain().focus().toggleCode().run()}
      />

      {/* #9 链接输入弹框 — 浮在工具栏上方。Enter 应用 / Esc 取消; 有链接时显移除。 */}
      {linkOpen && (
        <div className="absolute bottom-full left-3 mb-1.5 z-20 flex items-center gap-1 rounded-lg border border-ink-border bg-ink-1 p-1.5 shadow-md">
          <input
            autoFocus
            type="url"
            value={linkValue}
            placeholder={t('compose.editor.linkUrl')}
            onChange={(e) => setLinkValue(e.target.value)}
            onKeyDown={(e) => {
              // stopPropagation: 否则 Esc/Enter 冒泡到 ComposePanel 的 window 级 keydown
              // (Escape 会关掉整个撰写框) —— codex review MEDIUM。
              if (e.key === 'Enter') {
                e.preventDefault()
                e.stopPropagation()
                applyLink()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setLinkOpen(false)
              }
            }}
            className="h-7 w-60 rounded-md bg-ink-2/60 border border-ink-border/60 px-2 text-xs text-ink-fg-1 focus:outline-none focus:border-accent/60"
          />
          <button
            type="button"
            title={t('compose.editor.linkApply')}
            aria-label={t('compose.editor.linkApply')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={applyLink}
            className="folder-editor-btn"
          >
            <Check size={13} strokeWidth={2.5} />
          </button>
          {fmt.link && (
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
          )}
        </div>
      )}
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
