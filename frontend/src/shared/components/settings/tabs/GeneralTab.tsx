// Sprint 18 §PR D — General tab (主题 + 强调色 + 语言 + 辅助开关 + 兜底 poll).
//
// 不绑 .env, 全部走前端 zustand + localStorage. 主题三态 (system/dark/light)
// 和 accent 调色直接调 useAppearance setter (Sprint 4 已有). 兜底 poll 间隔
// 是 settings.json 字段 (Sprint 6 已有 PersistentSettings.pollIntervalSec),
// 不属于 .env 体系.

import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { useAppearance, type AccentId, type ThemeMode } from '@shared/state/appearance'
import { RadioGroup, RadioGroupItem } from '@shared/components/ui/radio-group'
import { Label } from '@shared/components/ui/label'
import { cn } from '@shared/lib/cn'

import { Section } from '../parts/Section'
import { Row } from '../parts/Row'

const THEME_OPTIONS: { value: ThemeMode; key: string }[] = [
  { value: 'system', key: 'settings.theme.system' },
  { value: 'light', key: 'settings.theme.light' },
  { value: 'dark', key: 'settings.theme.dark' }
]

const ACCENT_SWATCHES: AccentId[] = ['coral', 'cobalt', 'teal', 'rose', 'slate', 'olive']

export function GeneralTab(): React.ReactElement {
  const { t } = useTranslation()
  const themeMode = useAppearance((s) => s.themeMode)
  const setThemeMode = useAppearance((s) => s.setThemeMode)
  const accent = useAppearance((s) => s.accent)
  const setAccent = useAppearance((s) => s.setAccent)

  return (
    <>
      <Section title={t('settings.appearance')} helper={t('settings.themeModeHint') ?? undefined}>
        <Row label={t('settings.themeMode')} helper={t('settings.themeModeHint')}>
          <RadioGroup
            value={themeMode}
            onValueChange={(v) => setThemeMode(v as ThemeMode)}
            className="flex items-center gap-4"
          >
            {THEME_OPTIONS.map((opt) => (
              <div key={opt.value} className="flex items-center gap-1.5">
                <RadioGroupItem id={`theme-${opt.value}`} value={opt.value} />
                <Label htmlFor={`theme-${opt.value}`} className="cursor-pointer">
                  {t(opt.key)}
                </Label>
              </div>
            ))}
          </RadioGroup>
        </Row>

        <Row label={t('settings.accent')} helper={t('settings.accentHint')}>
          <div className="flex items-center gap-2.5">
            {ACCENT_SWATCHES.map((a) => (
              <button
                key={a}
                type="button"
                aria-label={a}
                onClick={() => setAccent(a)}
                className={cn(
                  'size-7 rounded-full',
                  'transition-transform duration-fast ease-standard hover:scale-110',
                  // Render the swatch by binding the same CSS var the app
                  // would use when this accent is active. We can't
                  // dynamically set `--c-accent` per-swatch, so each
                  // button paints itself with the accent's canonical hue
                  // via an inline style — single source still lives in
                  // index.css `:root[data-accent="<id>"]` blocks.
                  a === accent && 'ring-2 ring-coral/100 ring-offset-2 ring-offset-ink-1'
                )}
                style={{ backgroundColor: `rgb(var(--c-accent-${a}, var(--c-accent)))` }}
              />
            ))}
          </div>
        </Row>
      </Section>
    </>
  )
}
