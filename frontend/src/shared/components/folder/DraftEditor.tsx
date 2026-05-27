// Phase C — 草稿编辑器 (新建 + 编辑共用). 占据 detail 列 (FolderLayout 在
// editing/creating 时用它替换 FolderDetail)。
//
// 收件人 / 抄送 / 主题输入行 (逗号分隔多收件人) + TipTap 富文本正文 + 自建
// 格式工具栏 (bold/italic/underline/strike/有序·无序列表/link/code)。
//
// TipTap v3 注意: StarterKit 已内置 Bold/Italic/Strike/Underline/Link/Code/
// CodeBlock/BulletList/OrderedList/ListItem 等, 所以这里只挂 StarterKit (额外
// 单独挂 Link/Underline 会触发 "duplicate extension" 警告)。Link 默认
// openOnClick=true, 编辑器里关掉。输出走 editor.getHTML()。
//
// 保存: 编辑态 → folder.editDraft({id, html, ...}); 新建态 →
// folder.createDraft({to, cc, subject, html})。mutation onSuccess invalidate
// ['folder', 'drafts'] + toast。

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import {
  Bold,
  Code,
  Italic,
  Link2,
  List,
  ListOrdered,
  Loader2,
  Strikethrough,
  Underline as UnderlineIcon,
  X
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'
import { toastError, toastSuccess } from '@shared/state/toast'
import type { FolderEmailDetail } from '@shared/api/types'

interface Props {
  /** 编辑态: 传入要编辑的草稿 (含 body_html + 收件人); 新建态传 null. */
  draft: FolderEmailDetail | null
  /** 保存成功 / 取消后回调 — FolderLayout 关闭 editor 回到列表态. */
  onClose: () => void
}

// ── format toolbar button ───────────────────────────────────────────────
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
      // onMouseDown preventDefault 让 toolbar 点击不抢走编辑器 selection
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        'p-1.5 rounded transition-colors duration-fast',
        active
          ? 'text-coral bg-coral/10 hover:bg-coral/15'
          : 'text-ink-fg-2 hover:text-ink-fg hover:bg-ink-4'
      )}
    >
      {icon}
    </button>
  )
}

