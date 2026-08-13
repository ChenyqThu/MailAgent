// @vitest-environment happy-dom
//
// 08-12 living-bot-avatar WP3 —— 身份解析链换代（oreo → bot）+ 编辑器 Grok 化：
//   • resolveAgentAvatar 恒返回 bot config（type:'bot'）；空/坏值/上传态按 id 派生；
//     legacy oreo 生成式行确定性换脸（golden 引用：bloom/rose → diamond/white）。
//   • isAgentAvatarImage 判别一个字节不变（WP7 语义回归）。
//   • 编辑器：Bot/上传 两 tab + 重置 + 8 形网格 + 11 色 swatch + 随机骰子。
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import i18n from '@shared/i18n'
import { BOT_AVATAR_COLORS } from '../../src/shared/bot-avatar/colors'
import { BOT_AVATAR_SHAPES } from '../../src/shared/bot-avatar/shapes'
import { deriveBotAvatar, mapLegacyGeneratedToBot } from '../../src/shared/bot-avatar/random'
import { AgentAvatarEditor } from '../../src/shared/components/agents/AgentAvatar'
import {
  isAgentAvatarImage,
  resolveAgentAvatar,
  shuffledAgentAvatar
} from '../../src/shared/components/agents/agentAvatarIdentity'

await i18n.changeLanguage('zh-CN')

afterEach(cleanup)

describe('AgentAvatar identity（bot 语义）', () => {
  test('空 config 按 id 派生稳定 bot config（词表内）', () => {
    const first = resolveAgentAvatar('daily_email_digest')
    const second = resolveAgentAvatar('daily_email_digest')
    expect(second).toEqual(first)
    expect(first.type).toBe('bot')
    expect(BOT_AVATAR_SHAPES).toContain(first.shape)
    expect(BOT_AVATAR_COLORS).toContain(first.color)
    expect(first).toEqual(deriveBotAvatar('daily_email_digest'))
  })

  test('显式 bot 合法身份优先；词表越域回落 id 派生', () => {
    const explicit = { type: 'bot' as const, shape: 'diamond' as const, color: 'teal' as const }
    expect(resolveAgentAvatar('custom', explicit)).toEqual(explicit)
    expect(
      resolveAgentAvatar('custom', { type: 'bot', shape: 'diamond', color: 'neon' as never })
    ).toEqual(resolveAgentAvatar('custom'))
    expect(
      resolveAgentAvatar('custom', { type: 'bot', shape: 'star' as never, color: 'teal' })
    ).toEqual(resolveAgentAvatar('custom'))
  })

  test('v1 bot 形状名经 LEGACY_BOT_SHAPE_MAP 读侧换代（存量行不迁移仍有脸）', () => {
    expect(resolveAgentAvatar('custom', { type: 'bot', shape: 'hex' as never, color: 'teal' })).toEqual({
      type: 'bot',
      shape: 'diamond',
      color: 'teal'
    })
    expect(resolveAgentAvatar('custom', { type: 'bot', shape: 'blob' as never, color: 'orange' })).toEqual({
      type: 'bot',
      shape: 'sphere',
      color: 'orange'
    })
    // v1 形状 + 越域颜色 → 仍回落 id 派生（半合法不缝合）
    expect(
      resolveAgentAvatar('custom', { type: 'bot', shape: 'hex' as never, color: 'neon' as never })
    ).toEqual(resolveAgentAvatar('custom'))
  })

  test('legacy oreo 生成式行 → 确定性换脸（golden：bloom/rose → diamond/white）', () => {
    const legacy = { shape: 'bloom' as const, palette: 'rose', variant_id: 'v1' }
    expect(resolveAgentAvatar('custom', legacy)).toEqual({
      type: 'bot',
      shape: 'diamond',
      color: 'white'
    })
    // 同 shape+palette 恒同脸（variant_id 有意不进 hash），与 agentId 无关。
    expect(resolveAgentAvatar('another_agent', { shape: 'bloom', palette: 'rose' })).toEqual(
      mapLegacyGeneratedToBot({ shape: 'bloom', palette: 'rose' })
    )
  })

  test('legacy 坏值（越域 shape / 空 palette）回落 id 派生', () => {
    expect(
      resolveAgentAvatar('custom', { shape: 'sunrise' as never, palette: 'rose' })
    ).toEqual(resolveAgentAvatar('custom'))
    expect(resolveAgentAvatar('custom', { shape: 'nova', palette: '' })).toEqual(
      resolveAgentAvatar('custom')
    )
  })

  test('shuffle 确定性递进：≠ 当前、同起点恒同下一个、结果可原样保存', () => {
    const current = resolveAgentAvatar('custom')
    const next = shuffledAgentAvatar('custom', current)
    expect(next).not.toEqual(current)
    expect(resolveAgentAvatar('custom', next)).toEqual(next)
    expect(shuffledAgentAvatar('custom', current)).toEqual(next)
  })
})

