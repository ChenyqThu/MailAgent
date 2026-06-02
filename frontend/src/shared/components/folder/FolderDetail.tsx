// Phase C — 存档 / 草稿箱详情面板. 仿 EmailDetail 但精简: 无 AIFieldsBlock /
// 无翻译 / 无 thread。useQuery(['folder-email', id]) 拉详情 (含 body_html +
// 附件元数据)。MetaRow + FolderBodyFrame(body_html) + 只读附件列表 (Phase D
// 再做二进制下载)。
//
// 顶部 FolderToolbar:
//   archive: 移回收件箱 + 永久删除 (都弹 ConfirmDialog, 删除危险样式)
//   drafts:  编辑 (→ onEdit 打开 DraftEditor) + 发送 (二次确认) + 删除 (二次确认)
//
// 写操作走 react-query useMutation, onSuccess invalidate ['folder', folder] +
// toast (plan ③ 即时刷新)。

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import {
  AlertCircle,
  ArrowLeft,
  FileText,
  Flag,
  Image as ImageIcon,
  Mail,
  Paperclip,
  Paperclip as PaperclipMini
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useIsBelowLg } from '@shared/hooks/useMediaQuery'
import { formatDate, formatRelativeTime } from '@shared/format'
import { formatFileSize } from '@shared/format'
import { parseSender } from '@shared/lib/mail_parse'
import { toastError, toastSuccess } from '@shared/state/toast'
import type { FolderAttachmentMeta, FolderName } from '@shared/api/types'

import { ConfirmDialog, type ConfirmKind } from './ConfirmDialog'
import { FolderBodyFrame } from './FolderBodyFrame'
import { FolderToolbar, type FolderToolbarPending } from './FolderToolbar'

// avatar hue slot (1..6) — 与 FolderRow 同 djb2 hash, 详情头像与列表一致。
function avatarSlot(seed: string): 1 | 2 | 3 | 4 | 5 | 6 {
  let hash = 5381
  for (let i = 0; i < seed.length; i++) hash = (hash * 33) ^ seed.charCodeAt(i)
  return (((hash >>> 0) % 6) + 1) as 1 | 2 | 3 | 4 | 5 | 6
}
function avatarInitials(name: string): string {
  const s = name.trim()
  if (!s) return '?'
  if (/[一-鿿]/.test(s)) return s.slice(0, 2)
  const parts = s.split(/\s+/).filter(Boolean)
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + (parts[1]?.[0] ?? '')).toUpperCase()
}

// 把 "a@x, b@y" 拆成收件人列表 → 确认发送时渲染 recipient-chip。
function splitRecipients(raw: string): { initials: string; label: string }[] {
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((addr) => {
      const p = parseSender(addr)
      const label = p.name ? `${p.name} <${p.email || addr}>` : p.email || addr
      const base = (p.email || addr).split('@')[0] || addr
      return { initials: base.slice(0, 2).toUpperCase(), label }
    })
}

interface Props {
  folder: FolderName
  id: number | null
  /** drafts 模式 — 点「编辑」时回调, FolderLayout 用它打开 DraftEditor. */
  onEdit?: (id: number) => void
  /** <lg 详情覆盖列表时的返回入口（清选中）。FolderLayout 传 setSelectedId(null)。 */
  onBack?: () => void
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }): React.ReactElement {
  return (
    <>
      <span className="font-mono uppercase tracking-wider text-ink-fg-3">{label}</span>
      <span className="text-ink-fg-1 break-words">{value}</span>
    </>
  )
}

