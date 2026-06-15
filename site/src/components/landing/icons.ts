/**
 * Inline SVG path data for the landing sections — transcribed verbatim from the
 * reference frontend/docs/landing/MailAgent.html so the marketing page is
 * pixel-faithful. Each entry is the inner markup of a 0 0 24 24 viewBox icon.
 *
 * Two render styles in the reference:
 *   - stroke icons: <svg fill="none" stroke="currentColor" stroke-width=…>
 *   - fill icons:   <svg fill="currentColor">
 * The `f` flag marks fill icons; everything else is a stroke icon. Section
 * components pick the right wrapper via the <Icon> helper (Icon.astro).
 *
 * Kept as data (not components) so a section can map an array of icon keys to
 * its feature-list / strip items without 14 import lines.
 */
export interface IconDef {
  /** inner SVG markup (paths/polylines/etc.) */
  d: string
  /** true → fill="currentColor"; false/undefined → stroke icon */
  f?: boolean
  /** optional per-icon stroke-width override (reference uses 1.75–2.5) */
  sw?: number
}

export const ICONS: Record<string, IconDef> = {
  // brand sparkle star (fill)
  star: { f: true, d: '<path d="M12 2 14.4 9.6 22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z"/>' },

  // download arrow (stroke)
  download: { d: '<path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/>' },
  // apple logo (fill)
  apple: {
    f: true,
    d: '<path d="M16.4 12.9c0-2 1.6-3 1.7-3.1-.9-1.4-2.4-1.5-2.9-1.6-1.2-.1-2.4.7-3 .7s-1.6-.7-2.6-.7c-1.3 0-2.6.8-3.2 2-1.4 2.4-.4 6 1 8 .7 1 1.4 2 2.5 2 1 0 1.3-.6 2.5-.6s1.5.6 2.5.6 1.7-.9 2.4-1.9c.7-1.1 1-2.1 1-2.2 0 0-1.9-.8-1.9-2.9zM14.5 6.8c.5-.7.9-1.6.8-2.6-.8 0-1.8.6-2.4 1.2-.5.6-1 1.5-.8 2.4.9.1 1.8-.4 2.4-1z"/>',
  },
  // github mark (fill)
  github: {
    f: true,
    d: '<path d="M12 2C6.5 2 2 6.5 2 12c0 4.4 2.9 8.2 6.8 9.5.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.6 2.4 1.1 3 .8.1-.7.4-1.1.6-1.4-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5A10 10 0 0 0 22 12c0-5.5-4.5-10-10-10z"/>',
  },
  // arrow-right (stroke) — "see how it works"
  arrowRight: { d: '<path d="M5 12h14m0 0l-6-6m6 6l-6 6"/>' },

  // strip / feature-card icons (stroke)
  categorize: { d: '<path d="M4 7h16M4 12h10M4 17h7"/>' },
  prioritize: { d: '<path d="M3 17l6-6 4 4 8-8"/>' },
  summarize: { d: '<path d="M4 6h16M4 10h16M4 14h10M4 18h6"/>' },
  draft: { d: '<path d="M3 20l4-1 11-11-3-3L4 16l-1 4z"/>' },
  suggest: { d: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>' },
  search: { d: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/>' },

  // checkmark (stroke, thick) — flist bullet
  check: { sw: 2.4, d: '<path d="M20 6L9 17l-5-5"/>' },

  // island flist icons (stroke)
  bell: { d: '<path d="M12 2a7 7 0 0 0-7 7c0 5-2 6-2 6h18s-2-1-2-6a7 7 0 0 0-7-7zM10 21h4"/>' },
  arrowR2: { d: '<path d="M5 12h14M12 5l7 7-7 7"/>' },
  pulse: { d: '<path d="M9 19V6l9 2v11M9 19a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm9-2a2 2 0 1 1-4 0 2 2 0 0 1 4 0z"/>' },

  // report flist icons (stroke)
  calendar: { d: '<path d="M7 3v4M17 3v4M3 9h18M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/>' },
  shieldCheck: { d: '<path d="M9 12l2 2 4-4M12 3l7 4v5c0 4-3 7-7 8-4-1-7-4-7-8V7l7-4z"/>' },
  bars: { d: '<path d="M12 20v-6M6 20v-3M18 20v-9M4 4h16"/>' },
  refresh: { d: '<path d="M12 8V4M8 4h8M12 8a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 14l3-3"/>' },

  // custom-ai flist icons (stroke)
  cube: { d: '<path d="M4 7l8-4 8 4v10l-8 4-8-4V7zM12 3v18M4 7l8 4 8-4"/>' },
  bolt: { d: '<path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/>' },
}

/** Union of valid icon keys — use for typed icon-key arrays in sections. */
export type IconName = keyof typeof ICONS
