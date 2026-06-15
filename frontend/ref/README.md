# MailAgent · V1 Visual Mockups

> Static HTML mockups for the macOS Electron mail app. Read these as visual
> contracts: every color, font size, spacing value, and component shape is
> meant to be extracted directly into `tailwind.config.ts` + shadcn/ui
> components when Sprint 0 scaffolding starts.
>
> ⚠️ **归档参考（designer 原版）**：本目录是 designer 交付的 V1 原版设计包（mockup 素材 +
> 全量 `ref/DESIGN.md`）。**工程侧当前 SSoT 是 [`../DESIGN.md`](../DESIGN.md)**（经 sprint review 精简/迭代）。
> 本目录的 `DESIGN.md` 仅作像素对照存档，不再是工程更新目标；两者冲突以 `../DESIGN.md` 为准。
>
> 本 README 是本目录内的人类摘要 + 各 mockup 决策注记。

---

## File map

```
.
├── DESIGN.md                       ← ★ canonical design system (tokens · components · nav shell · Island · motion · a11y)
├── README.md                       ← this file
├── mockup-inbox.html               ← 3-pane inbox + ✦ AI panel + batch action bar  (canonical shell host)
├── mockup-search.html              ← ⌘K command palette over an inbox backdrop
├── mockup-settings.html            ← settings page (240/56 shell + 180px section nav)
├── mockup-admin.html               ← LLM Dashboard + 看板 Admin (240/56 shell + 180px section nav)
├── mockup-detail-window.html       ← pop-out single-email reader (no shell + "← Inbox" chip)
├── mockup-compose.html             ← standalone compose window (no shell + "← Inbox" chip)
├── mockup-onboarding.html          ← first-run modal (no chrome by design)
└── mockup-dynamic-island.html      ← notch overlay catalog (8 states · hero · spec sheet)
```

All `mockup-*.html` files live at the project root so Open Design's preview
pane picks them up immediately. They open in any browser with no build step —
Tailwind via play-CDN, no external assets beyond Lucide-style inline SVG.

**Reading order for review:**
1. `DESIGN.md` §1 (philosophy) → §2 (color + nav shell) → §3 (typography).
2. `mockup-inbox.html` — the canonical screen. Everything else is a delta.
3. `mockup-search.html`, `mockup-settings.html`, `mockup-admin.html` — the
   three sub-pages that share the nav shell.
4. `mockup-detail-window.html`, `mockup-compose.html` — pop-out windows.
5. `mockup-onboarding.html` — first-run.
6. `mockup-dynamic-island.html` — notch overlay states.

---

## What's new in this revision

V1.3 → **V1.4** (this turn): nav-shell contract rewrite + Tools removal.

### Added

- **Single-shell contract** (`<aside class="app-nav">`) covering inbox,
  settings, admin, and the search ghost. Documented in `DESIGN.md` §2.11
  with width contract, hooks, motion, lint rules, and cross-page route map.
  Sub-pages cannot draw their own primary nav anymore — they fill the space
  to the right of the shell.

- **Account selector at the top of the shell.** Single 36-px row sharing
  space with the collapse chevron: `[tp-link] lucien.chen ▾ ‹`. Clicking
  opens a `.glass-pop` dropdown with all bound accounts; clicking
  `+ 添加账户...` routes to settings → Accounts. Active row marked via
  `data-active="true"`. The badge auto-derives from the email domain
  (`lucien.chen@tp-link.com` → `tp-link`), so adding a `@gmail.com`
  account just lights up `gmail` in the same shape.

- **Collapsed (56 px) mode** with monogram avatar. The avatar is a 36 px
  circle showing the first letter of the local-part (`L`) on `var(--c-accent)`
  background, so switching the accent re-tints the avatar automatically.
  Clicking the avatar expands the shell first, then opens the dropdown.
  Toggle via the chevron, the avatar, or `⌥B`.

- **Group spacers as collapsed-mode dividers.** When the shell is collapsed,
  section headers / row labels / count badges hide via
  `display: none !important`, but the `app-nav-section-spacer` stays —
  intentionally — so the icon-only column has a visible break between
  Mailboxes / AI Agents / View.

- **Cross-page navigation.** The 5 nav targets that have their own mockup
  pages (`收件箱`, `LLM Dashboard`, `看板 Admin`, `设置`, `全文搜索 ⌘K`)
  are now real `<a href="mockup-*.html">` links. Collapse state syncs
  across pages via `localStorage["mailagent.nav.collapsed"]` + a `storage`
  event listener, so flipping in inbox is preserved when settings/admin
  mounts next. The accent + theme + locale picker continue to use the
  same persistence pattern.

