import { describe, expect, test } from 'vitest'

import {
  isAgentAvatarImage,
  resolveAgentAvatar,
  shuffledAgentAvatar
} from '../../src/shared/components/agents/agentAvatarIdentity'

describe('AgentAvatar identity', () => {
  test('empty config derives a stable shape, palette, and variant from agent id', () => {
    const first = resolveAgentAvatar('daily_email_digest')
    const second = resolveAgentAvatar('daily_email_digest')
    expect(second).toEqual(first)
    expect(first.variant_id).toBe('daily_email_digest')
  })

  test('explicit supported identity wins and malformed identity falls back', () => {
    const explicit = { shape: 'nova' as const, palette: 'aurora-pink', variant_id: 'custom:v2' }
    expect(resolveAgentAvatar('custom', explicit)).toEqual(explicit)
    expect(
      resolveAgentAvatar('custom', {
        shape: 'nova',
        palette: 'missing-palette',
        variant_id: 'bad'
      })
    ).toEqual(resolveAgentAvatar('custom'))
  })

  test('shuffle returns a different but deterministic persisted identity', () => {
    const current = resolveAgentAvatar('custom')
    const next = shuffledAgentAvatar('custom', current)
    expect(next).not.toEqual(current)
    expect(resolveAgentAvatar('custom', next)).toEqual(next)
    expect(shuffledAgentAvatar('custom', current)).toEqual(next)
  })
})

describe('AgentAvatar 上传态判别（WP7）', () => {
  const DATA_URI = `data:image/webp;base64,${'A'.repeat(40)}`

  test('只认 base64 data URI 的三个 mime —— 外链 / 坏形状 / 生成式一律 false', () => {
    expect(isAgentAvatarImage({ type: 'image', data: DATA_URI })).toBe(true)
    expect(isAgentAvatarImage({ type: 'image', data: `data:image/png;base64,QUJD` })).toBe(true)
    // 外链会让本地渲染发网络请求（追踪像素 / 离线空图）；svg 可带脚本。
    expect(isAgentAvatarImage({ type: 'image', data: 'https://example.test/a.png' })).toBe(false)
    expect(isAgentAvatarImage({ type: 'image', data: 'data:image/svg+xml;base64,QUJD' })).toBe(
      false
    )
    expect(isAgentAvatarImage({ type: 'image', data: '' })).toBe(false)
    expect(isAgentAvatarImage({ shape: 'nova', palette: 'aurora-pink' })).toBe(false)
    expect(isAgentAvatarImage(null)).toBe(false)
  })

  test('上传态没有 shape/palette → resolve 回落 id 派生基底，shuffle 从该基底递进', () => {
    const image = { type: 'image' as const, data: DATA_URI }
    expect(resolveAgentAvatar('custom', image)).toEqual(resolveAgentAvatar('custom'))
    // 「换一换」在上传态下必须给出**生成式**结果（不含 type/data 残留），否则保存回去还是图片。
    const next = shuffledAgentAvatar('custom', image)
    expect(next).toEqual(shuffledAgentAvatar('custom', resolveAgentAvatar('custom')))
    expect(isAgentAvatarImage(next)).toBe(false)
  })
})