describe('AgentAvatar 上传态判别（WP7 语义回归，一个字节不变）', () => {
  const DATA_URI = `data:image/webp;base64,${'A'.repeat(40)}`

  test('只认 base64 data URI 的三个 mime —— 外链 / 坏形状 / 生成式 / bot 一律 false', () => {
    expect(isAgentAvatarImage({ type: 'image', data: DATA_URI })).toBe(true)
    expect(isAgentAvatarImage({ type: 'image', data: `data:image/png;base64,QUJD` })).toBe(true)
    // 外链会让本地渲染发网络请求（追踪像素 / 离线空图）；svg 可带脚本。
    expect(isAgentAvatarImage({ type: 'image', data: 'https://example.test/a.png' })).toBe(false)
    expect(isAgentAvatarImage({ type: 'image', data: 'data:image/svg+xml;base64,QUJD' })).toBe(
      false
    )
    expect(isAgentAvatarImage({ type: 'image', data: '' })).toBe(false)
    expect(isAgentAvatarImage({ shape: 'nova', palette: 'aurora-pink' })).toBe(false)
    expect(isAgentAvatarImage({ type: 'bot', shape: 'diamond', color: 'teal' })).toBe(false)
    expect(isAgentAvatarImage(null)).toBe(false)
  })

  test('上传态没有 shape/color → resolve 回落 id 派生基底，shuffle 从该基底递进', () => {
    const image = { type: 'image' as const, data: DATA_URI }
    expect(resolveAgentAvatar('custom', image)).toEqual(resolveAgentAvatar('custom'))
    // 「换一换」在上传态下必须给出 **bot** 结果（不含 image 残留），否则保存回去还是图片。
    const next = shuffledAgentAvatar('custom', image)
    expect(next).toEqual(shuffledAgentAvatar('custom', resolveAgentAvatar('custom')))
    expect(isAgentAvatarImage(next)).toBe(false)
    expect(next.type).toBe('bot')
  })
})

