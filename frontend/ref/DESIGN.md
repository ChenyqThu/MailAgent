> ⚠️ **归档参考（designer 原版 V1.4 全量版）**：工程侧当前设计 SSoT 是 [`../DESIGN.md`](../DESIGN.md)；本文件仅作 mockup 像素对照存档，不再随工程迭代更新。

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
├── mockup-inbox.html               ← 3-pane inbox + ✦ AI panel + batch (canonical shell host)
├── mockup-search.html              ← ⌘K command palette over an inbox backdrop
├── mockup-settings.html            ← settings page (240/56 shell + 180px section nav)
├── mockup-admin.html               ← LLM Dashboard + 看板 Admin
├── mockup-detail-window.html       ← pop-out single-email reader (no shell + ← Inbox chip)
├── mockup-compose.html             ← standalone compose window (no shell + ← Inbox chip)
├── mockup-onboarding.html          ← first-run modal (no chrome by design)
└── mockup-dynamic-island.html      ← notch overlay (8 states)
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
  Everywhere else: subtraction. (The Liquid Glass chrome layer is not a
  flourish — it's the *medium*; see §2.8.)

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
5. **Both modes are first-class.** Dark is the historical canonical, but
   light parity ships in V1 (mockup-inbox revision 2). Both modes are pure
   token swaps on `:root[data-theme="..."]` — never a markup re-skin. See §2.8
   for the Liquid Glass material stack and §2.9 for the theme-toggle UI.

---

## 2. Color system

All colors live as Tailwind tokens; production code references them by name
via `theme.extend.colors`. **Never inline hex** outside the `:root` token
definition.

### 2.1 Window-chrome / surface tiers (6 levels)

Dark, cool, desaturated. Selected for legibility under macOS dark menu bar
without ever going pure black. **All `ink-*` tokens are now CSS-variable
backed** (RGB-triple form), so a single `:root[data-theme="light"]` block
re-skins every surface — and every Tailwind class like `bg-ink-1/55` is
valid for the Liquid Glass translucent layers (§2.8).

| Token              | Hex (dark) | RGB triple        | Use                                                |
|--------------------|-----------|--------------------|----------------------------------------------------|
| `ink-0`            | `#0E1013` | `14 16 19`         | Outermost canvas; covered by wallpaper (§2.8)      |
| `ink-1`            | `#15181D` | `21 24 29`         | Sidebar; bottom status bar; batch bar; title bar   |
| `ink-2`            | `#1A1E24` | `26 30 36`         | Email list column; AI panel base                   |
| `ink-3`            | `#1F242B` | `31 36 43`         | Detail pane; hover surface for rows / buttons      |
| `ink-4`            | `#262C35` | `38 44 53`         | Selected row; AI user-bubble bg; raised affordance |
| `ink-5`            | `#2E343E` | `46 52 62`         | Reserved — popover / menu surface above `ink-4`    |
| `ink-border`       | `#2C323B` | `44 50 59`         | Hairline between major panels                      |
| `ink-border-soft`  | `#1F242B` | `31 36 43`         | Row-internal divider (near-invisible)              |

Foreground text ramp (4 levels, all on dark):

| Token       | Hex       | Use                                          |
|-------------|-----------|----------------------------------------------|
| `ink-fg`    | `#E8EAEE` | Primary text (subject line, value text)      |
| `ink-fg-1`  | `#A4A9B3` | Secondary (sender meta, button label)        |
| `ink-fg-2`  | `#6B707A` | Tertiary (mono meta, label text, captions)   |
| `ink-fg-3`  | `#454A53` | Disabled / quaternary (skeleton-tier)        |

Light mode is a pure token swap on `:root[data-theme="light"]` — no markup
or class changes. The light ramp inverts the dark relationship: chrome
(ink-0, ink-1, ink-2) gets *darker* as you go toward content, while ink-3
(the main content surface) is the *whitest*, and ink-4 (selected/raised)
goes one tier darker than the content surface (so "raised" reads as a
subtle inset rather than a glow). Mapping:

| Token              | Dark      | Light     |
|--------------------|-----------|-----------|
| `ink-0`            | `#0E1013` | `#FAFAFA` |
| `ink-1`            | `#15181D` | `#F2F2F4` |
| `ink-2`            | `#1A1E24` | `#F8F9FB` |
| `ink-3`            | `#1F242B` | `#FFFFFF` |
| `ink-4`            | `#262C35` | `#E1E3E6` |
| `ink-5`            | `#2E343E` | `#D5D8DE` |
| `ink-border`       | `#2C323B` | `#D6DAE0` |
| `ink-border-soft`  | `#1F242B` | `#E6E8ED` |
| `ink-fg`           | `#E8EAEE` | `#1A1D22` |
| `ink-fg-1`         | `#A4A9B3` | `#5B616B` |
| `ink-fg-2`         | `#6B707A` | `#7A808A` |
| `ink-fg-3`         | `#454A53` | `#B2B8C0` |

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
system stays anchored. Theme (light/dark) is a separate axis — see §2.9.

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

### 2.8 Liquid Glass — translucent chrome over an aurora wallpaper

V1 (revision 2) adopts macOS Tahoe / iOS 26's "Liquid Glass" material as the
chrome treatment. The model: a colorful, accent-tinted wallpaper layer
pinned to the viewport, and a stack of translucent surfaces with strong
backdrop blur on top of it. Content layers (email body, AI message thread,
AI Fields grid) stay near-opaque so reading isn't disturbed; only the
*chrome* breathes.

**Surface stack (outer → inner):**

```
░░░ wallpaper          body::before, fixed, aurora gradient (color)
▒▒▒ chrome             title bar · sidebar · status bar · batch bar
▓▓▓ panel              email list · right AI panel
███ content            detail pane (mail body)
░░░ popover            theme picker · toast
```

**Utility classes** (defined in `mockup-inbox.html` `<style>`; production
should mirror them into `src/styles/glass.css`):

| Class       | Surface ink    | Alpha   | Backdrop filter                | Used on                                  |
|-------------|----------------|---------|--------------------------------|------------------------------------------|
| `.glass`    | `--ink-1`      | 0.55    | `saturate(180%) blur(40px)`    | title bar, sidebar, batch bar, status bar |
| `.glass-2`  | `--ink-2`      | 0.45    | `saturate(180%) blur(40px)`    | email list panel                          |
| `.glass-3`  | `--ink-3`      | 0.55    | `saturate(180%) blur(40px)`    | detail pane (content surface — opacity tuned so wallpaper bleed is unmistakable; inner panels are lifted via `.aif-*` / `.tile`) |
| `.glass-pop`| `--ink-2`      | 0.82    | `saturate(180%) blur(40px)` + 1px stroke + `--pop-shadow` | popovers, toasts, theme picker |
| `.ai-bg`    | `--ink-2`→`--ink-1` linear gradient | 0.50→0.55 | `saturate(180%) blur(40px)` | right AI panel (vertical sheen)         |

Saturation 180% is the Apple signature — it lifts the wallpaper colors so
they read *through* the blur instead of being washed out.

**Wallpaper recipe** (`--wallpaper` CSS variable):

```css
:root {
  --wallpaper:
    radial-gradient(60vw 60vh at  8% 12%, rgb(var(--c-accent) / 0.30), transparent 60%),
    radial-gradient(55vw 60vh at 95%  8%, rgba( 74,120,229,0.22),       transparent 65%),
    radial-gradient(60vw 55vh at 50% 110%, rgba(181,140,219,0.18),      transparent 70%),
    linear-gradient(180deg, #06080B 0%, #0A0C10 100%);
}
```

Notes on the wallpaper:
- **Accent-aware.** The top-left radial-gradient lobe is tinted with
  `var(--c-accent)`, so swapping accent (coral → cobalt → teal …) also
  re-colors the room behind the glass. The other two lobes stay neutral
  (cool blue + soft violet) so the picture doesn't go monochrome.
- **Pinned, not parallax.** Wallpaper lives on `body::before` with
  `position: fixed; inset: 0; z-index: -1` so scrolling content doesn't
  pull the colors through the blur (which causes shimmer).
- **Light mode rebinds** the same variable to softer paper tones —
  `linear-gradient(#F6F7FB → #ECEEF4)` with the same three lobes at
  slightly higher alpha (light backgrounds eat more saturation).

**Border treatment.** With glass surfaces, the old `border-ink-border` 1px
hairlines turn into `border-ink-border/60` — they're now an opaque hint
of the boundary on top of a translucent panel, which reads correctly in
both modes. Popovers carry an additional `--glass-stroke` of white/6–10%
to mimic the inner refraction edge Apple uses.

**Inner content tiles (revision 3).** When the detail pane (`.glass-3`) is
the parent surface, content panels on top of it must NOT be 100% opaque —
that paints the whole pane back to solid and kills the glass read. Use the
**tile** recipe instead:

| Class                     | Background                       | Used on                                  |
|---------------------------|----------------------------------|------------------------------------------|
| `.ai-fields .aif-head`    | `rgb(var(--ink-2) / 0.70)`       | AI Fields panel header strip             |
| `.ai-fields .aif-grid`    | `rgb(var(--ink-border) / 0.45)`  | The 1px divider grid                     |
| `.ai-fields .aif-cell`    | `rgb(var(--ink-3) / 0.62)`       | Each of the 11 AI Fields tiles           |
| `.tile`                   | `rgb(var(--ink-2) / 0.62)`       | Attachment cards, future inline panels   |
| `.tile:hover`             | `rgb(var(--ink-4) / 0.78)`       | Hover state on `.tile`                   |

Hierarchy is intentional: pane (0.55) < cell (0.62) < head (0.70). Each
layer is more opaque than the one beneath it so "panel inside pane" reads
correctly without either layer collapsing the glass effect. Code blocks
(`<pre>`), inline code, and the mail body use `rgb(var(--ink-fg) / 0.06)`
which is already translucent — no change needed there.

**Hard rules:**
- ✅ **Inner content tiles ARE translucent, not opaque.** See the table
  above. The detail pane lives by this — it's the difference between
  "the pane is glass" and "the pane is a window with a card sitting on it."
- ❌ **Glass on chrome only.** `.glass` / `.glass-2` / `.glass-3` apply to
  the four chrome panes (title bar, sidebar, list, detail) + the right AI
  pane (`.ai-bg`). Buttons, rows, chips, kbd, ai-tool-rows stay solid.
- ❌ **No nested `.glass*` utility.** Inner panels use the tile recipe,
  not a second `backdrop-filter` — stacked blurs don't compose to a richer
  glass; they just cost GPU.
- ❌ **No blur on hover.** Hover states stay solid (`hover:bg-ink-3` /
  `.tile:hover`) so the cursor feels precise, not floaty.
- ✅ **Honor `prefers-reduced-transparency`.** All `.glass*` classes
  flatten to opaque ink + `backdrop-filter: none` under that media query.
  Layout doesn't shift; just the material flattens. The `.aif-*` / `.tile`
  tiles also flatten in that mode (production: add them to the same
  `@media` block; the mockup leaves them translucent because the parent
  is already opaque).

**Browser support.** Electron uses Chromium, which has full
`backdrop-filter` support. We still ship `-webkit-backdrop-filter` for the
inevitable Safari preview surface.

### 2.9 Light / dark theme

V1 ships both modes. They are independent of the accent picker.

**Token contract.** Light mode is a pure CSS-variable rebind on
`:root[data-theme="light"]` — every `ink-*` token swaps to its light
equivalent (see §2.1 mapping table), the wallpaper gradient retunes to
soft paper, the popover shadow recipe inverts to a light-source-from-above
elevation, and `--glass-stroke` swaps from white-6% to white-70% for a
brighter rim.

What the swap **does** affect: every chrome surface, every text color,
every border, every input/composer field, mail body prose, and the
wallpaper. What it does **not** affect: status colors (`ok`/`warn`/
`fail`/`dead`), AI priority colors (`crit`/`urg`/`impt`/`norm`/`low`),
`info`, accent, traffic-light buttons. Those are semantic and stay the
same across modes — by design.

**Theme-toggle UI conventions:**

- Entry point: title-bar text-button `<sun|moon> Dark/Light` next to the
  Appearance (accent) button. Sun = currently light, click → dark; moon =
  currently dark, click → light. Same idiom as macOS Settings → Appearance.
- Persistence: `localStorage["mailagent.theme"]` (production: Electron
  `settings.json`).
- First-run default: follow `prefers-color-scheme`. If the user has never
  picked, OS-level toggles propagate live (we register a
  `matchMedia('(prefers-color-scheme: light)').addEventListener` and
  re-apply). Once the user has explicitly toggled at least once, the
  manual choice wins.
- Global shortcut: `⌥L` toggles theme.
- Transition: 280ms cross-fade on `background-color` and `border-color`
  only — text color stays instant so reading focus isn't disturbed.

**Production wiring (preview):**

```ts
// src/state/theme.ts
import { create } from 'zustand';

export type Theme = 'dark' | 'light';

interface Store { theme: Theme; setTheme(next: Theme): void; toggle(): void; }

const stored = (localStorage.getItem('mailagent.theme') as Theme | null);
const sys: Theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';

export const useTheme = create<Store>((set, get) => ({
  theme: stored ?? sys,
  setTheme(next) {
    const root = document.documentElement;
    if (next === 'light') { root.dataset.theme = 'light'; root.classList.remove('dark'); }
    else                  { delete root.dataset.theme;     root.classList.add('dark');    }
    localStorage.setItem('mailagent.theme', next);
    window.electron.send('appearance:theme', next); // → Island parity
    set({ theme: next });
  },
  toggle() { get().setTheme(get().theme === 'light' ? 'dark' : 'light'); },
}));
```

**Island parity.** The Dynamic Island overlay listens for `appearance:theme`
in the same way it listens for `appearance:accent`. Its surface stack uses
the same `.glass-pop` recipe so the notch pill, the resting icons, and the
hover-expand all participate in the system material — a critical pulse
ring is still semantic `crit` red, but its enclosing pill picks up
light-mode paper or dark-mode ink uniformly.

### 2.10 Internationalization (i18n) — Chinese / English

V1 ships in **two locales**: `zh-CN` (default, canonical) and `en`. Locale
is the third independent axis of the appearance system, alongside accent
(§2.7) and theme (§2.9). Switching it is a one-tap, no-reload operation,
the same way `data-theme` swaps tokens.

**The five rules of i18n.**

1. **Every UI string is dictionary-resolved.** Hand-coded literals in
   markup are banned outside the dictionary block. Every chrome node
   (sidebar item, button label, tooltip, placeholder, status pill,
   toast) carries `data-i18n="namespace.key"` and pulls from
   `I18N_DICT[locale]`. The mockup uses inline JS; production uses
   `react-i18next` reading from `src/i18n/dict.ts`.
2. **User data is never translated.** Email subject, body, sender
   name, AI-generated summary text, action-item card text, draft
   preview content, AI Fields *values* — all stay in the source
   language of the source data. The user invokes the `翻译` /
   `Translate` action when they want translated content; the UI does
   not silently re-render their mail in English.
3. **Section headers stay English UPPERCASE mono in both locales.**
   `MAILBOXES` / `AI AGENTS` / `AI FIELDS · 11` / `ATTACHMENTS` /
   `SUMMARY` etc. — §3.3 already mandates this for typographic
   reasons. The i18n layer must respect it. Translating them to
   Chinese would push them to `text-aux` 14 px (§3.3 fallback) and
   break the dense scanability the design is built on.
4. **`lang-pip` is content-language, not UI-language.** The little
   `EN` / `中` pip on every email row indicates the *email's* source
   language (used by the translate action). It does NOT swap when
   the user flips UI locale. They are orthogonal: a Chinese user can
   read their UI in Chinese while skimming English Sentry alerts,
   and the pip is what tells them which rows need a translate tap.
5. **14 px floor still applies in `en`.** The Chinese floor isn't
   relaxed in English — switching to `en` does not buy permission to
   use `text-micro` 11 px on body copy. Hierarchical reasons (this
   is a desktop tool, not a marketing site) carry across locales.

**Token shape — namespace-dotted keys.**

```ts
type LocaleId = 'zh-CN' | 'en';

const I18N_DICT: Record<LocaleId, Record<string, string>> = {
  'zh-CN': {
    'nav.inbox':            '收件箱',
    'nav.outbox':           '发件箱',
    'nav.flagged':          '已标旗',
    'nav.allMail':          '所有邮件',
    'nav.aiSessions':       'AI 会话历史',
    'ops.admin':            '看板 Admin',
    'titleBar.searchHint':  '搜索 / 跳转',
    'titleBar.themeDark':   'Dark',     // Apple convention — stays English
    'titleBar.themeLight':  'Light',    // Apple convention — stays English
    'list.filter.unread':   '未读',
    'list.filter.flagged':  '已标旗',
    'list.filter.attach':   '附件',
    'list.sort.latest':     '最新',
    'list.meta.selected':   '{n} selected',  // count chunks stay English-mono
    'toolbar.draft':        '✦ 起草回复',
    'toolbar.translate':    '一键翻译',
    'toolbar.markRead':     '标为已读',
    'toolbar.flag':         '切换标旗',
    'toolbar.archive':      '归档',
    'toolbar.retryNotion':  '重传 Notion',
    'toolbar.rerunAI':      'AI 重跑分类',
    'toolbar.openNotion':   '在 Notion 中打开',
    'ai.tab.thread':        'Thread',   // English mono, see §3.3
    'ai.tab.sync':          'Sync',     // English mono, see §3.3
    'ai.context.mail':      '邮件全文',
    'ai.context.fields':    'AI 11 fields',
    'ai.context.notion':    'Notion · 2 项目',
    'ai.qa.summarize':      '总结',
    'ai.qa.draft':          '起草回复',
    'ai.qa.translate':      '翻译',
    'ai.qa.extract':        '提取动作项',
    'ai.qa.linkNotion':     '关联 Notion',
    'ai.composer.placeholder': '/命令 或对这封邮件提问… (⌘↩ 发送)',
    'batch.selected':       '已选 {n} 封',
    'batch.selectAll':      '选全部 {n} 封',
    'batch.clear':          '清除',
    'batch.classify':       'AI 批量分类',
    'batch.draftReply':     'AI 批量起草回复',
    'batch.translate':      '批量翻译',
    'batch.markRead':       '标已读',
    'batch.archive':        '归档',
    'batch.retryNotion':    '重传 Notion',
    'toast.aiUpdated':      'AI 字段已更新',
    // ...
  },
  'en': {
    'nav.inbox':            'Inbox',
    'nav.outbox':           'Outbox',
    'nav.flagged':          'Flagged',
    'nav.allMail':          'All Mail',
    'nav.aiSessions':       'AI Sessions',
    'ops.admin':            'Admin',
    'titleBar.searchHint':  'Search / Jump',
    'titleBar.themeDark':   'Dark',
    'titleBar.themeLight':  'Light',
    'list.filter.unread':   'Unread',
    'list.filter.flagged':  'Flagged',
    'list.filter.attach':   'Attachments',
    'list.sort.latest':     'Latest',
    'list.meta.selected':   '{n} selected',
    'toolbar.draft':        '✦ Draft Reply',
    'toolbar.translate':    'Translate',
    'toolbar.markRead':     'Mark as Read',
    'toolbar.flag':         'Toggle Flag',
    'toolbar.archive':      'Archive',
    'toolbar.retryNotion':  'Retry Notion',
    'toolbar.rerunAI':      'Re-run AI Classify',
    'toolbar.openNotion':   'Open in Notion',
    'ai.tab.thread':        'Thread',
    'ai.tab.sync':          'Sync',
    'ai.context.mail':      'Mail Body',
    'ai.context.fields':    'AI · 11 fields',
    'ai.context.notion':    'Notion · 2 projects',
    'ai.qa.summarize':      'Summarize',
    'ai.qa.draft':          'Draft Reply',
    'ai.qa.translate':      'Translate',
    'ai.qa.extract':        'Extract Actions',
    'ai.qa.linkNotion':     'Link Notion',
    'ai.composer.placeholder': '/command or ask about this email… (⌘↩ to send)',
    'batch.selected':       '{n} selected',
    'batch.selectAll':      'Select all {n}',
    'batch.clear':          'Clear',
    'batch.classify':       'AI Batch Classify',
    'batch.draftReply':     'AI Batch Draft',
    'batch.translate':      'Batch Translate',
    'batch.markRead':       'Mark Read',
    'batch.archive':        'Archive',
    'batch.retryNotion':    'Retry Notion',
    'toast.aiUpdated':      'AI fields updated',
    // ...
  },
};
```

Keys are **kebab-namespaced** so a future split into per-screen
dictionary files (`nav.json`, `toolbar.json`, `ai.json`) is mechanical.

**Markup contract.**

```html
<!-- text content -->
<span data-i18n="nav.inbox">收件箱</span>

<!-- attribute(s) — comma-separated attr:key pairs -->
<button
  data-i18n="toolbar.draft"
  data-i18n-attr="title:toolbar.draft,aria-label:toolbar.draft"
>✦ 起草回复</button>

<!-- placeholder -->
<textarea data-i18n-attr="placeholder:ai.composer.placeholder"></textarea>

<!-- count interpolation — {n} is replaced from data-i18n-n -->
<span data-i18n="batch.selected" data-i18n-n="3">已选 3 封</span>

<!-- skip i18n on a subtree (user data inside chrome) -->
<div data-i18n-skip>
  <span class="font-medium">Sentry · alerts@sentry.io</span>
</div>
```

The literal text in the markup is the `zh-CN` fallback — if the script
fails to run, the page still reads correctly. `applyLocale('en')`
rewrites it in place.

**The applyLocale function.**

```ts
function applyLocale(loc: LocaleId) {
  const dict = I18N_DICT[loc] ?? I18N_DICT['zh-CN'];
  const interp = (s: string, n?: string) =>
    n != null ? s.replace('{n}', n) : s;

  // textContent
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => {
    if (el.closest('[data-i18n-skip]')) return;
    const key = el.dataset.i18n!;
    const n   = el.dataset.i18nN;
    if (dict[key]) el.textContent = interp(dict[key], n);
  });

  // attributes — title, aria-label, placeholder, etc.
  document.querySelectorAll<HTMLElement>('[data-i18n-attr]').forEach(el => {
    el.dataset.i18nAttr!.split(',').forEach(pair => {
      const [attr, key] = pair.split(':').map(s => s.trim());
      if (dict[key]) el.setAttribute(attr, dict[key]);
    });
  });

  // <html lang> + Intl scope
  document.documentElement.lang   = loc;
  document.documentElement.dataset.locale = loc;
  localStorage.setItem('mailagent.locale', loc);
  window.electron?.send('appearance:locale', loc);  // → Island parity
}
```

**First-run default.** Fall back to `navigator.language` — anything
starting with `zh` → `zh-CN`, everything else → `en`. Once the user has
explicitly switched at least once, that choice wins. The first-run
detection happens once on page load; later OS language changes do not
re-skin the UI (unlike `prefers-color-scheme`, which we honor live).

**Locale picker UI conventions.**

- Entry point: title-bar text-button next to the Dark/Light and Accent
  buttons, showing a globe `🌐` icon + current locale label (`中文` or
  `English`). One-click cycles to the other locale.
- Keyboard shortcut: `⌥G` (globe mnemonic) toggles.
- Persistence: `localStorage["mailagent.locale"]` (production:
  `settings.json`).
- Transition: text content swaps **instantly** — no fade. The user
  asked for a different language; show it.
- Island parity: the locale broadcasts to the Dynamic Island over the
  same unix-socket channel as `accent` and `theme`; the Island's
  Phase 1 pill text (`To: oncall ·` / `发给 oncall ·`) follows.

**Locale-aware formatting via `Intl`.** Timestamps, counts, currency,
relative time are formatted through `Intl.*` so flipping locale also
flips the format:

```ts
const fmtTime  = new Intl.DateTimeFormat(loc, { hour: '2-digit', minute: '2-digit' });
const fmtDate  = new Intl.DateTimeFormat(loc, { year: 'numeric', month: 'short', day: 'numeric' });
const fmtRel   = new Intl.RelativeTimeFormat(loc, { numeric: 'auto' });
const fmtCount = new Intl.NumberFormat(loc);
const fmtMoney = new Intl.NumberFormat(loc, { style: 'currency', currency: 'USD' });
```

Mono-numeric formatting (`tabular-nums`) is locale-independent — column
alignment in the status bar and AI cost line works the same way.

**What the locale picker does NOT touch.**

- Mono section headers (`MAILBOXES`, `AI FIELDS · 11`) — stay English.
- Component identifiers (`Notion Agent`, `Custom API`, `Island`,
  `LLM Dashboard`) — proper nouns, stay English.
- Email content — stays in source language until the user invokes
  Translate.
- Status colors / AI priority colors — semantic, no labels involved.
- Accent + theme — independent axes.

**Layout resilience.** English copy is on average 1.4× wider than
Chinese (`Inbox` ≤ `收件箱` is the rare exception; `AI Batch Draft` is
~1.6× wider than `AI 批量起草回复`). The chrome must accept this:

- Sidebar item: `flex` row with `min-w-0 truncate` on the label.
- Toolbar button: width adapts (icon-only buttons already do; labeled
  ones expand). Never use a fixed-width container around translatable
  text.
- Batch bar: items wrap with `flex-wrap` if the locale makes the bar
  overflow at 1280 px width — never clip.
- Status bar pills: keep mono `text-meta`; if a pill grows, drop the
  one furthest from the cursor (the build-hash pill is the first to
  shed).

**Production wiring (preview):**

```ts
// src/state/locale.ts
import { create } from 'zustand';

export type Locale = 'zh-CN' | 'en';

interface Store {
  locale: Locale;
  setLocale(next: Locale): void;
  toggle(): void;
}

const stored = localStorage.getItem('mailagent.locale') as Locale | null;
const sys    = navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';

export const useLocale = create<Store>((set, get) => ({
  locale: stored ?? sys,
  setLocale(next) {
    document.documentElement.lang = next;
    document.documentElement.dataset.locale = next;
    localStorage.setItem('mailagent.locale', next);
    window.electron.send('appearance:locale', next); // → Island parity
    set({ locale: next });
  },
  toggle() { get().setLocale(get().locale === 'zh-CN' ? 'en' : 'zh-CN'); },
}));
```

In React, `useLocale()` becomes the single source for the `t()` helper:

```tsx
const t = (key: string, n?: number) => {
  const s = I18N_DICT[useLocale.getState().locale]?.[key] ?? key;
  return n != null ? s.replace('{n}', String(n)) : s;
};
```

**File layout (production).**

```
src/i18n/
├── index.ts            ← t(), useLocale(), Intl helpers
├── dict.ts             ← imports per-namespace dictionaries
├── zh-CN/
│   ├── nav.json
│   ├── toolbar.json
│   └── …
└── en/
    ├── nav.json
    ├── toolbar.json
    └── …
```

Mockups use a single inline `I18N_DICT` for simplicity; the namespace
shape (`nav.*`, `nav.account.*`, `accountSwitcher.*`, `toolbar.*`,
`ai.*`, `batch.*`, `ops.*`, `titleBar.*`, `list.*`, `toast.*`,
`settings.*`, `search.*`, `island.*`) is the same. The `tools.*`
namespace was retired in revision 4 — see §2.11 for why.

### 2.11 Navigation shell — single source of truth across pages

The left navigation (`<aside class="app-nav">`) is the **app shell**, not
a per-page widget. It renders identically on `mockup-inbox.html`,
`mockup-settings.html`, `mockup-admin.html`, and as a non-interactive
ghost on `mockup-search.html`. Sub-pages must NOT draw their own primary
nav; they fill the space to the right of the shell.

**Windows that intentionally have no shell:**

- `mockup-detail-window.html` — pop-out single-email reader. Title bar
  carries a `← Inbox` breadcrumb chip that calls `window.close()`.
- `mockup-compose.html` — standalone compose window. Same breadcrumb.
- `mockup-onboarding.html` — first-run modal, by design has no chrome.

**Width contract.** Two states, persisted to
`localStorage["mailagent.nav.collapsed"]` (production: `settings.json`).
Cross-page sync is automatic — every page registers a `storage` event
listener so flipping in inbox is reflected the next time settings or
admin mounts in the same window.

| State     | Width | What's visible                                                       |
|-----------|-------|----------------------------------------------------------------------|
| expanded  | 240px | account selector + chevron · section headers · row labels · kbd hints · count badges |
| collapsed | 56px  | avatar monogram · row icons only (19px) · group spacers as dividers · chevron flipped |

Toggle:
- Click the `‹` / `›` chevron in the header.
- Click the avatar monogram (collapsed state) — first expands the shell,
  then opens the account dropdown.
- Global shortcut `⌥B` from anywhere in the window.

**Header zone — account on top.** The previous `ACCOUNTS` section at the
bottom of the shell was removed in revision 4; the active account moved
to the top so it shares a row with the collapse chevron.

Expanded layout (single row, ~36 px tall):

```
┌─────────────────────────────────────────────┐
│ [tp-link] lucien.chen        ▾         ‹   │
└─────────────────────────────────────────────┘
   ^badge      ^name         ^caret      ^chevron
```

- **Badge** (`text-micro font-mono` pill, `ink-3` bg + `border-soft`):
  the email's domain prefix (`tp-link`, `gmail`, `icloud`). Derived from
  the part before the first `.` of the domain — `lucien.chen@tp-link.com`
  → `tp-link`.
- **Name** (`text-body`, `text-ink-fg`): the local-part of the address
  (`lucien.chen`). Truncates with ellipsis when the panel is narrowed.
- **Caret** (`▾`, `text-ink-fg-2`): indicates the dropdown is available.
  Rotates 180° when the popover is open.
- **Chevron** (`‹` / `›`): collapse toggle. `app-nav-chevron-collapse`
  shows when expanded; `app-nav-chevron-expand` shows when collapsed.
  Implemented as a paired SVG swap (not an animated rotate) so direction
  is unambiguous.

Collapsed layout — chevron alone on row 1, avatar centered on row 2:

```
┌──────┐
│  ›   │
├──────┤
│  L   │   ← 36 × 36 circular monogram, bg = var(--c-accent)
└──────┘
```

- **Avatar monogram**: first letter of the local-part, uppercased.
  Background uses `var(--c-accent)` so the avatar re-tints when the user
  swaps accent (coral → cobalt → teal …). Tap to expand the shell so the
  dropdown has room to render.

**Account dropdown.** Anchored under the account-selector row, ~240 px
wide, `.glass-pop` material. One row per account in the same
`[badge] name` shape as the header. Active row carries
`data-active="true"` plus a coral 3 px left edge + coral-tinted badge.
Bottom row: `+ 添加账户...` ghost that opens settings → Accounts.

Switching accounts:
- Closes the popover immediately.
- Updates header badge + name + monogram letter in place.
- Broadcasts an `appearance:account` event over the unix socket so the
  Dynamic Island reflects the active mailbox.

**Section rhythm — exactly 3 groups, no more.**

| Group       | Header text  | Rows                                                            |
|-------------|--------------|-----------------------------------------------------------------|
| Mailboxes   | `MAILBOXES`  | 收件箱 (selected on inbox) · 发件箱 · 已标旗 · 所有邮件         |
| AI Agents   | `AI AGENTS`  | Notion Agent (with online dot) · Custom API · AI 会话历史       |
| View        | `VIEW`       | LLM Dashboard · 看板 Admin                                       |

Group dividers are `.app-nav-section-spacer` (`my-3 mx-4 border-t
ink-border-soft`). **In the collapsed state they stay visible —
intentionally** — because they are the only thing separating one
category of icons from another:

```css
.app-nav[data-collapsed="true"] .app-nav-section-spacer {
  margin-inline: 0.625rem;  /* shorter to fit the 56px width */
  margin-block:  0.5rem;
}
```

Section headers, count badges, kbd hints, and the account selector all
hide in collapsed (`display: none !important`); the `.app-nav-keep`
escape hatch keeps the AI-Agent online dot visible so the collapsed
icon row still has a colour anchor.

**Bottom strip.** Below the three groups (border-top `ink-border-soft`),
inside `.app-nav-bottom`:

- `设置` — `mockup-settings.html` (kbd `⌘,`). Active when on settings.
- `快捷键` — opens shortcut help modal (kbd `?`). Not a separate page.

There is **no second account row** here — accounts live exclusively at
the top of the shell.

**Why `TOOLS` was removed (revision 4).** Search lives in the
title-bar's `⌘K` command palette; translate lives in the email toolbar
(`翻译 EN→中`) and in the email body (`一键翻译此邮件为中文` button
under the subject). A nav row would have duplicated both entry points
without adding discovery — so the entire `TOOLS` group is gone. The
`tools.*` i18n namespace is retired with it.

**Why `OPS` was renamed to `VIEW` (revision 4).** Only two rows live
there now (LLM Dashboard, 看板 Admin) and they read as *places you go
to look at things* — not as operations. `VIEW` matches the macOS menu
convention (`View → Appearance` for the accent picker) and is
language-symmetric with `MAILBOXES` / `AI AGENTS`.

**Cross-page navigation.** The 5 nav targets that have their own pages
are real `<a href="mockup-*.html">` links (no JS handler — relies on
browser navigation). The rest (`发件箱`, `已标旗`, `所有邮件`,
`AI 会话历史`, `Notion Agent`, `Custom API`) are `href="#"` because
they are inbox-internal views, not separate pages. Production wires
them to React Router routes that swap the right side of the shell
while the shell itself stays mounted.

| Nav row              | Production route   | Mockup link                          |
|----------------------|--------------------|--------------------------------------|
| 收件箱               | `/inbox`           | `mockup-inbox.html`                  |
| 发件箱               | `/outbox`          | `#` (inbox view)                     |
| 已标旗               | `/inbox?flag=on`   | `#` (inbox view)                     |
| 所有邮件             | `/all`             | `#` (inbox view)                     |
| AI 会话历史          | `/ai/history`      | `#` (inbox view)                     |
| LLM Dashboard        | `/admin/llm`       | `mockup-admin.html`                  |
| 看板 Admin           | `/admin/kanban`    | `mockup-admin.html`                  |
| 设置                 | `/settings`        | `mockup-settings.html`               |
| 全文搜索 (`⌘K`)      | overlay (no route) | `mockup-search.html` (overlay only)  |

**Selected-row visual.** Exactly one nav row carries `.row-selected`
(plus `bg-ink-4 text-ink-fg font-medium` on the label). On inbox:
`收件箱`. On settings: `设置`. On admin: `看板 Admin`. Never two rows
selected across the shell at once.

**Motion contract.** The width transition is the only nav animation,
and it is short and unambiguous.

| Property       | Duration | Easing                                | Notes                                |
|----------------|----------|---------------------------------------|--------------------------------------|
| `width`        | 260 ms   | `cubic-bezier(0.32, 0.72, 0, 1)`      | Tighter than §8 standard — chrome shouldn't feel chatty |
| label opacity  | 140 ms   | linear                                | Fades during the width change        |
| chevron flip   | instant  | —                                     | Paired SVGs swapped via CSS          |
| popover open   | 120 ms   | `motion-fast`                         | Origin under the account row         |

Under `@media (prefers-reduced-motion: reduce)` the width changes are
instant. Layout is identical; only the transition flattens.

**Hooks the production code must keep.** The mockup uses these data
attributes / classes as load-bearing selectors. Production must keep
the same names so the same CSS works unchanged.

- `aside.app-nav` — shell root.
- `data-collapsed="true"` / absent — single source of truth for state.
- `.app-nav-account` — expanded-state header row (account selector).
- `.app-nav-avatar-row` — collapsed-state avatar row.
- `.app-nav-section-header` — group title (`MAILBOXES`, `AI AGENTS`, `VIEW`).
- `.app-nav-section-spacer` — between-group divider; stays visible when
  collapsed (the only group separator in icon-only mode).
- `.app-nav-chevron-collapse` / `.app-nav-chevron-expand` — paired SVGs.
- `.app-nav-keep` — survives collapse (e.g. the AI-Agent online dot).
- `.app-nav-bottom` — the `设置 / 快捷键` strip.
- `.row-selected` — the active page's nav row.

**i18n parity.**

- `nav.inbox`, `nav.outbox`, `nav.flagged`, `nav.allMail`, `nav.aiSessions`
  flip with locale.
- `VIEW` group: row label `看板 Admin` flips via `ops.admin`;
  `LLM Dashboard` is a proper noun and stays English in both locales.
- Section headers (`MAILBOXES`, `AI AGENTS`, `VIEW`) stay English mono in
  both locales (§3.3 rule).
- Account name + domain badge are user data — never translated.

**Lint contract for production** (`pnpm lint:design`):

1. Exactly one `<aside class="app-nav">` per page that has the shell.
2. Three and only three `.app-nav-section-header` children per shell.
3. No `<a>` row with `href="#"` inside `.app-nav-bottom` (those rows are
   either real routes or popover triggers, never dead links).
4. `.row-selected` count across the shell ≤ 1.

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

Sidebar groups (`MAILBOXES` / `AI AGENTS` / `VIEW` — see §2.11 for the
group inventory and why `ACCOUNTS` / `TOOLS` / `OPS` are gone),
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

**Visibility contract (revision 3).** The batch action bar is **hidden by
default** and appears only when one or more rows in the list have
`.cb-on`. Implementation:

- `<body>` is `flex flex-col`; `<main>` is `flex-1 min-h-0`. The batch
  bar lives between `<main>` and the status bar with `shrink-0` + a
  toggled `.hidden`. When hidden, `<main>` reclaims the 52 px without
  any height math.
- Enter batch mode: click a row checkbox (`.cb` → `.cb-on`). Production
  may also expose `⇧↓` / `⇧↑` and `⌘A` from a focused row.
- Exit: `清除` button, `×` button at the right edge of the bar, or `Esc`
  (consumed only when the bar is visible, so it doesn't fight the
  popover/dialog dismissal handlers).
- Open vs select: clicking a row body still opens the email. Only the
  checkbox toggles batch — same convention as Mail.app / Mimestream.
- Count text in the bar is sourced from a single `[data-batch-count]`
  attribute selector so the badge, the "已选 N 封" line, and any future
  aria-live region all stay in lock-step from one update path.

The first 3 buttons are **AI batch ops**, visually elevated with
`bg-coral/10 + border-coral/30 + text-coral`. The 3 default ops:

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
        // Ink ramp is CSS-variable backed (§2.1) so :root[data-theme="light"]
        // re-skins the whole app, AND Tailwind's /<alpha-value/> picks up
        // alpha for the Liquid Glass translucent layers (§2.8) — `bg-ink-1/55`
        // is now a valid translucent chrome surface.
        ink: {
          0: 'rgb(var(--ink-0) / <alpha-value>)',
          1: 'rgb(var(--ink-1) / <alpha-value>)',
          2: 'rgb(var(--ink-2) / <alpha-value>)',
          3: 'rgb(var(--ink-3) / <alpha-value>)',
          4: 'rgb(var(--ink-4) / <alpha-value>)',
          5: 'rgb(var(--ink-5) / <alpha-value>)',
          border:        'rgb(var(--ink-border)      / <alpha-value>)',
          'border-soft': 'rgb(var(--ink-border-soft) / <alpha-value>)',
          fg:     'rgb(var(--ink-fg)   / <alpha-value>)',
          'fg-1': 'rgb(var(--ink-fg-1) / <alpha-value>)',
          'fg-2': 'rgb(var(--ink-fg-2) / <alpha-value>)',
          'fg-3': 'rgb(var(--ink-fg-3) / <alpha-value>)',
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

✅ **Navigation shell — RESOLVED (revision 4).** The `<aside class="app-nav">`
shell is now a shared chrome contract across inbox / settings / admin
(plus the ghost backdrop in search). Two width states (240 / 56),
account-on-top header, monogram-avatar in collapsed mode, three groups
(MAILBOXES / AI AGENTS / VIEW), and a stable set of `.app-nav-*` hooks.
Detail / compose windows opt out of the shell and use a `← Inbox`
breadcrumb chip instead. See §2.11 for the full contract. Open
follow-up: when production splits the inbox into routed views, decide
whether `发件箱 / 已标旗 / 所有邮件` stay as nav rows or move into a
"filters" sub-strip under the mailbox header.

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
5. ✅ **Light mode parity — RESOLVED.** Shipped in `mockup-inbox.html`
   revision 2 alongside the Liquid Glass treatment. `ink-*` tokens now
   bind to CSS variables; `:root[data-theme="light"]` does the full swap.
   Theme toggle (§2.9) lives in the title bar; `⌥L` toggles globally. OS
   `prefers-color-scheme` is the first-run default. Open follow-up:
   bring the Dynamic Island mockup to parity (it currently still reads
   the dark ramp directly).
6. **Dynamic Island packaging.** Two paths:
   (a) ship as a separate Swift app (like Open Island) that talks to
       MailAgent.app over Unix socket — cleaner separation;
   (b) bundle as a child native helper inside the Electron `Resources/`
       — single download, but harder to test.

Recommend (a). Same reason Open Island is its own app.
