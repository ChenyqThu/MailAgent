// Phase 2.5 §11.1 — EventFormModal 1:1 mockup-event-form.html 复刻.
//
// 变化 vs Phase 2.2/2.3 初版:
// - 视觉切到 mockup class (.efm-* / .ef-* / .chip-*), 抽到 index.css
// - attendees 改 chip 输入 (Enter / `,` / `;` 加, Backspace 空输入框删上一个,
//   点 × 移除); 非法 email .chip-field 短暂 .invalid pulse
// - 验证改 inline .ef-err.show, 不再 toastError 干扰用户
// - Esc 关闭 + Tab focus-trap (a11y), 关闭时 restore focus
//
// 接口不变 (open / onClose / occurrence — null=create 非空=edit).

import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, X } from 'lucide-react'

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
  const [datePart, timePart] = localStr.split('T')
  const [y, mo, d] = datePart.split('-').map(Number)
  const [h, mi] = timePart.split(':').map(Number)
  const dt = new Date(y, mo - 1, d, h, mi)
  const tzOff = -dt.getTimezoneOffset()
  const sign = tzOff >= 0 ? '+' : '-'
  const tzH = pad(Math.floor(Math.abs(tzOff) / 60))
  const tzM = pad(Math.abs(tzOff) % 60)
  return `${datePart}T${timePart}:00${sign}${tzH}:${tzM}`
}

/** ISO 字符串 → datetime-local 本地字符串. */
function isoToDatetimeLocal(iso: string): string {
  return toDatetimeLocal(new Date(iso))
}

function emailRe(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
}