function EmptyShell({
  children,
  onBack
}: {
  children: React.ReactNode
  onBack?: () => void
}): React.ReactElement {
  // <lg 详情覆盖列表时，loading / error 空态没有 FolderToolbar 的返回按钮，
  // 这里自带一个防窄屏卡死。≥lg lg:hidden 收起 → 桌面零回归。onBack 仅选中态
  // 由 FolderDetail 传入（未选中态整列已被 FolderLayout 隐藏，不会显示）。
  const { t } = useTranslation()
  const belowLg = useIsBelowLg()
  return (
    <main
      aria-label="folder-main"
      className="relative flex-1 min-w-0 glass-3 flex items-center justify-center"
    >
      {belowLg && onBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label={t('toolbar.backToList', { defaultValue: '返回列表' })}
          className="lg:hidden absolute top-2 left-2 inline-flex items-center justify-center w-8 h-8 rounded-md text-ink-fg-2 hover:text-ink-fg hover:bg-ink-4 transition-colors duration-fast"
        >
          <ArrowLeft size={16} strokeWidth={2} />
        </button>
      )}
      {children}
    </main>
  )
}

// 只读附件 tile (Phase D 再接二进制下载). 复用 mockup .tile 视觉但不可点:
// image → warn 调, pdf/office → fail 调, 其余中性 ink。
function AttachmentTile({ att }: { att: FolderAttachmentMeta }): React.ReactElement {
  const { t } = useTranslation()
  const ct = (att.content_type ?? '').toLowerCase()
  const name = (att.filename ?? '').toLowerCase()
  const isImage = ct.startsWith('image/') || /\.(png|jpe?g|gif|webp|heic|svg)$/.test(name)
  const isDoc = ct === 'application/pdf' || /\.(pdf|docx?|xlsx?|pptx?|csv)$/.test(name)
  const Icon = isImage ? ImageIcon : isDoc ? FileText : Paperclip
  const iconTone = isImage ? 'text-warn' : isDoc ? 'text-fail' : 'text-ink-fg-2'
  return (
    <div className="tile rounded-md p-3 flex items-center gap-3 border border-ink-border-soft cursor-default">
      <div className="w-9 h-9 rounded bg-ink-4 grid place-items-center shrink-0">
        <Icon size={16} strokeWidth={2} className={iconTone} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-aux text-ink-fg font-medium truncate">
          {att.filename || t('folder.unnamedAttachment')}
        </div>
        <div className="text-meta font-mono text-ink-fg-2 tabular-nums">
          {att.size > 0 ? formatFileSize(att.size) : '—'}
          {att.content_type && (
            <>
              <span className="mx-1 text-ink-fg-3">·</span>
              <span className="text-ink-fg-2">{att.content_type}</span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

type DialogKind = 'move' | 'delete' | 'send' | null

export function FolderDetail({ folder, id, onEdit, onBack }: Props): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const queryClient = useQueryClient()
  const isDrafts = folder === 'drafts'
  const [dialog, setDialog] = useState<DialogKind>(null)

  const detailQ = useQuery({
    queryKey: ['folder-email', id],
    queryFn: () => mailApi.folder.get(id as number),
    enabled: id !== null,
    // 详情含 body_html (folder_email 落库的不可变正文), 重开同一封无需重拉。
    // staleTime 5min 避免切回/重选时 refetch, gcTime 15min 让缓存在列表卸载
    // (切去其它视图) 后存活, 切回点同一封即时打开。与列表缓存策略对齐。
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
    placeholderData: keepPreviousData
  })

  const invalidateList = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['folder', folder] }),
    [queryClient, folder]
  )

  const moveMut = useMutation({
    mutationFn: () => mailApi.folder.move(id as number, '收件箱'),
    onSuccess: async () => {
      await invalidateList()
      toastSuccess(t('folder.toast.moveOk'))
    },
    onError: (err: unknown) => surfaceErr(err, t('folder.toast.moveFail'))
  })
  const deleteMut = useMutation({
    mutationFn: () => mailApi.folder.deleteMsg(id as number),
    onSuccess: async () => {
      await invalidateList()
      toastSuccess(t('folder.toast.deleteOk'))
    },
    onError: (err: unknown) => surfaceErr(err, t('folder.toast.deleteFail'))
  })
  const sendMut = useMutation({
    mutationFn: () => mailApi.folder.sendDraft(id as number),
    onSuccess: async () => {
      await invalidateList()
      toastSuccess(t('folder.toast.sendOk'))
    },
    onError: (err: unknown) => surfaceErr(err, t('folder.toast.sendFail'))
  })

  function surfaceErr(err: unknown, title: string): void {
    const e = err instanceof Error ? err : new Error(String(err))
    const code = (e as Error & { code?: string }).code
    toastError(title, code ? `${code} · ${e.message}` : e.message)
  }

  const pending: FolderToolbarPending = {
    move: moveMut.isPending,
    delete: deleteMut.isPending,
    send: sendMut.isPending
  }

  const confirmAction = useCallback(() => {
    const kind = dialog
    setDialog(null)
    if (kind === 'move') moveMut.mutate()
    else if (kind === 'delete') deleteMut.mutate()
    else if (kind === 'send') sendMut.mutate()
  }, [dialog, moveMut, deleteMut, sendMut])

  const PlaceholderIcon = isDrafts ? FileText : Mail

  if (id === null) {
    return (
      <EmptyShell onBack={onBack}>
        <div className="flex flex-col items-center text-center px-8">
          <div className="w-14 h-14 rounded-2xl grid place-items-center mb-4 bg-ink-2/50 border border-ink-border-soft">
            <PlaceholderIcon size={24} strokeWidth={1.5} className="text-ink-fg-3" />
          </div>
          <div className="text-aux text-ink-fg-1 font-medium mb-1">
            {isDrafts ? t('folder.detail.noDraftSelected') : t('folder.detail.noMailSelected')}
          </div>
          <p className="text-meta text-ink-fg-3 max-w-[200px]">{t('folder.selectHint')}</p>
        </div>
      </EmptyShell>
    )
  }
  if (detailQ.isLoading) {
    return (
      <EmptyShell onBack={onBack}>
        <div className="text-aux text-ink-fg-2 animate-pulse motion-reduce:animate-none">
          {t('folder.loading')}
        </div>
      </EmptyShell>
    )
  }
  if (detailQ.isError || !detailQ.data) {
    return (
      <EmptyShell onBack={onBack}>
        <div className="flex flex-col items-center text-center px-8">
          <div className="w-14 h-14 rounded-2xl grid place-items-center mb-4 bg-fail/10 border border-fail/25">
            <AlertCircle size={24} strokeWidth={1.6} className="text-fail" />
          </div>
          <div className="text-aux text-ink-fg-1 font-medium mb-1">
            {t('folder.detail.loadFailed')}
          </div>
          <p className="text-meta text-ink-fg-3 max-w-[220px] break-words">
            {detailQ.error instanceof Error ? detailQ.error.message : t('folder.empty')}
          </p>
        </div>
      </EmptyShell>
    )
  }

  const email = detailQ.data
  const fromParsed = parseSender(email.sender)
  const fromName = email.sender_name || fromParsed.name
  const fromAddr = fromParsed.email || email.sender
  const attachments = email.attachments ?? []
  const subjectText = email.subject?.trim() ? email.subject : t('folder.detail.noSubject')

  // 详情头像 (archive sender-led; drafts 也用发件人=自己的徽). 与列表一致。
  const avatarName = fromName || fromAddr.split('@')[0] || '?'
  const detailSlot = avatarSlot(email.sender || String(email.id))
  const detailInitials = avatarInitials(avatarName)

  // 早返回之后才算 — 不能用 useMemo (会成条件 hook); splitRecipients 很轻。
  const recipients = splitRecipients(email.to_addr ?? '')

  // dialog 文案 + 图标徽 + 富内容槽
  const dialogProps: {
    title: string
    body: React.ReactNode
    confirmLabel: string
    kind: ConfirmKind
    danger: boolean
    extra?: React.ReactNode
  } | null =
    dialog === 'move'
      ? {
          title: t('folder.confirm.moveTitle'),
          body: (
            <span>
              「<span className="text-ink-fg font-medium">{subjectText}</span>」
              {t('folder.confirm.moveBodyTail')}
            </span>
          ),
          confirmLabel: t('folder.confirm.confirmMove'),
          kind: 'move',
          danger: false
        }
      : dialog === 'send'
        ? {
            title: t('folder.confirm.sendTitle', { count: recipients.length }),
            body: (
              <span>
                {t('folder.confirm.sendBodyLead')}{' '}
                <strong className="text-ink-fg">{t('folder.confirm.sendBodyStress')}</strong>
                {t('folder.confirm.sendBodyTail')}
              </span>
            ),
            confirmLabel: t('folder.confirm.confirmSend'),
            kind: 'send',
            danger: true,
            extra: (
              <>
                {recipients.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {recipients.map((r, i) => (
                      <span key={`${r.label}-${i}`} className="recipient-chip">
                        <span className="rc-av">{r.initials}</span>
                        {r.label}
                      </span>
                    ))}
                  </div>
                )}
                {attachments.length > 0 && (
                  <div className="mt-3 flex items-center gap-2 text-meta text-ink-fg-2 font-mono">
                    <PaperclipMini size={12} strokeWidth={2} />
                    {t('folder.confirm.sendAttachNote', { count: attachments.length })}
                  </div>
                )}
              </>
            )
          }
        : dialog === 'delete'
          ? isDrafts
            ? {
                title: t('folder.confirm.deleteDraftTitle'),
                body: (
                  <span>
                    「<span className="text-ink-fg font-medium">{subjectText}</span>」
                    {t('folder.confirm.deleteDraftBodyTail')}
                    <strong className="text-fail">{t('folder.confirm.deleteIrreversible')}</strong>
                    。
                  </span>
                ),
                confirmLabel: t('folder.confirm.confirmDeleteDraft'),
                kind: 'deleteDraft',
                danger: true
              }
            : {
                title: t('folder.confirm.deleteTitle'),
                body: (
                  <span>
                    「<span className="text-ink-fg font-medium">{subjectText}</span>」
                    {t('folder.confirm.deleteBodyTail')}
                  </span>
                ),
                confirmLabel: t('folder.confirm.confirmDelete'),
                kind: 'delete',
                danger: true,
                extra: (
                  <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-fail/[0.08] border border-fail/20">
                    <AlertCircle size={13} strokeWidth={2} className="text-fail shrink-0 mt-0.5" />
                    <span className="text-meta text-ink-fg-1 leading-snug">
                      {t('folder.confirm.deleteWarnLead')}
                      <strong className="text-fail">
                        {t('folder.confirm.deleteIrreversible')}
                      </strong>
                      {t('folder.confirm.deleteWarnTail')}
                    </span>
                  </div>
                )
              }
          : null

  return (
    <main aria-label="folder-main" className="flex-1 min-w-0 glass-3 flex flex-col min-h-0">
      <FolderToolbar
        folder={folder}
        onBack={onBack}
        onMoveToInbox={!isDrafts ? () => setDialog('move') : undefined}
        onDelete={() => setDialog('delete')}
        onEdit={isDrafts && onEdit ? () => onEdit(email.id) : undefined}
        onSend={isDrafts ? () => setDialog('send') : undefined}
        pending={pending}
      />

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="max-w-[820px] mx-auto px-10 pt-8 pb-16">
          <header className="mb-6 pb-5 border-b border-ink-border-soft">
            {/* drafts: 「草稿」徽 + 最后保存; archive: 留空 (sender 块承载身份) */}
            {isDrafts && (
              <div className="flex items-center gap-2 mb-3">
                <span className="text-micro font-mono uppercase tracking-wider text-coral px-2 py-0.5 rounded bg-coral/[0.12] border border-coral/30">
                  {t('folder.detail.draftBadge')}
                </span>
              </div>
            )}

            <h1 className="text-subj font-semibold tracking-tight leading-snug mb-4 text-ink-fg break-words">
              {subjectText}
            </h1>

            {isDrafts ? (
              // 草稿 — recipient 优先的 label/value 网格 (无身份头像块)
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-meta">
                <MetaRow
                  label={t('folder.detail.from')}
                  value={
                    <>
                      {fromAddr || '—'}{' '}
                      <span className="text-ink-fg-3">{t('folder.detail.selfTag')}</span>
                    </>
                  }
                />
                <MetaRow
                  label={t('folder.detail.to')}
                  value={
                    email.to_addr && email.to_addr.length > 0 ? (
                      email.to_addr
                    ) : (
                      <span className="text-ink-fg-3 italic">{t('folder.detail.noRecipient')}</span>
                    )
                  }
                />
                {email.cc_addr && email.cc_addr.length > 0 && (
                  <MetaRow label={t('folder.detail.cc')} value={email.cc_addr} />
                )}
                {email.date_received && (
                  <MetaRow
                    label={t('folder.detail.lastModified')}
                    value={<span className="font-mono">{formatDate(email.date_received)}</span>}
                  />
                )}
              </dl>
            ) : (
              // 存档 — sender 头像块 + label/value 网格 + 旗标指示
              <div className="flex items-start gap-3">
                <div className={cn('folder-avatar', `avatar-${detailSlot}`)} aria-hidden>
                  {detailInitials}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    {fromName && (
                      <span className="text-aux font-medium text-ink-fg">{fromName}</span>
                    )}
                    {fromAddr && (
                      <span className="text-meta font-mono text-ink-fg-2">&lt;{fromAddr}&gt;</span>
                    )}
                  </div>
                  <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-meta">
                    <MetaRow
                      label={t('folder.detail.to')}
                      value={
                        email.to_addr && email.to_addr.length > 0 ? (
                          email.to_addr
                        ) : (
                          <span className="text-ink-fg-3">—</span>
                        )
                      }
                    />
                    {email.cc_addr && email.cc_addr.length > 0 && (
                      <MetaRow label={t('folder.detail.cc')} value={email.cc_addr} />
                    )}
                    {email.date_received && (
                      <MetaRow
                        label={t('folder.detail.date')}
                        value={
                          <span className="font-mono">
                            {formatDate(email.date_received)}
                            <span className="text-ink-fg-2">
                              {' '}
                              · {formatRelativeTime(email.date_received)}
                            </span>
                          </span>
                        }
                      />
                    )}
                  </dl>
                </div>
                {email.is_flagged && (
                  <div className="text-meta font-mono text-ink-fg-2 flex items-center gap-1.5 shrink-0">
                    <Flag size={13} strokeWidth={1.5} className="text-coral fill-coral" />
                    {t('folder.detail.flagged')}
                  </div>
                )}
              </div>
            )}
          </header>

          {/* Body */}
          <FolderBodyFrame html={email.body_html} />

          {/* Attachments — 只读元数据 (Phase D 接二进制下载) */}
          {attachments.length > 0 && (
            <section aria-label="attachments" className="mt-8">
              <div className="text-micro font-mono uppercase tracking-wider text-ink-fg-2 mb-2.5">
                {t('folder.attachments')} · {attachments.length}{' '}
                <span className="text-ink-fg-3 normal-case tracking-normal">
                  {t('folder.detail.attachmentsReadonly')}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {attachments.map((att, i) => (
                  <AttachmentTile key={`${att.filename}-${i}`} att={att} />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>

      {dialogProps && (
        <ConfirmDialog
          open={dialog !== null}
          title={dialogProps.title}
          body={dialogProps.body}
          confirmLabel={dialogProps.confirmLabel}
          cancelLabel={t('folder.confirm.cancel')}
          kind={dialogProps.kind}
          danger={dialogProps.danger}
          extra={dialogProps.extra}
          pending={pending.move || pending.delete || pending.send}
          onConfirm={confirmAction}
          onCancel={() => setDialog(null)}
        />
      )}
    </main>
  )
}