function FmtToolbar({ editor }: { editor: Editor }): React.ReactElement {
  const { t } = useTranslation()
  const addLink = useCallback(() => {
    const prev = editor.getAttributes('link').href as string | undefined
    const url = window.prompt(t('folder.editor.link'), prev ?? 'https://')
    if (url === null) return
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      return
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
  }, [editor, t])

  return (
    <div className="flex items-center gap-0.5 px-3 py-1.5 border-b border-ink-border-soft">
      <FmtBtn
        icon={<Bold size={14} strokeWidth={2.5} />}
        label={t('folder.editor.bold')}
        active={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
      />
      <FmtBtn
        icon={<Italic size={14} strokeWidth={2} />}
        label={t('folder.editor.italic')}
        active={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      />
      <FmtBtn
        icon={<UnderlineIcon size={14} strokeWidth={2} />}
        label={t('folder.editor.underline')}
        active={editor.isActive('underline')}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      />
      <FmtBtn
        icon={<Strikethrough size={14} strokeWidth={2} />}
        label={t('folder.editor.strike')}
        active={editor.isActive('strike')}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      />
      <span className="w-px h-5 bg-ink-border mx-1" aria-hidden />
      <FmtBtn
        icon={<List size={14} strokeWidth={2} />}
        label={t('folder.editor.bulletList')}
        active={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      />
      <FmtBtn
        icon={<ListOrdered size={14} strokeWidth={2} />}
        label={t('folder.editor.orderedList')}
        active={editor.isActive('orderedList')}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      />
      <span className="w-px h-5 bg-ink-border mx-1" aria-hidden />
      <FmtBtn
        icon={<Link2 size={14} strokeWidth={2} />}
        label={t('folder.editor.link')}
        active={editor.isActive('link')}
        onClick={addLink}
      />
      <FmtBtn
        icon={<Code size={14} strokeWidth={2} />}
        label={t('folder.editor.code')}
        active={editor.isActive('code')}
        onClick={() => editor.chain().focus().toggleCode().run()}
      />
    </div>
  )
}

// ── meta input row ──────────────────────────────────────────────────────
function MetaInput({
  label,
  value,
  placeholder,
  onChange
}: {
  label: string
  value: string
  placeholder?: string
  onChange: (v: string) => void
}): React.ReactElement {
  return (
    <label className="flex items-center gap-3 px-8 py-1.5 border-b border-ink-border-soft text-aux">
      <span className="w-12 shrink-0 text-ink-fg-2 font-mono text-meta">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'flex-1 min-w-0 bg-transparent text-ink-fg outline-none',
          'placeholder:text-ink-fg-3'
        )}
      />
    </label>
  )
}

export function DraftEditor({ draft, onClose }: Props): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const queryClient = useQueryClient()
  const isEdit = draft !== null

  const [to, setTo] = useState(draft?.to_addr ?? '')
  const [cc, setCc] = useState(draft?.cc_addr ?? '')
  const [subject, setSubject] = useState(draft?.subject ?? '')

  const editor = useEditor({
    extensions: [
      // StarterKit v3 bundles Bold/Italic/Strike/Underline/Link/Code/
      // CodeBlock/BulletList/OrderedList/ListItem/Heading 等. Link 默认
      // openOnClick=true, 编辑器里关掉避免点链接跳转。
      StarterKit.configure({
        link: { openOnClick: false }
      })
    ],
    content: draft?.body_html ?? '',
    // React 19 — TipTap v3 默认 immediatelyRender:true 在 SSR/StrictMode 下
    // 会 warning; Electron renderer 是纯 CSR, 保持默认即可, 这里显式 false
    // 兜底 double-mount。
    immediatelyRender: false
  })

  const invalidateDrafts = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['folder', 'drafts'] }),
    [queryClient]
  )

  const saveMut = useMutation({
    mutationFn: async () => {
      const html = editor?.getHTML() ?? ''
      if (isEdit && draft) {
        return mailApi.folder.editDraft({
          id: draft.id,
          html,
          to: to.trim(),
          cc: cc.trim(),
          subject
        })
      }
      return mailApi.folder.createDraft({
        to: to.trim(),
        cc: cc.trim() || undefined,
        subject: subject || undefined,
        html
      })
    },
    onSuccess: async () => {
      await invalidateDrafts()
      toastSuccess(isEdit ? t('folder.toast.draftSaved') : t('folder.toast.draftCreated'))
      onClose()
    },
    onError: (err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err))
      const code = (e as Error & { code?: string }).code
      toastError(
        isEdit ? t('folder.toast.draftSaveFail') : t('folder.toast.draftCreateFail'),
        code ? `${code} · ${e.message}` : e.message
      )
    }
  })

  const handleSave = useCallback(() => {
    // 新建态至少要一个收件人 (编辑态允许沿用原草稿空 To, CLI 端兜底)。
    if (!isEdit && to.trim().length === 0) {
      toastError(t('folder.editor.toRequired'))
      return
    }
    saveMut.mutate()
  }, [isEdit, to, saveMut, t])

  const saving = saveMut.isPending

  return (
    <main aria-label="draft-editor" className="flex-1 min-w-0 glass-3 flex flex-col min-h-0">
      {/* toolbar — 标题 + 取消/保存 */}
      <header className="h-11 border-b border-ink-border-soft glass-2 flex items-center px-3 gap-2 shrink-0">
        <span className="text-aux font-medium text-ink-fg px-1">
          {isEdit ? t('folder.editor.editTitle') : t('folder.editor.newTitle')}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-aux',
              'text-ink-fg-1 hover:text-ink-fg hover:bg-ink-4 transition-colors duration-fast',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            )}
          >
            <X size={13} strokeWidth={2} />
            {t('folder.editor.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-aux font-medium',
              'btn-cta transition-colors duration-fast disabled:opacity-70 disabled:cursor-not-allowed'
            )}
          >
            {saving ? <Loader2 size={13} strokeWidth={2} className="animate-spin" /> : null}
            {saving ? t('folder.editor.saving') : t('folder.editor.save')}
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto scrollbar-thin flex flex-col min-h-0">
        {/* meta rows */}
        <MetaInput
          label={t('folder.editor.to')}
          value={to}
          placeholder={t('folder.editor.toPlaceholder')}
          onChange={setTo}
        />
        <MetaInput
          label={t('folder.editor.cc')}
          value={cc}
          placeholder={t('folder.editor.ccPlaceholder')}
          onChange={setCc}
        />
        <MetaInput
          label={t('folder.editor.subject')}
          value={subject}
          placeholder={t('folder.editor.subjectPlaceholder')}
          onChange={setSubject}
        />

        {/* format toolbar + TipTap body */}
        {editor && <FmtToolbar editor={editor} />}
        <div className="relative flex-1 min-h-0 px-8 py-4">
          {/* StarterKit v3 不带 Placeholder 扩展, 用 isEmpty 驱动一个定位 overlay
              代替 (editor.isEmpty 在 TipTap v3 transaction 后 re-render 刷新)。 */}
          {editor?.isEmpty && (
            <div
              aria-hidden
              className="pointer-events-none absolute left-8 top-4 text-body text-ink-fg-3"
            >
              {t('folder.editor.bodyPlaceholder')}
            </div>
          )}
          <EditorContent
            editor={editor}
            className="folder-draft-editor text-ink-fg-1 text-body leading-relaxed"
          />
        </div>
      </div>
    </main>
  )
}
