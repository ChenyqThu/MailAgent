// 跨语言闸 —— Matter「跟进规则」写侧 envelope 的形状。
//
// 病根（0812 dogfood，「跟进规则保存必定失败」）：TS 写侧类型与 pydantic 写侧模型各写各的、
// 中间没有裁判。builder 返回 `JSON.stringify(envelope)`（字符串），
// `MatterPatchWithScheduleRequest.schedule_json` 要的是 `dict[str, Any] | None`，于是 FastAPI
// 在请求校验层 422，把整条 PATCH（含 agent_enabled / profile / instructions）一起打掉。
// typecheck 拦不住，因为 `MatterPatchInput.schedule_json` 当年抄的是**读**侧那一列的形状。
//
// 两侧都读仓库根 `tests/fixtures/matter_trigger_envelope.json`：
// - 这里断言 builder 对 fixture 里那组输入的产出**逐键等于** fixture 里的 envelope，且不是字符串；
// - pytest `tests/matters/test_matter_trigger_envelope_parity.py` 把同一个 envelope 原样喂进
//   pydantic 模型与 `normalize_trigger_json`。
// 任何一侧单方面漂移都会红。
import { describe, expect, test } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { MatterAgentOverrides, MatterRunAction } from '@shared/api/types/matter'
import {
  buildTriggerEnvelope,
  parseAgentOverridesValue,
  type MatterTriggerEntry
} from '@shared/components/matters/matterSchedule'

interface Fixture {
  case: string
  input: {
    entries: MatterTriggerEntry[]
    actions: MatterRunAction[]
    agent?: MatterAgentOverrides
  }
  envelope: Record<string, unknown>
}

// frontend/tests/components/matters/ → 仓库根 tests/fixtures/
const FIXTURE_PATH = resolve(__dirname, '../../../../tests/fixtures/matter_trigger_envelope.json')

// 🔴 读不到就红。静默跳过 = 闸不存在，正是这个 bug 当初能活下来的条件。
const fixture: Fixture | null = existsSync(FIXTURE_PATH)
  ? (JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture)
  : null

describe('跨语言 envelope parity（写侧 schedule_json）', () => {
  test('fixture 在场且形状完整（缺了 = 前后端对齐没有裁判）', () => {
    expect(fixture, `fixture missing: ${FIXTURE_PATH}`).not.toBeNull()
    expect(Array.isArray(fixture?.input.entries)).toBe(true)
    expect(fixture?.input.entries.length).toBeGreaterThan(0)
    expect(typeof fixture?.envelope).toBe('object')
  })

  test('builder 的产出逐键等于 fixture', () => {
    const built = buildTriggerEnvelope(
      fixture!.input.entries,
      fixture!.input.actions,
      fixture!.input.agent
    )
    expect(built).toEqual(fixture!.envelope)
  })

  test('产出是对象，不是 JSON 字符串（pydantic 要 dict，发字符串 422）', () => {
    const built = buildTriggerEnvelope(
      fixture!.input.entries,
      fixture!.input.actions,
      fixture!.input.agent
    )
    expect(typeof built).not.toBe('string')
    expect(typeof built).toBe('object')
  })

  // 0813 轮 3 #10 —— 模型覆盖三项进同一个 envelope。写侧已经由上面那条逐键相等覆盖；这里补
  // **读回来还是同一份**（写 → 读的闭环，与 Python `parse_agent_overrides` 同源）。
  test('模型覆盖三项写进去、读回来逐键相同', () => {
    expect(fixture!.input.agent, 'fixture 缺 agent 覆盖块 —— 这三项就没有裁判了').toBeTruthy()
    const built = buildTriggerEnvelope(
      fixture!.input.entries,
      fixture!.input.actions,
      fixture!.input.agent
    )
    expect(parseAgentOverridesValue(built)).toEqual(fixture!.input.agent)
  })
})
