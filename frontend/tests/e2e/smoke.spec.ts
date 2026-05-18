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
//   ④ ⌘L AI Chat panel target visible
//   ⑤ Locale switch zh-CN → en-US flips QuickActions chip text
//   ⑥ Settings → 灵动岛 testConnection → connected (Sprint 10 §2.5.4-D)

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
  const hasRows = await list.locator('button[type="button"]').first().isVisible().catch(() => false)
  const hasEmptyState = await list.locator('text=没有可显示的内容').isVisible().catch(() => false)
  const hasError = await list.locator('.text-fail').isVisible().catch(() => false)
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

test('④ ⌘L toggles AI Chat panel visibility', async () => {
  // Sprint 10 user-acceptance — AIChatPanel is no longer always-mounted.
  // ⌘L (and the toolbar Bot button) toggle visibility; default is hidden
  // so EmailDetail gets the full right pane.
  await expect(win.locator('[aria-label="email-list"]')).toBeVisible({ timeout: 20_000 })
  const panel = win.locator('aside[aria-label="ai-chat-panel"]')
  // Hidden by default
  await expect(panel).toHaveCount(0)
  // Toggle on
  await win.keyboard.press('Meta+L')
  await expect(panel).toBeVisible({ timeout: 5_000 })
  // Toggle off
  await win.keyboard.press('Meta+L')
  await expect(panel).toHaveCount(0, { timeout: 5_000 })
})

test('⑤ locale switch flips QuickActions chip from "总结" to "Summarize"', async () => {
  // Defends Sprint 10 (d) i18n polish — `chat.quickActions.summarize` and
  // `chat.quickActions.summarizePrompt` must both be wired to i18n keys so
  // EN users get an English chip label AND an English prompt body.
  await expect(win.locator('[aria-label="email-list"]')).toBeVisible({ timeout: 20_000 })

  // Sprint 10 user-acceptance — QuickActions live inside AIChatPanel which
  // is now hidden by default. Open the panel via ⌘L before asserting on
  // chip text.
  await win.keyboard.press('Meta+L')
  await win
    .locator('aside[aria-label="ai-chat-panel"]')
    .waitFor({ state: 'visible', timeout: 5_000 })

  // Baseline zh-CN: chip text is "总结".
  await expect(win.locator('button:has-text("总结")').first()).toBeVisible({ timeout: 5_000 })

  // Switch to EN and re-init the renderer.
  await setLocale(win, 'en-US')
  await expect(win.locator('[aria-label="email-list"]')).toBeVisible({ timeout: 20_000 })

  // Re-open the panel (reload reset zustand state).
  await win.keyboard.press('Meta+L')
  await win
    .locator('aside[aria-label="ai-chat-panel"]')
    .waitFor({ state: 'visible', timeout: 5_000 })

  // After switch: EN chip must appear, zh chip must be gone.
  await expect(win.locator('button:has-text("Summarize")').first()).toBeVisible({
    timeout: 8_000
  })
  await expect(win.locator('button:has-text("总结")')).toHaveCount(0, { timeout: 5_000 })

  // Restore zh-CN so subsequent specs start clean.
  await setLocale(win, 'zh-CN')
})

test('⑥ Settings → Island testConnection → connected (ping-island live)', async () => {
  // Requires /tmp/island.sock to exist and ping-island.app to be running.
  // Per Sprint 10 §6.1 environment-prereq: this smoke is meaningful only
  // when the env passes the precheck; otherwise we skip (env-dependent,
  // not a code regression).
  await expect(win.locator('[aria-label="email-list"]')).toBeVisible({ timeout: 20_000 })

  // Sprint 10 user-acceptance — use the ⌘, shortcut for a locale-agnostic
  // navigation. Palette substring matching ("设置" vs "Settings") was
  // brittle when prior specs left the locale as en-US.
  await win.keyboard.press('Meta+,')

  // Settings page mounts a heading with i18n `settings.title` =
  // "设置" / "Settings". Wait until the Island section heading is on-screen.
  const islandHeading = win.locator(
    'text=/灵动岛集成|Dynamic Island integration/'
  )
  await expect(islandHeading).toBeVisible({ timeout: 10_000 })

  // Click "测试连接" / "Test connection". Match exact button text — the
  // hint phrasing nearby contains the same substring.
  const testBtn = win.locator(
    'button:has-text("测试连接"), button:has-text("Test connection")'
  ).first()
  await testBtn.click()

  // Pill should turn green = "已连接" / "Connected" within ~2s if
  // ping-island is alive. Allow up to 8s for cold socket connect.
  const connectedPill = win.locator('text=/已连接|^Connected$/').first()
  await expect(connectedPill).toBeVisible({ timeout: 8_000 })
})
