// Sprint 18 §PR D — General tab.
// Sprint 18 review — 完整按 mockup-settings.html §appearance 复刻三块:
//
//   1. 强调色 (Accent)
//      - `tile rounded-lg p-5 border border-ink-border-soft`
//      - grid-cols-6 swatch grid, 每列 `flex flex-col items-center gap-1.5`
//      - 44px swatch (mockup `.swatch-grid .swatch`) + 名字 label
//        (`text-meta font-mono text-ink-fg-1` 选中 / `text-ink-fg-2` 非选)
//      - 选中态: 双层 ring (2px ink-2 + 4px accent) + Check icon
//        (mockup `.swatch[aria-checked="true"]` 完整还原)
//      - 底部 helper note `text-meta text-ink-fg-2 leading-relaxed`
//
//   2. 语言 (Language) + 3. 主题 (Theme)
//      - `tile rounded-lg border + divide-y`
//      - 每 row `flex items-center gap-3 px-4 py-3 cursor-pointer`
//      - 左 14px 自定义 radio (`.rad` / `.rad-on` from index.css)
//      - 中 label + meta 两行
//      - 右 ISO code (zh-CN/en) 或 hint (recommended) mono
//
// 三块共用 mockup §appearance §header (PageHeader), Section.tsx 的 title
// row 已经用 `text-lead font-medium` + `meta font-mono`, 跟 mockup 一致.
// 但 Section.tsx 默认 children 走 `divide-y tile`, accent block 需要 `tile
// rounded-lg p-5` 单一容器, 所以 accent 跳过 Section, 直接组装 mb-7 块.

import * as React from 'react'
import { useTranslation } from 'react-i18next'

import {
  useAppearance,
  type AccentId,
  type BodyFont,
  type SurfaceStyle,
  type ThemeMode,
  BODY_FONT_SIZE_MIN,
  BODY_FONT_SIZE_MAX,
  BODY_LINE_HEIGHT_MIN,
  BODY_LINE_HEIGHT_MAX
} from '@shared/state/appearance'
import { SUPPORTED_LOCALES, type Locale } from '@shared/i18n'
import { cn } from '@shared/lib/cn'

import { PageHeader } from '../parts/PageHeader'

interface AccentMeta {
  id: AccentId
  label: string
  /** Hex 来自 mockup-settings.html line 642-647. 跟 `:root[data-accent=X]`
   *  block 里的 `--c-accent` 颜色对齐, 但作为 swatch 填充色直接 inline
   *  hex — `--c-accent-coral` 这种"每个 accent 一个变量"的 CSS 变量并不
   *  存在 (只有 `:root[data-accent="cobalt"]` 整组 override 一个 --c-accent),
   *  所以旧版 `var(--c-accent-${id})` fallback 永远 fallback 到当前活跃
   *  accent → 6 个 swatch 全部同色. */
  hex: string
}

// accent swatch 填充 = 主题色值定义（见上方 AccentMeta.hex 注释：per-accent
// `--c-accent-${id}` CSS 变量并不存在，swatch 只能 inline hex）。调色板字面量非
// token 滥用，规则豁免。
/* eslint-disable mailagent/no-raw-hex */
// 主题 v2 — swatch 填充对齐 accent v2 暗色 triplet (oklch .75 .135 h 导出,
// HANDOFF-theme-spec-v2 §2): coral 由偏橙移到 hue 28 真珊瑚。
const ACCENT_LIST: AccentMeta[] = [
  { id: 'coral', label: 'Coral', hex: '#F88A7D' },
  { id: 'cobalt', label: 'Cobalt', hex: '#7EADFF' },
  { id: 'teal', label: 'Teal', hex: '#37C7AE' },
  { id: 'rose', label: 'Rose', hex: '#F188AF' },
  { id: 'slate', label: 'Slate', hex: '#9EB0C4' },
  { id: 'olive', label: 'Olive', hex: '#A3B96C' }
]
/* eslint-enable mailagent/no-raw-hex */

