// @vitest-environment happy-dom
//
// S5 —— 报告里的 `matter_item` 块（事项进展区）。
//
// 三条判据：
// ① 运行时 schema 收下合法块、坏块降级成 invalid（不连累同批的兄弟块）；
// ② 🔴 事项条目**不**被前面那个 section 的折叠容器吞掉 —— `_SECTION_CHILDREN` 只收邮件类
//    子块，事项条目是顶层 leaf，所以「事项进展」区默认可见、不需要用户先展开；
//    （若哪天把 'matter_item' 加进 `_SECTION_CHILDREN`，SectionGroup 按 email 数算
//    collapsible ⇒ 0 封 ⇒ 整组条目**一条都不渲染**。这条断言就是那个坑的哨兵。）
// ③ 点条目 → 记下目标事项 + 跳 /matters（`mailagent://matter/…` 不在 main 的 deeplink
//    词表里，报告页内跳转走 router）。
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } })
}))

const mockNavigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mockNavigate }))

import { BlockRenderer } from '../../src/shared/components/agents/BlockRenderer'
import type { RenderCtx } from '../../src/shared/components/agents/lib'
import { useMatterNavigation } from '../../src/shared/components/matters/navigation'
import { validateReportBlocks } from '../../src/shared/api/reportBlocks'
import type { ReportBlock, ReportMatterItemBlock, ReportSectionBlock } from '@shared/api/types'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useMatterNavigation.getState().clear()
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

function makeMatter(over: Partial<ReportMatterItemBlock> = {}): ReportMatterItemBlock {
  return {
    type: 'matter_item',
    public_id: 'MAT-0012',
    title: '合同签署',
    status: 'waiting',
    health: 'at_risk',
    priority: 'p0',
    deeplink: 'mailagent://matter/MAT-0012',
    summary: '等对方法务回签',
    progress: { done: 1, total: 3 },
    waiting_on: ['张三'],
    next_action: '催一下法务',
    signal_count: 2,
    ...over
  }
}

const MATTER_SECTION: ReportSectionBlock = {
  type: 'section',
  id: 'matters',
  title: '事项进展',
  icon: 'star',
  summary: '主线推进了一步。'
}

describe('matter_item 运行时契约', () => {
  test('合法块原样收下', () => {
    const [block] = validateReportBlocks([makeMatter()])
    expect(block).toMatchObject({ type: 'matter_item', public_id: 'MAT-0012', priority: 'p0' })
  })

  test('坏块降级成 invalid，兄弟块不受连累', () => {
    const blocks = validateReportBlocks([
      { type: 'matter_item', public_id: '', title: '空 id' },
      makeMatter({ public_id: 'MAT-0002' })
    ])
    expect(blocks[0]).toMatchObject({ type: 'invalid', original_type: 'matter_item' })
    expect(blocks[1]).toMatchObject({ type: 'matter_item', public_id: 'MAT-0002' })
  })

  test('后端加了没见过的 status 也不整块降级（渲染侧退回原样显示）', () => {
    const [block] = validateReportBlocks([makeMatter({ status: 'brand_new_status' })])
    expect(block).toMatchObject({ type: 'matter_item', status: 'brand_new_status' })
  })
})

describe('matter_item 渲染', () => {
  test('紧跟 section 的事项条目默认可见（不被折叠容器吞掉）', () => {
    const blocks: ReportBlock[] = [MATTER_SECTION, makeMatter()]
    render(<BlockRenderer blocks={blocks} ctx={makeCtx()} />)
    // 没有任何展开操作，条目锚点就已在 DOM 里。
    expect(document.getElementById('matter-MAT-0012')).not.toBeNull()
  })

  test('渲染标识 / 标题 / 摘要', () => {
    const { container } = render(<BlockRenderer blocks={[makeMatter()]} ctx={makeCtx()} />)
    const row = container.querySelector('#matter-MAT-0012') as HTMLElement
    expect(row.textContent).toContain('MAT-0012')
    expect(row.textContent).toContain('合同签署')
    expect(row.textContent).toContain('等对方法务回签')
  })

  test('点条目 → 记下目标事项并跳 /matters', () => {
    render(<BlockRenderer blocks={[makeMatter()]} ctx={makeCtx()} />)
    fireEvent.click(document.getElementById('matter-MAT-0012') as HTMLElement)
    expect(useMatterNavigation.getState().targetPublicId).toBe('MAT-0012')
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/matters' })
  })
})
