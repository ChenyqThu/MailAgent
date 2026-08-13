// @vitest-environment happy-dom
//
// 0813 dogfood 轮 3 · B10 —— 「模型 / 思考强度 / 备用模型」三件套的**转换与门**。
//
// 事项级（覆盖）与全局配置面（默认）共用 `MatterModelFields`；本文件盯的就是那份共用判定，
// 因为它有一条不显眼的安全规则：**选了没有 reasoning 能力的模型时，思考强度不许写进块**。
// 档位阶梯按模型家族给，而对无 reasoning 能力的模型下发 effort，openai / deepseek 协议会往
// wire 上塞一个多余参数（16b 契约）——症状是整轮 run 400，不是界面上看得见的错。
//
// 🔴 走 `renderHook` 而不是点 UI：Radix Select 的选中在 happy-dom 里驱动不起来（仓内所有
// Select 测试都只断言选项、不真的选），硬点会得到一个"什么都没测到却全绿"的文件。

import { beforeEach, describe, expect, test, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

const { models } = vi.hoisted(() => ({ models: { value: [] as Record<string, unknown>[] } }))

// 真实 `useComposerModels` 要拉 /llm/providers + models.dev 目录；这里要控的恰恰是
// `capabilities.reasoning` 这一位（它决定思考强度那道门），打桩才测得准。
vi.mock('@shared/hooks/useComposerModels', () => ({
  useComposerModels: () => models.value
}))

const {
  MATTER_MODEL_FOLLOW,
  MATTER_MODEL_NO_FALLBACK,
  matterModelDraftFrom,
  useMatterModelFields
} = await import('@shared/components/matters/matterModelDraft')

function option(ref: string, reasoning: boolean | null): Record<string, unknown> {
  return {
    ref,
    providerId: 'default',
    providerLabel: null,
    protocol: 'anthropic',
    modelId: ref.split(':').pop(),
    displayName: ref,
    capabilities: reasoning === null ? null : { reasoning },
    maxOutput: null,
    contextWindow: null,
    catalogMeta: null
  }
}

beforeEach(() => {
  models.value = [
    option('default:thinker', true),
    option('default:plain', false),
    option('default:unknown', null)
  ]
})

function fields(draft: { model: string; effort: string; fallback: string }) {
  return renderHook(() => useMatterModelFields(draft)).result.current
}

const FOLLOW_ALL = {
  model: MATTER_MODEL_FOLLOW,
  effort: MATTER_MODEL_FOLLOW,
  fallback: MATTER_MODEL_FOLLOW
}

describe('matterModelDraftFrom —— 存储块 → 草稿', () => {
  test('没配过 ⇒ 三档都是「跟随」', () => {
    expect(matterModelDraftFrom(undefined)).toEqual(FOLLOW_ALL)
    expect(matterModelDraftFrom({})).toEqual(FOLLOW_ALL)
  })

  test('🔴 `[]` 与「没配过」是两种不同的空，映射到两个不同的档', () => {
    expect(matterModelDraftFrom({ fallback_models: [] }).fallback).toBe(MATTER_MODEL_NO_FALLBACK)
    expect(matterModelDraftFrom({}).fallback).toBe(MATTER_MODEL_FOLLOW)
    expect(matterModelDraftFrom({ fallback_models: ['default:plain'] }).fallback).toBe(
      'default:plain'
    )
  })

  test('往返：块 → 草稿 → 块 恒等（不许在中间悄悄丢掉一项）', () => {
    for (const block of [
      {},
      { model: 'default:thinker' },
      { model: 'default:thinker', effort: 'high' },
      { fallback_models: [] },
      { model: 'default:thinker', effort: 'low', fallback_models: ['default:plain'] }
    ]) {
      expect(fields(matterModelDraftFrom(block)).block).toEqual(block)
    }
  })
})

describe('useMatterModelFields —— 思考强度那道门', () => {
  test('没选模型 ⇒ 不适用（「跟随」时根本不知道最终跑哪个模型）', () => {
    const state = fields(FOLLOW_ALL)
    expect(state.effortApplicable).toBe(false)
    expect(state.block).toEqual({})
  })

  test('模型支持 reasoning ⇒ 档位可选，且写进块', () => {
    const state = fields({ ...FOLLOW_ALL, model: 'default:thinker', effort: 'high' })
    expect(state.effortApplicable).toBe(true)
    expect(state.block).toEqual({ model: 'default:thinker', effort: 'high' })
  })

  test('🔴 模型明确不支持 reasoning ⇒ 档位不适用，且**绝不**写进块', () => {
    const state = fields({ ...FOLLOW_ALL, model: 'default:plain', effort: 'high' })
    expect(state.effortApplicable).toBe(false)
    expect(state.block).toEqual({ model: 'default:plain' })
    expect(state.block.effort).toBeUndefined()
  })

  test('🔴 未标注 ≠ 不支持：目录/行都没说时仍然可选（不许当不支持灰死）', () => {
    expect(fields({ ...FOLLOW_ALL, model: 'default:unknown' }).effortApplicable).toBe(true)
  })

  test('blockFor 用的是**下一个**草稿的模型来判这道门（改一下存一次的面靠它）', () => {
    const state = fields({ ...FOLLOW_ALL, model: 'default:thinker', effort: 'high' })
    // 从"支持"切到"不支持"：那一档必须一起消失，而不是被带着存进库里
    expect(state.blockFor({ ...FOLLOW_ALL, model: 'default:plain', effort: 'high' })).toEqual({
      model: 'default:plain'
    })
    // 反向切回来照常带上
    expect(state.blockFor({ ...FOLLOW_ALL, model: 'default:thinker', effort: 'low' })).toEqual({
      model: 'default:thinker',
      effort: 'low'
    })
  })
})

describe('configuredCount —— 折叠起来时的「N 项覆盖」', () => {
  test('数的是**真的会存下去**的项，不是三个 select 动过几个', () => {
    expect(fields(FOLLOW_ALL).configuredCount).toBe(0)
    expect(fields({ ...FOLLOW_ALL, model: 'default:thinker' }).configuredCount).toBe(1)
    expect(
      fields({ ...FOLLOW_ALL, model: 'default:thinker', effort: 'high' }).configuredCount
    ).toBe(2)
    // 档位存不下去（模型不支持）⇒ 不该被数进去，否则计数在替一个不存在的覆盖背书
    expect(fields({ ...FOLLOW_ALL, model: 'default:plain', effort: 'high' }).configuredCount).toBe(
      1
    )
    // 「不设兜底」是一项真配置
    expect(fields({ ...FOLLOW_ALL, fallback: MATTER_MODEL_NO_FALLBACK }).configuredCount).toBe(1)
  })
})
