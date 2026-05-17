# MailAgent · Design System (V1)

> Single source of truth for the macOS Electron mail app. Everything in
> `mockup-inbox.html`, `mockup-dynamic-island.html`, and the future production
> code (React + TypeScript + Tailwind + shadcn/ui) derives from this file.
> If a mockup contradicts this document, the document wins; if this document
> doesn't cover a case, add it here before shipping it.

```
File map
.
├── DESIGN.md                       ← this file · SSoT
├── README.md                       ← human notes + review checklist
├── mockup-inbox.html               ← 3-pane inbox + ✦ AI panel + batch
├── mockup-dynamic-island.html      ← notch overlay (8 states)
└── mockups/                        ← (future) mockup-detail / search / settings / admin
```

---

## 1. Design philosophy

### 1.1 What this app is

A **desktop mail tool** for a single power user (the developer who owns the
SQLite SSoT). It is a *professional instrument*, in the lineage of Mimestream,
Spark, Linear, and VS Code — not a generic SaaS web app.

What that means concretely:

- **Information density is the feature.** A 1-line email row is the unit; a
  card is not.
- **Native macOS rhythms first.** System fonts, hairline borders, monochrome
  iconography, restrained accent, no Material/Tailwind defaults.
- **Keyboard equal to mouse.** Every primary action has a single-key or chord
  shortcut. `⌘K` opens the command palette. Lists are J/K navigable.
- **AI is a co-pilot, not a feature card.** The AI panel is *always* on
  (right side, 360px), the way GitHub Copilot is always in the sidebar of an
  IDE — not a marketing badge.
- **One decisive flourish, not three.** The Dynamic Island is the flourish.
  Everywhere else: subtraction.

### 1.2 What this app is NOT

