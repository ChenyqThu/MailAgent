# Artifact Studio

Design and build high-craft, self-contained HTML5 interactive deliverables via `artifact_write`.

## 1. Workflow

1. Clarify the deliverable goal and pick the single best `artifact_type`:
   - `dashboard`: executive metrics, filterable tables, multi-chart operational views.
   - `slides`: 16:9 keyboard-navigable presentation decks with overview/notes and print-to-PDF support.
   - `report`: editorial long-form analysis, comparisons, decision memos with sticky outline navigation.
   - `diagram`: crisp system architecture, sequence, flow, or data-model visuals with interactive inspection.
   - `app`: focused interactive calculators, forms, configurators, or UI prototypes. (For **Omada Controller / TP-Link network management UI prototypes**, call `skill_read("omada_prototype")` first and use `omada_catalog_query` + `artifact_write` with `@chenyqthu/omada-ui-kit`.)
2. Gather real facts from emails, Matters, Library documents, contacts, or connected tools before writing a single line of HTML. Never invent numbers, names, or dates. If a metric is missing, label it explicitly as unavailable.
3. Commit to one intentional Art Direction before coding.
4. Write one complete, self-contained HTML5 document (`<!doctype html> ... </html>`) via `artifact_write`. Choose a concise kebab-case `slug` (e.g. `q4-vendor-renewal-board`).
5. On revisions, pass the exact same `slug` to `artifact_write` so versions advance cleanly (`v1`, `v2`, ...) without overwriting prior snapshots.
6. When the user asks to publish, share a link, or iterate from team feedback, follow Section 6 after the local preview is clean.

## 6. Cloud Publishing & Review Loop

- **Publish / Update**: ALWAYS call `artifact_publish_bundle` with `slug` (and optional `version`, `title`, `artifact_type`, `visibility`, `change_note`) to upload the saved artifact directly from disk to Canvas Artifact Server — **never** paste compiled HTML or bundles into `mcp__artifact_server__artifact_publish`. Always return the `share_url` and `review_url` to the user first so they can inspect and comment full-screen; never invent or print tokens.
- **Inspect Team Feedback**: When `mcp__artifact_server__*` tools are available, call `mcp__artifact_server__comment_list` with `slug` and `status="open"` before revising an existing cloud artifact.
- **Close the Loop**: Apply requested changes in a new immutable `artifact_write` (or `artifact_build_omada`) version (`vN+1`), republish with `artifact_publish_bundle`, and mark addressed threads resolved with `mcp__artifact_server__comment_resolve`.

## 2. Art Direction & Visual Craft

Pick a deliberate visual register suited to the audience and ambient context:

- **Editorial Paper**: crisp off-white canvas (`#f8f7f4` or neutral `#fafafa`), deep ink text (`#16181d`), one editorial accent (terracotta, cobalt, or forest green), hairline 1px borders (`rgba(0,0,0,0.08)`), structured columns and generous whitespace.
- **Swiss Precision Dashboard**: cool high-contrast light surface (`#f5f7fa` / `#ffffff`), crisp 1px grid lines, strict tabular alignment, semantic status tokens only where data demands them.
- **Executive Dark Slate**: deep charcoal canvas (`#0f1318`, surface `#161b22`), high-contrast off-white ink (`#edf2f7`), restrained single-hue highlights, zero neon glow spam.
- **Crisp Presentation Deck**: bold typographic scale, max 1 core message per slide, breathing room >= 30% of slide area.

Define your entire palette once in `:root` CSS custom properties (background, surface, border, primary ink, muted ink, 1 primary brand color, 1 sharp accent, and semantic status tones). Ensure body text maintains >= 4.5:1 contrast against its surface.

### Anti-AI-Slop Bans (Match and Refuse)

- **No generic purple/indigo-to-blue gradient backgrounds or gradient clipped headlines.**
- **No monotonous grids of identical rounded white cards** with big shadow blobs and tiny all-caps eyebrow kickers (`01 · OVERVIEW`, `02 · METRICS`) above every section. Vary rhythm with asymmetric splits, compact summary strips, tables, and callouts.
- **No colored thick side-stripe borders** (`border-left: 4px solid ...`) on every card or callout. Use subtle full hairlines, surface tint shifts, or clean leading badges.
- **No nested cards inside cards** or heavy blurry drop shadows (`0 20px 50px`). Prefer crisp 1px borders and subtle `0 1px 2px` elevation.
- **No `// TODO` / `/* TODO */` / `<!-- TODO -->` placeholders** or truncated stub arrays (`// ... more items`).

