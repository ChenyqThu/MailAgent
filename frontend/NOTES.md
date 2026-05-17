# Frontend NOTES

> Small TODOs / issues / questions surfaced during day-to-day Sprint work.
> One line per entry, leading date in ISO. Cross-session blockers / things
> that need backend coordination → `gh issue create` instead.

## TODO

- 2026-05-17 — `src/shared/types/cli.gen.ts` is gitignored (codegen output); fresh checkout must run `pnpm gen:types` once before `pnpm typecheck` works. Consider wiring it into `postinstall` (alongside `electron-builder install-app-deps`) so new clones never see a typecheck miss.
- 2026-05-17 — `EmailGet_EmailRecord.cc_addr` schema declares it as required string but the SQLite column is nullable; DAO substitutes `''` for `null`. If a callsite ever needs to distinguish "no CC" from "empty CC string" we'll have to widen the schema. Low priority — Sprint 2 EmailDetail just renders the string.
- 2026-05-17 — `notion_url` is built as `https://www.notion.so/<id-no-dashes>` because the workspace prefix is private. Sprint 6 SettingsPage should let the user set a workspace-scoped prefix (`/omadanetworks/...`) for direct deep-links.
- 2026-05-17 — `vitest 4.1.6` deprecation: `test.poolOptions` was lifted to top-level; we just removed our `poolOptions.forks.singleFork`. If tests start interfering across files re-add it as the new top-level shape.
- 2026-05-17 — `eslint-plugin-local-rules` is in devDependencies but unused — we load `./eslint-rules/index.cjs` directly via `createRequire`. Remove on next dep-bump pass.
- 2026-05-17 — `no-cjk-in-mono-size` only catches CJK in JSX text nodes; it doesn't resolve `t('key')` against zh-CN locale JSON. If we start using `text-meta` className over a `{t()}` child, the i18n review at sprint close has to be the safety net.
- 2026-05-17 — Light mode visual spot-check still pending (REVIEW-LOG C-08). Once the app launches with `themeMode='light'` from Settings (Sprint 6), the 5 core components need a side-by-side dark/light diff: EmailRow / AIBadge / Toolbar / Composer / Sidebar — but Sprint 1 only ships TitleBar / StatusBar / Sidebar / InboxLayout. The other three appear in Sprint 2-4; carry the spot-check forward.
