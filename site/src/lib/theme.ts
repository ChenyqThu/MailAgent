/**
 * Cross-island theme / accent / language state — nanostores + persistent.
 *
 * Persisted to localStorage (keys ma_theme / ma_accent / ma_lang). Writing a
 * store updates data-theme / data-accent on <html>; tokens.css re-resolves the
 * CSS vars so the whole page (Astro + React islands) re-skins from one switch.
 *
 * Language is tracked here for the nav switcher's active state, but actual
 * locale routing is path-based (/ vs /en/) — see lib/i18n.ts. The no-flash
 * bootstrap (Landing.astro inline <script>) sets attrs before paint; this
 * module reconciles once React hydrates.
 */
import { persistentAtom } from '@nanostores/persistent'

export type Theme = 'dark' | 'light'
export type Accent = 'coral' | 'cobalt' | 'teal' | 'rose' | 'slate' | 'olive'
export type Lang = 'zh-CN' | 'en'

export const ACCENTS: Accent[] = ['coral', 'cobalt', 'teal', 'rose', 'slate', 'olive']

export const $theme = persistentAtom<Theme>('ma_theme', 'dark')
export const $accent = persistentAtom<Accent>('ma_accent', 'coral')
export const $lang = persistentAtom<Lang>('ma_lang', 'zh-CN')

/** Reflect theme/accent onto the <html> element. No-op on the server. */
export function applyThemeAttrs(theme: Theme, accent: Accent): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.setAttribute('data-theme', theme)
  root.setAttribute('data-accent', accent)
}

/** Subscribe stores → DOM. Call once from the island on mount. */
export function wireThemeToDom(): () => void {
  const unsubTheme = $theme.subscribe((t) => applyThemeAttrs(t, $accent.get()))
  const unsubAccent = $accent.subscribe((a) => applyThemeAttrs($theme.get(), a))
  return () => {
    unsubTheme()
    unsubAccent()
  }
}

/**
 * Inline no-flash bootstrap. Stringified and injected as <script is:inline>
 * in the Landing layout <head> so attrs are set before first paint. Reads the
 * SAME localStorage keys @nanostores/persistent uses (raw string values).
 */
export const NO_FLASH_SNIPPET = `(()=>{try{
  var t=localStorage.getItem('ma_theme')||'dark';
  var a=localStorage.getItem('ma_accent')||'coral';
  var r=document.documentElement;
  r.setAttribute('data-theme', t==='light'?'light':'dark');
  r.setAttribute('data-accent', a);
}catch(e){
  document.documentElement.setAttribute('data-theme','dark');
  document.documentElement.setAttribute('data-accent','coral');
}})();`