interface ThemeRow {
  value: ThemeMode
  labelKey: string
  metaKey: string
  rightKey?: string
}

const THEME_ROWS: ThemeRow[] = [
  {
    value: 'system',
    labelKey: 'settings.theme.system',
    metaKey: 'settings.general.theme.systemMeta',
    rightKey: 'settings.general.theme.recommended'
  },
  {
    value: 'dark',
    labelKey: 'settings.theme.dark',
    metaKey: 'settings.general.theme.darkMeta'
  },
  {
    value: 'light',
    labelKey: 'settings.theme.light',
    metaKey: 'settings.general.theme.lightMeta'
  }
]

interface LocaleRow {
  value: Locale
  labelKey: string
  metaKey: string
  code: string
}

const LOCALE_ROWS: LocaleRow[] = [
  {
    value: 'zh-CN',
    labelKey: 'settings.general.language.zh',
    metaKey: 'settings.general.language.zhMeta',
    code: 'zh-CN'
  },
  {
    value: 'en-US',
    labelKey: 'settings.general.language.en',
    metaKey: 'settings.general.language.enMeta',
    code: 'en-US'
  }
]

interface SurfaceRow {
  value: SurfaceStyle
  labelKey: string
  metaKey: string
}

// 主题 v2 — 液态档已删 (SurfaceStyle 收敛两档), 存量 localStorage 由
// appearance.ts readSurface 迁移为 frosted。
const SURFACE_ROWS: SurfaceRow[] = [
  {
    value: 'frosted',
    labelKey: 'surface.frosted',
    metaKey: 'settings.general.surface.frostedMeta'
  },
  {
    value: 'solid',
    labelKey: 'surface.solid',
    metaKey: 'settings.general.surface.solidMeta'
  }
]

interface BodyFontRow {
  value: BodyFont
  labelKey: string
  metaKey: string
}

const BODY_FONT_ROWS: BodyFontRow[] = [
  {
    value: 'system',
    labelKey: 'settings.general.bodyText.font.system',
    metaKey: 'settings.general.bodyText.font.systemMeta'
  },
  {
    value: 'serif',
    labelKey: 'settings.general.bodyText.font.serif',
    metaKey: 'settings.general.bodyText.font.serifMeta'
  },
  {
    value: 'mono',
    labelKey: 'settings.general.bodyText.font.mono',
    metaKey: 'settings.general.bodyText.font.monoMeta'
  }
]

/** 紧凑 +/− stepper — 给正文字号 / 行高用 (连续可调, 比 radio 档位更细)。
 *  左栏 label+meta 复用 RadioRow 节奏, 右侧 [− value +]。 */
function Stepper({
  label,
  meta,
  display,
  onDec,
  onInc,
  canDec,
  canInc
}: {
  label: React.ReactNode
  meta: React.ReactNode
  display: string
  onDec: () => void
  onInc: () => void
  canDec: boolean
  canInc: boolean
}): React.ReactElement {
  const btn = cn(
    'inline-flex size-7 items-center justify-center rounded-md border border-ink-border-soft',
    'text-ink-fg-1 hover:bg-ink-fg/[0.06] transition-colors duration-fast',
    'disabled:opacity-40 disabled:pointer-events-none',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70'
  )
  return (
    <div className="flex w-full items-center gap-3 px-4 py-3">
      <div className="flex-1 min-w-0">
        <div className="text-aux font-medium text-ink-fg">{label}</div>
        <div className="text-meta text-ink-fg-2 mt-0.5">{meta}</div>
      </div>
      <div className="inline-flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          aria-label="decrease"
          onClick={onDec}
          disabled={!canDec}
          className={btn}
        >
          −
        </button>
        <span className="w-14 text-center text-aux font-mono tabular-nums text-ink-fg">
          {display}
        </span>
        <button
          type="button"
          aria-label="increase"
          onClick={onInc}
          disabled={!canInc}
          className={btn}
        >
          +
        </button>
      </div>
    </div>
  )
}

