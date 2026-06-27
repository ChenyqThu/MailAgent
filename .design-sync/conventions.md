# MailAgent UI — how to build with it

MailAgent is a macOS desktop **email client**. This library is its real renderer components — Tailwind-styled, Radix-based primitives plus product compositions (email rows, calendar chips, settings rows, toolbars, badges). Build with the actual exported components; for layout glue, use the Tailwind idiom below.

## Setup & wrapping

- **No provider needed for the styled primitives.** `Button`, `Input`, `Select`, `Dialog`, `Popover`, `Tabs`, `Switch`, `Badge`, `EmailRow`, etc. are Radix + Tailwind — just render them. The shipped `styles.css` defines every token on `:root`, so components are styled with zero setup.
- **Theme & accent are root attributes.** Tokens default to **dark**; add `data-theme="light"` on a wrapping element for light mode. `data-accent="<hue>"` swaps the brand accent (default coral). One attribute re-skins everything.
- **Start from the `Foundations` group** — `FoundationColors`, `FoundationType`, `FoundationSemantics` are visual reference cards for the design tokens (colour, type scale, semantic chips). They are not building blocks; read them to learn the token values, then compose the real components.
- **Many core components ship a rich preview** (email row, calendar event chip/block, settings rows/sections, page header, tabs, segmented control, select, AI badge, empty state, …). The rest render an honest floor card ("preview not yet authored") but are fully importable with the same API.
- **Skip the AI-chat / rich-text-editor components** (`AgentThread`, `AgentConversation`, `AgentComposer`, `AIChatPanel`, `MessageList`, `ComposeEditor`, `ComposePanel`, `TranslatedBody`, the `*Layout` shells). Their heavy runtime deps (assistant-ui, lexical, TipTap, streamdown) are stubbed in this library, so they render empty. Use the primitives and smaller compositions instead.

## Styling idiom — Tailwind utilities with this system's tokens

Style with `className` Tailwind utilities (not style props). Every token class below is verified present in the shipped CSS and accepts an `/alpha` modifier (e.g. `bg-coral/15`, `text-ink-fg/60`):

| Family | Classes | Use |
|---|---|---|
| Neutral surfaces | `bg-ink-0` (deepest) · `bg-ink-1` · `bg-ink-2` · `bg-ink-3` · `bg-ink-4` · `bg-muted` | panels, rows, cards |
| Text inks | `text-ink-fg` (primary) · `text-ink-fg-1` · `text-ink-fg-2` · `text-ink-fg-3` (descending emphasis) · `text-muted-foreground` | body / secondary / tertiary |
| Borders | `border-ink-border` · `border-ink-border-soft` · `border-border` | hairlines, dividers |
| Brand accent | `bg-coral` · `text-coral` · on-accent text `text-accent-fg` · focus ring `ring-coral` · `bg-primary` / `text-primary-foreground` | primary CTAs, focus |
| Semantic (priority/status) | `crit` `urg` `impt` `norm` · `ok` `warn` `fail` · `text-ai` | chips — pattern `bg-urg/15 text-urg` |
| Type scale | `text-micro` (11) · `text-meta` (12) · `text-aux`/`text-body` (14) · `text-lead` (15) · `text-subj` (22) | sizes |
| Families | `font-sans` · `font-display` · `font-mono` | — |

- Merge classes with the exported **`cn()`** helper (clsx + tailwind-merge; it knows the custom `text-micro…subj` scale). Last class wins on conflicts.
- Primitives expose **variant props**, not class overrides for their core look — e.g. `<Button variant="…" size="…">`. `Button` variants: `default` · `secondary` · `ghost` · `outline` · `destructive` · `link`. Pass extra `className` for layout only.
- Hover/active are state utilities over the same tokens (`hover:bg-ink-4`, `active:scale-[0.98]`).

## Where the truth lives

Read these before styling — authoritative over this summary:
- `styles.css` (and its `@import` of `_ds_bundle.css`) — every token (`--ink-*`, `--c-accent*`, `--c-{crit,urg,…}`) and the compiled component CSS. **Only classes the app actually uses are compiled in** — if a utility isn't there, it won't style; prefer the families above.
- Each component's `<Name>.d.ts` (real props) and `<Name>.prompt.md` (usage).

## One idiomatic example

```tsx
// real library components for the controls; DS Tailwind idiom for layout glue
import { Button, Badge } from 'mailagent-frontend' // === window.MailAgent.*

<div className="flex items-center gap-2 p-3 rounded-lg bg-ink-2 border border-ink-border">
  <span className="text-meta text-ink-fg-2">Inbox</span>
  <span className="text-micro px-1.5 py-0.5 rounded bg-urg/15 text-urg">Urgent</span>
  <div className="ml-auto flex gap-1.5">
    <Button variant="ghost" size="default">Archive</Button>
    <Button variant="default" size="default">Reply</Button>
  </div>
</div>
```
