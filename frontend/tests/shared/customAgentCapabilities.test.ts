import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

import {
  CUSTOM_AGENT_CAPABILITY_TIERS,
  CUSTOM_AGENT_CAPABILITY_TOOL_SETS,
  applyCustomAgentCapabilityPatch,
  customAgentPolicyFromCapabilities,
  deriveCustomAgentCapabilities,
  isCustomAgentManagedTool,
  type CustomAgentCapabilityProfile
} from '../../src/shared/lib/customAgentCapabilities'
import {
  GATEWAY_LIBRARY_READ_TOOL_NAMES,
  GATEWAY_LIBRARY_WRITE_TOOL_NAMES
} from '../../src/shared/libraryConstants'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const AGENT_RUNS_PY = resolve(REPO_ROOT, 'src/api/routers/agent_runs.py')

type ToolCapabilityId = keyof typeof CUSTOM_AGENT_CAPABILITY_TOOL_SETS
const TOOL_CAPABILITIES = Object.keys(CUSTOM_AGENT_CAPABILITY_TOOL_SETS) as ToolCapabilityId[]

function tierTools(capability: ToolCapabilityId, tier: string): readonly string[] {
  const tiers = CUSTOM_AGENT_CAPABILITY_TOOL_SETS[capability] as Record<string, readonly string[]>
  return tiers[tier] ?? []
}

function managedTools(capability: ToolCapabilityId): string[] {
  return [
    ...new Set(
      Object.values(CUSTOM_AGENT_CAPABILITY_TOOL_SETS[capability]).flatMap((tools) => [...tools])
    )
  ]
}

/** Extract the backend default allowed-tools set. 🔴 Extraction failure must be LOUD: an empty or
 *  shrunken parse would make every assertion below pass vacuously — the exact failure mode the
 *  consistency-gate discipline in architecture-internals.md warns about. */
function backendDefaultAllowedTools(): string[] {
  const source = readFileSync(AGENT_RUNS_PY, 'utf-8')
  const match = source.match(/DEFAULT_CUSTOM_AGENT_ALLOWED_TOOLS[^=]*=\s*\(([\s\S]*?)\n\)/)
  if (!match) {
    throw new Error(
      `failed to extract DEFAULT_CUSTOM_AGENT_ALLOWED_TOOLS from ${AGENT_RUNS_PY} — update this parser`
    )
  }
  const tools = [...match[1].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1])
  if (tools.length < 10 || !tools.includes('email_get')) {
    throw new Error(
      `DEFAULT_CUSTOM_AGENT_ALLOWED_TOOLS extraction canary failed (got ${tools.length}: ${tools.join(', ')})`
    )
  }
  return tools
}

function profiles(): CustomAgentCapabilityProfile[] {
  const out: CustomAgentCapabilityProfile[] = []
  for (const email of CUSTOM_AGENT_CAPABILITY_TIERS.email) {
    for (const calendar of CUSTOM_AGENT_CAPABILITY_TIERS.calendar) {
      for (const knowledge of CUSTOM_AGENT_CAPABILITY_TIERS.knowledge) {
        for (const sessions of CUSTOM_AGENT_CAPABILITY_TIERS.sessions) {
          for (const reports of CUSTOM_AGENT_CAPABILITY_TIERS.reports) {
            for (const web of CUSTOM_AGENT_CAPABILITY_TIERS.web) {
              for (const files of CUSTOM_AGENT_CAPABILITY_TIERS.files) {
                for (const library of CUSTOM_AGENT_CAPABILITY_TIERS.library) {
                  out.push({ email, calendar, knowledge, sessions, reports, web, files, library })
                }
              }
            }
          }
        }
      }
    }
  }
  return out
}

