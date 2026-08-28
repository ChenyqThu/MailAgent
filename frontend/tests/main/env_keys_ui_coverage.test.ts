// 闸 (b) — 「UI 里读/写了某个 env 键, 但它不在 MANAGED_ENV_KEYS」→ 红。
//
// 真实 bug (2026-07-27 审计发现, 本批修): AccountsTab 渲染着三个 CalDAV 日历设置
// (`CALENDAR_CALDAV_SYNC_POLL_INTERVAL_SEC` / `_WINDOW_PAST_DAYS` / `_WINDOW_FUTURE_DAYS`),
// 后端 settings.py 白名单里有, 前端 env-keys.ts 白名单里**没有** → 桌面 App 上
// `env:get` 读回空 (显示不出已配的值)、`env:set` 抛 E_INVALID_KEY (点保存直接失败)。
// 远程 web 能改、桌面版不能改, 且**没有任何测试会红**。
//
// env-keys.ts 的头注释此前明说「反向检查 (env:set 拒绝没有 Tab UI 的键) 没有强制」——
// 但真正致命的是**正向**缺口: 渲染一个存不进去的输入框。本测试补的就是正向这半。
// 反向 (白名单有键但无 UI) 仍不强制: 白名单可以先行, UI 后落。
//
// 🔴 必须覆盖三条 UI 路径 —— 只查 `envKey=` 会漏 8 个键 (Agents 页 / 系统能力区 /
// 账户页 backend 切换走的是 `applyEnvPatch` 与 `snapshot.values` 直读):
//   1. `envKey="KEY"`            —— EnvField / EnvSecretField 声明式控件
//   2. `applyEnvPatch({KEY:...})` / `envPatch['KEY'] = ...`  —— 命令式写
//   3. `snapshot.values['KEY']` / `vals['KEY']`              —— 命令式读
// 三条路径的失效后果相同: env:get 过滤掉非受管键 ⇒ 读回 undefined; env:set 直接拒。
//
// 🔴 抽取失败必须红: 三个正则各自有 count 下限 + 一个「必须抽到」的具名键。抽取器因代码
// 风格变化而失效时集合会变空, 空集 ⊆ 白名单恒真 = 假绿 —— canary 让那一刻立刻红。
import { describe, expect, test } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, resolve } from 'path'

import { MANAGED_ENV_KEY_SET, READONLY_DISPLAY_KEYS } from '../../src/electron/main/lib/env-keys'

const HERE = dirname(fileURLToPath(import.meta.url))
// frontend/tests/main → frontend/src
const SRC_ROOT = resolve(HERE, '../../src')

interface UiEnvKeys {
  /** `envKey="KEY"` —— 声明式 EnvField / EnvSecretField。 */
  envField: Set<string>
  /** `applyEnvPatch({KEY:…})` / `<x>Patch['KEY'] = …` —— 命令式写。 */
  patchWrite: Set<string>
  /** `snapshot.values['KEY']` / `vals['KEY']` —— 命令式读。 */
  valueRead: Set<string>
}

/** `envKey=` 的**非**字符串字面量形态 (如 `envKey={someVar}`)。今天全仓为零; 一旦出现,
 *  上面的字面量抽取器就会静默漏掉那个键 —— 故单独报错而不是装看不见。 */
const DYNAMIC_ENV_KEY_RE = /envKey=(?!"[A-Z][A-Z0-9_]*")/g

