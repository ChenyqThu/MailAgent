// Phase 2.2/2.3 — EventFormModal: 一个 modal 复用 create + edit 两种语义.
// occurrence !== null → edit 预填; null → create.
//
// 实现取舍:
// - 不引入 radix/headless UI primitive, 用 inline fixed pos + glass-2 拼最简版
// - datetime input 用 native datetime-local (跟系统时区一致, 用户友好)
// - 转 ISO 时用本地 tz offset (跟 CLI parser 要求一致)
// - attendees 输入暂用单 textarea 多行 (每行 'email[,name]'), polish 后可优化

import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'

import { CALENDAR_EVENTS_KEY } from './hooks/useCalendarEvents'
import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { toastError, toastSuccess } from '@shared/state/toast'
import type {
  CalendarEventOccurrence,
  EventAttendeeInput,
  EventCreateOpts,
  EventUpdateOpts
} from '@shared/api/types'

interface Props {
  open: boolean
  onClose: () => void
  /** 非空 = edit (预填); null = create. */
  occurrence: CalendarEventOccurrence | null
}

// datetime-local 接受 'YYYY-MM-DDTHH:MM' (本地时区). 转换 helpers:

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Date → 'YYYY-MM-DDTHH:MM' (本地时区, datetime-local 友好). */
function toDatetimeLocal(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 'YYYY-MM-DDTHH:MM' (本地) → ISO with local tz offset.
 *  CLI _parse_iso_datetime_strict 要求 tz, 这里附本地 offset 保留语义. */
function localToIsoWithOffset(localStr: string): string {
  // localStr e.g. '2026-05-30T14:00'
  const [datePart, timePart] = localStr.split('T')
  const [y, mo, d] = datePart.split('-').map(Number)
  const [h, mi] = timePart.split(':').map(Number)
  const dt = new Date(y, mo - 1, d, h, mi)
  const tzOff = -dt.getTimezoneOffset() // minutes
  const sign = tzOff >= 0 ? '+' : '-'
  const tzH = pad(Math.floor(Math.abs(tzOff) / 60))
  const tzM = pad(Math.abs(tzOff) % 60)
  return `${datePart}T${timePart}:00${sign}${tzH}:${tzM}`
}

/** ISO UTC 字符串 → datetime-local 本地字符串 (展示用). */
function isoToDatetimeLocal(iso: string): string {
  const d = new Date(iso)
  return toDatetimeLocal(d)
}

/** textarea 输入 '邮箱[,显示名]' 多行 → EventAttendeeInput[]. */
function parseAttendees(text: string): EventAttendeeInput[] {
  const out: EventAttendeeInput[] = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    const parts = s.split(',', 2)
    const email = parts[0].trim()
    if (!email || !email.includes('@')) continue
    out.push({ email, name: parts[1]?.trim() || undefined })
  }
  return out
}

function attendeesToText(atts: ReadonlyArray<{ email: string; name?: string }>): string {
  return atts.map((a) => (a.name ? `${a.email},${a.name}` : a.email)).join('\n')
}

