// Visual + interaction sanity sweep — drives the packaged .app through the
// core UI states a user touches in the first 5 minutes, saves a PNG per
// state, and runs axe-core a11y scans on the heavy pages so the human
// reviewer can audit by eye AND catch the standard objective issues
// (contrast / aria / focus).
//
// Output: tests/e2e/screenshots/*.png — committed gitignore'd, refreshed
// on every run.

import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { launchApp, setLocale } from './electron-fixture'
import type { ElectronApplication } from 'playwright'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const SHOTS_DIR = path.join(__dirname, 'screenshots')
const A11Y_DIR = path.join(__dirname, 'a11y-reports')

let app: ElectronApplication
let win: Page

test.beforeAll(async () => {
  await fs.mkdir(SHOTS_DIR, { recursive: true })
  await fs.mkdir(A11Y_DIR, { recursive: true })
})

test.beforeEach(async () => {
  ;({ app, win } = await launchApp())
  // Wait for EmailList to confirm renderer settled, so screenshots aren't
  // of the blank pre-hydration window.
  await win.locator('[aria-label="email-list"]').waitFor({ state: 'visible', timeout: 20_000 })
})

test.afterEach(async () => {
  await app.close()
})

async function snap(win: Page, name: string, opts: { fullPage?: boolean } = {}): Promise<void> {
  await win.screenshot({
    path: path.join(SHOTS_DIR, `${name}.png`),
    fullPage: opts.fullPage ?? false,
    type: 'png'
  })
}

async function openSettings(win: Page): Promise<void> {
  // ⌘, navigates to /settings directly — locale-agnostic and avoids palette
  // string-matching fragility (the EN palette nav reads "Go · Settings",
  // the zh one reads "前往 · 设置"; a single keystroke skips both).
  await win.keyboard.press('Meta+,')
  // Settings is a tabbed SettingsShell (S18+), not the old single long-scroll
  // page — ⌘, always lands on the `general` tab. Wait on structural anchors
  // (PageFrame <main> + 设置域二级栏) which are tab/locale-agnostic; the previous
  // "灵动岛集成" heading only exists inside the non-default island tab, so it
  // never appears here and timed out. 节导航住在域二级栏（设置页自己不出 tab 条）。
  await win.locator('main[aria-label="settings"]').waitFor({ state: 'visible', timeout: 10_000 })
  await win.locator('[data-nav-panel]').waitFor({ state: 'visible', timeout: 10_000 })
}

test('01 inbox-zh-default', async () => {
  await snap(win, '01-inbox-zh-default')
})

test('02 inbox-with-detail-open', async () => {
  const firstRow = win.locator('[aria-label="email-list"] button[type="button"]').nth(3)
  // FilterChip buttons are first 3; row 3+ should be an actual email row if
  // there's content. Click whichever first visible row works.
  for (let i = 0; i < 10; i++) {
    const btn = win.locator('[aria-label="email-list"] button[type="button"]').nth(i)
    const txt = await btn.textContent().catch(() => '')
    if (txt && !['Unread', 'Flagged', 'Failed', 'Latest'].some((s) => txt.includes(s))) {
      await btn.click().catch(() => {})
      break
    }
  }
  await win.waitForTimeout(800)
  await snap(win, '02-inbox-with-detail')
})

test('03 command-palette-open', async () => {
  await win.keyboard.press('Meta+K')
  await win
    .locator('[role="dialog"]')
    .filter({ has: win.locator('input[role="combobox"]') })
    .waitFor({ state: 'visible', timeout: 5_000 })
  await win.waitForTimeout(300)
  await snap(win, '03-command-palette')
})

test('04 command-palette-with-typed-query', async () => {
  await win.keyboard.press('Meta+K')
  const palette = win
    .locator('[role="dialog"]')
    .filter({ has: win.locator('input[role="combobox"]') })
  await palette.waitFor({ state: 'visible', timeout: 5_000 })
  await palette.locator('input[role="combobox"]').fill('meeting')
  await win.waitForTimeout(500)
  await snap(win, '04-command-palette-search')
})

test('05 settings-top', async () => {
  await openSettings(win)
  // ⌘, lands on the `general` tab (appearance area: accent / language / theme /
  // material / glass). The old single-page "Appearance / Inbox / AI backends in
  // one viewport" no longer holds post rail 化 — Inbox/AI are now separate tabs.
  // This shot captures the general tab's real top content; the narrowed scope is
  // the expected rail 化 result, not a regression.
  await win.evaluate(() => window.scrollTo(0, 0))
  await win.waitForTimeout(200)
  await snap(win, '05-settings-top')
})

test('06 settings-full-page', async () => {
  await openSettings(win)
  await win.evaluate(() => window.scrollTo(0, 0))
  await snap(win, '06-settings-full', { fullPage: true })
})

test('07 settings-island-section', async () => {
  await openSettings(win)
  // openSettings lands on the general tab; the "灵动岛集成" section lives inside
  // the island tab's IslandSubsection. Radix TabsContent has no forceMount, so a
  // non-active tab's content is absent from the DOM — click the rail's island tab
  // first, then wait for its TabsContent to mount + GSAP autoAlpha fade to settle.
  await win.getByRole('tab', { name: /灵动岛与更新|Island & Updates/ }).click()
  await win
    .locator('text=/灵动岛集成|Dynamic Island integration/')
    .waitFor({ state: 'visible', timeout: 10_000 })
  await win.locator('text=/灵动岛集成|Dynamic Island integration/').scrollIntoViewIfNeeded()
  await win.waitForTimeout(200)
  await snap(win, '07-settings-island')
})

