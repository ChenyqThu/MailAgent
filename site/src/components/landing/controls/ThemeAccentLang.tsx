/**
 * Nav switchers: theme (dark/light) · accent (6 dots) · language (中/EN).
 * React island (client:load) bound to the nanostores in lib/theme.ts. Theme +
 * accent write data-* on <html> (re-skins via tokens.css). Language navigates
 * between / and /en/ and persists the choice.
 *
 * Kept small and dependency-light — only nanostores + the shared store module.
 */
import { useEffect } from 'react'
import { useStore } from '@nanostores/react'
import { $theme, $accent, $lang, ACCENTS, wireThemeToDom, type Accent } from '../../../lib/theme'
import { localizePath, type Locale } from '../../../lib/i18n'

export default function ThemeAccentLang() {
  const theme = useStore($theme)
  const accent = useStore($accent)
  const lang = useStore($lang)

  // Reflect store → DOM on mount (the no-flash snippet already set initial attrs).
  useEffect(() => wireThemeToDom(), [])

  function setLang(next: Locale) {
    $lang.set(next)
    if (typeof window === 'undefined') return
    const target = localizePath(next, window.location.pathname)
    if (target !== window.location.pathname) {
      window.location.assign(target + window.location.hash)
    }
  }

  return (
    <div className="nav-tools" style={{ gap: 8 }}>
      {/* accent presets */}
      <div className="accents" role="radiogroup" aria-label="Accent">
        {ACCENTS.map((a) => (
          <button
            key={a}
            type="button"
            className={`adot adot--${a}`}
            role="radio"
            aria-checked={accent === a}
            aria-label={a}
            title={a[0].toUpperCase() + a.slice(1)}
            onClick={() => $accent.set(a as Accent)}
          />
        ))}
      </div>

      {/* theme switch */}
      <div className="switch switch--theme" role="group" aria-label="Theme">
        <button
          type="button"
          className={theme === 'dark' ? 'on' : ''}
          aria-pressed={theme === 'dark'}
          title="Dark"
          onClick={() => $theme.set('dark')}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
          </svg>
        </button>
        <button
          type="button"
          className={theme === 'light' ? 'on' : ''}
          aria-pressed={theme === 'light'}
          title="Light"
          onClick={() => $theme.set('light')}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" />
          </svg>
        </button>
      </div>

      {/* language switch */}
      <div className="switch switch--mono" role="group" aria-label="Language">
        <button
          type="button"
          className={lang === 'zh-CN' ? 'on' : ''}
          aria-pressed={lang === 'zh-CN'}
          onClick={() => setLang('zh-CN')}
        >
          中
        </button>
        <button
          type="button"
          className={lang === 'en' ? 'on' : ''}
          aria-pressed={lang === 'en'}
          onClick={() => setLang('en')}
        >
          EN
        </button>
      </div>
    </div>
  )
}