## 3. Typography & Data Alignment

- **Chinese & Bilingual Font Stack**:
  `-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Segoe UI", system-ui, sans-serif`
- **Monospace / Numeric Stack**:
  `ui-monospace, "SF Mono", Menlo, Consolas, monospace`
- **Body Readability**: `14px` to `16px` font size, `line-height: 1.65`, prose column `max-width: 68ch`, `text-wrap: pretty`.
- **Headings**: `text-wrap: balance`, restrained tracking (`-0.02em` to `-0.03em` for large display numbers/titles; never tighter than `-0.04em`).
- **Numbers & Tables**: Apply `font-variant-numeric: tabular-nums` on every KPI, metric badge, currency figure, date column, and data table cell so digits align vertically.

## 4. Blueprints by `artifact_type`

### `dashboard`
- Compact header bar with title, reporting scope/date badge, and live interactive filters (search box, category pills, sort toggles).
- Top takeaway strip + asymmetric KPI row (`tabular-nums`, period delta only if backed by real data).
- Interactive chart zone (ECharts or clean responsive inline SVG with hover tooltips) + filterable/sortable detail table.

### `slides`
- Fixed 16:9 stage (`aspect-ratio: 16 / 9`, responsive scaling inside viewport) with smooth slide switching.
- Support Left/Right arrow keys, Space/PageDown, click controls, slide counter (`1 / N`), optional slide thumbnail rail, and toggleable speaker notes drawer.
- Include `@media print` rules that expand every slide cleanly into full-page landscape print breaks so the user can export crisp PDFs.

### `report`
- Sticky left or top table of contents with active section highlight on scroll (`IntersectionObserver`).
- Executive summary block upfront, structured comparison tables, pros/cons or risk matrices, and inline SVG or Mermaid diagrams for architecture/timelines.

### `diagram`
- Prefer clean semantic inline SVG (crisp typography, orthogonal connectors, subtle arrowheads, color-coded layers, zoom/pan or node-detail inspector panel on click) or Mermaid v11.
- Clicking a node or edge reveals structured metadata in a clean side or bottom detail bar rather than cramming paragraphs inside tiny boxes.

### `app`
- Real client-side state (reactive DOM updates, live recalculation, interactive tabs, filters, drawers, or modal dialogs using native `<dialog>` or clean CSS positioning).
- Mobile and desktop responsive breakpoints (`@media (max-width: 720px)`).

## 5. Sandbox Runtime & Library Discipline

Artifacts render inside an isolated sandboxed `<iframe>` without `allow-same-origin` (opaque `null` origin):

- **Never call `localStorage`, `sessionStorage`, or `document.cookie` bare** — they throw `SecurityError` in opaque origins and crash your script. Always wrap storage reads/writes in `try { ... } catch { ... }` with an in-memory fallback map.
- **Avoid external font/CSS/JS dependencies when clean CSS + inline SVG already achieves the result.**
- When interactive charts, diagrams, or icons materially elevate the deliverable, load pinned CDN versions with clean fallback handling so offline previews still render core content:
  - ECharts: `https://cdn.jsdelivr.net/npm/echarts@5.6.0/dist/echarts.min.js`
  - Mermaid: `https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js`
  - Lucide icons: `https://cdn.jsdelivr.net/npm/lucide@0.460.0/dist/umd/lucide.min.js`
- Always initialize charts after `DOMContentLoaded`, handle `ResizeObserver` / `window.resize`, and avoid external images unless URLs come directly from verified context.

## 6. Optional Visual Self-Check with `browser_use`

`artifact_write` and `artifact_build_omada` return a loopback `local_preview_url` alongside the saved Library path:

- When `browser_use` tools are enabled in the session and visual polish is critical (dense charts, complex grids, or slide layouts), open `local_preview_url` to inspect rendered output at both desktop and mobile viewports and confirm zero console errors.
- If you spot overlapping labels, contrast issues, or clipped containers, fix the artifact source and call `artifact_write` or `artifact_build_omada` again with the **same `slug`** to produce `v2`, `v3`, ... cleanly.
- If `browser_use` is unavailable or disabled, never claim you visually inspected the rendered pixels — report your static HTML/build verification accurately.