- ❌ Not a "general SaaS" landing-page-style UI with gradients/feature cards.
- ❌ Not Material Design (no FAB, no ripple, no thick drop-shadows on every layer).
- ❌ Not a chat product (Telegram/Slack idioms don't transplant here).
- ❌ Not a phone app blown up to desktop (no big rounded cards with 28px radius).
- ❌ Not an "AI productivity" Notion clone (no purple-violet gradient anywhere).

### 1.3 The five rules every screen must pass

1. **Chinese ≥ 14px floor.** 11/12px is mono English-only territory
   (timestamps, IDs, kbd, section headers). Never mix Chinese into `text-micro`/`text-meta`.
2. **One primary accent at most three times per screen.** Coral
   (`#E5654B`). See §2.2 for current allocations.
3. **Information density beats whitespace.** Mimestream-tier line height,
   not Notion-tier.
4. **AI is integrated, not a sidebar afterthought.** Every email surface
   exposes `✦ 起草回复` / `翻译` / `总结` within one click; batch ops support `AI 批量*`.
5. **Dark is the canonical mode.** Light is a token swap, never a re-skin.

---

## 2. Color system

All colors live as Tailwind tokens; production code references them by name
via `theme.extend.colors`. **Never inline hex** outside the `:root` token
definition.

### 2.1 Window-chrome / surface tiers (6 levels)

Dark, cool, desaturated. Selected for legibility under macOS dark menu bar
without ever going pure black.

| Token              | Hex       | Use                                                |
|--------------------|-----------|----------------------------------------------------|
| `ink-0`            | `#0E1013` | Outermost canvas; title bar; root `<html>` bg     |
| `ink-1`            | `#15181D` | Sidebar; bottom status bar; batch bar              |
| `ink-2`            | `#1A1E24` | Email list column; AI panel base                   |
| `ink-3`            | `#1F242B` | Detail pane; hover surface for rows / buttons      |
| `ink-4`            | `#262C35` | Selected row; AI user-bubble bg; raised affordance |
| `ink-5`            | `#2E343E` | Reserved — popover / menu surface above `ink-4`   |
| `ink-border`       | `#2C323B` | Hairline between major panels                      |
| `ink-border-soft`  | `#1F242B` | Row-internal divider (near-invisible)              |

Foreground text ramp (4 levels, all on dark):

| Token       | Hex       | Use                                          |
|-------------|-----------|----------------------------------------------|
| `ink-fg`    | `#E8EAEE` | Primary text (subject line, value text)      |
| `ink-fg-1`  | `#A4A9B3` | Secondary (sender meta, button label)        |
| `ink-fg-2`  | `#6B707A` | Tertiary (mono meta, label text, captions)   |
| `ink-fg-3`  | `#454A53` | Disabled / quaternary (skeleton-tier)        |

Light mode (future) is a token swap on `:root[data-theme="light"]` only —
no markup changes. Mapping:

| Token | Dark      | Light     |
|-------|-----------|-----------|
| `ink-0` | `#0E1013` | `#FAFAFA` |
| `ink-1` | `#15181D` | `#F2F2F4` |
| `ink-2` | `#1A1E24` | `#EAEBED` |
| `ink-3` | `#1F242B` | `#FFFFFF` |
| `ink-4` | `#262C35` | `#E1E3E6` |
| `ink-fg` | `#E8EAEE` | `#1A1D22` |
| `ink-fg-1` | `#A4A9B3` | `#5B616B` |
| `ink-fg-2` | `#6B707A` | `#7A7F8A` |
| `ink-fg-3` | `#454A53` | `#B4B8BF` |
| `ink-border` | `#2C323B` | `#D6D9DD` |

### 2.2 Primary accent — Coral `#E5654B`

Why not Tailwind default blue `#3B82F6`: too generic, present in every SaaS.
Why not purple/violet: banned by user brief (AI-SaaS slop tropes).
Why coral: warm + tool-feeling (Mimestream-adjacent), distinct from status
colors, legible on every `ink-*` background, harmonious with macOS system red.

**Allocation rule:** the accent appears on **at most 4 places** per major
surface (relaxed from 3 because this app has more headline actions than a
landing page). Catalog the placements before merging any new use.

Current inventory on `mockup-inbox.html`:

1. **Sidebar selected mailbox** — 3px left edge + 32 unread coral pill
2. **List selected row** — 3px left edge + coral unread dot (top of list)
3. **`✦ AI` tab indicator** in right panel — 2px coral underline + coral text
4. **`✦ 起草回复` toolbar button** — coral fill, white text (the headline action)

Plus contextual / sub-region accents (allowed inside the AI panel — that's the
*AI region's* primary action):

- AI panel composer **send** button on hover
- Draft preview card **send** button (it IS the AI's main output)
- Batch bar **AI batch** buttons (coral text + coral/10 fill)
- Dynamic Island states 03/04/06/08

Tokens:

| Token         | Hex       | Use                                  |
|---------------|-----------|--------------------------------------|
| `coral`       | `#E5654B` | Primary accent                       |
| `coral-hover` | `#D85841` | Hover state on `coral` fills         |
| `coral-dim`   | `#7E3D32` | Disabled coral; muted accent overlay |

Coral background overlays (via Tailwind `/N` opacity):
- `bg-coral/10` — pill/chip resting state
- `bg-coral/15` — pill/chip raised
- `bg-coral/20` — pressed / hover-on-pill
- `border-coral/30` — pill border
- Solid `bg-coral` is reserved for **the one primary CTA per surface**.

### 2.3 AI Priority — 5-color ramp (matches Notion DB enum)

Drives EmailRow chips, detail-pane AI Field cell, Dynamic Island accent.

| Priority   | Token  | Hex       |
|------------|--------|-----------|
| Critical   | `crit` | `#E5634F` |
| Urgent     | `urg`  | `#E89B4A` |
| Important  | `impt` | `#D4A53D` |
| Normal     | `norm` | `#7A7F8A` |
| Low        | `low`  | `#5A5E68` |

Chip shape (all priorities):
- Body bg `bg-{token}/15` · border `border-{token}/30` · text `text-{token}`
- 1.5px round dot prefix in the same `{token}`
- 11px mono uppercase (`text-micro`) — English-only by design

### 2.4 Sync state — 4 colors (StatusBadge reuse)

| State  | Token  | Hex       | Use                                    |
|--------|--------|-----------|----------------------------------------|
| OK     | `ok`   | `#5DBA8C` | Synced · reviewed · online             |
| Warn   | `warn` | `#E5B452` | Cache hit low · sync slow · throttled  |
| Fail   | `fail` | `#E36262` | Sync failed · API error · network down |
| Dead   | `dead` | `#6B707A` | Dead-letter; gave up after N retries   |

Visual: dot + label combo. Never use these colors for non-state purposes
(no decorative green underlines, no red borders that aren't error states).

### 2.5 Information accent — Info `#6FA8DC`

Cool blue reserved for AI-system meta (not primary action) — e.g. AI Field
block header icon, tool-call arrows in the AI panel, info-icon prefix.

### 2.6 What the accent system explicitly forbids

- ❌ Two different "primary accents" on one screen (coral + blue = visual chaos).
- ❌ Coral as a background **flood** (a full panel coral-tinted). Always pixels.
- ❌ Inventing a new accent for a new feature. Add it here first.
- ❌ Tailwind default `slate-*`, `zinc-*`, `gray-*` for backgrounds.
- ❌ Tailwind default `blue-*`, `indigo-*`, `purple-*` anywhere.

### 2.7 Theme system — user-pickable accent (unified CSS variables)

The accent is **not hard-coded**. Every coral pixel in the app resolves to
`rgb(var(--c-accent) / <alpha>)`. The user picks an accent in
`View → Appearance` (title-bar button, popover anchored under it); the
choice persists to `localStorage` (production: Electron `settings.json`)
and broadcasts to the Dynamic Island over the Unix socket.

This means **one variable swap re-skins the entire UI** — selected mailbox
edge, selected row edge, AI tab indicator, `✦ 起草回复` primary button, draft
preview card ring, batch-bar AI buttons, lang-pip on `EN→中`, Dynamic Island
critical ring + wave + click-ripple. No component-level overrides.

**Token shape** (three numbers as a space-separated RGB triple — the format
Tailwind's `rgb(<vars> / <alpha-value>)` syntax accepts):

```css
:root {
  --c-accent:     229 101 75;   /* the visible accent color */
  --c-accent-hi:  216  88  65;  /* hover state on accent fills */
  --c-accent-dim: 126  61  50;  /* disabled accent + tinted overlays */
}
```

**Tailwind binding** (same in both mockup and production `tailwind.config.ts`):

```ts
colors: {
  coral:         'rgb(var(--c-accent)      / <alpha-value>)',
  'coral-hover': 'rgb(var(--c-accent-hi)   / <alpha-value>)',
  'coral-dim':   'rgb(var(--c-accent-dim)  / <alpha-value>)',
}
```

After this binding, every existing class — `text-coral`, `bg-coral/15`,
`border-coral/30`, `ring-coral/50` — works unchanged.

**The 6 presets** (no Tailwind default blue; no purple/violet — banned):

| ID      | Display | RGB                   | Hover RGB             | Dim RGB               | Rationale                          |
|---------|---------|-----------------------|-----------------------|-----------------------|------------------------------------|
| coral   | Coral   | `229 101 75`  · `#E5654B` | `216 88 65`   · `#D85841` | `126 61 50`   · `#7E3D32` | Default. Warm, tool-feeling, Mimestream-adjacent |
| cobalt  | Cobalt  | `74 120 229`  · `#4A78E5` | `60 102 207`  · `#3C66CF` | `48 82 163`   · `#3052A3` | Cool, Linear/dev-tool feel. NOT Tailwind `blue-500` |
| teal    | Teal    | `45 181 166`  · `#2DB5A6` | `33 156 142`  · `#219C8E` | `24 110 100`  · `#186E64` | Fresh, distinct from `ok` green     |
| rose    | Rose    | `219 91 124`  · `#DB5B7C` | `198 71 105`  · `#C64769` | `140 50 74`   · `#8C324A` | Warm pink without saccharine        |
| slate   | Slate   | `126 134 148` · `#7E8694` | `105 113 127` · `#69717F` | `74 80 92`    · `#4A505C` | Colorless / focus mode — accent disappears |
| olive   | Olive   | `156 165 82`  · `#9CA552` | `134 143 70`  · `#868F46` | `94 100 48`   · `#5E6430` | Earthy, distinct from all status colors |

Each preset is a 3-line CSS rule attached to `:root[data-accent="<id>"]`.
Coral lives in the unscoped `:root` (default).

**Theme-pick UI conventions:**

- Entry point: title-bar text-button `<dot> Coral` showing the current
  accent. Dot is `bg-coral` so it re-tints automatically.
- Popover: 264px wide, anchored under the entry point, 3×2 grid of 36px
  swatches with text label below.
- Selected swatch: 2px accent ring + inset white check (visible against
  any swatch fill via `drop-shadow`).
- Live preview: on swatch click, accent applies *immediately* — no
  "Apply" button. Pre-clicked state is restored from `localStorage` on
  app launch.
- Confirmation toast: not shown (would be noise; the visible change *is*
  the confirmation).

**What the picker does NOT touch:**

- Status colors (`ok` / `warn` / `fail` / `dead`) — they're semantic.
  A failed sync should still be red, no matter the chosen accent.
- AI priority colors (`crit` / `urg` / `impt` / `norm` / `low`) — they're
  semantic too, driven by AI classification, not user preference.
- `info` (#6FA8DC) — system meta color stays cool blue.
- Ink scale, fg ramp, borders, type sizes.

So the picker only swaps the *one* accent slot — the rest of the design
system stays anchored.

**Production wiring (preview):**

```ts
// src/state/appearance.ts
import { create } from 'zustand';

export type AccentId = 'coral' | 'cobalt' | 'teal' | 'rose' | 'slate' | 'olive';

interface Store {
  accent: AccentId;
  setAccent(next: AccentId): void;
}

export const useAppearance = create<Store>((set) => ({
  accent: (localStorage.getItem('mailagent.accent') as AccentId) ?? 'coral',
  setAccent(next) {
    if (next === 'coral') document.documentElement.removeAttribute('data-accent');
    else                  document.documentElement.dataset.accent = next;
    localStorage.setItem('mailagent.accent', next);
    window.electron.send('appearance:accent', next); // → Island over unix socket
    set({ accent: next });
  },
}));
```

---

## 3. Typography

### 3.1 Font stacks

```ts
// tailwind.config.ts → theme.extend.fontFamily
sans: [
  '-apple-system', 'BlinkMacSystemFont',
  '"SF Pro Text"', '"PingFang SC"',
  '"Helvetica Neue"', 'system-ui', 'sans-serif',
],
display: [
  '-apple-system', 'BlinkMacSystemFont',
  '"SF Pro Display"', '"PingFang SC"',
  'system-ui', 'sans-serif',
],
mono: [
  'ui-monospace', '"SF Mono"', '"JetBrains Mono"', 'Menlo', 'monospace',
],
```

Why PingFang SC (and not Noto Sans SC): PingFang is the macOS system Han font;
on macOS it renders identically to Mail.app / Notion / VS Code — that's the
"feels native" signal. Noto is for cross-platform; we are Mac-only.

SF Mono is preferred for monospace; it has tabular-nums by default which we
exploit heavily for timestamps and counts.

### 3.2 Type scale

| Token        | Size / line-height | Family | Use                                                          |
|--------------|--------------------|--------|--------------------------------------------------------------|
| `text-micro` | 11 / 14            | mono   | UPPERCASE section headers, chip uppercase — **English-only** |
| `text-meta`  | 12 / 16            | mono   | Timestamps, IDs, counts, kbd, status bar — **English-only**  |
| `text-aux`   | **14** / 20        | sans   | Secondary text, button label, sidebar L2, chip — CN-safe     |
| `text-body`  | **14** / 20        | sans   | Email subject in list row, body copy, AI message content     |
| `text-lead`  | 15 / 22            | sans   | List header (mailbox name), detail metadata key              |
| `text-subj`  | 22 / 30            | sans   | Detail pane H1 (email subject)                               |

**Hard rule**: any token rendering Chinese must be ≥ `text-body` (14px).
`text-micro` and `text-meta` exist *only* for English mono runs.

### 3.3 Section headers — English UPPERCASE mono on purpose

Sidebar groups (`MAILBOXES` / `ACCOUNTS` / `AI AGENTS` / `TOOLS` / `OPS`),
right-panel tabs (`AI` / `Thread` / `Sync`), detail-pane card headers
(`AI FIELDS · 11` / `ATTACHMENTS · 2` / `SYNC STATE`) are all **English
small-caps mono**. This is deliberate, not a localization gap:

1. 11px mono UPPERCASE in Chinese is visually muddy ("韩式糊字号" — banned).
2. Mimestream / Linear / VS Code all keep section labels in English even in
   CN UI — it's a "tool/serious" typography signal.
3. The mixed English-label-Chinese-content rhythm is itself how macOS native
   pro apps look (Mail.app, Notion, Logic, Xcode).

If a future section header *must* be Chinese: bump to `text-aux` 14px (not
`text-micro` 11px).

### 3.4 Type rhythm rules

- Headings (`text-subj`, `text-lead`): `tracking-tight` (`-0.01em`), weight 600.
- Mono everywhere: `font-variant-numeric: tabular-nums` so columns of digits
  don't dance. Status bar relies on this.
- Line height for prose body: 1.6–1.7 (`leading-relaxed` / custom).
- Body line height for list rows: 1.4 (`leading-snug`).
- Never `text-align: justify` (causes ragged Chinese spacing).

---

## 4. Spacing, radius, shadow

### 4.1 Spacing — 8pt grid + 4pt inner

- Base unit: 4px. Pages built on 8px multiples; intra-row spacing uses 4px.
- List row vertical padding: `py-3` (12px) — Mimestream parity (~14px), Spark
  is 16, Linear 12. We've chosen the tight end intentionally.
- Section vertical rhythm: 24–32px between major detail-pane blocks
  (`mt-6` / `mt-7` / `mt-8`).
- Sidebar group spacing: `my-3 mx-4 border-t` between groups.
- Custom layout tokens:
  - `titlebar` = 36px
  - `statusbar` = 24px
  - `batchbar`  = 52px

### 4.2 Radius

| Token         | Value | Use                                          |
|---------------|-------|----------------------------------------------|
| `rounded`     | 4px   | Buttons, chips, kbd                          |
| `rounded-md`  | 6px   | Cards (attachment, action item), inputs      |
| `rounded-lg`  | 8px   | Major bordered blocks (AI Fields, draft card)|
| `rounded-2xl` | 18px  | Dynamic Island pill (Apple system reference) |
| `rounded-full`| 9999  | Dots, traffic lights, avatar circles         |

**Forbidden**: 28px+ "soft-cushion" cards (banned in user brief). 14–16px
radius reserved for the Dynamic Island only.

### 4.3 Shadow

Three levels:

- **0 — flat:** default for everything.
- **1 — raised:** `box-shadow: 0 8px 24px rgba(0,0,0,0.35)` — toasts, popovers,
  dropdowns. Used ONLY on detached-from-page elements.
- **2 — Island:** `box-shadow: 0 0 0 1px rgba(255,255,255,0.04), 0 12px 32px rgba(0,0,0,0.55), 0 4px 12px rgba(0,0,0,0.4)` — the Dynamic Island pill.

No drop shadows on inputs, no shadows on cards-in-page, no neumorphism, no
Material elevation cascade.

### 4.4 Borders

Two weights:
- 1px `border-ink-border` — between panels and on most components
- 1.5–2px `border-{accent}/X` — only when state-bearing (focus ring, AI draft
  card, critical pulse)

Border radius compounds with `overflow-hidden` on parent for clean inner
edges (see `AI Fields · 11` block in detail pane).

---

## 5. Component catalog

Mapping is mockup → production. Every component below has a class system
in the mockup that translates to a shadcn-ui-extended React component.

| Mockup component        | shadcn / production              | Notes                                  |
|-------------------------|----------------------------------|----------------------------------------|
| TitleBar (36px)         | self-written + `BrowserWindow` `titleBarStyle: 'hiddenInset'` | red/yellow/green from system; right side has `IslandIndicator` |
| Sidebar item            | `<NavLink>` + `<Tooltip>`        | collapsed mode (40px wide) reduces to icon + count |
| Sidebar section header  | `<SectionHeader>` (custom)       | `text-micro` mono uppercase; **English** |
| EmailRow                | `<EmailRow>` (custom)            | virtualized with `react-window`        |
| Unread dot              | inline span                       | 1.5px / `bg-coral`                      |
| AILabel chip            | shadcn `<Badge>` w/ 5 variants    | `crit / urg / impt / norm / low`        |
| ActionLabel chip        | shadcn `<Badge variant="outline">` | text-meta · ink-fg-1                 |
| LanguagePip             | self-written                     | 10px mono uppercase · `info` tint        |
| Toolbar primary button  | shadcn `<Button>` + coral variant | `✦ 起草回复` is the headline                |
| Toolbar ghost button    | shadcn `<Button variant="ghost">` |                                       |
| AI Fields block         | self-written `<dl>` grid          | 3 cols × 11 cells; NOT a `<Card>` (too thick) |
| Toast                   | shadcn `<Toast>` + dark variant  | 3s auto-dismiss + bottom progress bar  |
| Kbd hint                | self-written `<kbd>`             | 11px mono · ghost bg · 2px bottom border |
| Command palette ⌘K     | shadcn `<Command>`               | hint surface only in this mockup       |
| RightPanel tabs         | shadcn `<Tabs>` + custom         | coral underline on active              |
| Backend selector        | self-written                      | row + caret; expands to popover         |
| ContextChip strip       | self-written                      | mono meta chips; one is ok-tinted       |
| AIMessageBubble user    | self-written                      | right-aligned · `bg-ink-4` · rounded-br-sm |
| AIMessageBubble assistant | self-written                    | left-aligned · no bg · tool-call rows above |
| ToolCallRow             | self-written                      | mono micro · arrow + dot + label + timing |
| ActionItemCard          | self-written link card            | numbered · linked to Notion project   |
| DraftPreviewCard        | self-written                      | coral ring (THE primary output)         |
| QuickActionChip         | self-written                      | pill · `rounded-full` · hover lift      |
| Composer                | self-written textarea + footer    | `⌘↩` send; backend chip pinned right    |
| BatchActionBar          | self-written                      | 52px height; AI batch ops first         |
| StatusBar               | self-written                      | mono `text-meta` · ≥5 segments         |
| Toast                   | shadcn `<Toast>`                 | top-right; auto-dismiss with progress  |
| **Dynamic Island states (8)** | dedicated `<Island.*>` SwiftUI | NOT a React component — see §7        |

### 5.1 Reference: `<EmailRow>`

```tsx
// src/components/email/EmailRow.tsx
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Paperclip } from 'lucide-react';
import type { EmailListItem } from '@/types/email';

interface Props {
  email: EmailListItem;
  selected: boolean;
  inBatchMode: boolean;
  checked: boolean;
  onCheck(next: boolean): void;
  onSelect(): void;
}

export function EmailRow({ email, selected, inBatchMode, checked, onCheck, onSelect }: Props) {
  const unread = !email.read;
  const failed = email.syncStatus === 'failed';

  return (
    <article
      onClick={onSelect}
      className={cn(
        'row relative px-4 py-3 border-b border-ink-border-soft cursor-pointer transition',
        selected ? 'row-selected bg-ink-4' : 'hover:bg-ink-3',
      )}
    >
      <div className="flex items-start gap-2.5">
        {(inBatchMode || checked) ? (
          <button
            onClick={(e) => { e.stopPropagation(); onCheck(!checked); }}
            className={cn('cb mt-1', checked && 'cb-on')}
            aria-label="Toggle selection"
          />
        ) : (
          <span
            className={cn(
              'w-1.5 h-1.5 mt-1.5 shrink-0',
              unread && 'rounded-full',
              unread && (failed ? 'bg-fail' : 'bg-coral'),
            )}
            title={unread ? 'Unread' : ''}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-0.5">
            <span className={cn(
              'text-aux truncate flex-1',
              unread ? 'text-ink-fg font-medium' : 'text-ink-fg-1',
            )}>{email.fromName} · {email.fromAddr}</span>
            {email.lang !== 'zh' && <span className="lang-pip">{email.lang.toUpperCase()}</span>}
            {failed && (
              <span className="text-micro font-mono text-fail bg-fail/10 border border-fail/25 px-1.5 py-0.5 rounded shrink-0">
                SYNC FAILED
              </span>
            )}
            <span className="text-meta font-mono text-ink-fg-2 shrink-0 tabular-nums">
              {email.shortTime}
            </span>
          </div>
          <div className={cn(
            'text-body truncate',
            unread ? 'text-ink-fg font-semibold' : 'text-ink-fg-1',
          )}>{email.subject}</div>
          <div className="text-aux text-ink-fg-2 line-clamp-1 mt-0.5">
            {email.snippet}
          </div>
          <div className="flex items-center gap-1.5 mt-2">
            <Badge variant={email.aiPriority}>{email.aiPriority}</Badge>
            <Badge variant="outline">{email.aiAction}</Badge>
            {email.attachCount > 0 && (
              <span className="ml-auto flex items-center gap-1 text-ink-fg-2">
                <Paperclip size={11} />
                <span className="text-meta font-mono">{email.attachCount}</span>
              </span>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
```

### 5.2 Reference: `<AIBadge>` (priority chip)

```tsx
// src/components/ai/AIBadge.tsx
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const aiBadge = cva(
  'inline-flex items-center gap-1.5 text-micro font-mono uppercase tracking-wide px-1.5 py-0.5 rounded border',
  {
    variants: {
      priority: {
        critical:  'text-crit bg-crit/15 border-crit/30',
        urgent:    'text-urg  bg-urg/15  border-urg/30',
        important: 'text-impt bg-impt/15 border-impt/30',
        normal:    'text-norm bg-norm/15 border-norm/30',
        low:       'text-low  bg-low/15  border-low/30',
      },
    },
  },
);

interface Props extends VariantProps<typeof aiBadge> {
  withDot?: boolean;
  children: React.ReactNode;
}

export function AIBadge({ priority, withDot = false, children }: Props) {
  return (
    <span className={cn(aiBadge({ priority }))}>
      {withDot && <span className={cn(
        'w-1.5 h-1.5 rounded-full',
        priority === 'critical' && 'bg-crit',
        priority === 'urgent'   && 'bg-urg',
        priority === 'important'&& 'bg-impt',
        priority === 'normal'   && 'bg-norm',
        priority === 'low'      && 'bg-low',
      )} />}
      {children}
    </span>
  );
}
```

### 5.3 Reference: `<AIChatPanel>`

```tsx
// src/components/ai/AIChatPanel.tsx
import { useState } from 'react';
import { Sparkles, Plus, History } from 'lucide-react';
import { BackendSelector } from './BackendSelector';
import { ContextChips } from './ContextChips';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import { QuickActions } from './QuickActions';
import type { AIBackend } from '@/types/ai';

const DEFAULT_BACKEND: AIBackend = {
  kind: 'notion-agent',
  name: 'Notion Agent · Jarvis',
  binding: 'persona_overlay',
  agentPageId: 'YOUR-AGENT-PAGE-ID',
};

interface Props { emailId: number; }

export function AIChatPanel({ emailId }: Props) {
  const [backend, setBackend] = useState<AIBackend>(DEFAULT_BACKEND);
  const [tab, setTab] = useState<'ai' | 'thread' | 'sync'>('ai');

  return (
    <aside className="w-[360px] shrink-0 border-l border-ink-border flex flex-col ai-bg">
      <div className="h-10 border-b border-ink-border flex items-center px-1">
        <TabButton active={tab === 'ai'}     onClick={() => setTab('ai')}>
          <Sparkles size={13} className="fill-current" /> AI
        </TabButton>
        <TabButton active={tab === 'thread'} onClick={() => setTab('thread')}>
          Thread <span className="text-micro font-mono text-ink-fg-2 ml-1">4</span>
        </TabButton>
        <TabButton active={tab === 'sync'}   onClick={() => setTab('sync')}>Sync</TabButton>
        <div className="ml-auto pr-2 flex items-center gap-1">
          <button className="text-ink-fg-2 hover:text-ink-fg p-1.5 rounded hover:bg-ink-4" title="New (⌘N)">
            <Plus size={13} />
          </button>
          <button className="text-ink-fg-2 hover:text-ink-fg p-1.5 rounded hover:bg-ink-4" title="History">
            <History size={13} />
          </button>
        </div>
      </div>

      {tab === 'ai' && (
        <>
          <BackendSelector value={backend} onChange={setBackend} />
          <ContextChips emailId={emailId} />
          <MessageList emailId={emailId} backend={backend} className="flex-1 overflow-y-auto scrollbar-thin" />
          <QuickActions emailId={emailId} backend={backend} />
          <Composer emailId={emailId} backend={backend} />
        </>
      )}

      {tab === 'thread' && <ThreadView emailId={emailId} />}
      {tab === 'sync'   && <SyncView   emailId={emailId} />}
    </aside>
  );
}
```

### 5.4 Reference: `<BatchActionBar>`

```tsx
// src/components/batch/BatchActionBar.tsx
import { Sparkles, X, Mail, Archive, RefreshCcw, Languages } from 'lucide-react';
import { useBatchStore } from '@/state/batch';

export function BatchActionBar() {
  const { selectedIds, clear, runAIBatchClassify, runAIBatchDraft, runTranslate } = useBatchStore();
  if (selectedIds.length === 0) return null;

  return (
    <div className="h-batchbar bg-ink-1 border-t border-ink-border flex items-center px-3 gap-2 shrink-0">
      <SelectionBadge count={selectedIds.length} />
      <Divider />
      <AIBatchButton icon={<Sparkles size={13} className="fill-current" />} onClick={runAIBatchClassify}>
        AI 批量分类
      </AIBatchButton>
      <AIBatchButton icon={<Mail size={13} />} onClick={runAIBatchDraft}>
        AI 批量起草回复
      </AIBatchButton>
      <GhostButton icon={<Languages size={13} />} onClick={() => runTranslate('zh')}>
        批量翻译 <LangPip>EN→中</LangPip>
      </GhostButton>
      {/* maintenance ops ... */}
      <button onClick={clear} className="ml-auto text-ink-fg-2 hover:text-ink-fg p-1.5 rounded hover:bg-ink-3" title="Exit batch (Esc)">
        <X size={14} />
      </button>
    </div>
  );
}
```

---

## 6. AI chat conventions

The right-panel `✦ AI` tab is the new headline. The conventions below are
binding.

### 6.1 Two backends, never more than one selected at a time

1. **Notion Agent (preferred default).** Routed through `notion-agent-cli`
   (`pipx install notion-agent-cli`); `surface = custom_agent`,
   `binding_mode = persona_overlay`. Has read access to the user's Notion
   workspace via `token_v2` cookie. Use for: "关联现有项目", "查我 Q2 OKR",
   "把这封邮件转成 Notion 任务".
2. **Custom API.** A user-configured 3rd-party LLM endpoint
   (OpenAI / Anthropic / DeepSeek / Gemini). Use for: pure language tasks
   (translate, summarize, draft) that don't need Notion context.

The backend selector at the top of the AI panel is the **single source of
truth** for which backend any subsequent action uses (including quick-action
chips and batch-bar AI ops). The selector exposes a 2nd row of alternates
(`claude-3.5` / `gpt-5` / `deepseek-v3`) for one-tap swapping without
opening the full settings sheet.

### 6.2 Message bubble shape

- **User bubble**: right-aligned, `bg-ink-4`, `rounded-lg rounded-br-sm`
  (the squared-off corner signals "from you"), `max-w-[85%]`, `text-body`.
- **Assistant bubble**: left-aligned, **no bg**, full panel width,
  `text-body leading-relaxed`. Tool-call rows appear *above* the response
  body, as a stack of small mono "log lines" — see §6.3.
- **System divider**: horizontal hairline + center label (mono meta) for
  conversation breaks (new session, model swap, time gap > 5 min).
- **Per-message footer**: 3 actions `↺ 重生成 · 📋 复制 · 📌 转 Notion` in
  mono meta, appears under assistant messages only.

### 6.3 Tool-call rows

When the assistant calls a tool (Notion query, mail fetch, web search), each
call renders as one mono "log line" before the prose response:

```
→ notion-agent agents route "处理告警"   · 0.4s   [●]
→ notion.databases.query Projects [✓ 2]  · 0.8s   [●]
→ read mail#8472 body + 11 ai_fields     · cached [●]
```

- Arrow color: `text-info` (`#6FA8DC`)
- Status dot: `bg-ok` when complete, `bg-urg` pulsing while running
- Font: `mono 11.5px`, `text-ink-fg-2`
- Width: `width: max-content`, max 100% — never multiline
- Background: `rgba(255,255,255,0.025)`, `rounded`, `px-2`

This makes the AI's "thinking" auditable without being noisy. Production
should source these from a real tool-use trace, not fake them.

### 6.4 Action item cards

When the assistant outputs an actionable list (the most common case),
render each item as a linkable card with:
- Numbered prefix in coral (`01 / 02 / 03`)
- Action text in `text-aux text-ink-fg`
- Footer with: linked Notion project (green ↗ arrow) + estimated effort
- Whole card is `<a href>`-clickable → opens the Notion page

### 6.5 Draft preview card

When the AI drafts a reply, render the draft as a bordered card with a
coral ring (1px `coral/30` + 2px outer ring `coral/5`). This card is
*the* output and gets visual priority over surrounding messages.

Card sections:
1. Header: `DRAFT REPLY` mono uppercase + recipient
2. Body: rendered subject + body (with cursor `▎` while streaming)
3. Footer: `发送 (coral fill) · ↺ 重生成 · ✎ 编辑 · ▭ 在新窗口`

The send button is the **only** coral fill inside the AI panel — it has the
highest action weight because clicking it sends real email.

### 6.6 Composer

- Textarea grows `rows={2}` minimum, max `8` then internal scroll.
- Placeholder mixes Chinese intent + English `/slash` hint:
  `"/命令 或对这封邮件提问… (⌘↩ 发送)"`
- Footer strip shows: `attach` / `/slash` / `@thread` quick affordances + active
  backend chip + `⌘↩` kbd + circular send button.
- Send button transitions `bg-ink-4 → bg-coral` on focus/hover (no fill at
  rest — accent budget).

### 6.7 Quick action chips

Always-visible row above the composer. Five default chips:
`总结 / 起草回复 / 翻译 / 提取动作项 / 关联 Notion`. Each chip injects a
pre-built user message and triggers AI immediately (no extra confirmation).
Pills are `rounded-full`, `text-aux 13px`, hover lifts via bg + border.

### 6.8 Batch AI ops

When ≥1 row is selected, the batch action bar appears. The first 3 buttons
are **AI batch ops**, visually elevated with `bg-coral/10 + border-coral/30
+ text-coral`. The 3 default ops:

- `AI 批量分类` — re-classify with current backend (writes back 11 ai_fields)
- `AI 批量起草回复` — draft a reply per selected email (Notion Agent only)
- `批量翻译 EN→中` — language-detect → translate non-Chinese rows

Each runs as a queued background task; the right edge of the bar shows
`queued · est. ~4.2s · $0.018` so the user knows what they're spending.

---

## 7. Dynamic Island conventions

Inspired by [Open Island](https://github.com/Octane0411/open-vibe-island)
(native SwiftUI). MailAgent's island is **a separate native overlay binary**
that talks to the Electron app via Unix socket. It is NOT a React component
— see `mockup-dynamic-island.html` for the visual spec.

### 7.1 Four-phase lifecycle (THE model)

Every notification follows the same four phases. Whether it stops at Phase 1
or persists through Phase 4 depends on its priority (see §7.2 routing matrix).

```
┌─ Phase 1 ──┐   ┌─ Phase 2 ───────┐   ┌─ Phase 3 ─────┐   ┌─ Phase 4 ─────┐
│ Arrival    │ → │ Resting icon    │ → │ Hover expand  │ → │ Click → jump  │
│ full pill  │   │ 22×22 dock      │   │ re-expand pill│   │ open in app   │
│ 4 s hold   │   │ persistent      │   │ on cursor 200ms│  │ pill empties  │
└────────────┘   └─────────────────┘   └───────────────┘   └───────────────┘
        220ms              persists            220ms             flash + clear
```

| Phase | Duration              | Surface                          | What user sees |
|-------|-----------------------|----------------------------------|----------------|
| 1     | 4 s hold (or 2.5 s for Important; until done for streaming) | Full pill below the notch | Sender + subject + priority + ⏎ |
| 2     | Persistent until cleared | 22×22 icon docked left of the notch | One small icon (color-coded by type) |
| 3     | While hovered + 200 ms tail | Re-expanded pill (same as Phase 1 + 3 quick actions) | Full info + Ack / Open / Snooze |
| 4     | 220 ms flash + ripple | Pill clears; MailAgent.app comes to front | Email detail pane opens |

**Phase 2 dock layout:** icons sit immediately to the LEFT of the physical
notch, height 22 px, gap 6 px. Max 4 visible icons; the 5th and beyond
fold into a `+N` count chip. Visual order (left → right): **Critical →
Failed → AI ready → Urgent → Queued**.

### 7.2 Routing matrix — who persists, who fades

| Notification type            | Phase 1 | Phase 2 (resting icon)   | Phase 3 | Phase 4 | Clears on            |
|------------------------------|---------|--------------------------|---------|---------|----------------------|
| Critical (`ai_priority`)     | ✓ 4 s   | ✓ red pulsing dot        | ✓       | ✓       | Ack / open email     |
| Urgent (`ai_priority`)       | ✓ 4 s   | ✓ orange dot             | ✓       | ✓       | Mark read / open     |
| Important (`ai_priority`)    | ✓ 2.5 s | ✗ auto-fade              | —       | —       | —                    |
| Normal / Low                 | ✗       | ✗ (badge in inbox only)  | —       | —       | —                    |
| AI draft ready               | ✓       | ✓ ✦ icon                 | ✓       | ✓       | Send / dismiss / view |
| Sync failed (dead-letter)    | ✓       | ✓ ✕ icon · fail ring     | ✓       | ✓       | Retry success / dismiss |
| Sync progress (≥ 5 emails)   | ✓ live  | ✗ progress-only          | ✓       | ✓ → /admin | Complete (1.5 s) |
| Queued stack (≥ 3 pending)   | ✓       | ✓ `+N` count chip        | ✓ mini-list | ✓ first item | Drains to ≤ 2     |

**Rules of the matrix:**
- **Stay rule:** Critical / Urgent / AI-draft / Sync-failed leave a Phase 2
  icon and stay until acknowledged.
- **Fade rule:** Important briefly flashes and disappears with no resting
  icon (we don't want non-emergency mail piling up on the menu bar).
- **Cap rule:** 4 visible Phase 2 icons max — older ones fold into `+N`.

### 7.3 Visual rules

- The arrival pill (Phase 1) and the hover-expanded pill (Phase 3) always
  dock under the physical notch, centered horizontally.
- The resting icons (Phase 2) sit immediately to the LEFT of the notch.
- Pill background: pure `#000` to bleed seamlessly into the notch.
- Foreground: `#E8EAEE` (same `ink-fg` as the rest of the app).
- Radius: 22 px on the arrival/hover pill; 999 (full pill) on resting icons.
- Shadow: 3-layer (1px white inner stroke + soft black drop + crisp black
  drop). See §4.3 level 2.
- **Accent follows the user's theme choice.** Critical pulse uses the
  semantic `crit` color (red, not the accent). AI wave, draft ring,
  click-ripple, phase-tag use `var(--c-accent)`.

### 7.4 Motion

- Expand / collapse / re-expand: 220 ms `cubic-bezier(0.4, 0, 0.2, 1)`.
- Hover delay before re-expand: 200 ms (avoids twitchy expansion when the
  cursor passes through on the way somewhere else).
- Phase 1 hold: 4 s (Critical / Urgent / AI / Failed); 2.5 s (Important).
- Streaming (AI drafting / sync progress): no auto-collapse — runs until
  the underlying task finishes.
- Critical pulse: 1.6 s loop, `box-shadow` ring grow + fade.
- Click ripple (Phase 4): 2 s `box-shadow` outward from the icon center,
  then pill empties.
- Stack reorder (queued): 180 ms y-translate per card.
- **No springs / no bouncy easing** — that's a phone-app idiom; this is a
  notch overlay for a desktop pro app.

### 7.5 Keyboard

| Action                       | Shortcut |
|------------------------------|----------|
| Jump back to MailAgent       | `⌘↩`     |
| Ack Critical (no mouse)      | `⌘.`     |
| Snooze 10 min                | `⌥S`     |
| Next / prev in queued stack  | `J` / `K`|
| Force collapse               | `Esc`    |
| Toggle expand / collapse     | `⌥I`     |

Shortcuts are global (registered via the SwiftUI overlay) so they work even
when MailAgent isn't focused.

### 7.6 IPC contract — lifecycle events

```
mail-sync (Python)                MailAgent.app (Electron)        Island (SwiftUI)
        │                                  │                              │
        │ classify · 11 ai_fields          │ better-sqlite3 insert        │  ← unix socket
        ├────────────────────────────────▶ │ refresh inbox UI             │
        │                                  │                              │
        │                                  │ route(priority) → island.notify
        │                                  ├─────────────────────────────▶│  Phase 1 · expand 4 s
        │                                  │                              │      │
        │                                  │                              │      ▼ if persistent
        │                                  │                              │  Phase 2 · resting icon
        │                                  │                              │      │
        │                                  │                              │      ▼ cursor 200ms
        │                                  │                              │  Phase 3 · re-expand
        │                                  │ ◀── ack / snooze / dismiss ──│
        │                                  │                              │      │
        │                                  │                              │      ▼ click
        │                                  │ ◀── focus_email(id) ─────────│  Phase 4 · jump
        │                                  │  bring window front          │  pill empties
        │                                  │  open detail pane            │
        │                                  │                              │
        │                                  │ exec notion-agent chat       │
        │                                  ├─────────────────────────────▶│  state = ai_drafting (wave)
        │                                  │ ◀── stream tokens ───────────│
        │                                  │ draft ready                  │
        │                                  ├─────────────────────────────▶│  Phase 2 · ✦ AI icon
```

**Event surface** (Electron → Island, JSON over unix socket):

```ts
type IslandEvent =
  | { kind: 'notify'; id: string; priority: 'critical' | 'urgent' | 'important' | 'normal' | 'low'; sender: string; subject: string; lang?: 'zh' | 'en' | 'ja'; }
  | { kind: 'ai-draft-start'; id: string; subject: string; backend: 'notion-agent' | 'custom-api'; model: string; }
  | { kind: 'ai-draft-stream'; id: string; tokens: number; elapsedMs: number; }
  | { kind: 'ai-draft-ready'; id: string; preview: string; cost: number; }
  | { kind: 'sync-progress'; total: number; done: number; }
  | { kind: 'sync-failed'; count: number; reason: string; }
  | { kind: 'clear'; id: string; }
  | { kind: 'accent'; value: 'coral' | 'cobalt' | 'teal' | 'rose' | 'slate' | 'olive'; };  // theme parity
```

Failure modes are **fail-open**: if the island binary isn't running,
MailAgent works unchanged. SQLite is still the SSoT; the island is a
read-mostly view + shortcut surface.

---

## 8. Motion system

Three durations, one curve. Don't invent a fourth.

| Token         | Value | Use                                    |
|---------------|-------|----------------------------------------|
| `motion-fast` | 120ms | hover state, focus, micro-affordances  |
| `motion-base` | 220ms | tab switch, panel slide, Island expand |
| `motion-slow` | 380ms | rare — toast slide-in, batch reveal    |

Curve: `cubic-bezier(0.4, 0, 0.2, 1)` (Material's "standard", but we're
using only the curve, not the rest of Material).

**Banned**: spring, bounce, elastic, confetti, particle, parallax,
scroll-jacking. This is a tool.

**Allowed extras**:
- Pulse loop (1.6s) on critical state — accessibility-respectful (no flash).
- `animate-pulse` (Tailwind default) on skeleton rows.
- `animate-spin` on the sync/loading icon.
- Streaming text cursor `▎` blink (1s steps(2)).

---

## 9. Interaction patterns

### 9.1 Hover

Every interactive surface has a hover state. Defaults:
- Sidebar/list rows: `hover:bg-ink-3` (one tier lift)
- Toolbar buttons: `hover:bg-ink-4` + `text-ink-fg-1 → text-ink-fg`
- Ghost links: text color shifts coral or fg-1 → fg
- Cards (attachment, action item): `hover:bg-ink-4` + `hover:border-ink-fg-3`

Transition: `transition` (Tailwind default = 150ms).

### 9.2 Focus

Every focusable element MUST have a visible focus ring. Default:
`focus:outline-none focus:ring-2 focus:ring-coral/40 focus:ring-offset-1 focus:ring-offset-ink-3`.

Composer textarea uses `focus-within:border-coral/50` on its container
(a softer indicator since the textarea has its own ring conventions).

### 9.3 Active / pressed

Buttons subtle scale-down: `active:scale-[0.98]` for primary coral CTAs.
Ghost buttons get `active:bg-ink-4` (one tier deeper than hover). No
opacity dips — that reads as disabled.

### 9.4 Disabled

`opacity-50 cursor-not-allowed`. Disabled coral buttons swap to `coral-dim`
(`#7E3D32`) — recognizable as "this is the disabled version of an accent"
rather than just "muddied gray".

### 9.5 Keyboard shortcuts (global)

| Action                          | Shortcut       |
|---------------------------------|----------------|
| Command palette / search        | `⌘K`           |
| Settings                        | `⌘,`           |
| Shortcut help                   | `?`            |
| Next email                      | `J`            |
| Previous email                  | `K`            |
| Reply (AI draft)                | `R`            |
| Forward                         | `F`            |
| Mark read / unread              | `U`            |
| Toggle flag                     | `S`            |
| Archive                         | `E`            |
| Delete                          | `⌘⌫`           |
| Translate this email            | `⌥T`           |
| Send AI message                 | `⌘↩` (composer focused) |
| Toggle batch select on row      | `X`            |
| Open AI panel                   | `⌥A`           |
| Switch AI backend               | `⌥B`           |
| New AI conversation             | `⌘N` (AI panel focused) |
| Toggle Dynamic Island           | `⌥I`           |

The list lives in `src/keymap.ts` as the production SSoT. The shortcut-help
modal (`?`) reads from it.

---

## 10. Accessibility

- **Contrast**: all body text and chips passed WCAG AA against their nearest
  surface tier. Light mode tokens verified the same. Run `pnpm a11y:contrast`
  before shipping.
- **Focus**: visible focus ring is non-negotiable (see §9.2). Verify with
  keyboard-only navigation through inbox → row → detail → AI panel.
- **Color is never the only signal**: failed-sync rows have a red dot
  *and* the "SYNC FAILED" pill *and* red snippet text — color-blind users
  still see it. Priority chips have shape + text + color.
- **Motion-reduce**: respect `prefers-reduced-motion`. Critical pulse
  becomes a static red ring; AI streaming wave becomes a static `…`; tab
  transitions are instant.
- **Chinese floor**: 14px floor is itself an accessibility decision —
  smaller Han glyphs are unreadable.
- **Keyboard parity**: every clickable thing has a key. Test with VoiceOver
  (⌘F5) for the read-aloud flow.

---

## 11. tailwind.config.ts (paste-ready)

Pair this with a `:root { --c-accent: 229 101 75; ... }` block in your
global stylesheet (see §2.7) so `coral` resolves to the live theme value.

```ts
import type { Config } from 'tailwindcss';

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          0: '#0E1013', 1: '#15181D', 2: '#1A1E24',
          3: '#1F242B', 4: '#262C35', 5: '#2E343E',
          border: '#2C323B',
          'border-soft': '#1F242B',
          fg:   '#E8EAEE',
          'fg-1': '#A4A9B3',
          'fg-2': '#6B707A',
          'fg-3': '#454A53',
        },
        // Accent reads from CSS variables defined in :root and overridden
        // by :root[data-accent="..."] per §2.7. One swap re-skins the UI.
        coral:        'rgb(var(--c-accent)      / <alpha-value>)',
        'coral-hover':'rgb(var(--c-accent-hi)   / <alpha-value>)',
        'coral-dim':  'rgb(var(--c-accent-dim)  / <alpha-value>)',
        crit: '#E5634F', urg: '#E89B4A', impt: '#D4A53D',
        norm: '#7A7F8A', low: '#5A5E68',
        ok:   '#5DBA8C', warn: '#E5B452',
        fail: '#E36262', dead: '#6B707A',
        info: '#6FA8DC',
        ai:   '#B58CDB',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"SF Pro Text"', '"PingFang SC"', '"Helvetica Neue"', 'system-ui', 'sans-serif'],
        display: ['-apple-system', 'BlinkMacSystemFont', '"SF Pro Display"', '"PingFang SC"', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', '"SF Mono"', '"JetBrains Mono"', 'Menlo', 'monospace'],
      },
      fontSize: {
        micro: ['11px', '14px'],
        meta:  ['12px', '16px'],
        aux:   ['14px', '20px'],
        body:  ['14px', '20px'],
        lead:  ['15px', '22px'],
        subj:  ['22px', '30px'],
      },
      spacing: {
        titlebar: '36px',
        statusbar: '24px',
        batchbar: '52px',
      },
      transitionTimingFunction: {
        standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
      transitionDuration: {
        fast: '120ms',
        base: '220ms',
        slow: '380ms',
      },
      keyframes: {
        'pulse-crit': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(229,99,79,0.7)' },
          '70%':      { boxShadow: '0 0 0 8px rgba(229,99,79,0)' },
        },
      },
      animation: {
        'pulse-crit': 'pulse-crit 1.6s infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;
```

---

## 12. shadcn/ui install + variant additions

```bash
pnpm dlx shadcn-ui@latest init   # already done
pnpm dlx shadcn-ui@latest add button badge command toast tooltip dialog dropdown-menu input textarea tabs
```

After install, extend variants:

```tsx
// components/ui/badge.tsx — add 5 priority variants
priority: {
  critical:  'text-crit bg-crit/15 border-crit/30',
  urgent:    'text-urg  bg-urg/15  border-urg/30',
  important: 'text-impt bg-impt/15 border-impt/30',
  normal:    'text-norm bg-norm/15 border-norm/30',
  low:       'text-low  bg-low/15  border-low/30',
}

// components/ui/button.tsx — add coral primary
primary: 'bg-coral text-white hover:bg-coral-hover active:scale-[0.98]',
```

---

## 13. Project structure (recommended)

```
src/
├── App.tsx
├── main.tsx
├── keymap.ts                ← single SSoT for all shortcuts
├── components/
│   ├── ui/                  ← shadcn primitives + extensions
│   ├── chrome/              ← TitleBar, StatusBar, BatchActionBar
│   ├── email/               ← EmailRow, EmailList, EmailDetail, AIFieldsBlock, AttachmentCard
│   ├── ai/                  ← AIChatPanel, MessageList, Composer, BackendSelector, QuickActions, ActionItemCard, DraftPreviewCard
│   ├── island/              ← (native overlay app — kept as separate Swift package or sub-process)
│   ├── search/              ← CommandPalette, SearchPage
│   └── settings/            ← SettingsPage
├── state/                   ← Zustand stores (mail, batch, ai-session)
├── ipc/                     ← Electron renderer ↔ main ↔ mail-sync IPC
├── notion/                  ← notion-agent-cli wrapper (spawn via execa)
├── email/
│   ├── MailBodyStyles.css   ← .mail-body rules (production injects into sandboxed iframe)
│   └── sanitize.ts          ← DOMPurify configuration
├── lib/utils.ts             ← cn(), formatters
└── types/                   ← TypeScript interfaces
```

---

## 14. The non-negotiables (lint these in CI)

A future `pnpm lint:design` will check for these — the rules are codifiable:

1. No raw hex outside `tailwind.config.ts` (every color goes through tokens).
2. No `text-xs` Tailwind class on Chinese-bearing nodes (use `text-aux` 14px).
3. No `text-blue-*`, `text-purple-*`, `text-indigo-*` anywhere.
4. No `rounded-3xl` / `rounded-[28px]` / radius > 18px outside Dynamic Island components.
5. No `from-*-* to-*-*` gradient backgrounds.
6. No `shadow-2xl` / `shadow-lg` / `shadow-xl` outside `<Toast>` and `<Island>` components.
7. No Tailwind `slate-*` / `zinc-*` / `neutral-*` / `stone-*` for surfaces — use `ink-*`.
8. No coral-flood backgrounds (panel-tinted in coral) — pixels only.

---

## 15. Open questions (drive Sprint 0 review)

1. **AI panel width 360px is right for 14"+ MacBooks.** On a 1280×800 laptop
   (no longer sold but still active) the detail pane shrinks awkwardly.
   Should the AI panel collapse to a 48px icon rail under 1280? Mockup
   demonstrates 360px because that's where the conversation feels good;
   smaller widths need a different layout (drawer overlay).
2. **Batch bar 52px height** is dense; if we add a 2nd progress row when
   tasks run async, it becomes 80px. Acceptable trade or push progress to a
   right-edge toast stream?
3. **Two-backend selector vs unified.** Should "Notion Agent" and "Custom
   API" be one combined picker (search-as-you-type) or stay as a primary
   pick + alt-row? Current design = primary + alt-row, which makes the
   default (Notion Agent · Jarvis) obvious.
4. **Per-email pinned conversations.** Each email gets its own AI thread
   that persists. Stored in SQLite as `ai_session.email_id`? Or a separate
   `ai_sessions` table keyed by `(email_id, backend_id)`?
5. ~~**Light mode parity** — when does it ship?~~ **RESOLVED (REVIEW-LOG C-08)**: light tokens 已就位但 mockup 仅 dark；Sprint 0 完工 checklist 允许 light 视觉 unpolished；Sprint 1 末 5 个核心组件做 visual spot-check；Sprint 3 末 `pnpm a11y:contrast` 跑 12 组合 lint。无需在此 Open question 跟进。
6. **Dynamic Island packaging.** Two paths:
   (a) ship as a separate Swift app (like Open Island) that talks to
       MailAgent.app over Unix socket — cleaner separation;
   (b) bundle as a child native helper inside the Electron `Resources/`
       — single download, but harder to test.

Recommend (a). Same reason Open Island is its own app.

---

## 16. 国际化 i18n（标准化约束 · 自 Sprint 0 起强制）

> 2026-05-16 chenyq 追加 — 与 designer 共同确认 V1 必须 i18n-ready，并非 polish 议题。

### 16.1 决策

- **库**: `i18next` + `react-i18next` + `i18next-browser-languagedetector`（生态最成熟，TypeScript
  友好，Electron / Web SPA / PWA 通吃）
- **V1 支持 locales**: `zh-CN`（默认，所有 UI 已用中文起草）+ `en-US`（次主，对应 mockup 中
  `EN` lang pip 用户群）
- **V2 候选**: `ja-JP` / `ko-KR` / `de-DE`（仅在有真实用户需求时扩，不预投入）
- **不做**: RTL（阿拉伯 / 希伯来）— V3+ 议题，体量大

### 16.2 文件结构

```
frontend/src/shared/i18n/
├── index.ts                 ← initReactI18next config + 检测器
├── types.ts                 ← 自动从 zh-CN JSON 推导出 t() 的 key 类型（强类型）
└── locales/
    ├── zh-CN/
    │   ├── common.json      ← 全局通用（按钮、状态、错误）
    │   ├── email.json       ← 邮件列表 / 详情 / 工具栏
    │   ├── ai.json          ← AI Chat panel / 批量 AI 操作
    │   ├── island.json      ← 灵动岛 envelope 字段（plugin 也读这里）
    │   ├── settings.json    ← 设置页
    │   └── admin.json       ← 看板 / LLM dashboard / dead-letter
    └── en-US/
        └── ...（同 namespace 镜像）
```

### 16.3 命名规范

- Namespace per file: `t('email.list.empty')` / `t('ai.batch.classify')`
- 嵌套不超过 3 层（`email.list.empty` ✓ / `email.list.item.row.unread` ✗ → 拆成 `email.row.unread`）
- 复数走 i18next 标准 `_one` / `_other` 后缀，调用 `t('email.unreadCount', { count: n })`
- 含变量必须用 `{{var}}` 而不是字符串拼接

### 16.4 调用约定

```tsx
// 组件内
import { useTranslation } from 'react-i18next';

export function EmailListEmpty() {
  const { t } = useTranslation('email');
  return <div className="text-aux text-ink-fg-2">{t('list.empty')}</div>;
}

// 非组件（main 进程 / utility）
import i18n from '@/shared/i18n';
const msg = i18n.t('common.error.networkOffline');
```

### 16.5 数字 / 日期 / 货币本地化（REVIEW-LOG H-03 加边界）

**全部走 `Intl` 原生 API**，不用 i18next 自带 formatter（更轻）。**复数走 `i18next-icu` ICU MessageFormat**（中文无复数自动跳过 plural 规则）。

| 用途 | API | zh-CN 示例 | en-US 示例 |
|---|---|---|---|
| 数字 | `Intl.NumberFormat(locale).format(n)` | `1,234` | `1,234` |
| 货币 (AI cost) | `Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' })` | `US$0.018` | `$0.018` |
| 日期相对 | 自写 helper + `Intl.RelativeTimeFormat` | `2 分钟前` | `2 min ago` |
| 日期绝对 | `Intl.DateTimeFormat(locale, { ... })` | `2026/5/16 22:08` | `May 16, 2026 10:08 PM` |
| 文件大小 | 自写 helper（`KB/MB/GB` 全 locale 相同） | `1.2 MB` | `1.2 MB` |
| 复数 | i18next-icu `{count, plural, one {...} other {...}}` | `3 封邮件`（中文 plural 规则一律 other）| `1 mail` / `3 mails` |

封装在 `frontend/src/shared/format/` 下，组件不直接 call `Intl`。

**TZ 策略**：
- 后端 ISO8601 timestamp 带 timezone offset（如 `2026-05-16T22:08:00+08:00`）—— SQLite 列已是这种格式
- Frontend wrapper `formatDate(iso, locale)` 内部 `new Date(iso)` 让 JS 自动 resolve；`Intl.DateTimeFormat` 不传 `timeZone` 即用浏览器/Electron 本地时区
- **不假设服务端 UTC+8**：用户在 iPhone 出差到不同时区时，远端 Web SPA 自动按本机时区显示
- macOS Electron `app.getSystemTimeZone()`（Electron 21+）只用于 debug log，不参与格式化

**相对时间 threshold**:
```typescript
// shared/format/relativeTime.ts
const RELATIVE_THRESHOLDS = [
  { limit: 60_000,         unit: 'second', i18n: 'time.justNow' },  // < 1min → "刚刚" / "just now"
  { limit: 3600_000,       unit: 'minute' },                        // < 1h → "X 分钟前"
  { limit: 86400_000,      unit: 'hour' },                          // < 24h → "X 小时前"
  { limit: 7 * 86400_000,  unit: 'day' },                           // < 7d → "X 天前"
  { limit: Infinity,       absolute: true },                        // > 7d → 绝对日期
];
```

**RTL 预留**：CSS 用 `padding-inline-start` / `margin-inline-end` 替代 `padding-left` / `margin-right`，V3 RTL 实施时不用改组件。Stylelint 检查；ESLint rule "no-physical-margins-on-text-elements" 第 11 条候选（V1 不强制）。

### 16.6 中英文 typography 差异（针对 §3.2 type scale 的 i18n 收紧）

| 字号 | 行高 | 字体 | 语义 | zh-CN 用 | en-US 用 |
|---|---|---|---|---|---|
| `text-micro` 11px | 14 | mono | meta 标签 / chip 大写 | ❌ 不允许中文 | ✅ UPPERCASE meta / kbd / count |
| `text-meta` 12px | 16 | mono | timestamps / IDs / 状态 | ❌ 不允许中文 | ✅ timestamps / IDs |
| `text-aux` 14px | 20 | sans | 次要文字（sidebar L2 / 副标题 / chip 文案） | ✅ 中文最小尺寸 | ✅ 次要文字 |
| `text-body` 14px | 20 | sans | 主文（list 行主体 / message 内容 / 详情正文）| ✅ 主文 | ✅ 主文（en-US 偏小可考虑 13px 但保 V1 不动）|

字号同 14px 但用途不同：`text-aux` 是结构感（chip / label / 副标题），`text-body` 是阅读感（行高 + 段落节奏）。详 §3.2 type scale。

**lint 规则（REVIEW-LOG H-02 升级为 error，且不豁免 i18n 字符串）**:

任何 `text-micro` / `text-meta` className 的节点显示 CJK 字符 → CI **error**（不是 warning）。实现两层：

```typescript
// .eslint/rules/no-cjk-in-mono-size.ts
// 第 1 层：JSX 字面量直接含中文 → error
// <span className="text-micro">未读</span>  ✗

// 第 2 层：JSX 节点 className 含 text-micro/text-meta + 子节点是 {t('key')} →
//   解析 key 到 locales/zh-CN/*.json 拿到 zh 值 → 包含 CJK → error
// <span className="text-meta">{t('email.unread')}</span> 且 zh-CN/email.json: { "unread": "未读" } ✗
```

辅助 Stylelint rule：**禁止 `@media (prefers-color-scheme: ...)` 直接出现在组件 CSS**（REVIEW-LOG H-03）；唯一 source of truth 是 `data-theme` attr + Tailwind `.dark` class，避免 CSS 与 React state 两套真相。

### 16.7 Sprint 0 起的硬约束

- ✅ **任何 JSX 内的硬编码字符串 = code review 拒绝**。包括 `aria-label` / `title` / `placeholder`
- ✅ **错误 message 走 i18n**，但**错误 code (`E_NOT_FOUND` 等)留英文**（与后端 CLI schema 对齐）
- ✅ **新加字符串先写 zh-CN，再 mark `en-US` 为 `[TODO en]`**；CI 在 ship 前扫描，存量 `[TODO en]` ≤ 0 才允许 release
- ✅ **CN 字符串可以混用英文术语**（`"邮件 sync 失败"` 是合法的，因为术语 sync 用户认识），不强求"纯中文"
- ✅ **Island envelope 字段（title / preview）也走 i18n** — 不能在 Python plugin 里硬编码字符串，应从 `~/.mailagent/plugins/ping_island/locales/{lang}/island.json` 读

### 16.8 切语言 UI（REVIEW-LOG M-02 加 resolver）

- **Settings → Language**：单选 `跟随系统 (System)` / `简体中文` / `English`
- 默认 = `跟随系统`：检测 `navigator.language` (Web) / `app.getLocale()` (Electron) → 首匹配 zh-CN 或 en-US，否则 fallback `en-US`
- 切换实时生效（i18next 走 `i18n.changeLanguage(resolved)`，所有用 `useTranslation()` 的组件自动 rerender）
- localStorage key `mailagent.language` ∈ `{system, zh-CN, en-US}` —— 这是 **user choice**；
  i18next 实际 active language 是 `resolved language`（system 解析后的具体 locale），两者不同：

```typescript
// shared/i18n/resolver.ts
export type LanguageChoice = 'system' | 'zh-CN' | 'en-US';
export type ResolvedLanguage = 'zh-CN' | 'en-US';

export function resolveLanguage(choice: LanguageChoice): ResolvedLanguage {
  if (choice !== 'system') return choice;
  const sysLang = (navigator.language || 'en-US').toLowerCase();
  if (sysLang.startsWith('zh')) return 'zh-CN';
  return 'en-US';
}

export function applyLanguage(choice: LanguageChoice) {
  localStorage.setItem('mailagent.language', choice);
  const resolved = resolveLanguage(choice);
  i18n.changeLanguage(resolved);   // i18next 永远收到具体 locale，不收 'system'
}
```

OS 系统语言变化时：暂不监听（macOS 改系统语言后通常会重启所有 app，重启时下次读 navigator.language 自然 pick up）。

---

## 17. 主题系统 — 三态（light / dark / system）

> 2026-05-16 chenyq 追加 — 之前 §2.1 提了 light token 但只是"未来 swap"；现在升级为 V1 必做的
> 三态切换，与 i18n 同级标准。

### 17.1 决策

- **3 态**: `light` / `dark` / `system`（默认 = system，跟随 macOS / 浏览器 / iOS）
- **明暗 token 来源**: 全部走 [§2.1](#21-window-chrome--surface-tiers-6-levels) 已定义的 light/dark mapping，无需新色
- **accent (coral) 独立于明暗**: 6 个 accent × 3 个 mode = 18 个视觉组合，全部预先验证 WCAG AA 通过
- **切换瞬间生效**: 切完 `data-theme` attribute 立即变；不刷新页面

### 17.2 DOM 表达

```html
<html
  data-theme="dark"        <!-- "dark" | "light"（system 模式下根据 prefers-color-scheme 实时填值） -->
  data-accent="coral"      <!-- "coral" | "cobalt" | "teal" | "rose" | "slate" | "olive" -->
  class="dark"             <!-- Tailwind `darkMode: 'class'` 看这个 class -->
>
```

**关键**：`data-theme` 才是 source of truth；`class="dark"` 是 Tailwind 兼容附属，跟 `data-theme="dark"` 同步切换。

### 17.3 三态切换逻辑（REVIEW-LOG C-06 race + C-07 FOUC 修订）

```typescript
// shared/state/appearance.ts
type ThemeMode = 'system' | 'dark' | 'light';

interface AppearanceStore {
  themeMode: ThemeMode;
  resolvedTheme: 'dark' | 'light';   // 派生：system 模式下根据系统实时算
  setThemeMode(next: ThemeMode): void;
}

export const useAppearance = create<AppearanceStore>((set) => ({
  themeMode: (localStorage.getItem('mailagent.themeMode') as ThemeMode) ?? 'system',
  resolvedTheme: 'dark',  // 初值；inline bootstrap (§17.3.2) 在 DOM ready 前已覆盖
  setThemeMode(next) {
    localStorage.setItem('mailagent.themeMode', next);
    set({ themeMode: next });
    applyResolvedTheme();
  },
}));

// ▼ REVIEW-LOG C-06: op-id + rAF 串行 guard
// 用户手切 + OS prefers-color-scheme 同瞬间双触发时，
// 只让"最新一次 op" commit 到 DOM，丢弃旧 op，避免 state vs DOM 不一致。
let opCounter = 0;
function applyResolvedTheme() {
  const myOp = ++opCounter;
  requestAnimationFrame(() => {
    if (myOp !== opCounter) return;   // 有更新 op 已在排队，丢弃旧
    const { themeMode } = useAppearance.getState();
    const resolved: 'dark' | 'light' = themeMode === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : themeMode;

    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.classList.toggle('dark', resolved === 'dark');
    useAppearance.setState({ resolvedTheme: resolved });

    // Island 同步（resolved 是 'dark' | 'light'）
    if (window.electron) window.electron.send('appearance:theme', resolved);
    // Electron nativeTheme 同步（标题栏 traffic light 颜色等）；传 themeMode 而非 resolved
    if (window.electron) window.electron.send('appearance:nativeTheme', themeMode);
  });
}

// 初始 + 跟系统变化
applyResolvedTheme();
const mq = window.matchMedia('(prefers-color-scheme: dark)');
mq.addEventListener('change', () => {
  if (useAppearance.getState().themeMode === 'system') applyResolvedTheme();
});
```

Electron main 进程（REVIEW-LOG C-07：BrowserWindow 创建**前**设 nativeTheme + 处理 island broadcast）：

```typescript
// electron/main/appearance.ts
import { app, nativeTheme, ipcMain, BrowserWindow } from 'electron';
import Store from 'electron-store';   // 或自写 minimal kv read on disk

const settings = new Store<{ themeMode: 'system' | 'dark' | 'light' }>({
  defaults: { themeMode: 'system' },
});

// ▼ 关键：必须在 BrowserWindow 创建前调用，避免初次启动 light flash
export function bootNativeTheme() {
  nativeTheme.themeSource = settings.get('themeMode');
}

ipcMain.on('appearance:nativeTheme', (_evt, mode: 'system' | 'dark' | 'light') => {
  nativeTheme.themeSource = mode;
  settings.set('themeMode', mode);   // 持久化到磁盘，下次启动 bootNativeTheme 读
});

// REVIEW-LOG M-01：转发 appearance:theme 到 Island plugin
ipcMain.on('appearance:theme', (_evt, resolved: 'dark' | 'light') => {
  // 通过 island_dispatch 推一个 AppearanceChange envelope（详 ISLAND-PLUGIN.md §8）
  forwardToIslandPlugin({ kind: 'AppearanceChange', theme: resolved });
});

// app.ts 中：
// app.whenReady().then(() => { bootNativeTheme(); createMainWindow(); });
```

### 17.3.1 op-id 测试用例

```typescript
// tests/appearance.test.ts
import { vi } from 'vitest';

test('rapid setThemeMode + OS change converges to last op', async () => {
  const setSpy = vi.spyOn(document.documentElement, 'setAttribute');
  useAppearance.getState().setThemeMode('dark');     // op 1
  mq.dispatchEvent(new Event('change'));             // op 2 (system mode 改 light)
  useAppearance.getState().setThemeMode('light');    // op 3
  await new Promise(r => requestAnimationFrame(() => r(null)));
  // 只 commit 最后一次：data-theme=light
  expect(setSpy).toHaveBeenLastCalledWith('data-theme', 'light');
});
```

### 17.3.2 防 FOUC 的 inline bootstrap（renderer 首帧前生效）

`index.html` `<head>` 第一个 script 标签，**不能引外部依赖**：

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>MailAgent</title>
  <script>
    // FOUC bootstrap — REVIEW-LOG C-07
    (function() {
      try {
        var stored = localStorage.getItem('mailagent.themeMode') || 'system';
        var accent = localStorage.getItem('mailagent.accent') || 'coral';
        var resolved = stored === 'system'
          ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
          : stored;
        var html = document.documentElement;
        html.setAttribute('data-theme', resolved);
        if (accent !== 'coral') html.setAttribute('data-accent', accent);
        html.classList.toggle('dark', resolved === 'dark');
      } catch (e) { /* localStorage may throw on first paint; default dark is fine */ }
    })();
  </script>
  <style id="theme-bootstrap">
    /* 首帧背景色，确保 html bg 跟 token 一致，DOM ready 前不闪 */
    html[data-theme="dark"]  { background: #0E1013; color: #E8EAEE; }
    html[data-theme="light"] { background: #FAFAFA; color: #1A1D22; }
  </style>
  <!-- Vite/Electron 注入的其他 CSS/JS 在下面 -->
</head>
```

主 React app mount 后这套 inline bootstrap 不再起作用（CSS variable 与组件 CSS 接管），但 **paint 第一帧靠它**避免 light/dark mode flash。

### 17.4 切换 UI（Settings）

3 选 1 segmented control（shadcn `<Tabs>` 或自写）：

```
┌─────────────────────────────────┐
│  ☀ Light   │  ◐ System  │ 🌙 Dark │
└─────────────────────────────────┘
```

- 中间 `System` 默认选中，文案随 locale 切（`跟随系统` / `System`）
- 选中后立即生效，无 "Apply" 按钮
- 选 `System` 时下方加一行 hint：`当前系统：暗色` / `Currently: Dark mode`（实时显示 resolvedTheme）

### 17.5 主题 + accent 两层独立

- 主题（明 / 暗）= 6 tier ink scale + 4 tier fg ramp 切换
- Accent（6 swatch）= 仅 `--c-accent` CSS variable swap
- 用户改主题不影响 accent；改 accent 不影响主题
- localStorage 两个 key 独立：`mailagent.themeMode` + `mailagent.accent`

### 17.6 验证矩阵（CI lint 必跑，REVIEW-LOG H-01 落地）

**真实验证组合数**：6 accent × 2 mode（light/dark；system 模式 resolve 后等于其中一个） = **12 必验组合**（之前文档误写"18 组合"，6×3 含 system 是冗余的）。

| Mode × Accent (12 必验) | 验证项 |
|---|---|
| 全 12 | 所有 `ink-fg-*` 对所有 `ink-*` 背景 WCAG AA 通过（4.5:1） |
| 全 12 | `text-coral` (accent) 对所有 `ink-*` 背景 AA 通过 |
| 全 12 | priority chip 5 色 + sync state 4 色 在两个明暗下都可读 |
| 系统切换瞬间 | <50ms 内 DOM 切完，无视觉闪烁（参见 §17.3.2 inline bootstrap） |
| PWA / Web | iOS / iPadOS 浏览器 `prefers-color-scheme` 切换跟随 |

实现：`pnpm a11y:contrast` = Playwright + `@axe-core/playwright`：

```typescript
// scripts/a11y_contrast.ts
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const accents = ['coral', 'cobalt', 'teal', 'rose', 'slate', 'olive'] as const;
const modes = ['light', 'dark'] as const;
const routes = ['/inbox', '/search', '/admin', '/llm'];

const browser = await chromium.launch();
let failed = 0;
for (const accent of accents) for (const mode of modes) for (const route of routes) {
  const page = await browser.newPage();
  await page.goto(`http://localhost:5173${route}`);
  await page.evaluate(({ mode, accent }) => {
    const html = document.documentElement;
    html.setAttribute('data-theme', mode);
    html.classList.toggle('dark', mode === 'dark');
    if (accent === 'coral') html.removeAttribute('data-accent');
    else html.setAttribute('data-accent', accent);
  }, { mode, accent });
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2aa']).analyze();
  if (violations.length) {
    console.error(`[FAIL] ${accent}/${mode}/${route}: ${violations.length} violations`);
    failed += violations.length;
  }
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);  // 任何 violation fail CI
```

**何时跑**:
- Sprint 3 末第一次跑（提前于原计划 Sprint 7，REVIEW-LOG C-08）—— 验证 FTS5 + 翻译 ship 之前的 12 组合
- Sprint 7 ship 前再跑一次确认
- CI 上每个 PR 跑（约 30s，可接受）

### 17.7 不在三态主题范围

- ❌ 高对比度模式（Windows 风格 High Contrast） — V2 议题
- ❌ 自定义明暗 token swap UI（用户调单个色） — 不开放
- ❌ 主题持久化跨设备（远端 Web 与本机 Electron 共享 themeMode） — 各自本地 localStorage，不强同步

---

> **§16 + §17 是与 §1-§15 同级的 V1 标准**。任何 Sprint 0 之后加入的组件如果忽略 i18n 或硬编码主题色，
> code review 必须拒绝。CI 会自动 lint 这两层（[§14 lint 非协商项](#14-the-non-negotiables-lint-these-in-ci)
> 第 9 / 10 条新增）。
