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
import { FileText, Image as ImageIcon, Mail, Paperclip } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'
import { formatDate, formatRelativeTime } from '@shared/format'
import { formatFileSize } from '@shared/format'
import { parseSender } from '@shared/lib/mail_parse'
import { toastError, toastSuccess } from '@shared/state/toast'
import type { FolderAttachmentMeta, FolderName } from '@shared/api/types'

import { ConfirmDialog } from './ConfirmDialog'
import { FolderBodyFrame } from './FolderBodyFrame'
import { FolderToolbar, type FolderToolbarPending } from './FolderToolbar'

interface Props {
  folder: FolderName
  id: number | null
  /** drafts 模式 — 点「编辑」时回调, FolderLayout 用它打开 DraftEditor. */
  onEdit?: (id: number) => void
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }): React.ReactElement {
  return (
    <>
      <span className="text-ink-fg-2 font-mono text-aux">{label}</span>
      <span className="text-ink-fg-1 break-words">{value}</span>
    </>
  )
}

function EmptyShell({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <main
      aria-label="folder-main"
      className="flex-1 min-w-0 glass-3 flex items-center justify-center"
    >
      {children}
    </main>
  )
}

// 只读附件列表 (Phase D 再接二进制下载). 复用 AttachmentList 的视觉但不可点。
function AttachmentTile({ att }: { att: FolderAttachmentMeta }): React.ReactElement {
  const ct = (att.content_type ?? '').toLowerCase()
  const name = (att.filename ?? '').toLowerCase()
  const isImage = ct.startsWith('image/') || /\.(png|jpe?g|gif|webp|heic|svg)$/.test(name)
  const isPdf = ct === 'application/pdf' || name.endsWith('.pdf')
  const Icon = isImage
    ? ImageIcon
    : isPdf || /\.(docx?|xlsx?|pptx?|csv)$/.test(name)
      ? FileText
      : Paperclip
  const tone = isImage
    ? { bg: 'bg-info/10', border: 'border-info/25', text: 'text-info' }
    : isPdf
      ? { bg: 'bg-fail/10', border: 'border-fail/25', text: 'text-fail' }
      : { bg: 'bg-ink-4', border: 'border-ink-border', text: 'text-ink-fg-2' }
  return (
    <div
      className={cn(
        'flex items-start gap-3 px-3 py-2.5 rounded-md border border-ink-border bg-ink-2'
      )}
    >
      <div
        className={cn(
          'w-9 h-9 rounded-md grid place-items-center shrink-0 border',
          tone.bg,
          tone.border
        )}
      >
        <Icon size={16} strokeWidth={2} className={tone.text} />
      </div>
      <div className="min-w-0 flex-1 self-center">
        <div className="text-aux text-ink-fg font-medium truncate">
          {att.filename || '(unnamed)'}
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

export function FolderDetail({ folder, id, onEdit }: Props): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const queryClient = useQueryClient()
  const isDrafts = folder === 'drafts'
  const [dialog, setDialog] = useState<DialogKind>(null)

  const detailQ = useQuery({
    queryKey: ['folder-email', id],
    queryFn: () => mailApi.folder.get(id as number),
    enabled: id !== null,
    staleTime: 30_000,
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

  if (id === null) {
    return (
      <EmptyShell>
        <div className="text-aux text-ink-fg-2">
          <Mail size={28} strokeWidth={1.5} className="inline-block opacity-30 mb-2" />
          <div>{t('folder.selectHint')}</div>
        </div>
      </EmptyShell>
    )
  }
  if (detailQ.isLoading) {
    return (
      <EmptyShell>
        <div className="text-aux text-ink-fg-2 animate-pulse">{t('folder.loading')}</div>
      </EmptyShell>
    )
  }
  if (detailQ.isError || !detailQ.data) {
    return (
      <EmptyShell>
        <div className="text-aux text-fail">
          {detailQ.error instanceof Error ? detailQ.error.message : t('folder.empty')}
        </div>
      </EmptyShell>
    )
  }

  const email = detailQ.data
  const fromParsed = parseSender(email.sender)
  const fromName = email.sender_name || fromParsed.name
  const fromAddr = fromParsed.email || email.sender
  const attachments = email.attachments ?? []

  // dialog 文案选择
  const dialogProps =
    dialog === 'move'
      ? {
          title: t('folder.confirm.moveTitle'),
          body: t('folder.confirm.moveBody'),
          confirmLabel: t('folder.confirm.confirmMove'),
          danger: false
        }
      : dialog === 'send'
        ? {
            title: t('folder.confirm.sendTitle'),
            body: t('folder.confirm.sendBody'),
            confirmLabel: t('folder.confirm.confirmSend'),
            danger: true
          }
        : dialog === 'delete'
          ? isDrafts
            ? {
                title: t('folder.confirm.deleteDraftTitle'),
                body: t('folder.confirm.deleteDraftBody'),
                confirmLabel: t('folder.confirm.confirmDeleteDraft'),
                danger: true
              }
            : {
                title: t('folder.confirm.deleteTitle'),
                body: t('folder.confirm.deleteBody'),
                confirmLabel: t('folder.confirm.confirmDelete'),
                danger: true
              }
          : null

  return (
    <main aria-label="folder-main" className="flex-1 min-w-0 glass-3 flex flex-col min-h-0">
      <FolderToolbar
        folder={folder}
        onMoveToInbox={!isDrafts ? () => setDialog('move') : undefined}
        onDelete={() => setDialog('delete')}
        onEdit={isDrafts && onEdit ? () => onEdit(email.id) : undefined}
        onSend={isDrafts ? () => setDialog('send') : undefined}
        pending={pending}
      />

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="px-8 pt-6 pb-3 border-b border-ink-border-soft">
          <h1 className="text-subj font-semibold text-ink-fg leading-snug tracking-tight break-words">
            {email.subject || '(no subject)'}
          </h1>
        </div>

        <div className="px-8 pt-4 pb-6">
          <dl className="mt-1 grid grid-cols-[96px_1fr] gap-y-1.5 gap-x-3 text-aux">
            {/* 草稿: From 是自己, To 才是重点 — 都展示。 */}
            <MetaRow
              label="From"
              value={
                <>
                  {fromName && <span className="font-medium text-ink-fg">{fromName}</span>}
                  {fromName && fromAddr && <span className="text-ink-fg-2"> · </span>}
                  <span className="text-ink-fg-2">{fromAddr || '—'}</span>
                </>
              }
            />
            <MetaRow
              label="To"
              value={
                email.to_addr && email.to_addr.length > 0 ? (
                  <span className="text-ink-fg-1 break-words">{email.to_addr}</span>
                ) : (
                  <span className="text-ink-fg-3">—</span>
                )
              }
            />
            {email.cc_addr && email.cc_addr.length > 0 && (
              <MetaRow
                label="Cc"
                value={<span className="text-ink-fg-1 break-words">{email.cc_addr}</span>}
              />
            )}
            {email.date_received && (
              <MetaRow
                label="Date"
                value={
                  <span className="font-mono text-aux">
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

          {/* Body */}
          <div className="mt-7">
            <FolderBodyFrame html={email.body_html} />
          </div>

          {/* Attachments — 只读元数据 (Phase D 接二进制下载) */}
          {attachments.length > 0 && (
            <section aria-label="attachments" className="mt-8">
              <div className="flex items-center gap-2 mb-3">
                <Paperclip size={13} strokeWidth={2} className="text-ink-fg-2" />
                <span
                  className="text-meta font-mono uppercase text-ink-fg-1"
                  style={{ letterSpacing: '0.06em' }}
                >
                  {t('folder.attachments')} · {attachments.length}
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
          danger={dialogProps.danger}
          onConfirm={confirmAction}
          onCancel={() => setDialog(null)}
        />
      )}
    </main>
  )
}