describe('customAgentCapabilities', () => {
  test('all 1296 canonical profiles round-trip through allowed_tools + grants', () => {
    const all = profiles()
    // 3 email × 3 calendar × 2 knowledge × 2 sessions × 2 reports × 3 web × 2 files × 3 library
    expect(all).toHaveLength(1296)
    for (const profile of all) {
      const policy = customAgentPolicyFromCapabilities(profile)
      expect(deriveCustomAgentCapabilities(policy)).toEqual({ profile, customized: [] })
    }
  })

  test('report_write belongs only to the report produce tier', () => {
    const base: CustomAgentCapabilityProfile = {
      email: 'read',
      calendar: 'off',
      knowledge: 'off',
      sessions: 'own',
      reports: 'read',
      web: 'off',
      files: 'off',
      library: 'off'
    }
    expect(customAgentPolicyFromCapabilities(base).allowedTools).not.toContain('report_write')
    expect(
      customAgentPolicyFromCapabilities({ ...base, reports: 'produce' }).allowedTools
    ).toContain('report_write')
  })

  test('one card edit preserves unrelated and future atomic tools', () => {
    const next = applyCustomAgentCapabilityPatch(
      {
        allowedTools: ['email_get', 'calendar_event_get', 'future_tool_x'],
        grantWeb: 'gated',
        grantExec: true,
        grantSessions: 'all'
      },
      { reports: 'produce' }
    )
    expect(next.allowedTools).toEqual([
      'email_get',
      'calendar_event_get',
      'future_tool_x',
      'report_get',
      'report_list',
      'report_write'
    ])
    expect(next.grantWeb).toBe('gated')
    expect(next.grantExec).toBe(true)
    expect(next.grantSessions).toBe('all')
  })

  // task 09-02 — sessions is a GRANT dimension (read radius of the always-registered
  // chat_session_* tools), not a tool set: it never touches allowed_tools, and the three
  // session tool names are no longer managed by any card.
  test('sessions is a grant: own/all round-trip without touching allowed_tools', () => {
    const base: CustomAgentCapabilityProfile = {
      email: 'read',
      calendar: 'off',
      knowledge: 'on',
      sessions: 'own',
      reports: 'read',
      web: 'off',
      files: 'off',
      library: 'off'
    }
    const own = customAgentPolicyFromCapabilities(base)
    const all = customAgentPolicyFromCapabilities({ ...base, sessions: 'all' })
    expect(own.grantSessions).toBe('own')
    expect(all.grantSessions).toBe('all')
    expect(all.allowedTools).toEqual(own.allowedTools)
    expect(deriveCustomAgentCapabilities(all).profile.sessions).toBe('all')
    for (const name of ['chat_session_list', 'chat_session_search', 'chat_session_get']) {
      expect(own.allowedTools).not.toContain(name)
      expect(isCustomAgentManagedTool(name)).toBe(false)
    }
    // A legacy row still carrying the session names keeps them as unmanaged atomics — a card
    // edit must not delete them (and they are harmless: the gateway exempts them by name).
    const legacy = applyCustomAgentCapabilityPatch(
      { allowedTools: ['chat_session_list', 'email_get'], grantWeb: 'off', grantExec: false, grantSessions: 'all' },
      { knowledge: 'off' }
    )
    expect(legacy.allowedTools).toContain('chat_session_list')
    expect(legacy.grantSessions).toBe('all')
  })

  test('advanced partial selections are retained and surfaced as customized', () => {
    const policy = {
      allowedTools: ['email_get', 'email_draft_reply'],
      grantWeb: 'off' as const,
      grantExec: false,
      grantSessions: 'own' as const
    }
    const derived = deriveCustomAgentCapabilities(policy)
    expect(derived.customized).toContain('email')
    expect(policy.allowedTools).toEqual(['email_get', 'email_draft_reply'])
  })
})

// =============================================================================
// 🔴 投影恒不撒谎 —— 显示的档位权限必须 ⊇ 实际启用的工具
//
// 病根（本闸修的那个 bug）：deriveToolTier 的 fallback 原本向下取整（找「被 selection 完全包含
// 的最强档」，找不到就退 tiers[0]）。后端默认集里没有任何 email 档被完全包含（它含
// email_flag/archive/pin/resync/draft_reply，却缺 email_attachment_text/email_thread_attachments），
// 于是每个新建 agent 的邮件卡都渲染成「只读」——比实际权限低。权限展示错的方向只有一个能容忍：
// 宁高勿低。
// =============================================================================

function assertTierNeverUnderstates(
  capability: ToolCapabilityId,
  selected: readonly string[],
  label: string
): void {
  const derived = deriveCustomAgentCapabilities({
    allowedTools: [...selected],
    grantWeb: 'off',
    grantExec: false,
    grantSessions: 'own'
  })
  const shown = tierTools(capability, derived.profile[capability])
  const understated = selected.filter(
    (tool) => managedTools(capability).includes(tool) && !shown.includes(tool)
  )
  expect(
    understated,
    `${label}: 档位「${derived.profile[capability]}」不含已启用的 ${understated.join(', ')} ` +
      '—— 卡片显示的权限低于实际，正是本闸要挡的方向'
  ).toEqual([])
}

