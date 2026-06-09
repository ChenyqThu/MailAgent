// @vitest-environment happy-dom
//
// PR G / Bug 2 回归 — 报告分节摘要里的 [文本](#email-<id>) 跳转链接，在 section
// 折叠态点击要先展开该 section 再滚动高亮（之前折叠态锚点不在 DOM → scrollToEmail
// no-op → 用户「没反应」）。
//
// happy-dom 不做真实布局，scrollToEmail 的几何/滚动是 no-op；这里只锁「折叠态点跳转
// 链接 → 目标 email_item 锚点挂载（section 展开）」这一受控折叠行为。scrollToEmail
// 实际滚动效果需打包后人工确认。
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// Mock only scrollToEmail so we can assert it's invoked with the right id
// (happy-dom has no real layout/scroll). Everything else (RenderCtx, renderSummary,
// priorityTone…) stays real via importActual so BlockRenderer renders normally.
vi.mock('../../src/shared/components/agents/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/components/agents/lib')>()
  return { ...actual, scrollToEmail: vi.fn() }
})

import { BlockRenderer } from '../../src/shared/components/agents/BlockRenderer'
import { type RenderCtx, scrollToEmail } from '../../src/shared/components/agents/lib'
import type { ReportBlock, ReportEmailItemBlock, ReportSectionBlock } from '@shared/api/types'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function makeCtx(over: Partial<RenderCtx> = {}): RenderCtx {
  return {
    layout: 'console',
    rowStyle: 'list',
    dense: true,
    aiSummary: 'hover',
    onOpenEmail: vi.fn(),
    onJump: vi.fn(),
    ...over
  }
}

function makeEmail(internalId: number, subject: string): ReportEmailItemBlock {
  return {
    type: 'email_item',
    internal_id: internalId,
    subject,
    sender_name: 'Alice',
    time: '2026-06-08T09:00:00',
    source: { notion_url: null, app_deeplink: 'mailagent://email/' + internalId }
  }
}

// 一个 section（带含跳转链接的 summary）+ 该 section 内的一封 email。
function makeBlocks(emailId: number): ReportBlock[] {
  const sec: ReportSectionBlock = {
    type: 'section',
    id: 'sec-1',
    title: '需要关注',
    summary: `请看 [这封邮件](#email-${emailId}) 的进展。`
  }
  return [sec, makeEmail(emailId, '季度规划同步')]
}

describe('BlockRenderer — 折叠 section 摘要跳转链接', () => {
  test('折叠态：email_item 锚点初始不在 DOM', () => {
    render(<BlockRenderer blocks={makeBlocks(101)} ctx={makeCtx()} />)
    expect(document.getElementById('email-101')).toBeNull()
  })

  test('点摘要跳转链接 → 展开该 section（锚点挂载）', () => {
    const { container } = render(<BlockRenderer blocks={makeBlocks(202)} ctx={makeCtx()} />)

    // 折叠态：锚点尚未渲染。
    expect(document.getElementById('email-202')).toBeNull()

    // 摘要里的跳转链接（href="#email-202"）。
    const link = container.querySelector('a[href="#email-202"]')
    expect(link).not.toBeNull()

    fireEvent.click(link as HTMLAnchorElement)

    // 展开后 email_item 锚点已挂载。
    expect(document.getElementById('email-202')).not.toBeNull()
  })

  // 修复核心：折叠 section 内的 email，点 summary 跳转链接 → 先展开（锚点挂载）→
  // 再调 scrollToEmail(id)。jsdom/happy-dom 无真实滚动，故 mock scrollToEmail 验证调用。
  test('折叠态点跳转链接 → 展开 + scrollToEmail(id)（修复核心）', async () => {
    const sec: ReportSectionBlock = {
      type: 'section',
      id: 'sec-attention',
      title: '需要关注',
      summary: '处理进展见 [查看](#email-53933)。'
    }
    const blocks: ReportBlock[] = [sec, makeEmail(53933, '合同条款确认')]

    render(<BlockRenderer blocks={blocks} ctx={makeCtx()} />)

    // 初始折叠：列表未渲染 → 锚点不在 DOM。
    expect(document.getElementById('email-53933')).toBeNull()

    // 点击 summary 里的跳转链接。
    fireEvent.click(screen.getByRole('link', { name: '查看' }))

    // useEffect 在 DOM commit（section 展开）后才滚动 → 等展开 + effect 落定。
    await waitFor(() => {
      expect(document.getElementById('email-53933')).not.toBeNull()
    })
    await waitFor(() => {
      expect(scrollToEmail).toHaveBeenCalledWith(53933)
    })
  })
})