/** 14px 自定义 radio — mockup `.rad` / `.rad-on` 还原, 用 inline 样式
 *  避免依赖未定义的 utility class. selected 态外环 + 中心实心都用
 *  --c-accent. */
function Rad({ selected }: { selected: boolean }): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-3.5 shrink-0 items-center justify-center rounded-full',
        'border-[1.5px] transition-colors duration-fast',
        selected ? 'border-coral' : 'border-ink-fg-3'
      )}
    >
      {selected ? <span className="size-1.5 rounded-full bg-coral/100" /> : null}
    </span>
  )
}

/** mockup `.swatch-grid .swatch` (44px). aria-checked 时双层 ring +
 *  中心 white check svg + drop-shadow. 颜色来自 `ACCENT_LIST[i].hex`
 *  inline, 跟 mockup line 642-647 同源. 选中态 ring 用 ink-2 (与
 *  swatch grid 父容器 `.tile` = ink-2 同色) 做"挖空环", 再叠一层
 *  accent ring 形成 mockup 经典的 ring-in-ring 选中视觉. */
function Swatch({
  hex,
  selected,
  label,
  onSelect
}: {
  hex: string
  selected: boolean
  label: string
  onSelect: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      className={cn(
        'size-11 rounded-full relative cursor-pointer',
        'transition-transform duration-fast ease-standard hover:scale-105',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70'
      )}
      style={{
        backgroundColor: hex,
        // mockup `.swatch` 默认 1px black ring; selected 改 2px ink-2 +
        // 4px accent 双层 ring (mockup line 307). 用 box-shadow 直接组合.
        // selected ring 用当前 swatch 自己的 hex (不是 --c-accent), 这样
        // 用户切到任意 swatch 都立刻看到它自己的 hex 在 ring 里, 而不是
        // 等 setAccent 改 --c-accent 后 ring 才追上.
        boxShadow: selected
          ? `0 0 0 2px rgb(var(--ink-2)), 0 0 0 4px ${hex}, 0 1px 2px rgba(0,0,0,0.2)`
          : '0 0 0 1px rgba(0,0,0,0.25), 0 1px 2px rgba(0,0,0,0.2)'
      }}
    >
      {selected ? (
        // mockup-settings.html line 308-312 — 14px white check svg, drop
        // shadow 让它在所有 accent (含浅色 olive) 上都可读.
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="white"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="absolute inset-0 m-auto"
          style={{ filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.4))' }}
          aria-hidden="true"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : null}
    </button>
  )
}

interface RadioRowProps {
  selected: boolean
  label: React.ReactNode
  meta: React.ReactNode
  right?: React.ReactNode
  onSelect: () => void
}

/** mockup `<label class="flex items-center gap-3 px-4 py-3 cursor-pointer">`
 *  的 React 版. 用 button (a11y) 包 radio + label + meta + right code. */
function RadioRow({ selected, label, meta, right, onSelect }: RadioRowProps): React.ReactElement {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-3 px-4 py-3 text-left cursor-pointer',
        'transition-colors duration-fast ease-standard',
        'hover:bg-ink-fg/[0.04]',
        'focus-visible:outline-none focus-visible:bg-ink-fg/[0.04]'
      )}
    >
      <Rad selected={selected} />
      <div className="flex-1 min-w-0">
        <div className="text-aux font-medium text-ink-fg">{label}</div>
        <div className="text-meta text-ink-fg-2 mt-0.5">{meta}</div>
      </div>
      {right ? <span className="text-meta font-mono text-ink-fg-2 shrink-0">{right}</span> : null}
    </button>
  )
}

/** mockup §appearance 的二级 block 标题行: `text-lead font-medium` (左) +
 *  `text-meta font-mono text-ink-fg-2` (右 meta). 跟 Section.tsx 的 title
 *  row 节奏一致, 但 children 不走 divide-y tile, 由调用方控制. */
