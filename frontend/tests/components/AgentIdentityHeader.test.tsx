// @vitest-environment happy-dom
//
// 「头像 + 名称」抽屉统一头部（0804 dogfood 3b/3e）+ 08-12 living-bot-avatar 编辑器接线：
//   • 3b 默认折叠：只渲染「头像 + 名称」一行，点「更换」才展开编辑器（Bot/上传 tab）。
//   • 3e 两种名称语义：可编辑（custom/search）与只读（三个预设单例行）。
//   • WP7 上传：图片形态渲染成图片元素、失败出人话文案、Bot tab 点候选隐式切回 bot 身份。
//   • i18n zh/en agents.avatar key 对齐。
// （oreo 头像库时代的「四角白边」探针已随该依赖退役：BotAvatar 是透明底 SVG，
//   没有那层库自带的满幅方形 rect。）
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import i18n from '@shared/i18n'
import { AgentIdentityHeader } from '../../src/shared/components/agents/AgentAvatar'
import { resolveAgentAvatar } from '../../src/shared/components/agents/agentAvatarIdentity'
import { fileToAvatarImage } from '../../src/shared/components/agents/avatarImage'
import { BOT_AVATAR_COLORS } from '../../src/shared/bot-avatar/colors'
import { BOT_AVATAR_SHAPES } from '../../src/shared/bot-avatar/shapes'
import zhCommon from '../../src/shared/i18n/locales/zh-CN/common.json'
import enCommon from '../../src/shared/i18n/locales/en-US/common.json'

// canvas / createImageBitmap 在 happy-dom 下不存在 —— 处理逻辑本身在
// tests/components/avatarImage.test.ts 里用注入 deps 测，这里只测组件接线。
vi.mock('../../src/shared/components/agents/avatarImage', () => ({
  fileToAvatarImage: vi.fn()
}))
const mockedProcess = vi.mocked(fileToAvatarImage)

await i18n.changeLanguage('zh-CN')

afterEach(cleanup)