const ENV_FIELD_RE = /envKey="([A-Z][A-Z0-9_]*)"/g
const APPLY_PATCH_RE = /applyEnvPatch\(\s*\{([^}]*)\}/gs
const PATCH_OBJ_KEY_RE = /['"]?([A-Z][A-Z0-9_]*)['"]?\s*:/g
const PATCH_ASSIGN_RE = /[A-Za-z_]*[Pp]atch\[\s*'([A-Z][A-Z0-9_]*)'\s*\]\s*=/g
const VALUE_READ_RE = /\b(?:vals|values)\[\s*'([A-Z][A-Z0-9_]*)'\s*\]/g

function collectUiEnvKeys(sources: Map<string, string>): UiEnvKeys {
  const out: UiEnvKeys = { envField: new Set(), patchWrite: new Set(), valueRead: new Set() }
  for (const text of sources.values()) {
    for (const m of text.matchAll(ENV_FIELD_RE)) out.envField.add(m[1])
    for (const patch of text.matchAll(APPLY_PATCH_RE)) {
      for (const k of patch[1].matchAll(PATCH_OBJ_KEY_RE)) out.patchWrite.add(k[1])
    }
    for (const m of text.matchAll(PATCH_ASSIGN_RE)) out.patchWrite.add(m[1])
    for (const m of text.matchAll(VALUE_READ_RE)) out.valueRead.add(m[1])
  }
  return out
}

/** 抽取器失效自检 —— 任一路径抽空 / 丢掉其锚点键即抛。见文件头「抽取失败必须红」。 */
function assertExtractorsAlive(keys: UiEnvKeys): void {
  const checks: Array<[string, Set<string>, number, string]> = [
    ['envKey="KEY"', keys.envField, 60, 'LOG_LEVEL'],
    ['applyEnvPatch / patch[…]=', keys.patchWrite, 5, 'MAILAGENT_BACKEND'],
    // 锚点原是 MAILAGENT_REMOTE_ACCESS_ENABLED（StatusBar 的 remote 段）——
    // 08-27 批 StatusBar 退役后换用多处直读、语义稳定的 LLM 总闸。
    ["snapshot.values['KEY']", keys.valueRead, 8, 'LLM_AGENT_ENABLED']
  ]
  for (const [label, set, floor, anchor] of checks) {
    if (set.size < floor) {
      throw new Error(
        `UI 路径「${label}」只抽到 ${set.size} 个键 (下限 ${floor}) —— 抽取器坏了。` +
          ` 空集 ⊆ 白名单恒真, 不修的话这道闸会变成假绿。`
      )
    }
    if (!set.has(anchor)) {
      throw new Error(
        `UI 路径「${label}」没抽到锚点键 ${anchor} —— 该路径的正则失效了 (或该使用点被删,` +
          ` 那就换一个锚点)。`
      )
    }
  }
}

/** 三条路径里出现、但不在受管集的键 → 「渲染了却存不进去」。真实断言与反向用例共用。 */
function unmanagedUsages(keys: UiEnvKeys, allowed: Set<string>): string[] {
  const out: string[] = []
  const lanes: Array<[string, Set<string>]> = [
    ['envKey=', keys.envField],
    ['applyEnvPatch', keys.patchWrite],
    ['snapshot.values', keys.valueRead]
  ]
  for (const [label, set] of lanes) {
    for (const key of [...set].sort()) {
      if (!allowed.has(key)) out.push(`${key} (经 ${label})`)
    }
  }
  return out
}

function readSources(root: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        walk(full)
      } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
        out.set(full, readFileSync(full, 'utf8'))
      }
    }
  }
  walk(root)
  return out
}