function BlockHeader({
  title,
  meta
}: {
  title: React.ReactNode
  meta?: React.ReactNode
}): React.ReactElement {
  return (
    <div className="flex items-end justify-between mb-2.5">
      <h2 className="text-lead font-medium text-ink-fg">{title}</h2>
      {meta ? <span className="text-meta font-mono text-ink-fg-2">{meta}</span> : null}
    </div>
  )
}

/** Roving-tabindex 方向键导航 (WAI-ARIA radiogroup 键盘模式)。返回挂到
 *  `role="radiogroup"` 容器 onKeyDown 的处理器: ←↑=上一个 / →↓=下一个
 *  (循环 wrap), Home/End=首/尾。移动时同时 onSelect(next) + 把 DOM 焦点
 *  移到新选中的 `[role="radio"]`。其它键不拦截。 */
function makeRovingKeyDown<T>(
  values: readonly T[],
  current: T,
  onSelect: (value: T) => void
): (e: React.KeyboardEvent<HTMLDivElement>) => void {
  return (e) => {
    if (values.length === 0) return
    const currentIdx = values.indexOf(current)
    // 选中值不在数组里时, 把方向键起点视作首项 (-1 → prev=末 / next=首)。
    const base = currentIdx < 0 ? 0 : currentIdx
    let nextIdx: number
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIdx = (base - 1 + values.length) % values.length
        break
      case 'ArrowRight':
      case 'ArrowDown':
        nextIdx = (base + 1) % values.length
        break
      case 'Home':
        nextIdx = 0
        break
      case 'End':
        nextIdx = values.length - 1
        break
      default:
        return
    }
    e.preventDefault()
    const nextValue = values[nextIdx]
    if (nextValue !== current) onSelect(nextValue)
    const radios = e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')
    radios[nextIdx]?.focus()
  }
}

