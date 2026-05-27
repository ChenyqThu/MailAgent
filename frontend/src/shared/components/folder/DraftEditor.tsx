// Phase C — 草稿编辑器 (新建 + 编辑共用). Sprint 18 视觉重写 →
// ref/mockup-draft-composer.html: mode 徽头 + .folder-field-row (From/To/Cc/
// Subject) + recipient-chip 胶囊 (回车/逗号成 chip) + TipTap 富文本正文 +
// .folder-editor-btn 格式工具栏 + send dock。占据 detail 列 (FolderLayout 在
// editing/creating 时用它替换 FolderDetail)。
//
// 数据契约不变: to/cc 内部仍以逗号拼接字符串存 (chip 是视图层), saveMut 照旧
// 发 to.trim()/cc.trim() 给 editDraft/createDraft。
//
// 发送 (Sprint 18 dogfood #1): dock 增「发送」按钮 (primary, 左侧, 对应 mockup
// 第 348 行)。点发送 → 收件人校验 → ConfirmDialog (复用 folder.confirm.send*
// 键 + Send kind)。确认后 sendMut 做 save → refetch drafts → match imap_uid
// 定位新行 id → sendDraft。这避免改 createDraft/editDraft IPC 返回契约
// (CLI 已经返回 IMAP UID 作为响应 data 字段 — appended_uid/new_uid)。
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
  ChevronDown,
  ChevronUp,
  Code,
  Italic,
  Link2,
  List,
  ListOrdered,
  Loader2,
  Paperclip as PaperclipMini,
  Save,
  Send,
  Strikethrough,
  Underline as UnderlineIcon,
  X
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'
import { parseSender } from '@shared/lib/mail_parse'
import { toastError, toastSuccess } from '@shared/state/toast'
import type { FolderEmailDetail, FolderEmailMeta } from '@shared/api/types'

import { ConfirmDialog } from './ConfirmDialog'

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