describe('capability tier projection never understates granted power', () => {
  test('backend default allowed-tools set (the every-new-agent path)', () => {
    const defaults = backendDefaultAllowedTools()
    for (const capability of TOOL_CAPABILITIES) {
      assertTierNeverUnderstates(capability, defaults, `默认集 / ${capability}`)
    }
  })

  test('backend defaults specifically surface email write + report produce', () => {
    // 回归钉子：这两项就是 bug 的原始症状。默认集含 email_draft_reply 与 report_write，
    // 若哪天又显示成 'read'，说明 fallback 方向被改回去了。
    const defaults = backendDefaultAllowedTools()
    expect(defaults).toContain('email_draft_reply')
    expect(defaults).toContain('report_write')
    const { profile } = deriveCustomAgentCapabilities({
      allowedTools: defaults,
      grantWeb: 'off',
      grantExec: false,
      grantSessions: 'own'
    })
    expect(profile.email).toBe('draft')
    expect(profile.reports).toBe('produce')
  })

  test('every single-tool perturbation of every canonical tier', () => {
    // 单点扰动覆盖现实里最常见的「档 ± 一个工具」形态（Advanced 微调、后端默认集漂移、
    // 新工具进了某档但没进另一档），且规模可控（档数 × managed 工具数）。
    for (const capability of TOOL_CAPABILITIES) {
      const managed = managedTools(capability)
      for (const tier of CUSTOM_AGENT_CAPABILITY_TIERS[capability]) {
        const base = [...tierTools(capability, tier)]
        for (const tool of managed) {
          assertTierNeverUnderstates(
            capability,
            base.includes(tool) ? base.filter((t) => t !== tool) : [...base, tool],
            `${capability}/${tier} ±${tool}`
          )
        }
      }
    }
  })

  test('empty and full selections', () => {
    for (const capability of TOOL_CAPABILITIES) {
      assertTierNeverUnderstates(capability, [], `空集 / ${capability}`)
      assertTierNeverUnderstates(capability, managedTools(capability), `全集 / ${capability}`)
    }
  })

  test('grant dimensions project verbatim — a granted sessions=all is never shown as own', () => {
    // 投影恒不撒谎的 grant 版：三个 grant 维度（web / files / sessions）没有档位阶梯可取整，
    // 唯一诚实的投影就是原值。存量 knowledge=on 行由 Python 迁移规则物化成 all，这里钉住
    // 「all 进来必须 all 出去」。
    for (const sessions of CUSTOM_AGENT_CAPABILITY_TIERS.sessions) {
      const derived = deriveCustomAgentCapabilities({
        allowedTools: [],
        grantWeb: 'off',
        grantExec: false,
        grantSessions: sessions
      })
      expect(derived.profile.sessions).toBe(sessions)
      // a grant never marks the card customized (there is no atomic selection behind it)
      expect(derived.customized).not.toContain('sessions')
    }
  })

  test('tier ladders stay weakest→strongest supersets (the round-up precondition)', () => {
    // 「第一个包含 selection 的档 == 最小的那个」只在阶梯是包含链时成立。哪天有人给某个档
    // 加了独有工具而没加进更强档，向上取整就会挑到一个更强但不含它的档 —— 那时本条先红。
    for (const capability of TOOL_CAPABILITIES) {
      const tiers = CUSTOM_AGENT_CAPABILITY_TIERS[capability]
      for (let i = 1; i < tiers.length; i++) {
        const weaker = tierTools(capability, tiers[i - 1])
        const stronger = tierTools(capability, tiers[i])
        expect(
          weaker.filter((tool) => !stronger.includes(tool)),
          `${capability}: 「${tiers[i - 1]}」有「${tiers[i]}」不含的工具，档位阶梯不再是包含链`
        ).toEqual([])
      }
    }
  })

  test('reverse gate — the old round-down fallback would be caught', () => {
    // 证明本闸真会红而不是恒绿的摆设：复刻旧实现（向下取整 + 退 tiers[0]），喂默认集，
    // 必须得到那个撒谎的 'read'。
    const defaults = backendDefaultAllowedTools()
    const managed = managedTools('email')
    const selected = defaults.filter((tool) => managed.includes(tool))
    const tiers = CUSTOM_AGENT_CAPABILITY_TIERS.email
    let oldTier: string = tiers[0]
    for (const tier of tiers) {
      if (tierTools('email', tier).every((tool) => selected.includes(tool))) oldTier = tier
    }
    expect(oldTier).toBe('read')
    const understated = selected.filter((tool) => !tierTools('email', oldTier).includes(tool))
    expect(understated.length).toBeGreaterThan(0)
    expect(understated).toContain('email_draft_reply')
  })
})

