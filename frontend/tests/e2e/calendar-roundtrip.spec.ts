// 阶段 3·3.3 (#8) — 日历面 Playwright electron 冒烟 + 真日历 roundtrip。
//
// 日历面是 2026-05 mockup 复刻交付后从未进过 e2e 网的面。这里补两层验证:
//
//   ①【UI smoke — 默认跑】驱动打包 .app, 对真实 userData DB 做数据韧性冒烟:
//      日历面可达 / 5 视图切换渲染 / 事件点击开抽屉 + Esc 关 / 键盘巡航
//      (G 前缀视图 · T · ←→ · n 新建 · j/k 锚点 · Enter 开抽屉) / RSVP 确认卡
//      开+取消 (绝不真发 iTIP REPLY) / 邮件详情 MeetingInviteCard「在日历中查看」跳转。
//      —— 本仓 e2e fixture (electron-fixture.ts) 无 seed 注入机制, 既有 smoke/
//      screenshots 同样对真实 DB 跑 (screenshots.spec.ts ②「rows OR empty-state」),
//      故所有依赖具体事件的用例走**数据韧性**: 找不到事件/邀请就 test.skip 并给
//      清晰理由 (owner 生产装机 CALENDAR_CALDAV_SYNC_ENABLED=true, dogfood 跑时
//      真日历有事件, 这些用例才真正被行使)。结构型用例 (导航/视图切换/help modal/
//      新建表单开合) 不依赖数据, 恒定跑。
//
//   ②【真日历 roundtrip — env-gated, 默认 skip】CAL_E2E_LIVE==='1' 才跑:
//      经新建表单真写 Exchange (CalDAV PUT) → 出现在视图 → 抽屉删除 → 消失。
//      SUMMARY 用与 Lane B (#9 scripts/dev harness) 同款前缀约定 `[MailAgent 测试] `
//      便于人工辨识 + finally 清理。UID 前缀 `mailagent-caltest-` 是 Lane B 直连
//      CalDAV harness 的域 (UI 新建的 UID 由后端生成, 这里凭唯一 SUMMARY 定位)。
//      默认 CI/本地全 skip, 保护真日历不被误建。
//
// selector 纪律: 优先 role/aria/结构型 class (main[aria-label="calendar"] /
// [data-ui-drawer] / role=tab / role=dialog), 视图根用稳定结构 class
// (.cal-week/.cal-month/.cal-agenda), 不依赖易碎的视觉 class。
// 文本 selector 前统一 setLocale('zh-CN') 锁定语言。每个用例独立可重跑
// (beforeEach 冷启 .app, afterEach close)。零新依赖。

import { test, expect, type Page, type Locator } from '@playwright/test'
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

// ── 导航 / 视图 helpers ─────────────────────────────────────────────

/** 冷启后导航到日历面。setLocale('zh-CN') 锁定文本 selector 语言 (顺带 reload
 *  回到 inbox), 再点侧栏「日历」NavRow (aside[aria-label="primary"] 内唯一),
 *  等 main[aria-label="calendar"] 就位。默认 week 视图。 */
async function gotoCalendar(page: Page): Promise<void> {
  await setLocale(page, 'zh-CN')
  await page.locator('[aria-label="email-list"]').waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator('aside[aria-label="primary"]').getByRole('button', { name: '日历' }).click()
  await page.locator('main[aria-label="calendar"]').waitFor({ state: 'visible', timeout: 15_000 })
}

/** 日历工具栏视图切换 tab 列 (顺序固定 today/week/month/agenda/recurring)。 */
function viewTabs(page: Page): Locator {
  return page.locator('main[aria-label="calendar"] [role="tablist"] [role="tab"]')
}

/** 切到指定视图 (点 tab) 并断言 tab 选中。 */
async function switchView(page: Page, index: number): Promise<void> {
  const tab = viewTabs(page).nth(index)
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}

// 视图 tab 索引 + 各视图恒定根 (loading/empty/error/content 全分支共用)。
// day 与 week 自 dogfood 轮 2 起共用 TimelineView (dayCount 1/7), 根都是 .cal-week
// —— 「进的是哪个视图」由 switchView 里的 aria-selected 断言承担。
const VIEW = { day: 0, week: 1, month: 2, agenda: 3, recurring: 4 } as const
const VIEW_ROOT: Record<'day' | 'week' | 'month' | 'agenda', string> = {
  day: '.cal-week',
  week: '.cal-week',
  month: '.cal-month',
  agenda: '.cal-agenda'
}