describe('AgentAvatarEditor（Grok 化：tab / 网格 / 骰子 / 重置）', () => {
  test('默认落 Bot tab：8 形网格 + 11 色 swatch 在场，上传输入不在场；切 tab 互换', () => {
    render(<AgentAvatarEditor agentId="daily" value={null} onChange={vi.fn()} />)
    expect(
      within(screen.getByTestId('avatar-shape-grid')).getAllByRole('button')
    ).toHaveLength(BOT_AVATAR_SHAPES.length)
    expect(
      within(screen.getByTestId('avatar-color-grid')).getAllByRole('button')
    ).toHaveLength(BOT_AVATAR_COLORS.length)
    expect(screen.queryByTestId('avatar-upload-input')).toBeNull()

    fireEvent.click(screen.getByTestId('avatar-tab-upload'))
    expect(screen.queryByTestId('avatar-shape-grid')).toBeNull()
    expect(screen.getByTestId('avatar-upload-input')).toBeTruthy()

    fireEvent.click(screen.getByTestId('avatar-tab-bot'))
    expect(screen.getByTestId('avatar-shape-grid')).toBeTruthy()
  })

  test('上传图身份初始落上传 tab；null/bot 落 Bot tab', () => {
    const DATA_URI = `data:image/webp;base64,${'A'.repeat(40)}`
    render(
      <AgentAvatarEditor
        agentId="daily"
        value={{ type: 'image', data: DATA_URI }}
        onChange={vi.fn()}
      />
    )
    expect(screen.getByTestId('avatar-upload-input')).toBeTruthy()
    expect(screen.queryByTestId('avatar-shape-grid')).toBeNull()
  })

  test('选形 / 选色 → onChange 携带完整 bot config（另一维取当前解析基底）', () => {
    const onChange = vi.fn()
    render(<AgentAvatarEditor agentId="daily" value={null} onChange={onChange} />)
    const base = resolveAgentAvatar('daily')

    const otherShape = BOT_AVATAR_SHAPES.find((shape) => shape !== base.shape)
    fireEvent.click(within(screen.getByTestId('avatar-shape-grid')).getByLabelText(otherShape ?? ''))
    expect(onChange.mock.calls[0][0]).toEqual({ type: 'bot', shape: otherShape, color: base.color })

    const otherColor = BOT_AVATAR_COLORS.find((color) => color !== base.color)
    fireEvent.click(within(screen.getByTestId('avatar-color-grid')).getByLabelText(otherColor ?? ''))
    expect(onChange.mock.calls[1][0]).toEqual({ type: 'bot', shape: base.shape, color: otherColor })
  })

  test('当前身份在网格上高亮（aria-pressed）；上传图身份切到 Bot tab 高亮派生基底', () => {
    const explicit = { type: 'bot' as const, shape: 'diamond' as const, color: 'teal' as const }
    const first = render(
      <AgentAvatarEditor agentId="daily" value={explicit} onChange={vi.fn()} />
    )
    expect(
      within(screen.getByTestId('avatar-shape-grid')).getByLabelText('diamond').getAttribute(
        'aria-pressed'
      )
    ).toBe('true')
    expect(
      within(screen.getByTestId('avatar-color-grid')).getByLabelText('teal').getAttribute(
        'aria-pressed'
      )
    ).toBe('true')
    first.unmount()

    // 上传态 resolve 落 id 派生基底（prd §6.2：切到 Bot tab 显示派生基底）。
    const DATA_URI = `data:image/webp;base64,${'A'.repeat(40)}`
    render(
      <AgentAvatarEditor
        agentId="daily"
        value={{ type: 'image', data: DATA_URI }}
        onChange={vi.fn()}
      />
    )
    fireEvent.click(screen.getByTestId('avatar-tab-bot'))
    const derived = resolveAgentAvatar('daily')
    expect(
      within(screen.getByTestId('avatar-shape-grid'))
        .getByLabelText(derived.shape)
        .getAttribute('aria-pressed')
    ).toBe('true')
  })

  test('重置 → onChange(null)（写回派生态）', () => {
    const onChange = vi.fn()
    render(
      <AgentAvatarEditor
        agentId="daily"
        value={{ type: 'bot', shape: 'diamond', color: 'teal' }}
        onChange={onChange}
      />
    )
    fireEvent.click(screen.getByTestId('avatar-reset'))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  test('随机骰子 → shuffledAgentAvatar 语义（≠ 当前，确定性）', () => {
    const onChange = vi.fn()
    const explicit = { type: 'bot' as const, shape: 'diamond' as const, color: 'teal' as const }
    render(<AgentAvatarEditor agentId="daily" value={explicit} onChange={onChange} />)
    fireEvent.click(screen.getByTestId('avatar-shuffle'))
    const next = onChange.mock.calls[0][0]
    expect(next).toEqual(shuffledAgentAvatar('daily', explicit))
    expect(next).not.toEqual(explicit)
  })
})
