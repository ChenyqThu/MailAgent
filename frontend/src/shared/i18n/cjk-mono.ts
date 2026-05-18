// Sprint 4 review (opus M carry-forward) — locale-conditional className
// swap for chat panel sites that may resolve a `t(...)` value to a CJK
// string while rendering at `text-micro` (11px mono) or `text-meta`
// (12px mono).
//
// Background. DESIGN.md §1.3 + §3.2 + §14 #2 forbid Chinese at
// `text-micro` / `text-meta` — the 11/12px mono floor is English-only by
// design. The existing ESLint rule (`no-cjk-in-mono-size`) catches CJK
// in JSX source literals but cannot inspect the runtime value of an
// i18n key. So a Chinese `t('chat.context.aiFields')` rendering inside a
// `text-micro` chip slips past lint at build time.
//
// The fix is a runtime swap: when the active locale is CJK (`zh*` /
// `ja*` / `ko*`), substitute a CN-safe larger sans class. English/Latin
// locales keep the mono tightness — that's the "tool typography" signal
// DESIGN.md §3.3 calls out.
//
// Usage pattern (Sprint 4 chat panel):
//   const klass = useCjkMonoSwap('text-micro font-mono uppercase tracking-wider')
//   <span className={cn(klass, 'text-coral')}>{t('chat.draftReply.header')}</span>
//
// Pass the FULL mono className string (size + font-family + casing +
// tracking). The swap drops those properties together — they don't apply
// to 14px CJK sans rhythm anyway.

import { useTranslation } from 'react-i18next'

const CJK_PREFIXES: ReadonlyArray<string> = ['zh', 'ja', 'ko']

/**
 * Returns `monoClass` for non-CJK locales; returns `cjkClass`
 * (default `text-aux`) when the active locale is CJK. Renders are stable
 * across locale changes because the swap is driven by `i18n.language`.
 */
export function useCjkMonoSwap(monoClass: string, cjkClass: string = 'text-aux'): string {
  const { i18n } = useTranslation()
  return isCjkLocale(i18n.language) ? cjkClass : monoClass
}

export function isCjkLocale(language: string | undefined | null): boolean {
  if (!language) return false
  const lower = language.toLowerCase()
  return CJK_PREFIXES.some((p) => lower.startsWith(p))
}
