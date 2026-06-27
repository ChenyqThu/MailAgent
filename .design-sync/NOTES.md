# design-sync NOTES — MailAgent

Repo-specific gotchas for syncing the MailAgent UI to claude.ai/design. Read this before any re-sync.

## What this repo is (off-envelope)

`frontend/` is an **Electron application** (`mailagent-frontend`, `private: true`), NOT a published component library. No library build entry (`main` = `out/main/index.js`, the Electron MAIN process), no shipped `.d.ts` export tree. The DS is synthesized from `frontend/src/shared/components/**` in the converter's **synth-entry mode** (`[NO_DIST]` is expected, not an error).

Scope = `frontend/src/shared/components` only (132 source files → **170 components**, ~3.4MB bundle). `frontend/src/shared/assistant/` (assistant-ui runtime plumbing) is deliberately NOT synced.

## Build wiring (why each piece exists)

- **Scratch package** at `frontend/node_modules/mailagent-frontend/` (gitignored; **recreate on a fresh clone**). Because: (a) the converter resolves `PKG_DIR = <node-modules>/<pkg>` and `mailagent-frontend` doesn't self-install; (b) its `package.json` has **no `main`/`module`/`exports`** → `resolveDistEntry` returns null → forces synth mode (a real `frontend/` PKG_DIR would grab `out/main/index.js`, the Electron main process); (c) `cssEntry` must live **under** `realpath(PKG_DIR)`, so the compiled stylesheet is copied in as `_ds_compiled.css`.
- **`cssEntry` = `_ds_compiled.css`** = a copy of `frontend/out/renderer/assets/index-*.css` (electron-vite's **compiled Tailwind**: `:root{--c-accent…}` tokens + the utilities the app actually uses). `frontend/src/electron/renderer/index.css` is Tailwind SOURCE and is NOT usable directly. **Re-copy whenever the renderer CSS changes.** 🔴 Only utilities the app actually uses are compiled in — a token defined in `tailwind.config.ts` but unused by the app (e.g. `bg-card`, `bg-secondary`, `ring-ring`) is absent from the shipped CSS. `conventions.md` was written against the *built* CSS for this reason.
- **`tsconfig` = `.design-sync/tsconfig.dssync.json`** (portable, `baseUrl: ../frontend`). Resolves `@shared/*`/`@renderer/*` AND stubs the heavy libs (below). Two non-obvious rules:
  - **Directory imports** (`@shared/format`, `@shared/i18n` — dirs with only `index.ts`) need **exact path keys BEFORE the `@shared/*` wildcard** (the bundled `tsconfigPathsPlugin` matches in object order and its empty-extension probe treats a directory as a hit).
  - 🔴 **NEVER put a `"//"` comment key in this tsconfig.** The plugin's `//`-comment stripper eats a `"//": "…"` JSON key → JSON.parse throws → plugin returns null → every `@shared/*` import fails. Keep it pure JSON.

## Heavy-library stubbing (the 5MB cap)

Synth mode `export *`s every component → the whole transitive graph is bundled with zero tree-shaking. The AI-chat + rich-text-editor stack (**@assistant-ui, lexical, @tiptap/prosemirror, streamdown, ai-sdk, zod** ≈ 3.7MB) is transitively wired into core layout → `_ds_bundle.js` hits **7.8MB, over the 5MB cap**. Per the user's choice we **stub** those leaf libs (not exclude the components) → full 170 components, ~3.4MB; the AI-chat/editor components stay in the list but floor-card.

Stub = `.design-sync/stubs/empty.mjs` wired via `tsconfig.dssync.json` `paths`. Two 🔴 invariants:
- **The stub MUST be ESM, never CJS.** esbuild static-binds ESM named imports, but runs a CJS module through `__toESM` (copies only own enumerable props — none on a proxy) → `import { z } from 'zod'` would bind to `undefined`, `z.object(...)` throws at IIFE eval, blanking the ENTIRE bundle.
- **The export list is generated** by `.design-sync/scripts/collect-heavy-imports.mjs` (scans `src/shared` for named imports from the heavy modules, regenerates `empty.mjs`). **Re-run it on re-sync.** A new heavy-module import otherwise fails the build with a loud `No matching export in ".design-sync/stubs/empty.mjs"`. Add a brand-new heavy *module* to the script's `HEAVY` array AND the tsconfig `paths`. Namespace imports (`import * as X`) aren't covered by named exports — the collector warns if any appear (currently 0).

## ASCII-ify the bundle (charset robustness) — 🔴 required post-build step

The UI has CJK in regex literals (`/[一-鿿]/`) and Chinese comments (bundle is **not** minified). Served as a classic `<script src>` without a charset, a browser mis-decodes those multi-byte chars → the regex becomes a SyntaxError → the IIFE throws → `window.MailAgent` never populates. The converter's own `[BUNDLE_EXPORT]` smoke check loads the bundle via a charset-less `setContent` and so fails ("N/175 not a component") on a raw bundle, even though the preview cards (which carry `<meta charset="utf-8">`) render fine.

Fix: `node .design-sync/scripts/asciify-bundle.mjs` after every `package-build` (before validate/upload). It escapes all non-ASCII to `\uXXXX` (byte-identical, semantically equal in strings AND regex → no behavior change, renderHashes stay valid) and refreshes `_ds_sync.json`'s `bundleSha12`. After it, the bundle is charset-independent and `[BUNDLE_EXPORT]` passes.

## Bundle export collisions

`agents/primitives.tsx` (an assistant-ui re-export barrel, stubbed) also exports `Switch`, colliding with the real `ui/switch.tsx` `Switch` → ESM ambiguous star re-export drops `Switch` from `window.MailAgent`. The committed fork `.design-sync/overrides/source-kit.mjs` excludes files listed in `.design-sync/bundle-exclude.json` from the synth entry (currently just `agents/primitives.tsx`). If `[BUNDLE_EXPORT]` flags a NEW name as "not a component", check for a duplicate export (`grep -rl "export .* <Name>" src/shared/components`) and add the glue/barrel file to `bundle-exclude.json`. The fork needs `.design-sync/node_modules` (symlink → `.ds-sync/node_modules`, for ts-morph/esbuild) — recreate per clone.

## Setup (fresh clone — recreate the gitignored build inputs)

```sh
# 1. stage converter + deps (incl. playwright + chromium for the render check)
mkdir -p .ds-sync && cp -r "<skill>"/{package-build,package-validate,package-capture,resync}.mjs "<skill>"/lib "<skill>"/storybook .ds-sync/
#    keep the committed helper scripts too: collect-heavy-imports.mjs, asciify-bundle.mjs, analyze-bundle.mjs, closure-analyze.mjs, taint-trace.mjs
(cd .ds-sync && npm i esbuild ts-morph @types/react playwright && npx playwright install chromium)
# 2. fork needs to resolve bare deps from .design-sync/overrides/
ln -sfn ../.ds-sync/node_modules .design-sync/node_modules
# 3. scratch package (forces synth + holds the compiled CSS under PKG_DIR)
mkdir -p frontend/node_modules/mailagent-frontend
printf '{"name":"mailagent-frontend","version":"0.20.0","private":true}' > frontend/node_modules/mailagent-frontend/package.json
cp "$(ls -1 frontend/out/renderer/assets/index-*.css | head -1)" frontend/node_modules/mailagent-frontend/_ds_compiled.css
# 4. regenerate the heavy-import stub
node .design-sync/scripts/collect-heavy-imports.mjs
# 5. build → asciify → validate  (NOT the one-command resync.mjs driver — see Re-sync)
node .ds-sync/package-build.mjs --config .design-sync/config.json --node-modules frontend/node_modules --out ./ds-bundle
node .design-sync/scripts/asciify-bundle.mjs
node .ds-sync/package-validate.mjs ./ds-bundle    # must exit 0
```

If `frontend/out/renderer/assets/index-*.css` is absent, build the renderer first (`cd frontend && pnpm build`).

## Re-sync flow (🔴 the one-command driver does NOT fit)

`resync.mjs` chains build → diff → **validate** in one process. Validate would run on the RAW (non-asciified) bundle and fail `[BUNDLE_EXPORT]`. So run the steps manually: `cp -r` the staged scripts → re-copy `_ds_compiled.css` if renderer CSS moved → `collect-heavy-imports.mjs` → `package-build.mjs` → **`asciify-bundle.mjs`** → `package-validate.mjs`. Then fetch the project's `_ds_sync.json` and diff if you want the upload partition, or just re-upload (full writes are idempotent).

## Known render warns (non-blocking — recorded so re-sync doesn't re-flag)

Final validate: 170/170 render cleanly, **0 bad**, 117 floor cards (unauthored — the user chose all-floor-card), ~53 real renders, **15 `[RENDER_THIN]`** warns. The thin ones are layout fragments / compound sub-parts that paint little without their parent context (e.g. `Row`, `PageHeader`, `SectionHeader`, `EnvField`, `EnvSecretField`, `DialogHeader`, `DialogFooter`, `SelectGroup`, `Label`, `HoverTip`, `Tabs`, `RadioGroup`, `EmptyState`, `ShimmerText`, `ReportIcon`, `TranslatedBody`). All expected for a floor-card sync; not failures. ~17 total warns incl. a few `[RENDER_ERRORS]` on stubbed components (they swap to the floor card).

## Re-sync risks (what can silently go stale)

- **`_ds_compiled.css` is a point-in-time copy** — re-copy if `frontend/` styling changed, else stale tokens ship.
- **Stub export list / module list drifts** — re-run `collect-heavy-imports.mjs`; add new heavy modules to its `HEAVY` array + tsconfig paths. Fails closed (loud build error).
- **asciify must re-run after every build** — a raw bundle fails `[BUNDLE_EXPORT]` and is charset-fragile.
- **Bundle size can re-cross 5MB** if a new feature wires a heavy dep widely — check `_ds_bundle.js` size; `.design-sync/scripts/closure-analyze.mjs` re-measures heavy/light split, `analyze-bundle.mjs` breaks it down by package.
- **New ambiguous-star collisions** — `[BUNDLE_EXPORT]` will name them; add the glue file to `bundle-exclude.json`.
- **AI-chat/editor components are floor-card-by-construction** (libs stubbed) — intentional, not a regression; they can't get rich previews while stubbed.
- **Scratch package + symlink are machine-local** (gitignored) — recreate per Setup.
- **`conventions.md` cites only built-CSS classes** — if the app drops a utility the header names, re-validate the names against the fresh `_ds_bundle.css`.
