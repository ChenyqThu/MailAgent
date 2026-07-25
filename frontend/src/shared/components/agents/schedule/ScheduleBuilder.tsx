// 共享排程构建器 —— 完全自定义 Agent 与报告 Agent **同一个组件**（PRD 需求 2）。
//
// 移植自 lab.moumen.dev/components/schedule-builder（源码存
// `.trellis/tasks/07-24-…/research/schedule-builder-upstream.tsx`），保留其核心价值：
//   • 活的句子（词级 morph）—— 规则读起来像一句话，不是一排下拉框
//   • 「接下来 N 次真实运行」预览 —— 月末 skip / clamp / DST 跃变**如实呈现**，不装没事
// 相对上游的改动：
//   • 配色/圆角/间距全部换成 DESIGN.md v3 原生材质 token（不照搬 lab-theme）
//   • 英文句子 → 中英双语 i18n（./sentence.ts）
//   • 🔴 预览按**规则自己的 IANA 时区**算，不是浏览器本地时区（上游只有本地墙钟）
//   • 🔴 补 anchor 相位原点：上游 computeRuns 一律从 now 起算，持久化调度器会漂
//   • 🔴 修上游 monthly 分支忽略 interval 的缺陷（契约 §5 case 9）
//   • occurrence 计算委托 ./occurrences.ts（rrule + 契约 §3），与 Python 侧同语义
import { useMemo, useState } from 'react'
import { MotionConfig, motion, useReducedMotion } from 'motion/react'
import { useTranslation } from 'react-i18next'

import { offsetLabel, preview, wallPartsOf } from './occurrences'
import { hourOptionLabel, ordinalName, sentenceTokens, timeLabel, weekdayName } from './sentence'
import {
  ORDINALS,
  type ScheduleFreq,
  type ScheduleRule,
  type ScheduleValue,
  hostTimezone,
  isValidTimezone
} from './types'

const FREQS: ScheduleFreq[] = ['daily', 'weekly', 'monthly']
const WEEKDAY_IDS = [0, 1, 2, 3, 4, 5, 6]
const HOURS = Array.from({ length: 24 }, (_, i) => i)
const MINUTES = Array.from({ length: 60 }, (_, i) => i)
const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => i + 1)
const MAX_INTERVAL = 12
const PREVIEW_COUNT = 5

const controlStyle: React.CSSProperties = {
  fontFamily: 'inherit',
  fontSize: 13,
  color: 'rgb(var(--ink-fg))',
  background: 'rgb(var(--ink-1) / 0.55)',
  border: '1px solid rgb(var(--ink-border))',
  borderRadius: 'var(--r-ctl)',
  padding: '6px 9px'
}

const rowLabelStyle: React.CSSProperties = {
  width: 52,
  flexShrink: 0,
  fontSize: 12,
  fontWeight: 500,
  color: 'rgb(var(--ink-fg-2))'
}

const stepBtnStyle: React.CSSProperties = {
  width: 26,
  height: 26,
  display: 'grid',
  placeItems: 'center',
  fontFamily: 'inherit',
  fontSize: 14,
  lineHeight: 1,
  border: 0,
  background: 'transparent',
  color: 'rgb(var(--ink-fg-2))',
  cursor: 'pointer',
  borderRadius: 'var(--r-ctl)'
}

export interface ScheduleBuilderProps {
  value: ScheduleValue
  onChange: (next: ScheduleValue) => void
  /** 时区选择器（默认显示）。报告抽屉的 natural_day 时区字段已被本组件接管。 */
  showTimezone?: boolean
  /** 预览条数，默认 5。 */
  occurrences?: number
  /**
   * 锁死频率段（报告 Agent 用）。
   *
   * 🔴 报告侧 `cadence` 不只是节奏，还是**报告内容种类** —— worker 用它决定聚合窗、
   * 去重主键与周/月的层级聚合路径，且今天的 UI 本就把它渲染成只读 `CadencePill`。
   * 让用户在这里改 freq = 把「邮件日报」变成月报，是排程之外的语义变更（PRD 未要求）。
   * custom agent 侧不锁，组件全能力可用。
   */
  lockFreq?: boolean
}

