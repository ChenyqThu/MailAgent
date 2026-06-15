/**
 * Landing UI-chrome i18n — small dictionary for nav labels / buttons that are
 * NOT in the landing YAML (those carry long copy). Long-form section copy comes
 * from src/content/landing/<locale>.yaml; this is only for framework chrome.
 *
 * Locale routing is path-based: zh-CN at `/` (root, no prefix), en at `/en/`.
 */
export type Locale = 'zh-CN' | 'en'

export const LOCALES: Locale[] = ['zh-CN', 'en']
export const DEFAULT_LOCALE: Locale = 'zh-CN'

/** Detect the active locale from the URL (en under /en/, else zh-CN root). */
export function getLocale(url: URL): Locale {
  const seg = url.pathname.split('/').filter(Boolean)[0]
  return seg === 'en' ? 'en' : 'zh-CN'
}

/**
 * Map a path to its equivalent in `locale`. zh-CN is unprefixed; en is /en/...
 *   localizePath('en', '/')        → '/en/'
 *   localizePath('zh-CN', '/en/')  → '/'
 *   localizePath('en', '/docs/')   → '/en/docs/'
 */
export function localizePath(locale: Locale, path: string): string {
  // strip any leading /en prefix to get the canonical (zh) path
  let base = path.replace(/^\/en(\/|$)/, '/')
  if (!base.startsWith('/')) base = '/' + base
  if (locale === 'en') {
    return base === '/' ? '/en/' : `/en${base}`
  }
  return base
}

type Dict = {
  docs: string
  download: string
  skipToContent: string
  langName: string
}

export const UI: Record<Locale, Dict> = {
  'zh-CN': {
    docs: '文档',
    download: '下载',
    skipToContent: '跳到主内容',
    langName: '中',
  },
  en: {
    docs: 'Docs',
    download: 'Download',
    skipToContent: 'Skip to content',
    langName: 'EN',
  },
}

/** Convenience: chrome strings for a locale. */
export function t(locale: Locale): Dict {
  return UI[locale]
}