/** 数据韧性事件源: 切到 agenda (未来 14 天平铺列表 .ag-row, 最易命中事件),
 *  返回首个可点事件 Locator 或 null (无事件)。 */
async function firstAgendaEvent(page: Page): Promise<Locator | null> {
  await switchView(page, VIEW.agenda)
  await page.locator('.cal-agenda').waitFor({ state: 'visible', timeout: 10_000 })
  // agenda 首帧可能 skeleton/empty, 给数据落定一点时间。
  await page.waitForTimeout(600)
  const rows = page.locator('.cal-agenda .ag-row')
  const count = await rows.count().catch(() => 0)
  return count > 0 ? rows.first() : null
}

// ─────────────────────────────────────────────────────────────────────
// ① UI smoke — 默认跑
// ─────────────────────────────────────────────────────────────────────

test('日历面可达 — 侧栏进入, 工具栏渲染', async () => {
  await gotoCalendar(win)
  // 工具栏标题 h1「日历」+ 视图 tablist 就位 = 面挂载成功 (非 NotFound 白屏)。
  await expect(
    win.locator('main[aria-label="calendar"]').getByRole('heading', { level: 1 })
  ).toBeVisible()
  await expect(viewTabs(win)).toHaveCount(5)
  await expect(win.locator('text=Not Found')).toHaveCount(0)
})

test('5 视图切换均渲染各自根结构', async () => {
  await gotoCalendar(win)
  // day / week / month / agenda — 稳定根 class (每视图 loading/empty/error/
  // content 全分支共用该根, 不依赖是否有事件)。
  for (const key of ['day', 'week', 'month', 'agenda'] as const) {
    await switchView(win, VIEW[key])
    await expect(win.locator(VIEW_ROOT[key])).toBeVisible({ timeout: 10_000 })
  }
  // recurring (定期邀请表) — 根含固定 range chip「90d」按钮 (恒渲染, 与数据无关)。
  await switchView(win, VIEW.recurring)
  await expect(
    win.locator('main[aria-label="calendar"]').getByRole('button', { name: '90d' })
  ).toBeVisible({ timeout: 10_000 })
})

test('键盘: G 前缀切视图 + T 今天 + ←→ 步进不崩', async () => {
  await gotoCalendar(win)
  // G+M → 月 (tab index 2 选中)。keyboard.press 快于 G 前缀 800ms 窗口。
  await win.keyboard.press('g')
  await win.keyboard.press('m')
  await expect(viewTabs(win).nth(VIEW.month)).toHaveAttribute('aria-selected', 'true')

  // 月视图 range label = "{y} 年 {m} 月"; → 步进换月 → 标签变。label 是 h1 的
  // 相邻 sibling span (工具栏标题区)。
  const rangeLabel = win
    .locator('main[aria-label="calendar"] h1')
    .locator('xpath=following-sibling::span[1]')
  const before = (await rangeLabel.textContent())?.trim() ?? ''
  await win.keyboard.press('ArrowRight')
  await expect(rangeLabel).not.toHaveText(before, { timeout: 5_000 })
  // ← 回到原月。
  await win.keyboard.press('ArrowLeft')
  await expect(rangeLabel).toHaveText(before, { timeout: 5_000 })

  // G+W → 周; T → 今天 (不崩, 周视图仍在)。
  await win.keyboard.press('g')
  await win.keyboard.press('w')
  await expect(viewTabs(win).nth(VIEW.week)).toHaveAttribute('aria-selected', 'true')
  await win.keyboard.press('t')
  await expect(win.locator('.cal-week')).toBeVisible()
})

test('键盘: n 开新建事件表单, Esc 关闭', async () => {
  await gotoCalendar(win)
  // 桌面构建 IS_WEB_BUILD=false → n 快捷键接 handleNewEvent。EventFormModal
  // role=dialog aria-labelledby=efm-title (标题「新建事件」)。
  await win.keyboard.press('n')
  const modal = win.locator('.efm-modal[role="dialog"]')
  await expect(modal).toBeVisible({ timeout: 5_000 })
  await expect(modal.locator('#efm-title')).toBeVisible()
  // Esc 关 (表单 title input 已 autofocus, 走 modal 自身 Esc handler)。
  await win.keyboard.press('Escape')
  await expect(modal).not.toBeVisible({ timeout: 5_000 })
})

