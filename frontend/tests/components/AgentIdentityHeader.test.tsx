// @vitest-environment happy-dom
//
// 0804 dogfood 头像批（WP3）——「头像 + 名称」抽屉统一头部：
//   • 3a 四角白边：@oreo-design/avatar 生成的 SVG 自带一层**不透明方形底 rect**（浅色
//     #ffffff / 深色 #0b0b0d），画在圆形 mask 之外。顶层列表的 AgentAvatar 靠
//     overflow-hidden+rounded-full 裁掉了它，编辑器两张网格没有那层裁剪 → 露白。
//     修法 = 网格项传 background={null}。断言直接查 SVG 里那张满幅 rect 在不在
//     （明暗两主题走同一段代码：库只是把 fill 换个色，rect 在不在由 background 决定，
//     故一个断言即钉死两主题；有意不去驱动 appearance —— 本 App 从不传该参数）。
//   • 3b 默认折叠：只渲染「头像 + 名称」一行，点「更换」才展开编辑器。
//   • 3e 两种名称语义：可编辑（custom/search）与只读（三个预设单例行）。
//   • i18n zh/en agents.avatar key 对齐。
//   • WP7 上传：图片形态渲染成图片元素、失败出人话文案、点候选隐式切回生成式。
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import i18n from '@shared/i18n'
import { AgentIdentityHeader } from '../../src/shared/components/agents/AgentAvatar'
import { fileToAvatarImage } from '../../src/shared/components/agents/avatarImage'
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

/** 库自带的方形底 rect（`<rect width="100%" height="100%" fill="…"/>`）张数。 */
function backgroundRects(root: HTMLElement): number {
  return root.querySelectorAll('rect[width="100%"][height="100%"]').length
}

describe('AgentIdentityHeader — 折叠 / 名称两态（3b / 3e）', () => {
  test('默认折叠：形状与配色网格都不在场，点「更换」才展开、再点「收起」收回', () => {
    render(<AgentIdentityHeader agentId="daily" value={null} onChange={vi.fn()} name="日报" />)
    expect(screen.queryByTestId('avatar-shape-grid')).toBeNull()
    expect(screen.queryByTestId('avatar-palette-grid')).toBeNull()

    const toggle = screen.getByRole('button', { name: '更换' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('avatar-shape-grid')).toBeTruthy()
    expect(screen.getByTestId('avatar-palette-grid')).toBeTruthy()
    // 「换一换」（随机）在展开面板里，不是新需求（3c 的前提有误，它一直都在）。
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

  test('选形状 / 选配色 → onChange 携带完整身份（含派生 palette / shape）', () => {
    const onChange = vi.fn()
    render(<AgentIdentityHeader agentId="daily" value={null} onChange={onChange} name="日报" />)
    fireEvent.click(screen.getByRole('button', { name: '更换' }))

    fireEvent.click(within(screen.getByTestId('avatar-shape-grid')).getByLabelText('Jade'))
    expect(onChange.mock.calls[0][0]).toMatchObject({ shape: 'jade' })

    fireEvent.click(within(screen.getByTestId('avatar-palette-grid')).getByLabelText('Aurora Pink'))
    expect(onChange.mock.calls[1][0]).toMatchObject({ palette: 'aurora-pink' })
  })
})

describe('AgentAvatarEditor 网格四角白边（3a）', () => {
  test('两张网格的候选项都不带库自带方形底 rect —— 而头像预览带（证明探针有效）', () => {
    const { container } = render(
      <AgentIdentityHeader agentId="daily" value={null} onChange={vi.fn()} name="日报" />
    )
    // 控制组：头部预览走 AgentAvatar 包装（rounded-full + overflow-hidden 裁掉底 rect），
    // 底 rect 仍在 SVG 里 —— 探针查得到它，说明下面两条「查不到」不是假阴性。
    expect(backgroundRects(container)).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: '更换' }))
    const shapeGrid = screen.getByTestId('avatar-shape-grid')
    const paletteGrid = screen.getByTestId('avatar-palette-grid')
    // 网格确实渲染了头像（不是「没渲染所以查不到 rect」的空断言）。
    expect(shapeGrid.querySelectorAll('svg').length).toBe(6)
    expect(paletteGrid.querySelectorAll('svg').length).toBeGreaterThan(10)
    expect(backgroundRects(shapeGrid)).toBe(0)
    expect(backgroundRects(paletteGrid)).toBe(0)
  })
})

describe('头像上传（WP7）', () => {
  const DATA_URI = `data:image/webp;base64,${'A'.repeat(40)}`

  function expand(): HTMLInputElement {
    fireEvent.click(screen.getByRole('button', { name: '更换' }))
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
    pick(expand())
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ type: 'image', data: DATA_URI }))

    // 父层回填后：头部预览是 <img src=dataURI>，生成式 SVG 不再渲染。
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
    // 展开面板里的候选网格仍在（它们是「切回生成式」的入口），但头部预览不再有 SVG。
    const header = img?.closest('span')
    expect(header?.querySelector('svg')).toBeNull()
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
      pick(expand())
      expect((await screen.findByRole('alert')).textContent).toBe(text)
      unmount()
    }
    expect(onChange).not.toHaveBeenCalled()
  })

  test('上传态下点任一形状 → 隐式切回生成式（携带 id 派生的 palette/variant，不留 image 残留）', () => {
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
    // 上传态下 shape/palette 都不生效 → 网格不该高亮任何一项（高亮一个看不见的配色是谎）。
    const grid = screen.getByTestId('avatar-palette-grid')
    expect(grid.querySelectorAll('[aria-pressed="true"]').length).toBe(0)

    fireEvent.click(within(screen.getByTestId('avatar-shape-grid')).getByLabelText('Jade'))
    const next = onChange.mock.calls[0][0]
    expect(next).toMatchObject({ shape: 'jade' })
    expect(next.type).toBeUndefined()
    expect(next.data).toBeUndefined()
    expect(typeof next.palette).toBe('string')
  })

  test('上传失败后再点候选 → 头像换掉的同时报错行消失（不留下"这次也失败了"的假象）', async () => {
    mockedProcess.mockResolvedValue({ ok: false, reason: 'too_large' })
    const onChange = vi.fn()
    render(<AgentIdentityHeader agentId="daily" value={null} onChange={onChange} name="日报" />)
    pick(expand())
    expect((await screen.findByRole('alert')).textContent).toBe(
      zhCommon.agents.avatar.uploadErr.too_large
    )

    fireEvent.click(screen.getByRole('button', { name: '换一换' }))
    expect(onChange).toHaveBeenCalledTimes(1)
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