- **`← Inbox` breadcrumb chip** in the title bar of `mockup-detail-window`
  and `mockup-compose`. These windows opt out of the shell by design
  (`DESIGN.md` §2.11 — pop-out exception list); the chip is the user's
  way home. Clicking calls `window.close()`. `mockup-onboarding.html`
  is the third documented chrome-free surface (first-run modal).

- **Motion contract for the shell** — width transition `260 ms`
  `cubic-bezier(0.32, 0.72, 0, 1)`; label opacity `140 ms` linear;
  chevron flip instant via paired SVG swap. Tighter than §8's
  `motion-base` because chrome shouldn't feel chatty. Reduced-motion
  query flattens to instant.

### Changed

- **`OPS` group renamed to `VIEW`.** Only two rows live there now
  (LLM Dashboard + 看板 Admin); they read as places you *look at*, not
  operations you run. Matches the macOS menu convention (`View → Appearance`
  for the accent picker).

- **`TOOLS` group removed entirely.** Search lives in the title-bar `⌘K`
  command palette; translate lives in the email toolbar / body. A nav row
  would have duplicated both entry points without adding discovery, so
  the whole `TOOLS` block went away. The `tools.*` i18n namespace is
  retired with it (orphan dict entries cleaned up in revision 4).

- **`ACCOUNTS` group removed** from the bottom of the shell. The active
  account moved to the top header row; the dropdown handles multi-account
  switching. Bottom strip is now just `设置 / 快捷键`.

- **§3.3 typography rule updated** to list the new section header
  inventory (`MAILBOXES / AI AGENTS / VIEW`).

### Unchanged from prior revisions (still load-bearing)

- 6-tier ink scale + 4-tier fg ramp, all CSS-variable backed for
  light/dark token swap.
- Liquid Glass material stack on chrome surfaces with translucent tile
  recipe for inner panels (`.aif-*` / `.tile`).
- 6 accent presets (coral default + cobalt / teal / rose / slate /
  olive), driven by `:root[data-accent="..."]`.
- 5-color AI Priority ramp matching the Notion DB enum exactly.
- 4-color sync-status palette (`ok` / `warn` / `fail` / `dead`).
- 14 px floor for any Chinese text. English UPPERCASE mono for all
  section headers in both locales.
- Information-density list rows (`py-3`, hairline borders, no card spacing).
- No drop shadows except Toast and Dynamic Island.

---

## Per-mockup tour

| File | What it shows | Why this file exists |
|------|---------------|----------------------|
| `mockup-inbox.html`            | 3-pane inbox + ✦ AI panel + batch action bar, plus the canonical 240/56 nav shell. | The reference screen — every other page is a delta of this one. |
| `mockup-search.html`           | ⌘K command palette opened over a non-interactive inbox backdrop; result groups for JUMP / EMAIL / AI ACTIONS. | Search lives as an overlay, not a separate route — proves the `⌘K` entry point can carry the whole search UX. |
| `mockup-settings.html`         | 240/56 shell + 180 px settings section nav (Accounts / Appearance / AI / Notion / Sync / Shortcuts) + content pane. | Demonstrates how sub-pages combine the shared shell with a page-specific section rail. |
| `mockup-admin.html`            | Same shape as settings, but the right side is the LLM Dashboard + 看板 Admin (dead-letter queue, sync stats, cost timeline). | The single "operator surface" for everything that isn't end-user mail. |
| `mockup-detail-window.html`    | Pop-out single-email reader (full body + AI Fields sidebar). No shell; title bar carries `← Inbox`. | Validates the no-shell exception path documented in §2.11. |
| `mockup-compose.html`          | Standalone compose window with AI rail (chips + draft preview). No shell; `← Inbox` breadcrumb. | Same no-shell exception as detail-window; AI rail proves draft preview works outside the main app. |
| `mockup-onboarding.html`       | First-run centered 720 × 560 card on the wallpaper (Notion bind, mail accounts, accent + theme pick). | Documented exception — first-run has no chrome. |
| `mockup-dynamic-island.html`   | Hero shot + 4×2 catalog of all 8 Island states + sizing/motion/keyboard spec sheet + ASCII IPC diagram. | The notch overlay is a separate Swift Package — this file is its spec, not its renderer. |

---

## How to use these mockups for Sprint 0 scaffold

