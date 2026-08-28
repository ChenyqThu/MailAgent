// Sprint 11 V1.4 — DESIGN.md §2.11 nav-shell account derivation.
//
// The expanded nav-shell header renders a single 36px row:
//     [tp-link]  lucien.chen  ▾  ‹
// The collapsed nav-shell shows a 36px avatar monogram:
//     ┌──────┐
//     │  L   │   ← first letter of local-part, on var(--c-accent)
//     └──────┘
//
// Source values derive from one email address:
//   'lucien.chen@tp-link.com'  →  { localPart: 'lucien.chen',
//                                   badge:     'tp-link',
//                                   monogram:  'L' }
//
// V1: single account today (per CLAUDE.md). Source order:
//   1. settings.notionAgentName, if it contains '@'
//   2. Fallback 'me@local'
//
// When the backend grows a `mail_accounts` table, whatever surface lists
// accounts（原 AccountSwitcherPopover 已随 08-27 P1 邮件域面板退役删除）still
// renders per-row via `deriveAccount(email)`, so the helper stays unchanged.

export interface DerivedAccount {
  /** Local-part of the email (left of @). E.g. 'lucien.chen'. */
  localPart: string
  /** Domain prefix (left of first '.' of domain). E.g. 'tp-link'. */
  badge: string
  /** First letter of localPart, uppercased. For the monogram avatar. */
  monogram: string
}

export function deriveAccount(email: string | null | undefined): DerivedAccount {
  if (!email || !email.includes('@')) {
    return { localPart: 'me', badge: '', monogram: 'M' }
  }
  const at = email.indexOf('@')
  const local = email.slice(0, at)
  const domain = email.slice(at + 1)
  const badge = domain.split('.')[0] ?? ''
  const monogram = (local[0] ?? 'M').toUpperCase()
  return { localPart: local, badge, monogram }
}
