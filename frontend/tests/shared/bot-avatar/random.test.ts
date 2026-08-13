// random.ts 语义契约：
//   golden 稳定性 —— derive / legacy 映射的精确输入→输出钉死（防未来重构静默换脸，
//   prd §5.1「同一 agent 换版本后外观稳定」的机器化）。v2 词表换代是一次**有意的**
//   全量换脸（8 形从 2D path 换成 3D 原语），golden 随之重钉：索引算法未动，
//   同 id 的派生索引与 v1 相同，只是索引指到的形状名换了（blob→sphere 等双射）；
//   shuffle —— 确定性递进（同起点恒同下一个）且 ≠ 起点（全 88 起点穷举）；
//   randomBotAvatar —— 注入随机源可复现、词表内均匀取值。

import { describe, expect, test } from 'vitest'

import { BOT_AVATAR_COLORS } from '../../../src/shared/bot-avatar/colors'
import {
  deriveBotAvatar,
  mapLegacyGeneratedToBot,
  randomBotAvatar,
  shuffleBotAvatar
} from '../../../src/shared/bot-avatar/random'
import { BOT_AVATAR_SHAPES } from '../../../src/shared/bot-avatar/shapes'

describe('deriveBotAvatar：agent_id 确定性派生（golden 钉死）', () => {
  // 改动 hash / 词表顺序 / 索引算法任一处都会翻红 —— 翻红 = 全体存量 NULL 行换脸，
  // 必须回到 prd §5.1 重新评审而不是改断言了事。
  const GOLDENS: ReadonlyArray<[string, string, string]> = [
    ['daily_report', 'diamond', 'gray'],
    ['search', 'capsule', 'blue'],
    ['preprocess', 'cone', 'red'],
    ['custom_ai', 'diamond', 'gray'],
    ['project_progress', 'cube', 'yellow'],
    // 空 id 兜底种子 'mailagent'（对齐 resolveAgentAvatar 的 || 兜底）
    ['', 'cone', 'brown']
  ]

  test.each(GOLDENS)('%j -> %s/%s', (agentId, shape, color) => {
    expect(deriveBotAvatar(agentId)).toEqual({ type: 'bot', shape, color })
  })

  test('同 id 恒同结果', () => {
    expect(deriveBotAvatar('daily_report')).toEqual(deriveBotAvatar('daily_report'))
  })
})

describe('mapLegacyGeneratedToBot：oreo → bot 确定性映射（golden 钉死）', () => {
  const GOLDENS: ReadonlyArray<[string, string, string, string]> = [
    ['bloom', 'rose', 'diamond', 'white'],
    ['silk', 'ocean', 'sphere', 'brown'],
    ['flare', 'ember', 'cylinder', 'red'],
    ['nova', 'meadow', 'cylinder', 'gray'],
    ['jade', 'dusk', 'cylinder', 'yellow']
  ]

  test.each(GOLDENS)('%s/%s -> %s/%s', (shape, palette, botShape, botColor) => {
    expect(mapLegacyGeneratedToBot({ shape, palette })).toEqual({
      type: 'bot',
      shape: botShape,
      color: botColor
    })
  })

  test('variant_id 有意不进 hash（同 shape+palette 恒同脸）', () => {
    expect(mapLegacyGeneratedToBot({ shape: 'nova', palette: 'meadow', variant_id: 'v1' })).toEqual(
      mapLegacyGeneratedToBot({ shape: 'nova', palette: 'meadow' })
    )
  })
})

describe('shuffleBotAvatar：确定性递进且 ≠ 起点', () => {
  test('同起点恒同下一个（golden）', () => {
    const next = shuffleBotAvatar({ shape: 'sphere', color: 'orange' }, 'daily_report')
    expect(next).toEqual({ type: 'bot', shape: 'cube', color: 'gray' })
    expect(shuffleBotAvatar({ shape: 'sphere', color: 'orange' }, 'daily_report')).toEqual(next)
  })

  test('全 88 起点 × 3 个 agentId 穷举：结果 ≠ 起点且在词表内', () => {
    for (const agentId of ['daily_report', 'a', '']) {
      for (const shape of BOT_AVATAR_SHAPES) {
        for (const color of BOT_AVATAR_COLORS) {
          const next = shuffleBotAvatar({ shape, color }, agentId)
          expect(BOT_AVATAR_SHAPES).toContain(next.shape)
          expect(BOT_AVATAR_COLORS).toContain(next.color)
          expect(
            next.shape === shape && next.color === color,
            `${agentId}:${shape}/${color} 换一换后没变`
          ).toBe(false)
        }
      }
    }
  })

  test('current 非法/缺省时起点回落 id 派生基底', () => {
    const fromNull = shuffleBotAvatar(null, 'search')
    expect(fromNull).toEqual({ type: 'bot', shape: 'cursor', color: 'teal' })
    // 非法值（v1 词表残留 —— random 层不做 legacy 映射，那是 resolveAgentAvatar 的职责）
    expect(shuffleBotAvatar({ shape: 'blob', color: 'rose' } as never, 'search')).toEqual(fromNull)
    // 且 ≠ 派生基底本身
    expect(fromNull).not.toEqual(deriveBotAvatar('search'))
  })
})

describe('randomBotAvatar：注入随机源', () => {
  test('确定性序列可复现（shape 先消费、color 后消费）', () => {
    const makeSource = (values: readonly number[]): (() => number) => {
      let i = 0
      return () => values[Math.min(i++, values.length - 1)]
    }
    expect(randomBotAvatar(makeSource([0, 0]))).toEqual({
      type: 'bot',
      shape: BOT_AVATAR_SHAPES[0],
      color: BOT_AVATAR_COLORS[0]
    })
    expect(randomBotAvatar(makeSource([0.5, 0.5]))).toEqual({
      type: 'bot',
      shape: BOT_AVATAR_SHAPES[4],
      color: BOT_AVATAR_COLORS[5]
    })
    // 注入源顶到 1（越 random() 契约）也收边不越界
    expect(randomBotAvatar(makeSource([1, 1]))).toEqual({
      type: 'bot',
      shape: BOT_AVATAR_SHAPES[BOT_AVATAR_SHAPES.length - 1],
      color: BOT_AVATAR_COLORS[BOT_AVATAR_COLORS.length - 1]
    })
  })

  test('缺省随机源产出恒在词表内', () => {
    for (let i = 0; i < 32; i++) {
      const value = randomBotAvatar()
      expect(BOT_AVATAR_SHAPES).toContain(value.shape)
      expect(BOT_AVATAR_COLORS).toContain(value.color)
      expect(value.type).toBe('bot')
    }
  })
})