export function GeneralTab(): React.ReactElement {
  const { t, i18n } = useTranslation()
  const themeMode = useAppearance((s) => s.themeMode)
  const setThemeMode = useAppearance((s) => s.setThemeMode)
  const accent = useAppearance((s) => s.accent)
  const setAccent = useAppearance((s) => s.setAccent)
  const surface = useAppearance((s) => s.surface)
  const setSurface = useAppearance((s) => s.setSurface)
  const bodyFont = useAppearance((s) => s.bodyFont)
  const setBodyFont = useAppearance((s) => s.setBodyFont)
  const bodyFontSize = useAppearance((s) => s.bodyFontSize)
  const setBodyFontSize = useAppearance((s) => s.setBodyFontSize)
  const bodyLineHeight = useAppearance((s) => s.bodyLineHeight)
  const setBodyLineHeight = useAppearance((s) => s.setBodyLineHeight)

  const currentLocale: Locale = (SUPPORTED_LOCALES as readonly string[]).includes(i18n.language)
    ? (i18n.language as Locale)
    : 'zh-CN'

  function handleLocaleChange(next: Locale): void {
    void i18n.changeLanguage(next)
  }

  // 各 radiogroup 的取值数组 (派生自模块级静态常量, 故空依赖 memo —
  // 避免每次按键重新分配)。供 makeRovingKeyDown 计算 prev/next。
  const accentValues = React.useMemo(() => ACCENT_LIST.map((a) => a.id), [])
  const localeValues = React.useMemo(() => LOCALE_ROWS.map((r) => r.value), [])
  const themeValues = React.useMemo(() => THEME_ROWS.map((r) => r.value), [])
  const surfaceValues = React.useMemo(() => SURFACE_ROWS.map((r) => r.value), [])
  const bodyFontValues = React.useMemo(() => BODY_FONT_ROWS.map((r) => r.value), [])

  return (
    <>
      <PageHeader
        eyebrow="GENERAL"
        title={t('settings.appearance', { defaultValue: '外观' })}
        description={t('settings.general.page.intro', {
          defaultValue: '控制强调色、主题、语言与界面材质。所有偏好仅保存在本机。'
        })}
      />

      {/* ── 1. Accent color block ─────────────────────────────────── */}
      <section className="mb-[var(--settings-block-gap,1.75rem)]">
        <BlockHeader
          title={t('settings.accent', { defaultValue: '强调色' })}
          meta={t('settings.general.accent.meta', { defaultValue: '6 prebuilt' })}
        />
        <div className="tile rounded-lg p-5 border border-ink-border-soft">
          <div
            role="radiogroup"
            aria-label="accent"
            onKeyDown={makeRovingKeyDown(accentValues, accent, setAccent)}
            className="grid grid-cols-6 gap-x-2 gap-y-3 place-items-center mb-3"
          >
            {ACCENT_LIST.map(({ id, label, hex }) => {
              const selected = id === accent
              return (
                <div key={id} className="flex flex-col items-center gap-1.5">
                  <Swatch
                    hex={hex}
                    selected={selected}
                    label={label}
                    onSelect={() => setAccent(id)}
                  />
                  <span
                    className={cn(
                      'text-meta font-mono',
                      selected ? 'text-ink-fg-1' : 'text-ink-fg-2'
                    )}
                  >
                    {label}
                  </span>
                </div>
              )
            })}
          </div>
          <p className="text-meta text-ink-fg-2 leading-relaxed">
            {t('settings.general.accent.note', {
              defaultValue:
                '同步至灵动岛通知边框、收件列表选中条、AI 起草按钮、批量栏徽章。每次切换都会广播到 ping-island 桥接。'
            })}
          </p>
        </div>
      </section>

      {/* ── 2. Language block ─────────────────────────────────────── */}
      <section className="mb-[var(--settings-block-gap,1.75rem)]">
        <BlockHeader
          title={t('settings.general.language.title', { defaultValue: '语言' })}
          meta={
            <span className="inline-flex items-center gap-1">
              <kbd>⌥G</kbd>
            </span>
          }
        />
        <div
          role="radiogroup"
          aria-label="locale"
          onKeyDown={makeRovingKeyDown(localeValues, currentLocale, handleLocaleChange)}
          className="tile rounded-lg border border-ink-border-soft divide-y divide-ink-border-soft"
        >
          {LOCALE_ROWS.map(({ value, labelKey, metaKey, code }) => (
            <RadioRow
              key={value}
              selected={value === currentLocale}
              label={t(labelKey, { defaultValue: value })}
              meta={t(metaKey, { defaultValue: '' })}
              right={code}
              onSelect={() => handleLocaleChange(value)}
            />
          ))}
        </div>
        <p className="text-meta text-ink-fg-2 mt-2.5 leading-relaxed">
          {t('settings.general.language.note', {
            defaultValue:
              '列表头 (MAILBOXES · AI FIELDS · ATTACHMENTS) 保持英文等宽体,与正文字号/密度无关。'
          })}
        </p>
      </section>

      {/* ── 3. Theme block ────────────────────────────────────────── */}
      <section className="mb-[var(--settings-block-gap,1.75rem)]">
        <BlockHeader
          title={t('settings.general.theme.title', { defaultValue: '主题' })}
          meta={
            <span className="inline-flex items-center gap-1">
              <kbd>⌥L</kbd>
            </span>
          }
        />
        <div
          role="radiogroup"
          aria-label="theme"
          onKeyDown={makeRovingKeyDown(themeValues, themeMode, setThemeMode)}
          className="tile rounded-lg border border-ink-border-soft divide-y divide-ink-border-soft"
        >
          {THEME_ROWS.map(({ value, labelKey, metaKey, rightKey }) => (
            <RadioRow
              key={value}
              selected={value === themeMode}
              label={t(labelKey, { defaultValue: value })}
              meta={t(metaKey, { defaultValue: '' })}
              right={rightKey ? t(rightKey, { defaultValue: 'recommended' }) : undefined}
              onSelect={() => setThemeMode(value)}
            />
          ))}
        </div>
      </section>

      {/* ── 4. Surface block (mockup 没有, 但我们有 surface 系统) ─── */}
      <section className="mb-[var(--settings-block-gap,1.75rem)]">
        <BlockHeader
          title={t('settings.general.surface.title', { defaultValue: '界面材质' })}
          meta={t('settings.general.surface.meta', { defaultValue: '3 styles' })}
        />
        <div
          role="radiogroup"
          aria-label="surface"
          onKeyDown={makeRovingKeyDown(surfaceValues, surface, setSurface)}
          className="tile rounded-lg border border-ink-border-soft divide-y divide-ink-border-soft"
        >
          {SURFACE_ROWS.map(({ value, labelKey, metaKey }) => (
            <RadioRow
              key={value}
              selected={value === surface}
              label={t(labelKey, { defaultValue: value })}
              meta={t(metaKey, { defaultValue: '' })}
              onSelect={() => setSurface(value)}
            />
          ))}
        </div>
      </section>

      {/* ── 5. Body text — 正文外观 (字体 / 字号 / 行高) ──────────────
          仅作用于 EmailBodyFrame iframe 正文; 通过 appearance store 注入 BODY_CSS
          的 --ma-body-* 变量。字号/行高用 Stepper 连续可调, 行高默认 1.15。 */}
      <section className="mb-[var(--settings-block-gap,1.75rem)]">
        <BlockHeader
          title={t('settings.general.bodyText.title', { defaultValue: '正文外观' })}
          meta={t('settings.general.bodyText.meta', { defaultValue: '仅邮件正文' })}
        />
        <div className="tile rounded-lg border border-ink-border-soft divide-y divide-ink-border-soft">
          {/* radiogroup 只包字体选项 — 不把下面的 Stepper 混进 radiogroup (a11y, codex Low)。 */}
          <div
            role="radiogroup"
            aria-label="body font"
            onKeyDown={makeRovingKeyDown(bodyFontValues, bodyFont, setBodyFont)}
            className="divide-y divide-ink-border-soft"
          >
            {BODY_FONT_ROWS.map(({ value, labelKey, metaKey }) => (
              <RadioRow
                key={value}
                selected={value === bodyFont}
                label={t(labelKey, { defaultValue: value })}
                meta={t(metaKey, { defaultValue: '' })}
                onSelect={() => setBodyFont(value)}
              />
            ))}
          </div>
          <Stepper
            label={t('settings.general.bodyText.size.label', { defaultValue: '字号' })}
            meta={t('settings.general.bodyText.size.meta', { defaultValue: '正文文字大小' })}
            display={`${bodyFontSize}px`}
            onDec={() => setBodyFontSize(bodyFontSize - 1)}
            onInc={() => setBodyFontSize(bodyFontSize + 1)}
            canDec={bodyFontSize > BODY_FONT_SIZE_MIN}
            canInc={bodyFontSize < BODY_FONT_SIZE_MAX}
          />
          <Stepper
            label={t('settings.general.bodyText.lineHeight.label', { defaultValue: '行间距' })}
            meta={t('settings.general.bodyText.lineHeight.meta', {
              defaultValue: '行与行的垂直间距'
            })}
            display={bodyLineHeight.toFixed(2)}
            onDec={() => setBodyLineHeight(Math.round((bodyLineHeight - 0.05) * 100) / 100)}
            onInc={() => setBodyLineHeight(Math.round((bodyLineHeight + 0.05) * 100) / 100)}
            canDec={bodyLineHeight > BODY_LINE_HEIGHT_MIN + 1e-6}
            canInc={bodyLineHeight < BODY_LINE_HEIGHT_MAX - 1e-6}
          />
        </div>
        <p className="text-meta text-ink-fg-2 mt-2.5 leading-relaxed">
          {t('settings.general.bodyText.note', {
            defaultValue:
              '仅作用于邮件正文阅读区，不改变列表、AI 字段与界面其它文字。行间距默认 1.15。'
          })}
        </p>
      </section>
    </>
  )
}