export function EventFormModal({ open, onClose, occurrence }: Props): React.ReactElement | null {
  const isEdit = occurrence !== null
  const mailApi = useMailApi()
  const qc = useQueryClient()

  const [summary, setSummary] = useState('')
  const [startLocal, setStartLocal] = useState('')
  const [endLocal, setEndLocal] = useState('')
  const [location, setLocation] = useState('')
  const [description, setDescription] = useState('')
  const [attendeesText, setAttendeesText] = useState('')

  useEffect(() => {
    if (!open) return
    if (occurrence) {
      // edit 预填
      setSummary(occurrence.summary || '')
      setStartLocal(isoToDatetimeLocal(occurrence.occurrence_start_iso))
      setEndLocal(isoToDatetimeLocal(occurrence.occurrence_end_iso))
      setLocation(occurrence.location || '')
      setDescription('')
      setAttendeesText(attendeesToText(occurrence.attendees || []))
    } else {
      // create defaults: 1h 后开始 + 1h 长
      const start = new Date(Date.now() + 60 * 60 * 1000)
      // round to nearest 30 min for usability
      start.setMinutes(Math.floor(start.getMinutes() / 30) * 30, 0, 0)
      const end = new Date(start.getTime() + 60 * 60 * 1000)
      setSummary('')
      setStartLocal(toDatetimeLocal(start))
      setEndLocal(toDatetimeLocal(end))
      setLocation('')
      setDescription('')
      setAttendeesText('')
    }
  }, [open, occurrence])

  const mut = useMutation({
    mutationFn: async () => {
      const startIso = localToIsoWithOffset(startLocal)
      const endIso = localToIsoWithOffset(endLocal)
      const attendees = parseAttendees(attendeesText)
      if (isEdit && occurrence) {
        const opts: EventUpdateOpts = {
          icalUid: occurrence.ical_uid,
          summary,
          startIso,
          endIso,
          location: location || undefined,
          description: description || undefined,
          attendees: attendees.length > 0 ? attendees : undefined
        }
        return mailApi.calendar.eventUpdate(opts)
      } else {
        const opts: EventCreateOpts = {
          summary,
          startIso,
          endIso,
          location: location || undefined,
          description: description || undefined,
          attendees: attendees.length > 0 ? attendees : undefined
        }
        return mailApi.calendar.eventCreate(opts)
      }
    },
    onSuccess: () => {
      toastSuccess(isEdit ? '事件已更新' : '事件已创建, ~60s 内同步到本地视图')
      void qc.invalidateQueries({ queryKey: CALENDAR_EVENTS_KEY })
      void qc.invalidateQueries({ queryKey: ['calendar', 'event'] })
      onClose()
    },
    onError: (err: unknown) => {
      const e = err as Error
      toastError(isEdit ? '更新事件失败' : '创建事件失败', e.message || '未知错误')
    }
  })

  if (!open) return null

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!summary.trim()) {
      toastError('请填写标题', '标题不能为空')
      return
    }
    if (!startLocal || !endLocal) {
      toastError('请填写时间', '开始/结束时间必填')
      return
    }
    if (endLocal <= startLocal) {
      toastError('时间无效', '结束时间必须晚于开始时间')
      return
    }
    mut.mutate()
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 backdrop-blur-[2px]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={isEdit ? '编辑事件' : '新建事件'}
    >
      <div
        className={cn(
          'glass-2 rounded-[10px] border border-ink-border/60 shadow-2xl',
          'w-full max-w-md max-h-[85vh] overflow-auto scrollbar-thin',
          'flex flex-col'
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* head */}
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-ink-border-soft">
          <h2 className="text-base font-semibold text-ink-fg">
            {isEdit ? '编辑事件' : '新建事件'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-fg-3 hover:text-ink-fg transition-colors"
            aria-label="关闭"
            title="关闭 (Esc)"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        {/* form */}
        <form onSubmit={handleSubmit} className="p-5 flex flex-col gap-3.5">
          <Field label="标题" required>
            <input
              type="text"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              required
              autoFocus
              maxLength={200}
              className={inputCls}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="开始" required>
              <input
                type="datetime-local"
                value={startLocal}
                onChange={(e) => setStartLocal(e.target.value)}
                required
                className={inputCls}
              />
            </Field>
            <Field label="结束" required>
              <input
                type="datetime-local"
                value={endLocal}
                onChange={(e) => setEndLocal(e.target.value)}
                required
                className={inputCls}
              />
            </Field>
          </div>

          <Field label="地点">
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              maxLength={500}
              placeholder="可选 — 实体地点 / Teams 会议 / Zoom 链接"
              className={inputCls}
            />
          </Field>

          <Field label="描述">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="可选 — 会议议程 / 备注"
              className={cn(inputCls, 'resize-none')}
            />
          </Field>

          <Field
            label="与会者"
            hint="每行一个: 'email' 或 'email,显示名'"
          >
            <textarea
              value={attendeesText}
              onChange={(e) => setAttendeesText(e.target.value)}
              rows={3}
              placeholder={'alice@example.com\nbob@example.com,Bob'}
              className={cn(inputCls, 'resize-none font-mono text-[12px]')}
            />
          </Field>

          {/* actions */}
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-ink-border-soft mt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={mut.isPending}
              className={cn(
                'px-4 h-9 rounded-md text-[13px] cursor-pointer',
                'text-ink-fg-2 hover:bg-ink-3/50 transition-colors',
                'disabled:opacity-50 disabled:cursor-wait'
              )}
            >
              取消
            </button>
            <button
              type="submit"
              disabled={mut.isPending}
              className={cn(
                'px-4 h-9 rounded-md text-[13px] font-medium cursor-pointer',
                'bg-coral text-white hover:bg-coral/90 transition-colors',
                'disabled:opacity-60 disabled:cursor-wait'
              )}
            >
              {mut.isPending
                ? isEdit ? '保存中…' : '创建中…'
                : isEdit ? '保存' : '创建'}
            </button>
          </div>

          {isEdit && occurrence && (
            <div className="text-[11px] text-ink-fg-3 font-mono pt-2 border-t border-ink-border-soft/40">
              UID: {occurrence.ical_uid.slice(0, 48)}
              {occurrence.ical_uid.length > 48 ? '…' : ''}
            </div>
          )}
        </form>
      </div>
    </div>
  )
}

// ============================================================
// helpers / styled
// ============================================================

const inputCls = cn(
  'w-full px-3 py-2 rounded-md text-[13px]',
  'bg-ink-3/40 border border-ink-border/60 text-ink-fg',
  'placeholder:text-ink-fg-3',
  'focus:outline-none focus:border-coral/60 focus:bg-ink-3/60',
  'transition-colors'
)

function Field({
  label,
  hint,
  required,
  children
}: {
  label: string
  hint?: string
  required?: boolean
  children: React.ReactNode
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11.5px] text-ink-fg-2 font-medium uppercase tracking-wider">
        {label}
        {required && <span className="text-coral ml-0.5">*</span>}
        {hint && (
          <span className="ml-2 text-ink-fg-3 normal-case tracking-normal font-normal">
            ({hint})
          </span>
        )}
      </span>
      {children}
    </label>
  )
}