// =============================================================================
// 第 8 张卡「资料库」（library epic P2-L2）
//
// 三档 off | read | write，逐级 superset。工具名的唯一来源是零依赖叶子
// `shared/libraryConstants.ts`（Python 侧 `src/library/constants.py` 与它有 parity 闸）——
// 本文件断言映射表**引用**的就是那两个数组，而不是又手抄一遍名字：只要有人在能力卡里
// 抄第三份名单，下面第一条就红。
// =============================================================================

describe('library capability card', () => {
  test('the three tiers are exactly [] ⊂ reads ⊂ reads+writes, sourced from libraryConstants', () => {
    // canary：叶子表缩水会让下面的相等断言变成空 == 空。
    expect(GATEWAY_LIBRARY_READ_TOOL_NAMES).toHaveLength(3)
    expect(GATEWAY_LIBRARY_WRITE_TOOL_NAMES).toHaveLength(4)

    expect(CUSTOM_AGENT_CAPABILITY_TIERS.library).toEqual(['off', 'read', 'write'])
    expect(tierTools('library', 'off')).toEqual([])
    expect(tierTools('library', 'read')).toEqual([...GATEWAY_LIBRARY_READ_TOOL_NAMES])
    expect(tierTools('library', 'write')).toEqual([
      ...GATEWAY_LIBRARY_READ_TOOL_NAMES,
      ...GATEWAY_LIBRARY_WRITE_TOOL_NAMES
    ])
    // 没有第三处名单：卡片管的工具集恰好是那 7 个。
    expect(managedTools('library').sort()).toEqual(
      [...GATEWAY_LIBRARY_READ_TOOL_NAMES, ...GATEWAY_LIBRARY_WRITE_TOOL_NAMES].sort()
    )
  })

  test('off grants nothing; read grants only the read three; write grants all seven', () => {
    const base = { allowedTools: [], grantWeb: 'off' as const, grantExec: false, grantSessions: 'own' as const }
    expect(applyCustomAgentCapabilityPatch(base, { library: 'off' }).allowedTools).toEqual([])
    expect(applyCustomAgentCapabilityPatch(base, { library: 'read' }).allowedTools).toEqual([
      ...GATEWAY_LIBRARY_READ_TOOL_NAMES
    ])
    for (const name of GATEWAY_LIBRARY_WRITE_TOOL_NAMES) {
      expect(applyCustomAgentCapabilityPatch(base, { library: 'read' }).allowedTools).not.toContain(
        name
      )
      expect(applyCustomAgentCapabilityPatch(base, { library: 'write' }).allowedTools).toContain(
        name
      )
    }
  })

  test('dropping to off removes every library tool and leaves other cards alone', () => {
    const full = applyCustomAgentCapabilityPatch(
      {
        allowedTools: ['email_get', 'future_tool_x'],
        grantWeb: 'gated',
        grantExec: true,
        grantSessions: 'all'
      },
      { library: 'write' }
    )
    const off = applyCustomAgentCapabilityPatch(full, { library: 'off' })
    expect(off.allowedTools).toEqual(['email_get', 'future_tool_x'])
    expect(off.grantWeb).toBe('gated')
    expect(off.grantExec).toBe(true)
    expect(off.grantSessions).toBe('all')
  })

  test('🔴 一个写工具就必须显示成「写入」—— 向上取整在第 8 张卡上同样成立', () => {
    // 这是本卡最容易出的撒谎形态：只勾了 library_append（Advanced 微调，或未来某个写工具进了
    // write 档而没进 read 档），若向下取整就会渲染成「读取」，卡片说它只能读，实际能改文件。
    const derived = deriveCustomAgentCapabilities({
      allowedTools: [...GATEWAY_LIBRARY_READ_TOOL_NAMES, 'library_append'],
      grantWeb: 'off',
      grantExec: false,
      grantSessions: 'own'
    })
    expect(derived.profile.library).toBe('write')
    expect(derived.customized).toContain('library')
  })

  test('library tools are managed atomics (a card edit owns them, unlike the session three)', () => {
    for (const name of [...GATEWAY_LIBRARY_READ_TOOL_NAMES, ...GATEWAY_LIBRARY_WRITE_TOOL_NAMES]) {
      expect(isCustomAgentManagedTool(name)).toBe(true)
    }
  })
})
