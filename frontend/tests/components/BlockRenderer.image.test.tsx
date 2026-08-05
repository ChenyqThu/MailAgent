// @vitest-environment happy-dom
//
// BlockRenderer `image` block — wired to ProgressiveImage (0804 dogfood follow-up: beUI
// image-generation state-table adaptation, see ProgressiveImage.tsx header). This only asserts
// the wiring (real consumption point, not just an unused component): src/alt reach the <img>, and
// the load/error lifecycle actually flows through to the rendered DOM.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import i18n from '@shared/i18n'
import { BlockRenderer } from '../../src/shared/components/agents/BlockRenderer'
import { type RenderCtx } from '../../src/shared/components/agents/lib'
import type { ReportBlock, ReportImageBlock } from '@shared/api/types'

await i18n.changeLanguage('zh-CN')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function makeCtx(): RenderCtx {
  return {
    layout: 'console',
    rowStyle: 'list',
    dense: true,
    aiSummary: 'hover',
    onOpenEmail: vi.fn(),
    onJump: vi.fn()
  }
}

function makeImageBlock(over: Partial<ReportImageBlock> = {}): ReportImageBlock {
  return {
    type: 'image',
    src: '/api/reports/attachments/42',
    alt: '季度趋势图',
    ...over
  }
}

describe('BlockRenderer — image block 接 ProgressiveImage', () => {
  test('渲染出 <img>，src/alt 透传', () => {
    const blocks: ReportBlock[] = [makeImageBlock()]
    render(<BlockRenderer blocks={blocks} ctx={makeCtx()} />)

    const img = screen.getByAltText('季度趋势图') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('/api/reports/attachments/42')
    // pending 态：还没 fire load，opacity 应为 0（真的接上了状态机，不是静态 <img>）。
    expect(img.style.opacity).toBe('0')
  })

  test('onLoad 后：opacity 变为 1（不是一挂载就恒定可见的老 <img>）', () => {
    const blocks: ReportBlock[] = [makeImageBlock()]
    render(<BlockRenderer blocks={blocks} ctx={makeCtx()} />)

    const img = screen.getByAltText('季度趋势图') as HTMLImageElement
    fireEvent.load(img)
    expect(img.style.opacity).toBe('1')
  })

  test('加载失败：<img> 被卸载，改渲染 ImageOff 回退（不是浏览器原生 broken-image 图标）', () => {
    const blocks: ReportBlock[] = [makeImageBlock()]
    const { container } = render(<BlockRenderer blocks={blocks} ctx={makeCtx()} />)

    fireEvent.error(screen.getByAltText('季度趋势图'))
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByRole('img', { name: '图片加载失败' })).toBeTruthy()
  })

  test('caption 仍原样渲染在图片下方', () => {
    const blocks: ReportBlock[] = [makeImageBlock({ caption: '图 1：季度收件量趋势' })]
    render(<BlockRenderer blocks={blocks} ctx={makeCtx()} />)
    expect(screen.getByText('图 1：季度收件量趋势')).toBeTruthy()
  })
})