describe('env 键 UI 覆盖闸 (渲染了就必须存得进去)', () => {
  const sources = readSources(SRC_ROOT)
  const allowed = new Set<string>([...MANAGED_ENV_KEY_SET, ...READONLY_DISPLAY_KEYS])

  test('canary: 源文件扫得到 + 三条抽取路径都活着', () => {
    expect(
      sources.size,
      `frontend/src 下只扫到 ${sources.size} 个 ts/tsx —— 遍历坏了`
    ).toBeGreaterThan(200)
    expect(() => assertExtractorsAlive(collectUiEnvKeys(sources))).not.toThrow()
  })

  test('canary: 抽取器失效时本闸必红 (反向用例)', () => {
    // 三个路径全空 = 抽取器坏掉的样子。若没有这层自检, 下面的 subset 断言会平凡通过。
    const dead: UiEnvKeys = { envField: new Set(), patchWrite: new Set(), valueRead: new Set() }
    expect(() => assertExtractorsAlive(dead)).toThrow(/抽取器坏了/)
    // 只坏一条路径 (只查 envKey= 的旧写法) 同样要红 —— 这正是漏掉 8 个命令式键的形态。
    const onlyEnvField = collectUiEnvKeys(sources)
    onlyEnvField.patchWrite = new Set()
    onlyEnvField.valueRead = new Set()
    expect(() => assertExtractorsAlive(onlyEnvField)).toThrow(/applyEnvPatch/)
  })

  test('UI 里读/写的每个 env 键都在 MANAGED_ENV_KEYS (或只读展示集)', () => {
    const keys = collectUiEnvKeys(sources)
    assertExtractorsAlive(keys)
    const violations = unmanagedUsages(keys, allowed)

    expect(
      violations,
      '以下 env 键在 Settings UI 里被读/写, 但不在 MANAGED_ENV_KEYS —— 桌面 App 上 env:get\n' +
        '读回空、env:set 抛 E_INVALID_KEY (用户填了、点保存、失败或静默丢失):\n' +
        violations.map((v) => `  ${v}`).join('\n') +
        '\n→ 加进 frontend/src/electron/main/lib/env-keys.ts 的 MANAGED_ENV_KEYS,\n' +
        '  并**同步**加进后端 src/api/routers/settings.py 的 _MANAGED_ENV_KEYS\n' +
        '  (两份白名单由 tests/config/test_managed_env_keys_parity.py 对账)。'
    ).toEqual([])
  })

  test('反向用例: 新渲染一个未受管键 → 本闸红', () => {
    // 故意制造违规 —— 一个「渲染着但存不进去」的输入框, 三条路径各来一个。
    const synthetic = new Map<string, string>([
      ['fake/Tab.tsx', '<EnvField envKey="TOTALLY_UNMANAGED_KEY" control="text" />'],
      ['fake/Patch.tsx', "await applyEnvPatch({ ANOTHER_UNMANAGED_KEY: 'true' })"],
      ['fake/Read.tsx', "const v = snapshot.values['THIRD_UNMANAGED_KEY'] ?? ''"]
    ])
    // 用的是 `unmanagedUsages` —— 与上面真实断言同一个判定, 不是另写一份等价逻辑。
    expect(unmanagedUsages(collectUiEnvKeys(synthetic), allowed)).toEqual([
      'TOTALLY_UNMANAGED_KEY (经 envKey=)',
      'ANOTHER_UNMANAGED_KEY (经 applyEnvPatch)',
      'THIRD_UNMANAGED_KEY (经 snapshot.values)'
    ])
  })

  test('envKey 全是字符串字面量 (动态形态会让抽取器静默漏键)', () => {
    const dynamic: string[] = []
    for (const [path, text] of sources) {
      for (const _ of text.matchAll(DYNAMIC_ENV_KEY_RE)) {
        dynamic.push(path.slice(SRC_ROOT.length + 1))
      }
    }
    expect(
      [...new Set(dynamic)],
      '以下文件用了非字面量的 `envKey={…}` —— 上面的正则抽不到那个键, 本闸会对它静默失效。\n' +
        '→ 改回 `envKey="KEY"` 字面量, 或把抽取器扩展到能解析该形态。'
    ).toEqual([])
  })

  test('🔴 回归钉子: 三个 CalDAV 日历键真的受管 (桌面存得进去)', () => {
    // 没有这条, 上面的 subset 测试在「谁把 AccountsTab 那三个控件删了」时会平凡绿,
    // 而键仍可能从白名单里掉出去。
    for (const key of [
      'CALENDAR_CALDAV_SYNC_POLL_INTERVAL_SEC',
      'CALENDAR_CALDAV_SYNC_WINDOW_PAST_DAYS',
      'CALENDAR_CALDAV_SYNC_WINDOW_FUTURE_DAYS'
    ]) {
      expect(MANAGED_ENV_KEY_SET.has(key), `${key} 掉出 MANAGED_ENV_KEYS —— 桌面又存不进去了`).toBe(
        true
      )
    }
  })
})