1. **Read `DESIGN.md` §2.11 first** before touching any nav code. The
   shell contract (240/56, account-on-top, monogram, dropdown, spacers,
   `app-nav-*` hooks, cross-page sync) is non-obvious from the markup
   alone, and getting it wrong cascades across every page.

2. **Copy the Tailwind extend block** from `DESIGN.md` §11 into
   `tailwind.config.ts`. Token names are already production-shaped;
   `ink-*` is CSS-variable backed so `:root[data-theme="light"]` is a
   one-line theme swap.

3. **Install shadcn primitives** per `DESIGN.md` §12:
   ```bash
   pnpm dlx shadcn-ui@latest add button badge command toast tooltip dialog \
     dropdown-menu input textarea tabs popover avatar
   ```

4. **Extend variants** (Badge: 5 priority variants; Button: coral primary;
   Avatar: monogram fill) per `DESIGN.md` §12.

5. **Build components in this order** (each maps to a file in `src/`):
   - `chrome/AppShell.tsx` — the nav shell. Width state, account header,
     dropdown, monogram avatar, group rhythm, bottom strip. Wire to
     `localStorage["mailagent.nav.collapsed"]` and the `storage` event.
   - `chrome/AccountSwitcher.tsx` — popover content under the account
     header row.
   - `chrome/TitleBar.tsx` + `chrome/StatusBar.tsx` — including the
     `← Inbox` breadcrumb variant for detached windows.
   - `ui/Kbd.tsx`
   - `email/EmailRow.tsx` (virtualized — `DESIGN.md` §5.1 ref code)
   - `email/EmailList.tsx` (sticky header + filter chips + virtualized rows)
   - `email/EmailDetail.tsx` (toolbar + body + AI Fields block + attachments)
   - `email/AIFieldsBlock.tsx` (the 3×11 grid)
   - `ai/AIChatPanel.tsx` (`DESIGN.md` §5.3 ref code)
   - `ai/MessageList.tsx` + `ai/Composer.tsx` + `ai/BackendSelector.tsx`
   - `batch/BatchActionBar.tsx` (`DESIGN.md` §5.4 ref code)
   - `island/` — separate Swift package, communicates via Unix socket.

6. **Wire up keymap** from `DESIGN.md` §9.5 into `src/keymap.ts` and bind
   via `useHotkeys`. `⌥B` (nav collapse) and `⌥L` (theme) are the two
   new global shortcuts since V1.3.

7. **Notion Agent backend** — wrap `notion-agent-cli` via execa:
   ```ts
   import { execaCommand } from 'execa';
   const res = await execaCommand(
     `notion-agent chat "${prompt}" --agent-page-id ${agentPageId} --json`
   );
   ```

8. **Dynamic Island** — build as a separate Swift Package (Open Island
   pattern). MailAgent.app publishes events over Unix socket; Island
   publishes user actions back the same way. Fails open.

---

## Open questions still on the table

Most prior questions are now resolved (light mode, accent picker, nav shell,
cross-page navigation, breadcrumb chip). What remains:

1. **AI panel default-open vs default-closed.** Default-open on ≥ 1280 px
   width (current mockup state) vs collapsed to a 48 px icon rail with
   `⌥A` toggle. Recommendation: keep default-open on full-size laptops,
   collapse below 1280.

2. **Per-email AI conversation persistence.** Mockup implies each email
   keeps its own thread. Schema sketch in `DESIGN.md` §15 question 4 —
   confirm `(email_id, backend_id)` keying before Sprint 0.

3. **Cost transparency.** AI panel and batch bar surface dollar costs
   inline (`$0.0021` / `est. $0.018`). Keep — this app's user is the
   developer who pays the API bills.

4. **Filters as nav rows vs sub-strip.** Currently `发件箱 / 已标旗 /
   所有邮件 / AI 会话历史` are nav rows in the Mailboxes group. When
   production routes split, decide whether they stay there or move into
   a "filters" strip under the mailbox header.

5. **Dynamic Island packaging.** Separate Swift app (Open Island
   pattern) vs bundled native helper in `Resources/`. Recommendation:
   separate app.

---

> Visual approval rule: when you're happy with `mockup-inbox.html` +
> `mockup-dynamic-island.html` + `DESIGN.md`, the rest of the mockups
> become tightly bounded — they reuse the same tokens, components,
> shell, and motion. Sign off on these three, and the remaining five
> mockups are ~half a day of paste-and-adjust work.
