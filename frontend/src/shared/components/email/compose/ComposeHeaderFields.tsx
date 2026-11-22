// Compose pure presentation headers extracted from ComposePanel:
// ComposeActionHeader (Outlook-style top action toolbar) and
// ComposeHeaderFields (From / To / Cc / Bcc / Subject + Importance).

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown,
  FileDown,
  Flag,
  Loader2,
  Paperclip,
  PenLine,
  RotateCcw,
  Send,
  Trash2,
  X
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import type { ComposeImportance } from '@shared/api/types'

import { RecipientField } from './RecipientField'
import { SenderChip } from './SenderChip'

const IMPORTANCE_OPTS: ReadonlyArray<{ value: ComposeImportance; key: string }> = [
  { value: 'high', key: 'compose.importanceHigh' },
  { value: 'normal', key: 'compose.importanceNormal' },
  { value: 'low', key: 'compose.importanceLow' }
]

/** 重要性下拉 — 主题行右侧 (Outlook 同位)。high 用 warn 色旗标, low 灰旗, normal 朴素。 */
function ImportanceSelect({
  value,
  onChange
}: {
  value: ComposeImportance
  onChange: (v: ComposeImportance) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const tone = value === 'high' ? 'text-warn' : value === 'low' ? 'text-ink-fg-3' : 'text-ink-fg-2'
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={t('compose.importance')}
        className={cn(
          'inline-flex items-center gap-1 rounded-[var(--r-ctl)] px-1.5 py-0.5 text-meta font-mono',
          'hover:bg-ink-3/60 transition-colors duration-fast',
          tone
        )}
      >
        <Flag size={12} strokeWidth={2} fill={value === 'high' ? 'currentColor' : 'none'} />
        {t(IMPORTANCE_OPTS.find((o) => o.value === value)?.key ?? 'compose.importanceNormal')}
        <ChevronDown size={11} strokeWidth={2} />
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute right-0 top-full mt-1 z-50 w-28 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 shadow-md py-1"
        >
          {IMPORTANCE_OPTS.map((o) => (
            <li key={o.value} role="option" aria-selected={o.value === value}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(o.value)
                  setOpen(false)
                }}
                className={cn(
                  'w-full text-left px-2.5 py-1.5 flex items-center gap-2 text-meta',
                  'transition-colors duration-fast hover:bg-ink-3',
                  o.value === value ? 'text-ink-fg' : 'text-ink-fg-2'
                )}
              >
                <Flag
                  size={12}
                  strokeWidth={2}
                  className={
                    o.value === 'high'
                      ? 'text-warn'
                      : o.value === 'low'
                        ? 'text-ink-fg-3'
                        : 'text-ink-fg-2'
                  }
                  fill={o.value === 'high' ? 'currentColor' : 'none'}
                />
                {t(o.key)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

interface ComposeActionHeaderProps {
  isDraftEdit: boolean
  busy: boolean
  sendDisabled: boolean
  sendPending: boolean
  deletePending: boolean
  savePending: boolean
  uploadsPending: boolean
  fwdAttachBlocked: boolean
  lastSavedAt: Date | null
  signature: string | null
  libraryPickerAvailable: boolean
  headerHint: string
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>
  onSendClick: () => void
  onDiscard: () => void
  onSaveDraftClick: () => void
  onInsertSignature: () => void
  onOpenLibraryPicker: () => void
  onFilesSelected: (files: FileList | null) => void
}

/** Top Outlook-style compose action bar. */
export function ComposeActionHeader({
  isDraftEdit,
  busy,
  sendDisabled,
  sendPending,
  deletePending,
  savePending,
  uploadsPending,
  fwdAttachBlocked,
  lastSavedAt,
  signature,
  libraryPickerAvailable,
  headerHint,
  fileInputRef,
  onSendClick,
  onDiscard,
  onSaveDraftClick,
  onInsertSignature,
  onOpenLibraryPicker,
  onFilesSelected
}: ComposeActionHeaderProps): React.ReactElement {
  const { t } = useTranslation()
  return (
    <header className="h-12 shrink-0 border-b border-ink-border/60 flex items-center gap-1.5 px-3">
      <button
        type="button"
        onClick={onSendClick}
        disabled={sendDisabled}
        className="gbtn gbtn-primary"
        style={{ height: '34px' }}
      >
        {sendPending ? (
          <Loader2 size={13} strokeWidth={2} className="animate-spin" />
        ) : (
          <Send size={13} strokeWidth={2} />
        )}
        {t('compose.send')}
      </button>
      <button
        type="button"
        onClick={onDiscard}
        disabled={busy}
        className="gbtn gbtn-bare"
        style={{ height: '34px' }}
        title={isDraftEdit ? t('compose.deleteDraft') : `${t('compose.discard')} · Esc`}
      >
        {deletePending ? (
          <Loader2 size={13} strokeWidth={2} className="animate-spin" />
        ) : (
          <Trash2 size={13} strokeWidth={2} />
        )}
        {isDraftEdit ? t('compose.deleteDraft') : t('compose.discard')}
      </button>
      {/* 保存草稿 — draft-edit 也有 (task 08-20 draft-save B: 原「改完就发」设计
          把唯一保存路径留给离开守卫弹框)。draft-edit 语义 = 存后留在编辑态
          (replace 保存, 锚换新行); 其余模式维持存后关闭。走单飞 saveDraftAsync,
          与离开守卫共用 in-flight。 */}
      <button
        type="button"
        onClick={onSaveDraftClick}
        disabled={busy || uploadsPending || fwdAttachBlocked}
        className="gbtn"
        style={{ height: '34px' }}
      >
        {savePending ? <Loader2 size={13} strokeWidth={2} className="animate-spin" /> : null}
        {t('compose.saveDraft')}
      </button>
      {isDraftEdit && lastSavedAt && (
        <span className="text-meta font-mono text-ink-fg-3">
          {t('compose.savedAt', {
            time: lastSavedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          })}
        </span>
      )}
      <span className="w-px h-5 bg-ink-border-soft mx-1" aria-hidden />
      <button
        type="button"
        onClick={onInsertSignature}
        disabled={!signature || busy}
        className="gbtn gbtn-bare"
        style={{ height: '34px' }}
        title={signature ? t('compose.signatureInsert') : t('compose.signatureEmpty')}
      >
        <PenLine size={13} strokeWidth={2} />
        {t('compose.signature')}
      </button>
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={busy}
        className="gbtn gbtn-bare"
        style={{ height: '34px' }}
        title={t('compose.attach')}
      >
        <Paperclip size={13} strokeWidth={2} />
        {t('compose.attach')}
      </button>
      {libraryPickerAvailable && (
        <button
          type="button"
          onClick={onOpenLibraryPicker}
          disabled={busy}
          className="gbtn gbtn-bare"
          style={{ height: '34px' }}
          title={t('library.compose.pickFromLibrary')}
        >
          <FileDown size={13} strokeWidth={2} />
          {t('library.compose.pickFromLibrary')}
        </button>
      )}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        aria-label={t('compose.attach')}
        onChange={(e) => {
          onFilesSelected(e.currentTarget.files)
          // 清空 value 让同一文件可重复选择 (删了再加回)。
          e.currentTarget.value = ''
        }}
      />
      <div className="ml-auto flex items-center gap-2 min-w-0">
        <span className="text-meta text-ink-fg-2 truncate max-w-[220px]" title={headerHint}>
          {headerHint}
        </span>
      </div>
    </header>
  )
}

interface ComposeHeaderFieldsProps {
  selfEmail: string | null
  isNew: boolean
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  importance: ComposeImportance
  ccVisible: boolean
  bccVisible: boolean
  onToChange: (next: string[]) => void
  onCcChange: (next: string[]) => void
  onBccChange: (next: string[]) => void
  onSubjectChange: (next: string) => void
  onImportanceChange: (next: ComposeImportance) => void
  onShowCc: () => void
  onShowBcc: () => void
  onCollapseCc: () => void
  onCollapseBcc: () => void
}

/** Envelope header rows: From(read-only) / To / Cc·Bcc / Subject(with Importance). */
export function ComposeHeaderFields({
  selfEmail,
  isNew,
  to,
  cc,
  bcc,
  subject,
  importance,
  ccVisible,
  bccVisible,
  onToChange,
  onCcChange,
  onBccChange,
  onSubjectChange,
  onImportanceChange,
  onShowCc,
  onShowBcc,
  onCollapseCc,
  onCollapseBcc
}: ComposeHeaderFieldsProps): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="border-b border-ink-border/60 shrink-0">
      <div className="folder-field-row">
        <span className="field-label">{t('compose.from')}</span>
        <div className="flex items-center gap-2 min-w-0">
          <SenderChip email={selfEmail} fallbackLabel={t('compose.fromUnknown')} />
        </div>
        <span />
      </div>

      <div className="relative">
        <RecipientField
          label={t('compose.to')}
          values={to}
          placeholder={t('compose.toPlaceholder')}
          onChange={onToChange}
          selfEmail={selfEmail}
          excludeEmails={[...cc, ...bcc]}
          autoFocus={isNew}
        />
        {(!ccVisible || !bccVisible) && (
          <div className="absolute right-3 top-2 flex items-center gap-1 text-meta font-mono text-ink-fg-2">
            {!ccVisible && (
              <button
                type="button"
                onClick={onShowCc}
                className="px-1.5 py-0.5 rounded hover:bg-ink-3/60 hover:text-ink-fg transition-colors duration-fast"
              >
                Cc
              </button>
            )}
            {!ccVisible && !bccVisible && <span className="text-ink-fg-3">·</span>}
            {!bccVisible && (
              <button
                type="button"
                onClick={onShowBcc}
                className="px-1.5 py-0.5 rounded hover:bg-ink-3/60 hover:text-ink-fg transition-colors duration-fast"
              >
                Bcc
              </button>
            )}
          </div>
        )}
      </div>

      {ccVisible && (
        <div className="relative">
          <RecipientField
            label={t('compose.cc')}
            values={cc}
            placeholder={t('compose.ccPlaceholder')}
            onChange={onCcChange}
            selfEmail={selfEmail}
            excludeEmails={[...to, ...bcc]}
          />
          {/* × 收起并清空 (design/app.jsx ComposeFields cmp-fieldx)。 */}
          <button
            type="button"
            aria-label={t('compose.ccCollapse')}
            title={t('compose.ccCollapse')}
            onClick={onCollapseCc}
            className="absolute right-3 top-2.5 p-1 rounded-[var(--r-ctl)] text-ink-fg-3 hover:text-ink-fg hover:bg-ink-3/60 transition-colors duration-fast"
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      )}
      {bccVisible && (
        <div className="relative">
          <RecipientField
            label={t('compose.bcc')}
            values={bcc}
            placeholder={t('compose.bccPlaceholder')}
            onChange={onBccChange}
            selfEmail={selfEmail}
            excludeEmails={[...to, ...cc]}
          />
          <button
            type="button"
            aria-label={t('compose.bccCollapse')}
            title={t('compose.bccCollapse')}
            onClick={onCollapseBcc}
            className="absolute right-3 top-2.5 p-1 rounded-[var(--r-ctl)] text-ink-fg-3 hover:text-ink-fg hover:bg-ink-3/60 transition-colors duration-fast"
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      )}

      <div className="folder-field-row">
        <span className="field-label">{t('compose.subject')}</span>
        <input
          className="text-aux font-medium"
          value={subject}
          placeholder={t('compose.subjectPlaceholder')}
          onChange={(e) => onSubjectChange(e.target.value)}
          aria-label={t('compose.subject')}
        />
        <ImportanceSelect value={importance} onChange={onImportanceChange} />
      </div>
    </div>
  )
}

/** draftPlan 失败 banner (reply/forward only) — 收件人/正文预填失败时显式告知 + 重试。 */
export function ComposePlanErrorBanner({
  code,
  onRetry
}: {
  code: string
  onRetry: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="border-b border-ink-border/60 shrink-0 px-4 py-3 flex items-start gap-3 bg-fail/10">
      <div className="flex-1 text-aux text-fail">
        <div className="font-medium">{t('compose.planError')}</div>
        <div className="text-meta font-mono text-ink-fg-2 mt-0.5">
          {t('compose.planErrorHint', { code })}
        </div>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 px-2.5 py-1.5 rounded text-aux text-fail hover:bg-fail/15 transition-colors duration-fast inline-flex items-center gap-1.5"
      >
        <RotateCcw size={11} strokeWidth={2} />
        {t('compose.planRetry')}
      </button>
    </div>
  )
}