// 折叠态摘要: 前 2 个地址 + "+N"。
function summarizeAddrs(list: string[]): string {
  if (list.length === 0) return ''
  if (list.length <= 2) return list.join(', ')
  return `${list.slice(0, 2).join(', ')} +${list.length - 2}`
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
  // 收件人/抄送默认折叠 (编辑态只占一行, 把空间留给正文); 新建态展开方便填写。
  const [recipExpanded, setRecipExpanded] = useState(draft === null)
  const [sendDialogOpen, setSendDialogOpen] = useState(false)

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

  // send 流程: save → refetch drafts → match imap_uid 定位新行 id → sendDraft.
  // CLI 返回 {appended_uid} (create) / {new_uid} (edit). 这条路径完全在前端拼,
  // 不动 IPC 契约 (FolderApi.createDraft/editDraft 仍 returns unknown)。
  const sendMut = useMutation({
    mutationFn: async () => {
      const html = editor?.getHTML() ?? ''
      const to = joinAddrs(toList)
      const cc = joinAddrs(ccList)
      // 1) 保存 (新建 or 编辑) — CLI 返回 IMAP UID 作为 anchor
      let savedUid: number | null = null
      if (isEdit && draft) {
        const r = (await mailApi.folder.editDraft({
          id: draft.id,
          html,
          to,
          cc,
          subject
        })) as { new_uid?: number } | null
        savedUid = typeof r?.new_uid === 'number' ? r.new_uid : null
      } else {
        const r = (await mailApi.folder.createDraft({
          to,
          cc: cc || undefined,
          subject: subject || undefined,
          html
        })) as { appended_uid?: number } | null
        savedUid = typeof r?.appended_uid === 'number' ? r.appended_uid : null
      }
      // 2) 让 drafts 列表缓存刷掉, 再独立 list 一次找新行 id (不走 cached query
      //    避免 race; FolderList 那边的 query 会被 invalidate 异步刷)
      await queryClient.invalidateQueries({ queryKey: ['folder', 'drafts'] })
      if (savedUid === null) {
        // CLI 没给 uid (不该走到), 抛 locate fail
        throw new Error(t('folder.editor.sendLocateFail'))
      }
      const list = await mailApi.folder.list({ folder: 'drafts', limit: 200 })
      const target = list.find((m: FolderEmailMeta) => m.imap_uid === savedUid)
      if (!target) {
        // refresh_drafts 应该已经把新 row 落表了, 找不到是异常
        throw new Error(t('folder.editor.sendLocateFail'))
      }
      // 3) 真发送
      return mailApi.folder.sendDraft(target.id)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['folder', 'drafts'] })
      toastSuccess(t('folder.toast.sendOk'))
      onClose()
    },
    onError: (err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err))
      const code = (e as Error & { code?: string }).code
      toastError(t('folder.toast.sendFail'), code ? `${code} · ${e.message}` : e.message)
    }
  })

  const handleSendClick = useCallback(() => {
    if (toList.length === 0) {
      toastError(t('folder.editor.toRequired'))
      return
    }
    setSendDialogOpen(true)
  }, [toList, t])

  const confirmSend = useCallback(() => {
    setSendDialogOpen(false)
    sendMut.mutate()
  }, [sendMut])

  const saving = saveMut.isPending
  const sending = sendMut.isPending
  const busy = saving || sending

  // 给 ConfirmDialog 渲染收件人 chip — 复用 parseSender 把 "Name <a@x>"
  // 拆出可读 label, 跟 FolderDetail 的 send 对话框视觉一致。
  const recipientsForDialog = toList.map((addr) => {
    const p = parseSender(addr)
    const label = p.name ? `${p.name} <${p.email || addr}>` : p.email || addr
    const base = (p.email || addr).split('@')[0] || addr
    return { initials: base.slice(0, 2).toUpperCase(), label }
  })

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

      {/* recipients block — 折叠态只占一行 (编辑默认折叠, 把空间留给正文) */}
      <div className="border-b border-ink-border/60 shrink-0">
        {recipExpanded ? (
          <div className="relative">
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
            <button
              type="button"
              onClick={() => setRecipExpanded(false)}
              title={t('folder.editor.collapseRecipients')}
              aria-label={t('folder.editor.collapseRecipients')}
              className="absolute right-3 top-1.5 w-6 h-6 rounded grid place-items-center text-ink-fg-3 hover:text-ink-fg hover:bg-ink-3 transition-colors"
            >
              <ChevronUp size={14} strokeWidth={2} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setRecipExpanded(true)}
            aria-label={t('folder.editor.expandRecipients')}
            className="folder-field-row w-full text-left hover:bg-ink-3/30 transition-colors"
          >
            <span className="field-label">{t('folder.editor.to')}</span>
            <span className="flex-1 min-w-0 truncate text-aux">
              {toList.length > 0 ? (
                <span className="text-ink-fg-1">{summarizeAddrs(toList)}</span>
              ) : (
                <span className="text-ink-fg-3">{t('folder.editor.toPlaceholder')}</span>
              )}
              {ccList.length > 0 && (
                <span className="text-ink-fg-2">
                  {'  ·  '}
                  {t('folder.editor.cc')} {summarizeAddrs(ccList)}
                </span>
              )}
            </span>
            <ChevronDown size={14} strokeWidth={2} className="text-ink-fg-3 shrink-0" />
          </button>
        )}
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

      {/* send dock — 对应 mockup-draft-composer 第 348 行: 发送 (primary, 主操作)
          + 保存草稿 (中性, 二级) + 丢弃 (bare)。点「发送」会先保存再真发出。 */}
      <div className="border-t border-ink-border/60 bg-ink-2/40 px-3 py-2.5 flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={handleSendClick}
          disabled={busy}
          className="gbtn gbtn-primary"
          style={{ height: '34px' }}
        >
          {sending ? (
            <Loader2 size={13} strokeWidth={2} className="animate-spin" />
          ) : (
            <Send size={13} strokeWidth={2} />
          )}
          {sending ? t('folder.editor.sending') : t('folder.editor.send')}
        </button>
        <span className="w-px h-5 bg-ink-border-soft mx-1" aria-hidden />
        <button
          type="button"
          onClick={handleSave}
          disabled={busy}
          className="gbtn"
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
          disabled={busy}
          className="gbtn gbtn-bare"
          style={{ height: '34px' }}
        >
          <X size={13} strokeWidth={2} />
          {t('folder.editor.cancel')}
        </button>
      </div>

      <ConfirmDialog
        open={sendDialogOpen}
        kind="send"
        danger
        title={t('folder.confirm.sendTitle', { count: recipientsForDialog.length })}
        body={
          <span>
            {t('folder.confirm.sendBodyLead')}{' '}
            <strong className="text-ink-fg">{t('folder.confirm.sendBodyStress')}</strong>
            {t('folder.confirm.sendBodyTail')}
          </span>
        }
        extra={
          <>
            {recipientsForDialog.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {recipientsForDialog.map((r, i) => (
                  <span key={`${r.label}-${i}`} className="recipient-chip">
                    <span className="rc-av">{r.initials}</span>
                    {r.label}
                  </span>
                ))}
              </div>
            )}
            {isEdit && draft && draft.attachments && draft.attachments.length > 0 && (
              <div className="mt-3 flex items-center gap-2 text-meta text-ink-fg-2 font-mono">
                <PaperclipMini size={12} strokeWidth={2} />
                {t('folder.confirm.sendAttachNote', { count: draft.attachments.length })}
              </div>
            )}
          </>
        }
        confirmLabel={t('folder.confirm.confirmSend')}
        cancelLabel={t('folder.confirm.cancel')}
        pending={sending}
        onConfirm={confirmSend}
        onCancel={() => setSendDialogOpen(false)}
      />
    </main>
  )
}