test('08 inbox-en-locale', async () => {
  await setLocale(win, 'en-US')
  await win.locator('[aria-label="email-list"]').waitFor({ state: 'visible', timeout: 20_000 })
  await win.waitForTimeout(400)
  await snap(win, '08-inbox-en')
  await setLocale(win, 'zh-CN')
})

test('09 settings-en-locale', async () => {
  await setLocale(win, 'en-US')
  await win.locator('[aria-label="email-list"]').waitFor({ state: 'visible', timeout: 20_000 })
  await openSettings(win)
  await win.evaluate(() => window.scrollTo(0, 0))
  await win.waitForTimeout(200)
  await snap(win, '09-settings-en')
  await setLocale(win, 'zh-CN')
})

test('10a inbox-ai-modal-open', async () => {
  // ⌘L AiChatPanel was retired in S3 (07-02, legacy harness deletion) — the main
  // window's AI surface is now the ⌘J AssistantChatModal (mirrors the W5 debt noted
  // in smoke.spec.ts's header). Rewritten 2026-07-11 from ⌘L AiChatPanel → ⌘J modal.
  // Select an email first (same row-picking loop as 02) so the modal carries email
  // context, making the screenshot meaningful.
  for (let i = 0; i < 10; i++) {
    const btn = win.locator('[aria-label="email-list"] button[type="button"]').nth(i)
    const txt = await btn.textContent().catch(() => '')
    if (txt && !['Unread', 'Flagged', 'Failed', 'Latest'].some((s) => txt.includes(s))) {
      await btn.click().catch(() => {})
      break
    }
  }
  await win.keyboard.press('Meta+J')
  // AssistantChatModal toggles visibility via CSS class (not mount/unmount after the
  // first open), so assert on visibility rather than mere presence.
  await win
    .getByRole('dialog', { name: /AI 对话|AI chat/ })
    .waitFor({ state: 'visible', timeout: 5_000 })
  await win.waitForTimeout(400)
  await snap(win, '10a-inbox-ai-modal')
})

test('10b llm-dashboard', async () => {
  await win.keyboard.press('Meta+K')
  const palette = win
    .locator('[role="dialog"]')
    .filter({ has: win.locator('input[role="combobox"]') })
  await palette.waitFor({ state: 'visible', timeout: 5_000 })
  await palette.locator('input[role="combobox"]').fill('LLM')
  await palette.locator('[role="option"]').first().waitFor({ state: 'visible', timeout: 5_000 })
  await win.keyboard.press('Enter')
  await win.waitForTimeout(1_500)
  await snap(win, '10b-llm-dashboard')
})

test('10c admin-page', async () => {
  await win.keyboard.press('Meta+K')
  const palette = win
    .locator('[role="dialog"]')
    .filter({ has: win.locator('input[role="combobox"]') })
  await palette.waitFor({ state: 'visible', timeout: 5_000 })
  await palette.locator('input[role="combobox"]').fill('看板')
  await palette.locator('[role="option"]').first().waitFor({ state: 'visible', timeout: 5_000 })
  await win.keyboard.press('Enter')
  await win.waitForTimeout(1_500)
  await snap(win, '10c-admin')
})

test('10d inbox-flagged-filter', async () => {
  // Sidebar 已标旗 entry → should switch EmailList filter
  const flaggedItem = win.locator('button:has-text("已标旗")').first()
  if (await flaggedItem.isVisible().catch(() => false)) {
    await flaggedItem.click()
    await win.waitForTimeout(600)
  }
  await snap(win, '10d-inbox-flagged-filter')
})

test('10 inbox-dark-mode', async () => {
  // Theme is persisted via the appearance store (localStorage). Force dark.
  await win.evaluate(() => {
    localStorage.setItem('mailagent.themeMode', 'dark')
  })
  await win.reload()
  await win.locator('[aria-label="email-list"]').waitFor({ state: 'visible', timeout: 20_000 })
  await win.waitForTimeout(400)
  await snap(win, '10-inbox-dark')
  await win.evaluate(() => {
    localStorage.setItem('mailagent.themeMode', 'system')
  })
})

// @axe-core/playwright's `analyze()` calls `browserContext.newPage()` to
// inject axe-core, which Electron's `BrowserWindow` doesn't expose
// (`Target.createTarget: Not supported`). The dequelabs upstream tracking
// issue is at @axe-core/playwright error-handling.md; until they ship a
// `--no-new-page` mode we rely on `pnpm a11y:contrast --strict` (CI gate)
// plus manual axe DevTools spot-checks. Skip so the smoke run stays green.
test.skip('11 a11y scan — inbox (skipped: axe-core needs newPage)', async () => {
  void AxeBuilder
  void A11Y_DIR
})

test.skip('12 a11y scan — settings (skipped: axe-core needs newPage)', async () => {
  void AxeBuilder
  void A11Y_DIR
})
