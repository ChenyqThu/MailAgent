// Sprint 10 acceptance Tier 1 smoke — drives the packaged .app to cover
// §6.3 user-acceptance items that don't require human input. The 2026-05-18
// .dmg ship hit two packaged-only bugs (router file:// → NotFound;
// better-sqlite3 ABI 141 vs 140) that vitest + happy-dom + build:mac all
// missed. These six smokes lock the regression surface.
//
// Coverage map (matches SPRINT10-HANDOFF.md §6.3):
//   ① boot → Inbox three-pane shell, no NotFound  (defends e34b83c)
//   ② email.listEnriched IPC returns rows         (defends 23f3bc8 ABI fix)
//   ③ ⌘K command palette opens                    (Sprint 7 keymap)
//   ④⑤ RETIRED in S3 (07-02): the ⌘L sidebar AIChatPanel + its QuickActions chips
//      were deleted with the legacy chat UI (the email AI surface is now the ⌘J
//      AssistantChatModal). Re-writing these smokes against the modal (open via ⌘J,
//      locale flip inside AgentConversation) is a W5 follow-up — manual lane, needs a
//      packaged .app run to author against the real DOM.
//   ⑥ RETIRED (Phase 3b): Ping Island uninstalled; replaced by Tray + macOS Notifications.

import { test, expect, type Page } from '@playwright/test'
import { launchApp, setLocale } from './electron-fixture'
import type { ElectronApplication } from 'playwright'

let app: ElectronApplication
let win: Page

test.beforeEach(async () => {
  ;({ app, win } = await launchApp())
})

test.afterEach(async () => {
  await app.close()
})

test('① boot lands on Inbox, no NotFound', async () => {
  // Defends `e34b83c` — packaged file:// must route to '/' via memoryHistory.
  // If the router-instance file:// detection regresses, TanStack Router falls
  // through to NotFoundRoute and renders the default "Not Found" text.
  await expect(win.locator('[aria-label="email-list"]')).toBeVisible({ timeout: 20_000 })
  // The default TanStack NotFoundRoute renders this literal — assert zero
  // matches so we don't get a green from a partial render.
  await expect(win.locator('text=Not Found')).toHaveCount(0)
})

test('② email.listEnriched IPC returns rows or empty-state', async () => {
  // Defends `23f3bc8` — better-sqlite3 ABI 141 vs 140 would crash the IPC
  // before any list state resolves. Either rows show up OR the "nothing to
  // show" empty state appears; both prove the IPC returned cleanly.
  const list = win.locator('[aria-label="email-list"]')
  await expect(list).toBeVisible({ timeout: 20_000 })
  // Wait for the loading skeleton to clear (className contains animate-pulse
  // with "Loading…" text per EmailList.tsx).
  await expect(list.locator('text=/Loading…/').first()).toHaveCount(0, { timeout: 20_000 })
  // After load, one of these is true: there are rows OR there is the empty
  // state. A render where neither is present means the query crashed.
  const hasRows = await list
    .locator('button[type="button"]')
    .first()
    .isVisible()
    .catch(() => false)
  const hasEmptyState = await list
    .locator('text=没有可显示的内容')
    .isVisible()
    .catch(() => false)
  const hasError = await list
    .locator('.text-fail')
    .isVisible()
    .catch(() => false)
  expect(hasError, 'EmailList rendered the error pane — IPC likely failed').toBe(false)
  expect(hasRows || hasEmptyState, 'EmailList rendered neither rows nor empty state').toBe(true)
})

test('③ ⌘K opens command palette', async () => {
  await expect(win.locator('[aria-label="email-list"]')).toBeVisible({ timeout: 20_000 })
  await win.keyboard.press('Meta+K')
  // dialog aria-label comes from t('palette.aria.label') — zh default is
  // "命令面板". The smoke runs against whatever locale the user last set;
  // accept either spelling.
  const dialog = win.locator('[role="dialog"]').filter({
    has: win.locator('input[role="combobox"]')
  })
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await win.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })
})
