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
import { useTranslation } from 'react-i18next'

import { CALENDAR_EVENTS_KEY, useCalendarEvent, useCalendarNames } from './hooks/useCalendarEvents'
import { RRuleEditor } from './RRuleEditor'
import { buildRRule, parseRRule, defaultRRuleState, type RRuleState } from './lib/rrule'
import { resolveAttendeesUpdate } from './lib/attendees'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { cn } from '@shared/lib/cn'
import { qk } from '@shared/lib/queryKeys'
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
// F32 — pad 抽到 ./lib/format
import { pad } from './lib/format'

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

// Phase 4·#2 — 全天事件用 floating date (UTC midnight Z). occurrence_*_iso 是
// UTC ISO; 全天事件存 date 00:00 UTC + dtend exclusive (caldav_reader 确认).
/** ISO (UTC) → UTC date 部分 'YYYY-MM-DD'. */
function isoToUtcDate(iso: string): string {
  return iso.slice(0, 10)
}
/** date str ± n 天 (UTC 运算, 避免本地时区偏移导致跨日). */
function addDaysToDateStr(ds: string, n: number): string {
  const [y, mo, d] = ds.split('-').map(Number)
  const dt = new Date(Date.UTC(y, mo - 1, d + n))
  return dt.toISOString().slice(0, 10)
}
/** 本地今天 'YYYY-MM-DD' (create 全天默认). */
function todayDateStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
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
  const { t } = useTranslation()
  const isEdit = occurrence !== null
  const mailApi = useMailApi()
  const qc = useQueryClient()

  const [summary, setSummary] = useState('')
  const [startLocal, setStartLocal] = useState('')
  const [endLocal, setEndLocal] = useState('')
  // Phase 4·#2 — 全天事件: isAllDay toggle 切 date input (startDate/endDate
  // inclusive); 提交转 UTC midnight Z + end exclusive (inclusive +1).
  const [isAllDay, setIsAllDay] = useState(false)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [location, setLocation] = useState('')
  const [description, setDescription] = useState('')
  // Phase 4·#1 — calendar 归属 (create 可选下拉; edit 只读展示, 跨 calendar
  // move 不在 scope). 仅 calendars.length > 1 时显示该字段.
  const [calendarName, setCalendarName] = useState('')
  const { data: calendarNames } = useCalendarNames()
  const calendars = calendarNames ?? []
  // Phase 4·#3 — 重复规则 (RRuleEditor 受控). edit 时拉 detail 拿 rrule
  // (occurrence 无 rrule 字段); rruleDirty 防有损解析覆盖原复杂 RRULE.
  const [rruleState, setRruleState] = useState<RRuleState>(defaultRRuleState())
  const [rruleDirty, setRruleDirty] = useState(false)
  // Phase 4·#3c — 周期事件 edit 保存时弹 scope 对话 (改这一次/整系列)
  const [scopeDialogOpen, setScopeDialogOpen] = useState(false)
  const { data: detail } = useCalendarEvent(
    occurrence
      ? {
          icalUid: occurrence.ical_uid,
          recurrenceId: occurrence.recurrence_id,
          source: occurrence.source
        }
      : null
  )
  // Phase 4·#3c — 周期事件 (有 RRULE) edit 时保存弹 scope 对话
  const isRecurring = isEdit && !!detail?.rrule
  // chip 输入: chips = 已确认 attendees, chipInputValue = 当前输入框中字符
  const [chips, setChips] = useState<EventAttendeeInput[]>([])
  const [chipInputValue, setChipInputValue] = useState('')
  const [chipFocused, setChipFocused] = useState(false)
  const [chipInvalid, setChipInvalid] = useState(false)
  // Phase 4·#4 — 用户主动改与会者 (加/删 chip) 才置 true. 未 dirty 提交不传
  // attendees → 后端保留原与会者 + partstat (防退化); dirty + 删光 → clearAttendees.
  const [attendeesDirty, setAttendeesDirty] = useState(false)
  // inline 验证 (替代之前的 toastError, mockup §11.1)
  const [errTitle, setErrTitle] = useState(false)
  const [errTime, setErrTime] = useState(false)

  const titleRef = useRef<HTMLInputElement>(null)
  const startRef = useRef<HTMLInputElement>(null)
  const chipInputRef = useRef<HTMLInputElement>(null)
  const modalRef = useRef<HTMLDivElement>(null)
  const lastFocusRef = useRef<HTMLElement | null>(null)
  // 退场延迟卸载：backdrop 淡入 + .efm-modal 位移缩放。GSAP 接管进/退两端，
  // index.css 已移除 .efm-backdrop .open 过渡（含旧第二曲线）。
  const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(open, {
    card: '.efm-modal'
  })
  // Phase 4·#3c scope 对话退场动画（居中模态模式）
  const { shouldRender: scopeDlgRender, scopeRef: scopeDlgRef } = useExitAnimation<HTMLDivElement>(
    scopeDialogOpen,
    { card: '[data-anim-card]' }
  )

  // 打开时预填 / 重置
  useEffect(() => {
    if (!open) return
    lastFocusRef.current = (document.activeElement as HTMLElement | null) ?? null
    if (occurrence) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 模态打开按 occurrence 预填表单（各字段转换 / 下方 else 走 create defaults）。React Compiler 迁移债：真重构需 key 重置 remount，预填等价性风险高于收益。effect 合理保留。
      setSummary(occurrence.summary || '')
      setStartLocal(isoToDatetimeLocal(occurrence.occurrence_start_iso))
      setEndLocal(isoToDatetimeLocal(occurrence.occurrence_end_iso))
      // Phase 4·#2 — 全天预填: startDate=start UTC date; endDate=end UTC date -1
      // (occurrence_end 是 exclusive, 转 inclusive 显示).
      setIsAllDay(!!occurrence.is_all_day)
      setStartDate(isoToUtcDate(occurrence.occurrence_start_iso))
      setEndDate(
        occurrence.is_all_day
          ? addDaysToDateStr(isoToUtcDate(occurrence.occurrence_end_iso), -1)
          : isoToUtcDate(occurrence.occurrence_end_iso)
      )
      setLocation(occurrence.location || '')
      setCalendarName(occurrence.calendar_name || '')
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
      // Phase 4·#2 — create 默认非全天; 全天 date 默认今天单日 (toggle on 时用)
      setIsAllDay(false)
      setStartDate(todayDateStr())
      setEndDate(todayDateStr())
      setLocation('')
      setCalendarName('')
      setDescription('')
      setChips([])
    }
    setChipInputValue('')
    setErrTitle(false)
    setErrTime(false)
    // Phase 4·#3 — 重置重复规则 (edit 的真实 rrule 由下方 detail effect 异步预填)
    setRruleState(defaultRRuleState())
    setRruleDirty(false)
    setAttendeesDirty(false)
    // focus 标题 (mockup setTimeout 60 让 transition 先跑)
    const id = window.setTimeout(() => titleRef.current?.focus(), 60)
    return () => window.clearTimeout(id)
  }, [open, occurrence])

  // Phase 4·#3 — detail.rrule 到了预填 RRuleEditor (仅 edit + 未 dirty, 防覆盖
  // 用户已编辑). 复杂 RRULE parseRRule 回退 freq=NONE, 但 rruleDirty 仍 false →
  // 提交时不传 rrule → 后端保留原值, 不破坏.
  useEffect(() => {
    if (open && occurrence && detail && !rruleDirty) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- detail.rrule 异步到达后预填 RRuleEditor（仅 edit+未 dirty，防覆盖用户编辑）。响应异步 detail 数据，effect 合理。React Compiler 迁移债。
      setRruleState(parseRRule(detail.rrule))
    }
  }, [open, occurrence, detail, rruleDirty])

  const mut = useMutation({
    mutationFn: async (scope?: 'this' | 'all' | 'future') => {
      // Phase 4·#2 — 全天: UTC midnight Z + end exclusive (inclusive endDate +1);
      // 非全天: 本地 datetime + tz offset (现有).
      const startIso = isAllDay ? `${startDate}T00:00:00Z` : localToIsoWithOffset(startLocal)
      const endIso = isAllDay
        ? `${addDaysToDateStr(endDate, 1)}T00:00:00Z`
        : localToIsoWithOffset(endLocal)
      const builtRrule = buildRRule(rruleState)
      if (isEdit && occurrence) {
        const opts: EventUpdateOpts = {
          icalUid: occurrence.ical_uid,
          summary,
          startIso,
          endIso,
          location: location || undefined,
          description: description || undefined,
          isAllDay
        }
        if (scope === 'this' || scope === 'future') {
          // Phase 4·#3c/#3d — 改这一次 / 改未来 (split). recurrenceId = 该次原始
          // dtstart (instance recurrence_id 或展开 start). occurrence override /
          // split 不走 builder rrule, 也不改与会者 (继承 master, 跟 CLI/writer 一致).
          opts.recurrenceId = occurrence.recurrence_id || occurrence.occurrence_start_iso
          if (scope === 'future') opts.splitFuture = true
        } else {
          // 改整系列. rrule 仅用户动了重复段才传 (含 '' 删除); 没动保留原值
          // (防 builder 有损解析破坏复杂规则).
          if (rruleDirty) opts.rrule = builtRrule
          // Phase 4·#4 — attendees 三态决策抽到 lib/attendees (可单测): 未 dirty 不传
          // (后端保留原与会者 + partstat, 防退化触发 Exchange 重发邀请) / dirty 非空替换
          // / dirty 删光 → clearAttendees 显式清空 (因不传语义现在=保留).
          Object.assign(opts, resolveAttendeesUpdate(attendeesDirty, chips))
        }
        return mailApi.calendar.eventUpdate(opts)
      } else {
        const opts: EventCreateOpts = {
          summary,
          startIso,
          endIso,
          location: location || undefined,
          description: description || undefined,
          attendees: chips.length > 0 ? chips : undefined,
          calendarName: calendarName || undefined,
          rrule: builtRrule || undefined,
          isAllDay: isAllDay || undefined
        }
        return mailApi.calendar.eventCreate(opts)
      }
    },
    onSuccess: () => {
      toastSuccess(
        isEdit
          ? t('calendar.form.toastUpdated', '事件已更新')
          : t('calendar.form.toastCreated', '事件已创建, ~60s 内同步到本地视图')
      )
      void qc.invalidateQueries({ queryKey: CALENDAR_EVENTS_KEY })
      void qc.invalidateQueries({ queryKey: qk.calendar.event() })
      onClose()
    },
    onError: (err: unknown) => {
      const e = err as Error
      toastError(
        isEdit
          ? t('calendar.form.toastErrUpdate', '更新事件失败')
          : t('calendar.form.toastErrCreate', '创建事件失败'),
        e.message || t('calendar.toolbar.syncTipUnknownErr', '未知错误')
      )
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
    // Phase 4·#2 — 全天用 date 比较 (单日 endDate==startDate 合法); 非全天用 datetime.
    const timeInvalid = isAllDay
      ? !!(startDate && endDate && endDate < startDate)
      : !!(startLocal && endLocal && new Date(endLocal) <= new Date(startLocal))
    if (timeInvalid) {
      setErrTime(true)
      ok = false
    } else {
      setErrTime(false)
    }
    return ok
  }, [summary, startLocal, endLocal, isAllDay, startDate, endDate])

  // 用户边改边清错 (mockup behaviour)：render 期间条件 setState（输入转有效即清错误，
  // 守卫 errX && valid 防循环），取代原两个 set-state-in-effect。
  if (errTitle && summary.trim()) setErrTitle(false)
  const timeValidNow = isAllDay
    ? !!(startDate && endDate && endDate >= startDate)
    : !!(startLocal && endLocal && new Date(endLocal) > new Date(startLocal))
  if (errTime && timeValidNow) setErrTime(false)

  const handleSubmit = (): void => {
    if (!validate()) {
      if (!summary.trim()) titleRef.current?.focus()
      else startRef.current?.focus()
      return
    }
    // Phase 4·#3c — 周期事件 edit: 先弹 scope 对话 (改这一次/整系列)
    if (isEdit && isRecurring) {
      setScopeDialogOpen(true)
      return
    }
    mut.mutate(isEdit ? 'all' : undefined)
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
      setAttendeesDirty(true)
    },
    [chips]
  )

  const onChipInputKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      e.preventDefault()
      addChip(chipInputValue)
    } else if (e.key === 'Backspace' && chipInputValue === '' && chips.length) {
      setChips((cs) => cs.slice(0, -1))
      setAttendeesDirty(true)
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

  if (!shouldRender) return null

  return (
    <div
      ref={scopeRef}
      className="efm-backdrop"
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
            {isEdit
              ? t('calendar.form.titleEdit', '编辑事件')
              : t('calendar.form.titleCreate', '新建事件')}
          </h2>
          <button
            type="button"
            className="efm-close"
            onClick={onClose}
            aria-label={t('calendar.shared.close', '关闭 (Esc)')}
            title={t('calendar.shared.close', '关闭 (Esc)')}
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        <div className="efm-body scrollbar-thin">
          {/* 标题 */}
          <div className="ef-field">
            <label className="ef-label" htmlFor="ef-title">
              {t('calendar.form.labelTitle', '标题')}
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
              placeholder={t('calendar.form.placeholderTitle', '事件标题')}
              autoComplete="off"
              aria-required
              aria-invalid={errTitle || undefined}
              maxLength={200}
            />
            <div className={cn('ef-err', errTitle && 'show')} role="alert">
              <AlertCircle size={13} strokeWidth={2} />
              <span>{t('calendar.form.errTitle', '请输入事件标题')}</span>
            </div>
          </div>

          {/* 起止时间 (Phase 4·#2 — 全天 toggle 切 date input) */}
          <div className="ef-field">
            <div className="flex items-center justify-between">
              <label className="ef-label">{t('calendar.form.labelTime', '起止时间')}</label>
              <label className="flex items-center gap-1.5 text-aux text-ink-fg-1 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={isAllDay}
                  onChange={(e) => setIsAllDay(e.target.checked)}
                />
                <span>{t('calendar.form.allDayToggle', '全天')}</span>
              </label>
            </div>
            <div className="ef-grid2">
              {isAllDay ? (
                <>
                  <input
                    ref={startRef}
                    className={cn('ef-input mono', errTime && 'invalid')}
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    aria-label={t('calendar.form.ariaStart', '开始时间')}
                  />
                  <input
                    className={cn('ef-input mono', errTime && 'invalid')}
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    aria-label={t('calendar.form.ariaEnd', '结束时间')}
                  />
                </>
              ) : (
                <>
                  <input
                    ref={startRef}
                    className={cn('ef-input mono', errTime && 'invalid')}
                    type="datetime-local"
                    value={startLocal}
                    onChange={(e) => setStartLocal(e.target.value)}
                    aria-label={t('calendar.form.ariaStart', '开始时间')}
                  />
                  <input
                    className={cn('ef-input mono', errTime && 'invalid')}
                    type="datetime-local"
                    value={endLocal}
                    onChange={(e) => setEndLocal(e.target.value)}
                    aria-label={t('calendar.form.ariaEnd', '结束时间')}
                  />
                </>
              )}
            </div>
            <div className={cn('ef-err', errTime && 'show')} role="alert">
              <AlertCircle size={13} strokeWidth={2} />
              <span>{t('calendar.form.errTime', '结束时间需晚于开始时间')}</span>
            </div>
          </div>

          {/* Phase 4·#1 — 日历归属 (仅多 calendar 显示; edit 只读) */}
          {calendars.length > 1 && (
            <div className="ef-field">
              <label className="ef-label" htmlFor="ef-cal">
                {t('calendar.form.labelCalendar', '日历')}
              </label>
              {isEdit ? (
                <input
                  id="ef-cal"
                  type="text"
                  className="ef-input"
                  value={calendarName || t('calendar.form.calendarDefault', '默认日历')}
                  disabled
                  title={t('calendar.form.calendarEditLocked', '暂不支持跨日历移动事件')}
                />
              ) : (
                <select
                  id="ef-cal"
                  className="ef-input"
                  value={calendarName}
                  onChange={(e) => setCalendarName(e.target.value)}
                >
                  <option value="">{t('calendar.form.calendarDefault', '默认日历')}</option>
                  {calendars.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {/* Phase 4·#3 — 重复规则 (RRULE builder) */}
          <RRuleEditor
            value={rruleState}
            onChange={(next) => {
              setRruleState(next)
              setRruleDirty(true)
            }}
            seriesHint={isEdit && !!detail?.rrule}
          />

          {/* 地点 */}
          <div className="ef-field">
            <label className="ef-label" htmlFor="ef-loc">
              {t('calendar.form.labelLocation', '地点')}
            </label>
            <input
              id="ef-loc"
              type="text"
              className="ef-input"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder={t('calendar.form.placeholderLocation', '会议室 / Teams 链接 / 地址')}
              autoComplete="off"
              maxLength={500}
            />
          </div>

          {/* 与会者 chip 输入 */}
          <div className="ef-field">
            <label className="ef-label" htmlFor="ef-att-input">
              {t('calendar.form.attendees.label', '与会者')}
            </label>
            <div
              className={cn('chip-field', chipFocused && 'focus', chipInvalid && 'invalid')}
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
                      setAttendeesDirty(true)
                    }}
                    aria-label={t('calendar.form.attendees.removeChip', '移除 {email}', {
                      email: c.email
                    })}
                    title={t('calendar.shared.closeAria', '关闭')}
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
                placeholder={
                  chips.length === 0
                    ? t('calendar.form.attendees.placeholder', '输入 email 后回车添加')
                    : ''
                }
                autoComplete="off"
                aria-label={t('calendar.form.attendees.label', '与会者')}
              />
            </div>
            <div className="chip-hint">
              {t('calendar.form.attendees.hint', 'Enter 添加 · ⌫ 删除上一个 · 点 × 移除')}
            </div>
          </div>

          {/* 描述 */}
          <div className="ef-field">
            <label className="ef-label" htmlFor="ef-desc">
              {t('calendar.form.labelDescription', '描述')}
            </label>
            <textarea
              id="ef-desc"
              className="ef-textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('calendar.form.placeholderDescription', '议程、备注、相关链接…')}
              maxLength={2000}
            />
          </div>
        </div>

        <div className="efm-foot">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={mut.isPending}>
            {t('calendar.form.actions.cancel', '取消')}
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={handleSubmit}
            disabled={mut.isPending}
          >
            {mut.isPending
              ? isEdit
                ? t('calendar.form.actions.saving', '保存中…')
                : t('calendar.form.actions.creating', '创建中…')
              : isEdit
                ? t('calendar.form.actions.save', '保存')
                : t('calendar.form.actions.create', '创建')}
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

      {/* Phase 4·#3c — 周期事件 scope 对话 (改这一次 / 整个系列) */}
      {scopeDlgRender && (
        <div
          ref={scopeDlgRef}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget) setScopeDialogOpen(false)
          }}
        >
          {/* 主题 v3 C8/批 4: 模态确认浮窗 rounded-xl(12) → --r-pop(14) */}
          <div data-anim-card className="glass-pop p-5 rounded-[var(--r-pop)] max-w-[340px] mx-4">
            <div className="text-lead text-ink-fg font-medium mb-1">
              {t('calendar.form.recurrenceScope.title', '周期事件')}
            </div>
            <div className="text-aux text-ink-fg-2 mb-4">
              {t('calendar.form.recurrenceScope.body', '此修改应用到：')}
            </div>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                className="btn-primary"
                disabled={mut.isPending}
                onClick={() => {
                  setScopeDialogOpen(false)
                  mut.mutate('this')
                }}
              >
                {t('calendar.form.recurrenceScope.thisOnly', '仅此事件')}
              </button>
              <button
                type="button"
                className="btn-ghost"
                disabled={mut.isPending}
                onClick={() => {
                  setScopeDialogOpen(false)
                  mut.mutate('future')
                }}
              >
                {t('calendar.form.recurrenceScope.thisAndFuture', '此事件及以后')}
              </button>
              <button
                type="button"
                className="btn-ghost"
                disabled={mut.isPending}
                onClick={() => {
                  setScopeDialogOpen(false)
                  mut.mutate('all')
                }}
              >
                {t('calendar.form.recurrenceScope.allSeries', '整个系列')}
              </button>
              <button
                type="button"
                className="text-meta text-ink-fg-3 mt-1"
                onClick={() => setScopeDialogOpen(false)}
              >
                {t('calendar.form.actions.cancel', '取消')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