test('事件点击开抽屉, Esc 关闭 (数据韧性)', async () => {
  await gotoCalendar(win)
  const ev = await firstAgendaEvent(win)
  test.skip(
    ev === null,
    '真实 DB agenda 未来 14 天无事件 — 数据韧性跳过 (dogfood 真日历有事件时行使)'
  )
  await ev!.click()
  // Drawer 打开 = [data-ui-drawer] 就位 + .dw-title 有内容。
  const drawer = win.locator('[data-ui-drawer]')
  await expect(drawer).toBeVisible({ timeout: 5_000 })
  await expect(drawer.locator('.dw-title')).toBeVisible()
  await win.keyboard.press('Escape')
  await expect(drawer).not.toBeVisible({ timeout: 5_000 })
})

test('键盘: j 移动选中锚点, Enter 开抽屉 (数据韧性)', async () => {
  await gotoCalendar(win)
  const ev = await firstAgendaEvent(win)
  test.skip(ev === null, '真实 DB agenda 无事件 — 数据韧性跳过')
  // j 只动锚点 (不开抽屉): 某行获得 .is-selected。
  await win.keyboard.press('j')
  await expect(win.locator('.cal-agenda .ag-row.is-selected')).toHaveCount(1, { timeout: 5_000 })
  // Enter 把锚点提升为 active → 开抽屉。
  await win.keyboard.press('Enter')
  await expect(win.locator('[data-ui-drawer]')).toBeVisible({ timeout: 5_000 })
  await win.keyboard.press('Escape')
})

test('RSVP 确认卡: 打开后取消 — 绝不发送 iTIP REPLY (数据韧性)', async () => {
  await gotoCalendar(win)
  // 需要一个 attendee 事件 (非 owner) 的抽屉才有 .btn-rsvp。遍历 agenda 前若干
  // 事件找命中, 预算限制避免长跑; 找不到就跳过。
  const rows = win.locator('.cal-agenda .ag-row')
  await switchView(win, VIEW.agenda)
  await win.locator('.cal-agenda').waitFor({ state: 'visible', timeout: 10_000 })
  await win.waitForTimeout(600)
  const total = await rows.count().catch(() => 0)
  test.skip(total === 0, '真实 DB agenda 无事件 — 数据韧性跳过')

  const drawer = win.locator('[data-ui-drawer]')
  let rsvpBtn: Locator | null = null
  const budget = Math.min(total, 8)
  for (let i = 0; i < budget; i++) {
    await rows.nth(i).click()
    await expect(drawer).toBeVisible({ timeout: 5_000 })
    // dw-foot 的 RSVP 三键仅 attendee (非 owner) 事件渲染。
    const candidate = drawer.locator('.btn-rsvp').first()
    if (await candidate.isVisible().catch(() => false)) {
      rsvpBtn = candidate
      break
    }
    await win.keyboard.press('Escape')
    await expect(drawer).not.toBeVisible({ timeout: 5_000 })
  }
  test.skip(
    rsvpBtn === null,
    '真实 DB 前 8 个事件均无 attendee RSVP 键 (全 owner 事件) — 数据韧性跳过'
  )

  // 点「接受」→ 确认卡 (role=dialog aria-labelledby=cal-rsvp-confirm-title) 出现。
  await rsvpBtn!.click()
  const confirm = win.locator('[role="dialog"][aria-labelledby="cal-rsvp-confirm-title"]')
  await expect(confirm).toBeVisible({ timeout: 5_000 })
  // 🔴 只点「取消」(btn-ghost), 绝不点「发送回复」—— 不可撤回的 SMTP iTIP REPLY。
  await confirm.getByRole('button', { name: '取消' }).click()
  await expect(confirm).not.toBeVisible({ timeout: 5_000 })
  // 抽屉仍在 (取消不关抽屉), 证明无副作用发出。
  await expect(drawer).toBeVisible()
})

