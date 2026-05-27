// Phase C — 草稿编辑器 (新建 + 编辑共用). Sprint 18 视觉重写 →
// ref/mockup-draft-composer.html: mode 徽头 + .folder-field-row (From/To/Cc/
// Subject) + recipient-chip 胶囊 (回车/逗号成 chip) + TipTap 富文本正文 +
// .folder-editor-btn 格式工具栏 + send dock。占据 detail 列 (FolderLayout 在
// editing/creating 时用它替换 FolderDetail)。
//
// 数据契约不变: to/cc 内部仍以逗号拼接字符串存 (chip 是视图层), saveMut 照旧
// 发 to.trim()/cc.trim() 给 editDraft/createDraft。草稿不走 sendDraft (那是
// FolderDetail toolbar 的活), 所以 dock 只有「保存草稿」+「丢弃」, 无发送。
//
// TipTap v3 注意: StarterKit 已内置 Bold/Italic/Strike/Underline/Link/Code/
// CodeBlock/BulletList/OrderedList/ListItem 等, 这里只挂 StarterKit。Link 默认
// openOnClick=true, 编辑器里关掉。输出走 editor.getHTML()。

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
  Save,
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

// "a@x, b@y" → ['a@x', 'b@y']; chip 视图层用, 不改底层逗号拼接契约。
function splitAddrs(raw: string): string[] {
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)
}
function joinAddrs(list: string[]): string {
  return list.join(', ')
}
function chipInitials(addr: string): string {
  const at = addr.split('@')[0] ?? addr
  return (at.slice(0, 2) || '?').toUpperCase()
}

// ── format toolbar button (mockup .folder-editor-btn) ────────────────────
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
      className={cn('folder-editor-btn', active && 'is-on')}
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
    <div className="border-t border-ink-border/60 bg-ink-2/40 px-3 py-2 flex items-center gap-1.5 shrink-0">
      <FmtBtn
        icon={<Bold size={13} strokeWidth={2.5} />}
        label={t('folder.editor.bold')}
        active={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
      />
      <FmtBtn
        icon={<Italic size={13} strokeWidth={2} />}
        label={t('folder.editor.italic')}
        active={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      />
      <FmtBtn
        icon={<UnderlineIcon size={13} strokeWidth={2} />}
        label={t('folder.editor.underline')}
        active={editor.isActive('underline')}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      />
      <FmtBtn
        icon={<Strikethrough size={13} strokeWidth={2} />}
        label={t('folder.editor.strike')}
        active={editor.isActive('strike')}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      />
      <span className="w-px h-5 bg-ink-border-soft mx-1" aria-hidden />
      <FmtBtn
        icon={<List size={13} strokeWidth={2} />}
        label={t('folder.editor.bulletList')}
        active={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      />
      <FmtBtn
        icon={<ListOrdered size={13} strokeWidth={2} />}
        label={t('folder.editor.orderedList')}
        active={editor.isActive('orderedList')}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      />
      <span className="w-px h-5 bg-ink-border-soft mx-1" aria-hidden />
      <FmtBtn
        icon={<Link2 size={13} strokeWidth={2} />}
        label={t('folder.editor.link')}
        active={editor.isActive('link')}
        onClick={addLink}
      />
      <FmtBtn
        icon={<Code size={13} strokeWidth={2} />}
        label={t('folder.editor.code')}
        active={editor.isActive('code')}
        onClick={() => editor.chain().focus().toggleCode().run()}
      />
    </div>
  )
}

// ── recipient chip field (mockup .folder-field-row + recipient-chip) ──────
function ChipField({
  label,
  values,
  placeholder,
  onChange
}: {
  label: string
  values: string[]
  placeholder: string
  onChange: (next: string[]) => void
}): React.ReactElement {
  const [input, setInput] = useState('')

  const commit = useCallback(() => {
    const v = input.trim().replace(/,$/, '')
    if (!v) return
    onChange([...values, v])
    setInput('')
  }, [input, values, onChange])

  const handleKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault()
        commit()
      } else if (e.key === 'Backspace' && input === '' && values.length > 0) {
        // 空输入退格删最后一个 chip
        onChange(values.slice(0, -1))
      }
    },
    [commit, input, values, onChange]
  )

  const removeAt = useCallback(
    (idx: number) => onChange(values.filter((_, i) => i !== idx)),
    [values, onChange]
  )

  return (
    <div className="folder-field-row">
      <span className="field-label">{label}</span>
      <div className="flex items-center gap-1.5 flex-wrap min-w-0">
        {values.map((addr, i) => (
          <span key={`${addr}-${i}`} className="recipient-chip">
            <span className="rc-av">{chipInitials(addr)}</span>
            <span>{addr}</span>
            <button
              type="button"
              className="rc-close"
              aria-label="remove"
              onClick={() => removeAt(i)}
            >
              <X size={11} strokeWidth={2.2} />
            </button>
          </span>
        ))}
        <input
          value={input}
          placeholder={values.length === 0 ? placeholder : ''}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKey}
          onBlur={commit}
        />
      </div>
    </div>
  )
}