export function ScheduleBuilder({
  value,
  onChange,
  showTimezone = true,
  occurrences = PREVIEW_COUNT,
  lockFreq = false
}: ScheduleBuilderProps): React.ReactElement {
  const { t, i18n } = useTranslation()
  const locale = i18n.language || 'zh-CN'
  const reduce = useReducedMotion()
  const rule = value.rule
  const tz = isValidTimezone(value.timezone) ? value.timezone : hostTimezone()

  // 预览基准时刻 = 抽屉打开的那一刻，之后钉住不动（列表在编辑过程中不抖，上游同款纪律）。
  // 渲染期调 Date.now() 是不纯的（react-hooks/purity）；useState 的 lazy initializer 是
  // 该规则的既定例外（同 useCalendarEvents.useNowTick / MeetingInviteCard 写法）。
  // 不挂 interval 刷新：配置抽屉是短命的，而定时重算会让预览列表在用户编辑途中自己重排。
  const [now] = useState(() => Date.now())

  const setRule = (patch: Partial<ScheduleRule>): void => {
    onChange({ ...value, rule: { ...rule, ...patch } })
  }

  const setTimezone = (nextTz: string): void => {
    // 时区变了，anchor 的「本地日期」含义也变了 —— 但 anchor 只在 interval>1 时影响相位，
    // 且用户此刻的意图是「换个时区跑同一套规则」，故保持 anchor 不动（相位不跳）。
    onChange({ ...value, timezone: nextTz })
  }

  const toggleWeekday = (day: number): void => {
    const has = rule.weekdays.includes(day)
    // 周规则至少要留一天（否则 RRULE 退化成「按 dtstart 的星期」，语义漂移）。
    if (has && rule.weekdays.length === 1) return
    setRule({
      weekdays: has
        ? rule.weekdays.filter((d) => d !== day)
        : [...rule.weekdays, day].sort((a, b) => a - b)
    })
  }

  const tokens = useMemo(
    () => sentenceTokens(t, locale, rule),
    // t 每次 render 是新引用（i18next），只按真正影响文案的入参重算。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locale, rule]
  )

  const entries = useMemo(
    () => preview(rule, tz, value.anchor, now, occurrences),
    [rule, tz, value.anchor, now, occurrences]
  )
  const runs = entries.filter((e) => e.kind === 'run')
  const baseOffset = runs.length ? offsetLabel(runs[0].utcMs, tz) : null

  const tzOptions = useMemo(() => {
    try {
      return Intl.supportedValuesOf('timeZone')
    } catch {
      return [hostTimezone()]
    }
  }, [])

  // 设备时区快捷项：`America/Los_Angeles（设备时区 · PT）`。缩写取不到就退化成不带缩写的
  // 文案（不硬编任何时区名）。
  const deviceTz = useMemo(() => hostTimezone(), [])
  const deviceTzLabel = useMemo(() => {
    const abbr = timeZoneAbbr(deviceTz)
    return abbr
      ? t('agents.schedule.tzDevice', { tz: deviceTz, abbr })
      : t('agents.schedule.tzDeviceNoAbbr', { tz: deviceTz })
    // t 每次 render 新引用；只在 locale / 设备时区变化时重算。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceTz, locale])

  const intervalUnit = t(`agents.schedule.unit.${rule.freq}${rule.interval === 1 ? '1' : 'N'}`)

  return (
    <MotionConfig reducedMotion="user">
      {/* 外层 gap 兼作「句子块 → 第一个配置行」的间距（dogfood：原 12 + minHeight 富余
          ≈29px 太散），与配置行之间的 gap 取齐到 8。 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* ── 活的句子 ───────────────────────────────────────────────────────
            span 之间保留真实空格：选中/复制/读屏拿到的是「Every week…」而不是
            「Everyweek…」。存活的 key 靠 layout 滑动，新 key 淡入。
            外面套浅底块（dogfood：句子原本「裸在那里」）—— 复用本抽屉既有的说明块配方
            （同 agents.config.aggregation：--ink-1 半透 + --ink-border-soft + --r-ctl），
            不新造装饰语言、不硬编码颜色。aria-live 留在 <p> 上，容器不夺走它。 */}
        <div
          style={{
            padding: '8px 10px',
            borderRadius: 'var(--r-ctl)',
            background: 'rgb(var(--ink-1) / 0.55)',
            border: '1px solid rgb(var(--ink-border-soft))'
          }}
        >
          <p
            aria-live="polite"
            data-testid="schedule-sentence"
            style={{
              margin: 0,
              // 留一行高度（14×1.5=21px）而不是删掉：句子换行时仍有跳动，但把单行时的
              // 富余空白清零 —— dogfood 明确要更紧凑，接受这个取舍。
              minHeight: '1.5em',
              fontSize: 14,
              lineHeight: 1.5,
              fontWeight: 500,
              letterSpacing: '-0.01em',
              color: 'rgb(var(--ink-fg))'
            }}
          >
            {tokens.map(({ word, key }, index) => (
              <span key={key}>
                {index > 0 && ' '}
                <motion.span
                  layout={reduce ? false : 'position'}
                  initial={reduce ? false : { opacity: 0, filter: 'blur(2px)', y: '0.3em' }}
                  animate={{ opacity: 1, filter: 'blur(0px)', y: 0 }}
                  transition={{
                    layout: { duration: 0.22, ease: [0.23, 1, 0.32, 1] },
                    duration: 0.12,
                    ease: [0.23, 1, 0.32, 1]
                  }}
                  style={{ display: 'inline-block' }}
                >
                  {word}
                </motion.span>
              </span>
            ))}
          </p>
        </div>

        {/* ── 控件 ──────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* 频率（报告 Agent 锁死：cadence 同时是报告内容种类，见 lockFreq 注释） */}
          {!lockFreq && (
            <div className="flex items-center" style={{ gap: 8, flexWrap: 'wrap', minHeight: 30 }}>
              <span style={rowLabelStyle}>{t('agents.schedule.repeats')}</span>
              <div className="seg" role="group" aria-label={t('agents.schedule.repeats')}>
                {FREQS.map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={rule.freq === f ? 'on' : ''}
                    aria-pressed={rule.freq === f}
                    onClick={() => setRule({ freq: f })}
                  >
                    {t(`agents.schedule.freq.${f}`)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 间隔（每 N 天/周/月）—— 🔴 monthly 也有（上游漏了，契约 §5 case 9 要求修） */}
          <div className="flex items-center" style={{ gap: 8, flexWrap: 'wrap', minHeight: 30 }}>
            <span style={rowLabelStyle}>{t('agents.schedule.every')}</span>
            <div
              className="flex items-center"
              role="group"
              aria-label={t('agents.schedule.every')}
              style={{
                background: 'rgb(var(--ink-1) / 0.55)',
                border: '1px solid rgb(var(--ink-border))',
                borderRadius: 'var(--r-ctl)'
              }}
            >
              <button
                type="button"
                style={stepBtnStyle}
                aria-label={t('agents.schedule.lessOften')}
                disabled={rule.interval <= 1}
                onClick={() => setRule({ interval: rule.interval - 1 })}
              >
                −
              </button>
              <span
                data-testid="schedule-interval"
                style={{
                  minWidth: 22,
                  textAlign: 'center',
                  fontSize: 13,
                  fontVariantNumeric: 'tabular-nums',
                  color: 'rgb(var(--ink-fg))'
                }}
              >
                {rule.interval}
              </span>
              <button
                type="button"
                style={stepBtnStyle}
                aria-label={t('agents.schedule.moreOften')}
                disabled={rule.interval >= MAX_INTERVAL}
                onClick={() => setRule({ interval: rule.interval + 1 })}
              >
                +
              </button>
            </div>
            <span style={{ fontSize: 12, color: 'rgb(var(--ink-fg-3))' }}>{intervalUnit}</span>
          </div>

          {/* 周几（weekly） */}
          {rule.freq === 'weekly' && (
            <div className="flex items-center" style={{ gap: 8, flexWrap: 'wrap', minHeight: 30 }}>
              <span style={rowLabelStyle}>{t('agents.schedule.on')}</span>
              <div className="flex items-center" role="group" style={{ gap: 4 }}>
                {WEEKDAY_IDS.map((day) => {
                  const on = rule.weekdays.includes(day)
                  return (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={on}
                      aria-label={weekdayName(t, day)}
                      onClick={() => toggleWeekday(day)}
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 999,
                        fontFamily: 'inherit',
                        fontSize: 12,
                        fontWeight: 500,
                        cursor: 'pointer',
                        color: on ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-fg-2))',
                        background: on ? 'rgb(var(--c-accent) / 0.14)' : 'rgb(var(--ink-1) / 0.5)',
                        border: `1px solid ${on ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-border))'}`,
                        transition:
                          'color 120ms var(--ease-out-strong), background-color 120ms var(--ease-out-strong), border-color 120ms var(--ease-out-strong)'
                      }}
                    >
                      {t(`agents.schedule.weekdayInitial.${day}`)}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* 按日期 / 按第 N 个星期几（monthly） */}
          {rule.freq === 'monthly' && (
            <>
              <div
                className="flex items-center"
                style={{ gap: 8, flexWrap: 'wrap', minHeight: 30 }}
              >
                <span style={rowLabelStyle}>{t('agents.schedule.on')}</span>
                <div className="seg" role="group" aria-label={t('agents.schedule.monthModeLabel')}>
                  {(['date', 'nth'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={rule.monthMode === m ? 'on' : ''}
                      aria-pressed={rule.monthMode === m}
                      onClick={() => setRule({ monthMode: m })}
                    >
                      {t(`agents.schedule.monthMode.${m}`)}
                    </button>
                  ))}
                </div>
                {rule.monthMode === 'date' ? (
                  <select
                    value={rule.monthDay}
                    aria-label={t('agents.schedule.monthDayLabel')}
                    onChange={(e) => setRule({ monthDay: Number(e.target.value) })}
                    style={controlStyle}
                  >
                    {MONTH_DAYS.map((d) => (
                      <option key={d} value={d}>
                        {t('agents.schedule.dayN', { day: d })}
                      </option>
                    ))}
                  </select>
                ) : (
                  <>
                    <select
                      value={String(rule.ordinal)}
                      aria-label={t('agents.schedule.ordinalLabel')}
                      onChange={(e) =>
                        setRule({
                          ordinal:
                            e.target.value === 'last'
                              ? 'last'
                              : (Number(e.target.value) as 1 | 2 | 3 | 4)
                        })
                      }
                      style={controlStyle}
                    >
                      {ORDINALS.map((o) => (
                        <option key={String(o)} value={String(o)}>
                          {ordinalName(t, o)}
                        </option>
                      ))}
                    </select>
                    <select
                      value={rule.weekday}
                      aria-label={t('agents.schedule.weekdayLabel')}
                      onChange={(e) => setRule({ weekday: Number(e.target.value) })}
                      style={controlStyle}
                    >
                      {WEEKDAY_IDS.map((d) => (
                        <option key={d} value={d}>
                          {weekdayName(t, d)}
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </div>

              {/* 月末策略 —— 只有「按日期」且可能撞上短月时才有意义 */}
              {rule.monthMode === 'date' && rule.monthDay > 28 && (
                <div
                  className="flex items-center"
                  style={{ gap: 8, flexWrap: 'wrap', minHeight: 30 }}
                >
                  <span style={rowLabelStyle}>{t('agents.schedule.monthEnd')}</span>
                  <div className="seg" role="group" aria-label={t('agents.schedule.monthEnd')}>
                    {([false, true] as const).map((c) => (
                      <button
                        key={String(c)}
                        type="button"
                        className={rule.clamp === c ? 'on' : ''}
                        aria-pressed={rule.clamp === c}
                        onClick={() => setRule({ clamp: c })}
                      >
                        {t(`agents.schedule.clamp.${c ? 'on' : 'off'}`)}
                      </button>
                    ))}
                  </div>
                  <span style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))' }}>
                    {t(`agents.schedule.clampHint.${rule.clamp ? 'on' : 'off'}`)}
                  </span>
                </div>
              )}
            </>
          )}

          {/* 时刻 */}
          <div className="flex items-center" style={{ gap: 8, flexWrap: 'wrap', minHeight: 30 }}>
            <span style={rowLabelStyle}>{t('agents.schedule.at')}</span>
            <select
              value={rule.hour}
              aria-label={t('agents.schedule.hourLabel')}
              onChange={(e) => setRule({ hour: Number(e.target.value) })}
              style={controlStyle}
            >
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {hourOptionLabel(h)}
                </option>
              ))}
            </select>
            <select
              value={rule.minute}
              aria-label={t('agents.schedule.minuteLabel')}
              onChange={(e) => setRule({ minute: Number(e.target.value) })}
              style={controlStyle}
            >
              {/* 纯两位数字，不带前导冒号（dogfood：分钟下拉里的「:30」多余，
                  小时/分钟已经是两个相邻控件，冒号反而像输入的一部分）。 */}
              {MINUTES.map((m) => (
                <option key={m} value={m}>
                  {String(m).padStart(2, '0')}
                </option>
              ))}
            </select>
          </div>

          {/* 时区 —— 预览与实际触发都按它，不是浏览器本地时区 */}
          {showTimezone && (
            <div className="flex items-center" style={{ gap: 8, flexWrap: 'wrap', minHeight: 30 }}>
              <span style={rowLabelStyle}>{t('agents.schedule.timezone')}</span>
              {/* 原生 <select>：IANA 列表有 418 项，Radix SelectItem × 418 的挂载成本明显
                  （抽屉里还另有一个 Radix 模型下拉），且原生 select 自带跨 418 项的键盘
                  type-ahead —— 长列表这里比 Radix 好用。与本构建器其余控件（小时/分钟/
                  每月几号）也一致。 */}
              <select
                value={tz}
                aria-label={t('agents.schedule.timezone')}
                onChange={(e) => setTimezone(e.target.value)}
                style={{ ...controlStyle, flex: 1, minWidth: 180 }}
              >
                {/* 顶部快捷项：设备时区带标注（dogfood：默认值本来就是设备时区，但夹在
                    418 项字母序 IANA 里看不出来）。🔴 它与下方列表里的原项**同 value** ——
                    存的永远是解析后的 IANA 名，绝不引入 'local' 之类哨兵值：空/哨兵时区正是
                    本批契约花力气消灭的东西（报告 agent 空时区会退化成 UTC、让 9 点报告漂走）。
                    同 value 时浏览器按首个匹配项回显，于是选中设备时区就显示带标注那条。 */}
                <option key={`device-${deviceTz}`} value={deviceTz}>
                  {deviceTzLabel}
                </option>
                {tzOptions.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* ── 证据：真实运行时刻 + 被跳过月份的 ghost 行 ──────────────────── */}
        <div style={{ borderTop: '1px solid rgb(var(--ink-border-soft))', paddingTop: 10 }}>
          <div
            style={{
              fontSize: 11.5,
              fontWeight: 500,
              color: 'rgb(var(--ink-fg-3))',
              marginBottom: 6
            }}
          >
            {t('agents.schedule.nextRuns', { count: runs.length })}
          </div>
          <ol
            data-testid="schedule-preview"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              margin: 0,
              padding: 0,
              listStyle: 'none'
            }}
          >
            {entries.map((entry, index) =>
              entry.kind === 'skip' ? (
                <motion.li
                  key={entry.key}
                  initial={reduce ? false : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.12, ease: [0.23, 1, 0.32, 1], delay: index * 0.02 }}
                  className="flex items-center"
                  style={{
                    justifyContent: 'space-between',
                    gap: 12,
                    padding: '4px 8px',
                    borderRadius: 'var(--r-ctl)',
                    fontSize: 12,
                    color: 'rgb(var(--ink-fg-3))',
                    border: '1px dashed rgb(var(--ink-border))'
                  }}
                >
                  <span>
                    {t('agents.schedule.skipReason', {
                      month: monthLabel(locale, entry.year, entry.month),
                      days: entry.days
                    })}
                  </span>
                  <span style={{ fontSize: 11 }}>{t('agents.schedule.skipped')}</span>
                </motion.li>
              ) : (
                <motion.li
                  key={entry.utcMs}
                  initial={reduce ? false : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.12, ease: [0.23, 1, 0.32, 1], delay: index * 0.02 }}
                  className="flex items-center"
                  style={{
                    justifyContent: 'space-between',
                    gap: 12,
                    padding: '4px 8px',
                    borderRadius: 'var(--r-ctl)',
                    fontSize: 13,
                    color: 'rgb(var(--ink-fg))'
                  }}
                >
                  <span
                    style={{
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {runDateLabel(locale, entry.wall)}
                    {entry.clamped && (
                      <span style={{ marginLeft: 6, fontSize: 11, color: 'rgb(var(--c-warn))' }}>
                        {t('agents.schedule.clamped')}
                      </span>
                    )}
                  </span>
                  <span
                    className="flex items-baseline"
                    style={{
                      gap: 6,
                      flexShrink: 0,
                      color: 'rgb(var(--ink-fg-2))',
                      fontVariantNumeric: 'tabular-nums'
                    }}
                  >
                    {timeLabel(entry.wall.hour, entry.wall.minute)}
                    <span
                      style={{
                        fontSize: 11,
                        // DST 跃变：与首行偏移不同的行标暖色，让用户看见「时刻没变、偏移变了」。
                        color:
                          offsetLabel(entry.utcMs, tz) !== baseOffset
                            ? 'rgb(var(--c-warn))'
                            : 'rgb(var(--ink-fg-3))'
                      }}
                    >
                      {offsetLabel(entry.utcMs, tz)}
                    </span>
                  </span>
                </motion.li>
              )
            )}
          </ol>
        </div>
      </div>
    </MotionConfig>
  )
}

/** 预览行的日期（本地化，含星期）。wall 已是规则时区的墙钟分量 → 用 UTC 格式化避免二次换算。 */
function runDateLabel(locale: string, wall: ReturnType<typeof wallPartsOf>): string {
  const d = new Date(Date.UTC(wall.year, wall.month, wall.day))
  try {
    return new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC'
    }).format(d)
  } catch {
    return d.toISOString().slice(0, 10)
  }
}

/**
 * 时区缩写（`PT` / `ET` / `GMT+8`），供设备时区快捷项标注用。
 *
 * 固定用 `en-US` 取值而非 UI locale：缩写按惯例是拉丁记号（owner 要的就是 "PT"），
 * zh-CN 下 `shortGeneric` 会给「洛杉矶时间」、`short` 会给 `GMT-7`，都不是想要的。
 * 优先 `shortGeneric`（LA→PT、NY→ET，不含夏令时变体），但它对多数时区会给
 * 「China Time」这类长名 —— 只在结果是紧凑全大写缩写时才采用，否则退回 `short`
 * （`GMT+8` / `GMT+5:30` / `UTC`，仍然有信息量）。取不到 → null，调用方省略缩写。
 */
function timeZoneAbbr(tz: string): string | null {
  const pick = (style: 'short' | 'shortGeneric'): string | null => {
    try {
      return (
        new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: style })
          .formatToParts(new Date())
          .find((p) => p.type === 'timeZoneName')?.value ?? null
      )
    } catch {
      return null
    }
  }
  const generic = pick('shortGeneric')
  if (generic && /^[A-Z]{2,5}$/.test(generic)) return generic
  return pick('short')
}

function monthLabel(locale: string, year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 1))
  try {
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'long',
      timeZone: 'UTC'
    }).format(d)
  } catch {
    return `${year}-${String(month + 1).padStart(2, '0')}`
  }
}
