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
      color: (e?.getAttributes('textStyle').color as string | undefined) ?? '#1a1a1a',
      backgroundColor:
        (e?.getAttributes('textStyle').backgroundColor as string | undefined) ?? '#fde68a'
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
    color: '#1a1a1a',
    backgroundColor: '#fde68a'
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

  const selectCls =
    'h-7 rounded-md bg-ink-2/50 border border-ink-border/60 text-[11px] px-1 text-ink-fg-2 ' +
    'hover:bg-ink-2 focus:outline-none focus:border-accent/60 cursor-pointer max-w-[88px]'

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
      {/* #9 字体 — setFontFamily / unsetFontFamily (textStyle mark)。 */}
      <select
        className={selectCls}
        title={t('compose.editor.fontFamily')}
        aria-label={t('compose.editor.fontFamily')}
        value={fmt.fontFamily}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          const v = e.target.value
          if (v) editor.chain().focus().setFontFamily(v).run()
          else editor.chain().focus().unsetFontFamily().run()
        }}
      >
        {fontFamilies.map((f) => (
          <option key={f.key} value={f.value}>
            {t(`compose.editor.${f.key}`)}
          </option>
        ))}
      </select>
      {/* #9 字号 — setFontSize / unsetFontSize (官方 FontSize)。 */}
      <select
        className={selectCls}
        title={t('compose.editor.fontSize')}
        aria-label={t('compose.editor.fontSize')}
        value={fmt.fontSize}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          const v = e.target.value
          if (v) editor.chain().focus().setFontSize(v).run()
          else editor.chain().focus().unsetFontSize().run()
        }}
      >
        {fontSizes.map((s) => (
          <option key={s || 'default'} value={s}>
            {s ? s.replace('px', '') : t('compose.editor.fontDefault')}
          </option>
        ))}
      </select>
      {/* #9 字体颜色 — 原生 color input (setColor); icon 反映当前色。 */}
      <label
        className="folder-editor-btn relative cursor-pointer"
        title={t('compose.editor.textColor')}
        aria-label={t('compose.editor.textColor')}
        onMouseDown={(e) => e.preventDefault()}
      >
        <Baseline size={13} strokeWidth={2} style={{ color: fmt.color }} />
        <input
          type="color"
          value={fmt.color}
          className="absolute inset-0 h-full w-full opacity-0 cursor-pointer"
          onChange={(e) => editor.chain().focus().setColor(e.target.value).run()}
        />
      </label>
      {/* #9 字体底色 — BackgroundColor (setBackgroundColor); icon 反映当前底色。 */}
      <label
        className="folder-editor-btn relative cursor-pointer"
        title={t('compose.editor.bgColor')}
        aria-label={t('compose.editor.bgColor')}
        onMouseDown={(e) => e.preventDefault()}
      >
        <Highlighter size={13} strokeWidth={2} style={{ color: fmt.backgroundColor }} />
        <input
          type="color"
          value={fmt.backgroundColor}
          className="absolute inset-0 h-full w-full opacity-0 cursor-pointer"
          onChange={(e) => editor.chain().focus().setBackgroundColor(e.target.value).run()}
        />
      </label>
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
        <div className="absolute bottom-full left-3 mb-1.5 z-20 flex items-center gap-1 rounded-lg border border-ink-border bg-ink-1 p-1.5 shadow-lg">
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus -- 弹框打开即聚焦输入是预期交互
            autoFocus
            type="url"
            value={linkValue}
            placeholder={t('compose.editor.linkUrl')}
            onChange={(e) => setLinkValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                applyLink()
              } else if (e.key === 'Escape') {
                e.preventDefault()
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