test('邮件详情 MeetingInviteCard「在日历中查看」跳日历面 (数据韧性/降级)', async () => {
  // seed 面做不到 (fixture 无 SQLite 注入): 降级为遍历 inbox 前若干邮件找带
  // email_meeting 映射的会议邮件 (其详情渲染 .cal-invite 会议邀请卡), 命中则测
  // 「在日历中查看」跳转; 找不到就跳过 (dogfood 选中真会议邮件时行使)。
  await setLocale(win, 'zh-CN')
  const list = win.locator('[aria-label="email-list"]')
  await expect(list).toBeVisible({ timeout: 20_000 })
  await expect(list.locator('text=/Loading…/').first()).toHaveCount(0, { timeout: 20_000 })

  const rows = list.locator('button[type="button"]')
  const total = await rows.count().catch(() => 0)
  test.skip(total === 0, 'inbox 无邮件 — 数据韧性跳过')

  const invite = win.locator('section.cal-invite[aria-label="会议邀请"]')
  let hit = false
  const budget = Math.min(total, 8)
  for (let i = 0; i < budget; i++) {
    const txt = await rows
      .nth(i)
      .textContent()
      .catch(() => '')
    // FilterChip (Unread/Flagged/…) 非邮件行, 跳过。
    if (txt && ['Unread', 'Flagged', 'Failed', 'Latest'].some((s) => txt.includes(s))) continue
    await rows
      .nth(i)
      .click()
      .catch(() => {})
    await win.waitForTimeout(500)
    if (await invite.isVisible().catch(() => false)) {
      hit = true
      break
    }
  }
  test.skip(!hit, 'inbox 前 8 封无会议邀请卡 (无 email_meeting 映射邮件) — 数据韧性/降级跳过')

  // 点「在日历中查看」→ 应用内导航 (F13 教训: 禁 <a href> 真导航) → 落日历面。
  await invite.getByRole('button', { name: '在日历中查看' }).click()
  await expect(win.locator('main[aria-label="calendar"]')).toBeVisible({ timeout: 10_000 })
  await expect(win.locator('text=Not Found')).toHaveCount(0)
})

// ─────────────────────────────────────────────────────────────────────
// ② 真日历 roundtrip — env-gated (CAL_E2E_LIVE=1), 默认 skip
// ─────────────────────────────────────────────────────────────────────

test('真日历 roundtrip: 新建 → 出现 → 删除 → 消失 (CAL_E2E_LIVE)', async () => {
  test.skip(
    process.env.CAL_E2E_LIVE !== '1',
    '真日历写测试默认 skip — 设 CAL_E2E_LIVE=1 且授权后才跑 (D5); 新建走 CalDAV PUT 真写 Exchange'
  )

  // SUMMARY 唯一前缀 (Lane B #9 harness 同款): 便于人工辨识 + 定位 + finally 清理。
  const summary = `[MailAgent 测试] roundtrip ${Date.now()}`
  await gotoCalendar(win)

  const drawer = win.locator('[data-ui-drawer]')
  let created = false
  try {
    // ── 新建: n 开表单 → 填标题 → 保存 (CalDAV PUT) ──
    await win.keyboard.press('n')
    const modal = win.locator('.efm-modal[role="dialog"]')
    await expect(modal).toBeVisible({ timeout: 5_000 })
    await modal.locator('#ef-title').fill(summary)
    // 保存/创建: efm-foot 主按钮 .btn-primary (create 态文案「创建」, 用 class
    // 避开 创建/创建中 文案切换) → handleSubmit → CalDAV PUT。
    await modal.locator('.efm-foot .btn-primary').click()
    await expect(modal).not.toBeVisible({ timeout: 15_000 })
    created = true

    // ── 出现: agenda 视图应能查到该唯一 SUMMARY 行 (worker 事件桥/轮询秒级可见) ──
    await switchView(win, VIEW.agenda)
    const row = win.locator('.cal-agenda .ag-row', { hasText: summary })
    await expect(row).toBeVisible({ timeout: 20_000 })

    // ── 删除: 开抽屉 → 删除 → 5s undo toast → 提交后消失 ──
    await row.click()
    await expect(drawer).toBeVisible({ timeout: 5_000 })
    await drawer.locator('.btn-op.delete').click()
    // 删除关抽屉 + push undo toast; 等 undo 窗口 (5s) 过, 事件真 CalDAV DELETE。
    await expect(drawer).not.toBeVisible({ timeout: 5_000 })
    await expect(win.locator('.cal-agenda .ag-row', { hasText: summary })).toHaveCount(0, {
      timeout: 20_000
    })
    created = false
  } finally {
    // best-effort 清理: 若中途失败仍留着测试事件, 尝试再删一次 (UI 路径)。
    // Lane B (#9) scripts/dev harness 持权威 CalDAV 直连清理 (按 UID 前缀), 此处
    // 仅 UI 兜底避免 roundtrip 中断留垃圾。
    if (created) {
      const leftover = win.locator('.cal-agenda .ag-row', { hasText: summary })
      if (
        await leftover
          .first()
          .isVisible()
          .catch(() => false)
      ) {
        await leftover
          .first()
          .click()
          .catch(() => {})
        await drawer
          .locator('.btn-op.delete')
          .click({ timeout: 3_000 })
          .catch(() => {})
        await win.waitForTimeout(6_000)
      }
    }
  }
})