/** chip avatar initials — mockup §chip-av. */
function initials(email: string): string {
  const n = email.split('@')[0].replace(/[._-]/g, ' ').trim()
  const p = n.split(' ')
  return ((p[0] || '')[0] || email[0] || '?').toUpperCase()
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
  // chip 输入: chips = 已确认 attendees, chipInputValue = 当前输入框中字符
  const [chips, setChips] = useState<EventAttendeeInput[]>([])
  const [chipInputValue, setChipInputValue] = useState('')
  const [chipFocused, setChipFocused] = useState(false)
  const [chipInvalid, setChipInvalid] = useState(false)
  // inline 验证 (替代之前的 toastError, mockup §11.1)
  const [errTitle, setErrTitle] = useState(false)
  const [errTime, setErrTime] = useState(false)

  const titleRef = useRef<HTMLInputElement>(null)
  const startRef = useRef<HTMLInputElement>(null)
  const chipInputRef = useRef<HTMLInputElement>(null)
  const modalRef = useRef<HTMLDivElement>(null)
  const lastFocusRef = useRef<HTMLElement | null>(null)

  // 打开时预填 / 重置
  useEffect(() => {
    if (!open) return
    lastFocusRef.current = (document.activeElement as HTMLElement | null) ?? null
    if (occurrence) {
      setSummary(occurrence.summary || '')
      setStartLocal(isoToDatetimeLocal(occurrence.occurrence_start_iso))
      setEndLocal(isoToDatetimeLocal(occurrence.occurrence_end_iso))
      setLocation(occurrence.location || '')
      setDescription('')
      setChips(
        (occurrence.attendees || []).map((a) => ({
          email: a.email,
          name: a.name || undefined
        }))
      )
    } else {
      // create defaults: 下一个 30 分钟整点 + 1h 长
      const start = new Date(Date.now() + 60 * 60 * 1000)
      start.setMinutes(Math.floor(start.getMinutes() / 30) * 30, 0, 0)
      const end = new Date(start.getTime() + 60 * 60 * 1000)
      setSummary('')
      setStartLocal(toDatetimeLocal(start))
      setEndLocal(toDatetimeLocal(end))
      setLocation('')
      setDescription('')
      setChips([])
    }
    setChipInputValue('')
    setErrTitle(false)
    setErrTime(false)
    // focus 标题 (mockup setTimeout 60 让 transition 先跑)
    const id = window.setTimeout(() => titleRef.current?.focus(), 60)
    return () => window.clearTimeout(id)
  }, [open, occurrence])

  const mut = useMutation({
    mutationFn: async () => {
      const startIso = localToIsoWithOffset(startLocal)
      const endIso = localToIsoWithOffset(endLocal)
      const attendees = chips.length > 0 ? chips : undefined
      if (isEdit && occurrence) {
        const opts: EventUpdateOpts = {
          icalUid: occurrence.ical_uid,
          summary,
          startIso,
          endIso,
          location: location || undefined,
          description: description || undefined,
          attendees
        }
        return mailApi.calendar.eventUpdate(opts)
      } else {
        const opts: EventCreateOpts = {
          summary,
          startIso,
          endIso,
          location: location || undefined,
          description: description || undefined,
          attendees
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

  // inline validate — 失败时 setErrTitle/setErrTime 让 .ef-err.show + .invalid 描边
  const validate = useCallback((): boolean => {
    let ok = true
    if (!summary.trim()) {
      setErrTitle(true)
      ok = false
    } else {
      setErrTitle(false)
    }
    if (startLocal && endLocal && new Date(endLocal) <= new Date(startLocal)) {
      setErrTime(true)
      ok = false
    } else {
      setErrTime(false)
    }
    return ok
  }, [summary, startLocal, endLocal])

  // 用户边改边清错 (mockup behaviour)
  useEffect(() => {
    if (errTitle && summary.trim()) setErrTitle(false)
  }, [summary, errTitle])
  useEffect(() => {
    if (errTime && startLocal && endLocal && new Date(endLocal) > new Date(startLocal)) {
      setErrTime(false)
    }
  }, [startLocal, endLocal, errTime])

  const handleSubmit = (): void => {
    if (!validate()) {
      if (!summary.trim()) titleRef.current?.focus()
      else startRef.current?.focus()
      return
    }
    mut.mutate()
  }

  // ── chip ops ──
  const addChip = useCallback(
    (raw: string): void => {
      const v = raw.trim().replace(/[,;]$/, '')
      if (!v) return
      if (!emailRe(v)) {
        setChipInvalid(true)
        window.setTimeout(() => setChipInvalid(false), 700)
        return
      }
      if (chips.some((c) => c.email.toLowerCase() === v.toLowerCase())) {
        setChipInputValue('')
        return
      }
      setChips((cs) => [...cs, { email: v }])
      setChipInputValue('')
    },
    [chips]
  )

  const onChipInputKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      e.preventDefault()
      addChip(chipInputValue)
    } else if (e.key === 'Backspace' && chipInputValue === '' && chips.length) {
      setChips((cs) => cs.slice(0, -1))
    }
  }

  const onChipInputBlur = (): void => {
    if (chipInputValue.trim()) addChip(chipInputValue)
    setChipFocused(false)
  }

  // Esc 关闭 + Tab focus-trap (mockup §a11y)
  useEffect(() => {
    if (!open) return
    const prevFocus = lastFocusRef.current
    const handle = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key === 'Tab' && modalRef.current) {
        const focusables = modalRef.current.querySelectorAll<HTMLElement>(
          'button,input,textarea,[tabindex]:not([tabindex="-1"])'
        )
        const list = Array.from(focusables).filter(
          (el) => !el.hasAttribute('disabled') && el.offsetParent !== null
        )
        if (!list.length) return
        const first = list[0]
        const last = list[list.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', handle)
    return () => {
      window.removeEventListener('keydown', handle)
      prevFocus?.focus?.()
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className={cn('efm-backdrop', open && 'open')}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="presentation"
    >
      <div
        ref={modalRef}
        className="efm-modal glass-pop"
        role="dialog"
        aria-modal="true"
        aria-labelledby="efm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="efm-head">
          <span className="efm-accent" aria-hidden />
          <h2 id="efm-title" className="efm-title">
            {isEdit ? '编辑事件' : '新建事件'}
          </h2>
          <button
            type="button"
            className="efm-close"
            onClick={onClose}
            aria-label="关闭 (Esc)"
            title="关闭 (Esc)"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        <div className="efm-body scrollbar-thin">
          {/* 标题 */}
          <div className="ef-field">
            <label className="ef-label" htmlFor="ef-title">
              标题
              <span className="req" aria-hidden>
                *
              </span>
            </label>
            <input
              ref={titleRef}
              id="ef-title"
              type="text"
              className={cn('ef-input', errTitle && 'invalid')}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="事件标题"
              autoComplete="off"
              aria-required
              aria-invalid={errTitle || undefined}
              maxLength={200}
            />
            <div className={cn('ef-err', errTitle && 'show')} role="alert">
              <AlertCircle size={13} strokeWidth={2} />
              <span>请输入事件标题</span>
            </div>
          </div>

          {/* 起止时间 */}
          <div className="ef-field">
            <label className="ef-label">起止时间</label>
            <div className="ef-grid2">
              <input
                ref={startRef}
                className={cn('ef-input mono', errTime && 'invalid')}
                type="datetime-local"
                value={startLocal}
                onChange={(e) => setStartLocal(e.target.value)}
                aria-label="开始时间"
              />
              <input
                className={cn('ef-input mono', errTime && 'invalid')}
                type="datetime-local"
                value={endLocal}
                onChange={(e) => setEndLocal(e.target.value)}
                aria-label="结束时间"
              />
            </div>
            <div className={cn('ef-err', errTime && 'show')} role="alert">
              <AlertCircle size={13} strokeWidth={2} />
              <span>结束时间需晚于开始时间</span>
            </div>
          </div>

          {/* 地点 */}
          <div className="ef-field">
            <label className="ef-label" htmlFor="ef-loc">
              地点
            </label>
            <input
              id="ef-loc"
              type="text"
              className="ef-input"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="会议室 / Teams 链接 / 地址"
              autoComplete="off"
              maxLength={500}
            />
          </div>

          {/* 与会者 chip 输入 */}
          <div className="ef-field">
            <label className="ef-label" htmlFor="ef-att-input">
              与会者
            </label>
            <div
              className={cn(
                'chip-field',
                chipFocused && 'focus',
                chipInvalid && 'invalid'
              )}
              onClick={() => chipInputRef.current?.focus()}
            >
              {chips.map((c) => (
                <span key={c.email} className="chip">
                  <span className="chip-av" aria-hidden>
                    {initials(c.email)}
                  </span>
                  <span>{c.email}</span>
                  <button
                    type="button"
                    className="chip-x"
                    onClick={(e) => {
                      e.stopPropagation()
                      setChips((cs) => cs.filter((x) => x.email !== c.email))
                    }}
                    aria-label={`移除 ${c.email}`}
                    title="移除"
                  >
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                    >
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </span>
              ))}
              <input
                ref={chipInputRef}
                id="ef-att-input"
                type="text"
                className="chip-input"
                value={chipInputValue}
                onChange={(e) => setChipInputValue(e.target.value)}
                onKeyDown={onChipInputKey}
                onFocus={() => setChipFocused(true)}
                onBlur={onChipInputBlur}
                placeholder={chips.length === 0 ? '输入 email 后回车添加' : ''}
                autoComplete="off"
                aria-label="添加与会者 email"
              />
            </div>
            <div className="chip-hint">
              <kbd>Enter</kbd> 添加 · <kbd>⌫</kbd> 删除上一个 · 点 × 移除
            </div>
          </div>

          {/* 描述 */}
          <div className="ef-field">
            <label className="ef-label" htmlFor="ef-desc">
              描述
            </label>
            <textarea
              id="ef-desc"
              className="ef-textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="议程、备注、相关链接…"
              maxLength={2000}
            />
          </div>
        </div>

        <div className="efm-foot">
          <button
            type="button"
            className="btn-ghost"
            onClick={onClose}
            disabled={mut.isPending}
          >
            取消
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={handleSubmit}
            disabled={mut.isPending}
          >
            {mut.isPending
              ? isEdit
                ? '保存中…'
                : '创建中…'
              : isEdit
                ? '保存'
                : '创建'}
          </button>
        </div>

        {isEdit && occurrence && (
          <div
            className="px-5 pb-3 text-[11px] text-ink-fg-3 font-mono break-all"
            aria-label="事件 UID"
          >
            UID: {occurrence.ical_uid.slice(0, 64)}
            {occurrence.ical_uid.length > 64 ? '…' : ''}
          </div>
        )}
      </div>
    </div>
  )
}