describe('AgentIdentityHeader — 折叠 / 名称两态（3b / 3e）', () => {
  test('默认折叠：形状与颜色网格都不在场，点「更换」才展开、再点「收起」收回', () => {
    render(<AgentIdentityHeader agentId="daily" value={null} onChange={vi.fn()} name="日报" />)
    expect(screen.queryByTestId('avatar-shape-grid')).toBeNull()
    expect(screen.queryByTestId('avatar-color-grid')).toBeNull()

    const toggle = screen.getByRole('button', { name: '更换' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    // value 非上传图 → 默认落 Bot tab：8 形网格 + 11 色 swatch + 随机骰子。
    expect(screen.getByTestId('avatar-shape-grid')).toBeTruthy()
    expect(screen.getByTestId('avatar-color-grid')).toBeTruthy()
    expect(screen.getByRole('button', { name: '换一换' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '收起' }))
    expect(screen.queryByTestId('avatar-shape-grid')).toBeNull()
  })

  test('给了 onNameChange → 名称可编辑；省略 → 只读展示（预设单例行）', () => {
    const onNameChange = vi.fn()
    const { unmount } = render(
      <AgentIdentityHeader
        agentId="dms_helper"
        value={null}
        onChange={vi.fn()}
        name="DMS 审批助手"
        onNameChange={onNameChange}
        namePlaceholder="如 DMS 审批助手"
      />
    )
    fireEvent.change(screen.getByPlaceholderText('如 DMS 审批助手'), { target: { value: '巡检' } })
    expect(onNameChange).toHaveBeenCalledWith('巡检')
    unmount()

    render(
      <AgentIdentityHeader
        agentId="email_preprocess_agent"
        value={null}
        onChange={vi.fn()}
        name="AI 邮件预处理"
      />
    )
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText('AI 邮件预处理')).toBeTruthy()
  })

  test('选形状 / 选颜色 → onChange 携带完整 bot 身份（另一维取派生基底）', () => {
    const onChange = vi.fn()
    render(<AgentIdentityHeader agentId="daily" value={null} onChange={onChange} name="日报" />)
    fireEvent.click(screen.getByRole('button', { name: '更换' }))

    const base = resolveAgentAvatar('daily')
    const otherShape = BOT_AVATAR_SHAPES.find((shape) => shape !== base.shape)
    fireEvent.click(
      within(screen.getByTestId('avatar-shape-grid')).getByLabelText(otherShape ?? '')
    )
    expect(onChange.mock.calls[0][0]).toEqual({ type: 'bot', shape: otherShape, color: base.color })

    const otherColor = BOT_AVATAR_COLORS.find((color) => color !== base.color)
    fireEvent.click(
      within(screen.getByTestId('avatar-color-grid')).getByLabelText(otherColor ?? '')
    )
    expect(onChange.mock.calls[1][0]).toEqual({ type: 'bot', shape: base.shape, color: otherColor })
  })
})

describe('头像上传（WP7，编辑器 tab 化后走上传 tab）', () => {
  const DATA_URI = `data:image/webp;base64,${'A'.repeat(40)}`

  /** 展开编辑器并切到上传 tab，返回文件输入。 */
  function expandToUpload(): HTMLInputElement {
    fireEvent.click(screen.getByRole('button', { name: '更换' }))
    fireEvent.click(screen.getByTestId('avatar-tab-upload'))
    return screen.getByTestId('avatar-upload-input') as HTMLInputElement
  }

  function pick(input: HTMLInputElement, file = new File(['x'], 'a.png', { type: 'image/png' })) {
    fireEvent.change(input, { target: { files: [file] } })
  }

  test('选中文件 → onChange 收到 image 形态；预览换成图片元素（不再是生成 SVG）', async () => {
    mockedProcess.mockResolvedValue({
      ok: true,
      avatar: { type: 'image', data: DATA_URI },
      bytes: 2048
    })
    const onChange = vi.fn()
    const { rerender, container } = render(
      <AgentIdentityHeader agentId="daily" value={null} onChange={onChange} name="日报" />
    )
    pick(expandToUpload())
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ type: 'image', data: DATA_URI }))

    // 父层回填后：头部预览是 <img src=dataURI>，bot SVG 不再渲染在头部外壳里。
    rerender(
      <AgentIdentityHeader
        agentId="daily"
        value={{ type: 'image', data: DATA_URI }}
        onChange={onChange}
        name="日报"
      />
    )
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe(DATA_URI)
    const header = img?.closest('span')
    expect(header?.querySelector('svg')).toBeNull()
  })

  test('图片身份展开 → 编辑器初始落上传 tab（不闪回 Bot tab）', () => {
    render(
      <AgentIdentityHeader
        agentId="daily"
        value={{ type: 'image', data: DATA_URI }}
        onChange={vi.fn()}
        name="日报"
      />
    )
    fireEvent.click(screen.getByRole('button', { name: '更换' }))
    expect(screen.getByTestId('avatar-upload-input')).toBeTruthy()
    expect(screen.queryByTestId('avatar-shape-grid')).toBeNull()
  })

  test('处理失败 → 展示对应人话文案，且不落任何值', async () => {
    const onChange = vi.fn()
    for (const [reason, text] of [
      ['too_large', zhCommon.agents.avatar.uploadErr.too_large],
      ['source_too_large', zhCommon.agents.avatar.uploadErr.source_too_large],
      ['not_image', zhCommon.agents.avatar.uploadErr.not_image],
      ['decode_failed', zhCommon.agents.avatar.uploadErr.decode_failed]
    ] as const) {
      mockedProcess.mockResolvedValue({ ok: false, reason })
      const { unmount } = render(
        <AgentIdentityHeader agentId="daily" value={null} onChange={onChange} name="日报" />
      )
      pick(expandToUpload())
      expect((await screen.findByRole('alert')).textContent).toBe(text)
      unmount()
    }
    expect(onChange).not.toHaveBeenCalled()
  })

  test('上传态切到 Bot tab → 网格高亮派生基底；点任一形状 → 隐式切回 bot 身份（不留 image 残留）', () => {
    const onChange = vi.fn()
    render(
      <AgentIdentityHeader
        agentId="daily"
        value={{ type: 'image', data: DATA_URI }}
        onChange={onChange}
        name="日报"
      />
    )
    fireEvent.click(screen.getByRole('button', { name: '更换' }))
    fireEvent.click(screen.getByTestId('avatar-tab-bot'))

    // 上传态 resolve 落 id 派生基底 —— 网格高亮它（prd §6.2：切到 Bot tab 显示派生基底）。
    const base = resolveAgentAvatar('daily')
    const shapeGrid = screen.getByTestId('avatar-shape-grid')
    expect(within(shapeGrid).getByLabelText(base.shape).getAttribute('aria-pressed')).toBe('true')

    const otherShape = BOT_AVATAR_SHAPES.find((shape) => shape !== base.shape)
    fireEvent.click(within(shapeGrid).getByLabelText(otherShape ?? ''))
    const next = onChange.mock.calls[0][0]
    expect(next).toEqual({ type: 'bot', shape: otherShape, color: base.color })
    expect(next.data).toBeUndefined()
  })

  test('上传失败后再点候选 → 头像换掉的同时报错不再出现（不留下"这次也失败了"的假象）', async () => {
    mockedProcess.mockResolvedValue({ ok: false, reason: 'too_large' })
    const onChange = vi.fn()
    render(<AgentIdentityHeader agentId="daily" value={null} onChange={onChange} name="日报" />)
    pick(expandToUpload())
    expect((await screen.findByRole('alert')).textContent).toBe(
      zhCommon.agents.avatar.uploadErr.too_large
    )

    fireEvent.click(screen.getByTestId('avatar-tab-bot'))
    fireEvent.click(screen.getByRole('button', { name: '换一换' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    // 回到上传 tab：报错已被这次成功落值清掉，不残留。
    fireEvent.click(screen.getByTestId('avatar-tab-upload'))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('i18n — agents.avatar key 对齐', () => {
  test('zh / en key 一致（含 uploadErr 子节 —— 少一条 reason 就会显示 raw key）', () => {
    expect(Object.keys(zhCommon.agents.avatar).sort()).toEqual(
      Object.keys(enCommon.agents.avatar).sort()
    )
    expect(Object.keys(zhCommon.agents.avatar.uploadErr).sort()).toEqual(
      Object.keys(enCommon.agents.avatar.uploadErr).sort()
    )
  })
})
