// env flag 可发现性批 Lane 2 — 回归钉子：Top 10 项的 14 个新受管键必须真的在
// MANAGED_ENV_KEYS 里（镜像三个 CalDAV 键的钉法，env_keys_ui_coverage.test.ts:191）。
//
// 为什么 subset 闸不够：ui_coverage 闸只保证「UI 用到的键 ⊆ 白名单」——谁把某个
// EnvField 控件删了，subset 闸平凡绿，而键可能同时掉出白名单，「设置项存不进去」
// 悄悄复活。这里按键逐个钉死。settings.py 的 _MANAGED_ENV_KEYS 镜像由
// tests/config/test_managed_env_keys_parity.py 对账 → 这 14 个键传递性地两侧都被钉住。
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { MANAGED_ENV_KEY_SET, SECRET_ENV_KEYS } from '../../src/electron/main/lib/env-keys'
import { __test__ as envHandler } from '../../src/electron/main/handlers/env'
import { refreshEnvPath } from '../../src/electron/main/lib/env-path'

/** Lane 2 最终清单（team-lead 2026-07-27 修订版，naive-user 基准重判后）。
 *  撤下 DAVMAIL_ROOT / FOLDER_NOTIFY_ENABLED / FOLDER_LLM_DISABLED（「env 输入框」
 *  是错解，正解形态排后续版本——见 env-keys.ts 同位注释）；追加岛外观两键。 */
const LANE2_MANAGED_KEYS = [
  'ISLAND_MAIL_NOTIFY_SCOPE', // #1 灵动岛邮件弹卡范围
  'KOS_REQUIRE_LABELED', // #2 仅推已标注
  'KOS_INGEST_PRIORITY_FLOOR', // #3 入库重要度门槛（与 #2 是同一决策的两半）
  'CALENDAR_REMINDER_LEAD_MINUTES', // #4 会前提醒提前量
  'MAILAGENT_MEM0_CAPTURE', // #5 自动记忆
  'MAILAGENT_MEM0_RETRIEVAL', // #5 记忆注入
  'KEEP_ALIVE_ENABLED', // #6 防休眠保活
  'KEEP_ALIVE_DIM', // #6 保活调暗屏幕
  'MAILAGENT_ATTACHMENT_OCR_ENABLED', // #7 附件 OCR
  'MAILAGENT_DAILY_DIGEST_HOURS', // #8 巡检钟点
  'MAILAGENT_REPORT_AGENT_ENABLED', // #9 报告服务总闸
  'ISLAND_ACCENT', // #10 岛主题色（六选一）
  'ISLAND_THEME' // #10 岛明暗
] as const

/** 修订时撤下的三键 —— 必须**不在**白名单（防止有人从旧 diff 把它们捞回来）。 */
const LANE2_WITHDRAWN_KEYS = [
  'DAVMAIL_ROOT',
  'FOLDER_NOTIFY_ENABLED',
  'FOLDER_LLM_DISABLED'
] as const

describe('Lane 2 十项的受管键（渲染了就必须存得进去）', () => {
  test.each(LANE2_MANAGED_KEYS)('%s ∈ MANAGED_ENV_KEYS', (key) => {
    expect(
      MANAGED_ENV_KEY_SET.has(key),
      `${key} 掉出 MANAGED_ENV_KEYS —— 对应设置控件在桌面 App 上读回空 / 保存抛 E_INVALID_KEY`
    ).toBe(true)
  })

  test('这 13 个键都不是 secret（全是普通开关 / 枚举 / 文本，不该被脱敏成 ***）', () => {
    const wronglySecret = LANE2_MANAGED_KEYS.filter((k) => SECRET_ENV_KEYS.has(k))
    expect(wronglySecret).toEqual([])
  })

  test.each(LANE2_WITHDRAWN_KEYS)('%s 已撤下，不在 MANAGED_ENV_KEYS', (key) => {
    expect(
      MANAGED_ENV_KEY_SET.has(key),
      `${key} 出现在 MANAGED_ENV_KEYS —— 该键在 2026-07-27 清单修订中被撤下（错解形态），勿从旧 diff 捞回`
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 真实写盘抽查（prd 验收第 4 条「真的能存进 .env，不是只渲染出来」的自动化形态）
// —— 走 env:set 的**同一条**代码路径 writePatch（tmp .env + MAILAGENT_ENV_FILE
// 覆盖，harness 抄 handlers_env.test.ts）。抽三种代表形态：枚举 select / 布尔
// toggle / 逗号列表文本（digest 钟点）。
// ---------------------------------------------------------------------------

describe('Lane 2 抽查：新键经 env:set 真实落盘', () => {
  let dir: string
  let envPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mailagent-lane2-env-'))
    envPath = join(dir, '.env')
    writeFileSync(envPath, '# lane2 fixture\nUSER_EMAIL=probe@test.local\n', 'utf8')
    process.env.MAILAGENT_ENV_FILE = envPath
    refreshEnvPath()
  })

  afterEach(() => {
    delete process.env.MAILAGENT_ENV_FILE
    refreshEnvPath()
    rmSync(dir, { recursive: true, force: true })
    // writePatch 成功后会把 changedKeys 同步进 process.env（blocker A 语义）——
    // 清掉抽查残留，别泄漏进后续测试。
    delete process.env.ISLAND_MAIL_NOTIFY_SCOPE
    delete process.env.KOS_REQUIRE_LABELED
    delete process.env.MAILAGENT_DAILY_DIGEST_HOURS
  })

  test('枚举 / 布尔 / 逗号列表三形态：写入成功 + 落盘 + 快照读回', () => {
    const result = envHandler.writePatch({
      ISLAND_MAIL_NOTIFY_SCOPE: 'all',
      KOS_REQUIRE_LABELED: 'true',
      MAILAGENT_DAILY_DIGEST_HOURS: '9,18'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changedKeys.sort()).toEqual([
      'ISLAND_MAIL_NOTIFY_SCOPE',
      'KOS_REQUIRE_LABELED',
      'MAILAGENT_DAILY_DIGEST_HOURS'
    ])
    expect(result.restartRequired).toBe(true)

    const text = readFileSync(envPath, 'utf8')
    expect(text).toContain('ISLAND_MAIL_NOTIFY_SCOPE=all')
    expect(text).toContain('KOS_REQUIRE_LABELED=true')
    expect(text).toContain('MAILAGENT_DAILY_DIGEST_HOURS=')

    // env:get 侧读回（受管过滤 + 非 secret 不脱敏 + parseEnv 解引号）——控件下次
    // 挂载显示的必须是已存值本身。
    const snap = envHandler.readSnapshot()
    expect(snap.values.ISLAND_MAIL_NOTIFY_SCOPE).toBe('all')
    expect(snap.values.KOS_REQUIRE_LABELED).toBe('true')
    expect(snap.values.MAILAGENT_DAILY_DIGEST_HOURS).toBe('9,18')
  })

  test('反向：白名单外的键仍被 E_INVALID_KEY 拒（抽查不是靠放松闸换来的）', () => {
    const result = envHandler.writePatch({ TOTALLY_UNMANAGED_LANE2_KEY: 'x' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('E_INVALID_KEY')
  })
})