export function DraftEditor({ draft, onClose }: Props): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const queryClient = useQueryClient()
  const isEdit = draft !== null

  const [toList, setToList] = useState<string[]>(() => splitAddrs(draft?.to_addr ?? ''))
  const [ccList, setCcList] = useState<string[]>(() => splitAddrs(draft?.cc_addr ?? ''))
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
    // 会 warning; Electron renderer 是纯 CSR, 显式 false 兜底 double-mount。
    immediatelyRender: false
  })

  const invalidateDrafts = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['folder', 'drafts'] }),
    [queryClient]
  )

  const saveMut = useMutation({
    mutationFn: async () => {
      const html = editor?.getHTML() ?? ''
      const to = joinAddrs(toList)
      const cc = joinAddrs(ccList)
      if (isEdit && draft) {
        return mailApi.folder.editDraft({
          id: draft.id,
          html,
          to,
          cc,
          subject
        })
      }
      return mailApi.folder.createDraft({
        to,
        cc: cc || undefined,
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
    if (!isEdit && toList.length === 0) {
      toastError(t('folder.editor.toRequired'))
      return
    }
    saveMut.mutate()
  }, [isEdit, toList, saveMut, t])

  const saving = saveMut.isPending

  return (
    <main aria-label="draft-editor" className="flex-1 min-w-0 glass-3 flex flex-col min-h-0">
      {/* mode 徽头 */}
      <header className="h-12 shrink-0 border-b border-ink-border/60 flex items-center gap-2.5 px-4">
        <span className="text-micro font-mono uppercase tracking-wider px-2 py-1 rounded text-coral bg-coral/[0.12] border border-coral/30">
          {isEdit ? t('folder.editor.editTitle') : t('folder.editor.newTitle')}
        </span>
        <span className="text-meta text-ink-fg-2 truncate">
          {isEdit ? t('folder.editor.editHint') : t('folder.editor.newHint')}
        </span>
      </header>

      {/* recipients block */}
      <div className="border-b border-ink-border/60 shrink-0">
        <ChipField
          label={t('folder.editor.to')}
          values={toList}
          placeholder={t('folder.editor.toPlaceholder')}
          onChange={setToList}
        />
        <ChipField
          label={t('folder.editor.cc')}
          values={ccList}
          placeholder={t('folder.editor.ccPlaceholder')}
          onChange={setCcList}
        />
        <div className="folder-field-row">
          <span className="field-label">{t('folder.editor.subject')}</span>
          <input
            className="text-aux font-medium"
            value={subject}
            placeholder={t('folder.editor.subjectPlaceholder')}
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>
      </div>

      {/* editor body */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="relative max-w-[760px] mx-auto px-10 pt-7 pb-12">
          {/* StarterKit v3 不带 Placeholder 扩展, 用 isEmpty 驱动一个定位 overlay
              代替 (editor.isEmpty 在 TipTap v3 transaction 后 re-render 刷新)。 */}
          {editor?.isEmpty && (
            <div
              aria-hidden
              className="pointer-events-none absolute left-10 top-7 text-body text-ink-fg-3"
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

      {/* format toolbar */}
      {editor && <FmtToolbar editor={editor} />}

      {/* send dock — 草稿不发送, 只「保存草稿」+「丢弃」 */}
      <div className="border-t border-ink-border/60 bg-ink-2/40 px-3 py-2.5 flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="gbtn gbtn-primary"
          style={{ height: '34px' }}
        >
          {saving ? (
            <Loader2 size={13} strokeWidth={2} className="animate-spin" />
          ) : (
            <Save size={13} strokeWidth={2} />
          )}
          {saving ? t('folder.editor.saving') : t('folder.editor.save')}
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="gbtn gbtn-bare"
          style={{ height: '34px' }}
        >
          <X size={13} strokeWidth={2} />
          {t('folder.editor.cancel')}
        </button>
      </div>
    </main>
  )
}
