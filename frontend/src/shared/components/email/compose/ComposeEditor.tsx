// Compose rich-text editor — TipTap v3 + format toolbar.
//
// Mirrors the folder DraftEditor's editor recipe verbatim (StarterKit v3
// bundles Bold/Italic/Strike/Underline/Link/Code/BulletList/OrderedList;
// Link `openOnClick` disabled in-editor). Reuses the `.folder-editor-btn` +
// `.folder-draft-editor` CSS tokens (index.css §Composer). The parent owns
// the Editor instance (so it can read getHTML() on send/save) and passes it
// down; this file renders the surface + toolbar only.

import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { EditorContent, type Editor } from '@tiptap/react'
import {
  Bold,
  Code,
  Italic,
  Link2,
  List,
  ListOrdered,
  Strikethrough,
  Underline as UnderlineIcon
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

  const addLink = useCallback(() => {
    const prev = editor.getAttributes('link').href as string | undefined
    const url = window.prompt(t('compose.editor.link'), prev ?? 'https://')
    if (url === null) return
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      return
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
  }, [editor, t])

  return (
    <div className="border-t border-ink-border/60 bg-ink-2/40 px-3 py-2 flex items-center gap-1.5 shrink-0">
      <FmtBtn
        icon={<Bold size={13} strokeWidth={2.5} />}
        label={t('compose.editor.bold')}
        active={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
      />
      <FmtBtn
        icon={<Italic size={13} strokeWidth={2} />}
        label={t('compose.editor.italic')}
        active={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      />
      <FmtBtn
        icon={<UnderlineIcon size={13} strokeWidth={2} />}
        label={t('compose.editor.underline')}
        active={editor.isActive('underline')}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      />
      <FmtBtn
        icon={<Strikethrough size={13} strokeWidth={2} />}
        label={t('compose.editor.strike')}
        active={editor.isActive('strike')}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      />
      <span className="w-px h-5 bg-ink-border-soft mx-1" aria-hidden />
      <FmtBtn
        icon={<List size={13} strokeWidth={2} />}
        label={t('compose.editor.bulletList')}
        active={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      />
      <FmtBtn
        icon={<ListOrdered size={13} strokeWidth={2} />}
        label={t('compose.editor.orderedList')}
        active={editor.isActive('orderedList')}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      />
      <span className="w-px h-5 bg-ink-border-soft mx-1" aria-hidden />
      <FmtBtn
        icon={<Link2 size={13} strokeWidth={2} />}
        label={t('compose.editor.link')}
        active={editor.isActive('link')}
        onClick={addLink}
      />
      <FmtBtn
        icon={<Code size={13} strokeWidth={2} />}
        label={t('compose.editor.code')}
        active={editor.isActive('code')}
        onClick={() => editor.chain().focus().toggleCode().run()}
      />
    </div>
  )
}

export function ComposeEditor({ editor }: { editor: Editor | null }): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin">
      {/* 正文用满宽 + 24px 内边距 (旧 px-10=40px + max-w-760 居中导致大段留白, 观感
          像"缩进很多"); 去掉宽度上限让正文铺满 compose 列, 与 Outlook 撰写区一致。 */}
      <div className="relative px-6 pt-6 pb-10">
        {editor?.isEmpty && (
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
