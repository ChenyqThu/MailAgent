// @vitest-environment happy-dom
//
// 批 M5 —— 资料详情面板对齐设计稿 v3 §5（V3-16/17/18/20/21）。
//
// 这里盯的是**只有打开抽屉才看得见**的那几件事，逐属性对照表
// （`.trellis/tasks/08-12-matters-design-alignment/research/m5-resource-drawer-parity.md`）
// 里判「改」的 26 个结构点中，会静默退化的那些：
//   · 摘要三态 —— `resource.sum` 是 v56 新列（批 M4），读错字段的后果是「框恒在、内容恒空」，
//     和这一节 0811 那次假修复一模一样，肉眼 dogfood 只会看到"还没有摘要"而以为是没跑过；
//   · 原文地址行的打开 / 复制 —— 两个 icon 钮没有文字，回归了也不会有人一眼发现；
//   · 可见性 segmented —— 从独立 section 收进属性行，写入参数（scope='resource'）漏了就会
//     变成"只改本事项"，而后端语义是跨事项共享；
//   · 🔴 边界回归：thread 的「暂停订阅」按钮设计稿里没有，本批**不许**顺手删。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import i18n from '@shared/i18n'
import type {
  MatterAccessPolicy,
  MatterResourceKind,
  MatterResourceListItem,
  MatterResourceSummarySource
} from '@shared/api/types/matter'

const { navigate, patchResource, unlinkResource, toastSuccess, toastError, writeText } = vi.hoisted(
  () => ({
    navigate: vi.fn(),
    patchResource: vi.fn(),
    unlinkResource: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    writeText: vi.fn()
  })
)

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@shared/components/matters/hooks', () => ({
  useMattersApi: () => ({ patchResource, unlinkResource }),
  useMatterChatApi: () => ({ applyUndo: vi.fn() })
}))
vi.mock('@shared/state/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/state/toast')>()
  return { ...actual, toastSuccess, toastError }
})

const { ResourceDrawer } = await import('@shared/components/matters/ResourceDrawer')

await i18n.changeLanguage('zh-CN')

interface ResourceOverrides {
  kind?: MatterResourceKind
  provider?: string
  externalKey?: string
  canonicalUrl?: string | null
  accessPolicy?: MatterAccessPolicy
  sum?: string | null
  sumSrc?: MatterResourceSummarySource | null
  metadata?: Record<string, unknown>
}

function resourceItem(overrides: ResourceOverrides = {}): MatterResourceListItem {
  return {
    resource: {
      id: 7,
      kind: overrides.kind ?? 'doc',
      provider: overrides.provider ?? 'notion',
      external_key: overrides.externalKey ?? 'page:abc',
      canonical_url: overrides.canonicalUrl === undefined ? null : overrides.canonicalUrl,
      title: '交付方案 v3',
      metadata: overrides.metadata ?? {},
      sum: overrides.sum ?? null,
      sum_src: overrides.sumSrc ?? null,
      sum_at: overrides.sum ? 1_700_000_000_000 : null,
      revision: null,
      content_hash: null,
      permission_state: null,
      sync_state: null,
      access_policy: overrides.accessPolicy ?? 'allowed',
      last_checked_at: 1_700_000_000_000,
      created_at: 0,
      updated_at: 0,
      available: true
    },
    link: {
      id: 7,
      matter_id: 1,
      resource_id: 7,
      relation_type: null,
      pinned: false,
      added_by_kind: 'user',
      added_by_id: null,
      confidence: null,
      provenance: {},
      confirmed_at: 1,
      sub_state: 'none',
      deleted_at: null,
      created_at: 0,
      updated_at: 0
    }
  } as unknown as MatterResourceListItem
}

function renderDrawer(item: MatterResourceListItem): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ResourceDrawer
        open
        matterId="MAT-0001"
        matterVersion={3}
        item={item}
        onClose={() => {}}
        onChanged={() => {}}
      />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  patchResource.mockResolvedValue({})
  unlinkResource.mockResolvedValue({})
  writeText.mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true
  })
})

afterEach(cleanup)

describe('ResourceDrawer —— V3-16 资料摘要三态', () => {
  test('有摘要 → 渲染摘要正文，且标注「Agent 概括 · 基于缓存摘录」', () => {
    renderDrawer(resourceItem({ sum: '供应商已确认交付窗口在 9 月第二周。', sumSrc: 'agent' }))
    expect(screen.getByText('供应商已确认交付窗口在 9 月第二周。')).toBeTruthy()
    expect(screen.getByText('Agent 概括 · 基于缓存摘录')).toBeTruthy()
    expect(screen.queryByText(/还没有摘要/)).toBeNull()
  })

  test('摘要来自邮件（sum_src=mail）→ 标注改成「摘要 · 沿用邮件自带」', () => {
    renderDrawer(
      resourceItem({
        kind: 'email',
        provider: 'mailagent',
        externalKey: 'email:905',
        sum: '对方在问回款节点。',
        sumSrc: 'mail'
      })
    )
    expect(screen.getByText('摘要 · 沿用邮件自带')).toBeTruthy()
    expect(screen.queryByText('Agent 概括 · 基于缓存摘录')).toBeNull()
  })

  test('无摘要 → 虚线空态，且不显示来源标注（没有摘要就没有出处可说）', () => {
    renderDrawer(resourceItem({ sum: null }))
    const empty = screen.getByText(/还没有摘要/)
    expect(empty.className).toContain('border-dashed')
    expect(screen.queryByText('Agent 概括 · 基于缓存摘录')).toBeNull()
    expect(screen.queryByText('摘要 · 沿用邮件自带')).toBeNull()
  })

  test('「缓存摘录」是另一个概念：没有摘录就不渲染那一节，有摘要也不占位', () => {
    renderDrawer(resourceItem({ sum: '一句摘要。', sumSrc: 'agent' }))
    expect(screen.queryByText('缓存摘录')).toBeNull()
    renderDrawer(resourceItem({ metadata: { cached_excerpt: '原始缓存文本片段' } }))
    expect(screen.getAllByText('缓存摘录').length).toBe(1)
    expect(screen.getByText('原始缓存文本片段')).toBeTruthy()
  })
})

describe('ResourceDrawer —— V3-20 原文地址行', () => {
  test('有 canonical_url → mono 链接 + 打开 / 复制两个按钮；打开走 window.open', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    renderDrawer(resourceItem({ canonicalUrl: 'https://www.notion.so/plan-v3' }))
    expect(screen.getByText('原文地址')).toBeTruthy()
    const link = screen.getByRole('button', { name: 'https://www.notion.so/plan-v3' })
    expect(link.className).toContain('font-mono')
    // 右上角与地址行的跳转钮共用「在 {来源} 中打开」这句 —— 来源名取自 provider 词表。
    const openButtons = screen.getAllByRole('button', { name: '在 Notion 中打开' })
    expect(openButtons.length).toBe(2)
    fireEvent.click(openButtons[1])
    expect(open).toHaveBeenCalledWith(
      'https://www.notion.so/plan-v3',
      '_blank',
      'noopener,noreferrer'
    )
    open.mockRestore()
  })

  test('复制链接 → 写剪贴板 + 成功 toast', async () => {
    renderDrawer(resourceItem({ canonicalUrl: 'https://www.notion.so/plan-v3' }))
    fireEvent.click(screen.getByRole('button', { name: '复制链接' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://www.notion.so/plan-v3'))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('链接已复制'))
  })

  test('邮件类资料没有 canonical_url → 不渲染原文地址行（不做空行 / 死控件）', () => {
    renderDrawer(resourceItem({ kind: 'email', provider: 'mailagent', externalKey: 'email:905' }))
    expect(screen.queryByText('原文地址')).toBeNull()
    // 头部跳转仍在，只是指向本地邮件库。
    expect(screen.getByRole('button', { name: '在 本地邮件库 中打开' })).toBeTruthy()
  })
})

describe('ResourceDrawer —— V3-21 可见性内嵌 segmented', () => {
  test('切到「仅元数据」→ 带 scope=resource 写服务端（跨事项语义不能丢）', async () => {
    renderDrawer(resourceItem({ canonicalUrl: 'https://www.notion.so/plan-v3' }))
    fireEvent.click(screen.getByRole('tab', { name: '仅元数据' }))
    await waitFor(() =>
      expect(patchResource).toHaveBeenCalledWith(
        'MAT-0001',
        7,
        { access_policy: 'metadata_only', scope: 'resource' },
        { expectedVersion: 3 }
      )
    )
  })

  test('已是「仅元数据」→ 卡底补后果说明；「允许读取」时不补', () => {
    renderDrawer(resourceItem({ accessPolicy: 'metadata_only' }))
    expect(screen.getByText(/Agent 只能看到标题、版本与时间/)).toBeTruthy()
    cleanup()
    renderDrawer(resourceItem({ accessPolicy: 'allowed' }))
    expect(screen.queryByText(/Agent 只能看到标题、版本与时间/)).toBeNull()
    // 「改档影响所有事项」是本仓真实语义，任何档位都要在场。
    expect(screen.getByText(/改档会影响该资料在所有事项下的可见性/)).toBeTruthy()
  })

  test('「排除」档也解释后果（设计只画了两档，第三档不能是哑开关）', () => {
    renderDrawer(resourceItem({ accessPolicy: 'excluded' }))
    expect(screen.getByText(/Agent 完全看不到这份资料/)).toBeTruthy()
  })
})

describe('ResourceDrawer —— V3-18 属性行与边界', () => {
  test('六个属性行按设计顺序出现（原文地址随 URL 有无进出）', () => {
    renderDrawer(resourceItem({ canonicalUrl: 'https://www.notion.so/plan-v3' }))
    const labels = Array.from(document.querySelectorAll('dt')).map((node) => node.textContent)
    expect(labels).toEqual(['类型', '来源', '原文地址', '最近活动', '关联方式', '内容可见性'])
  })

  test('关联方式说真话：未确认的资料是「Agent 建议关联」，不是写死的「手动关联 · 已确认」', () => {
    const item = resourceItem()
    ;(item.link as { confirmed_at: number | null }).confirmed_at = null
    renderDrawer(item)
    expect(screen.getByText('Agent 建议关联')).toBeTruthy()
    expect(screen.queryByText('手动关联 · 已确认')).toBeNull()
  })

  test('🔴 边界 1：thread 资料底部仍有「暂停订阅」—— 设计稿没画不等于要删', () => {
    const item = resourceItem({ kind: 'thread', provider: 'mailagent', externalKey: 'thread:t1' })
    ;(item.link as { sub_state: string }).sub_state = 'active'
    renderDrawer(item)
    expect(screen.getByRole('button', { name: /暂停订阅/ })).toBeTruthy()
    // 边界 2：底部只有 置顶 / 订阅 / 解除关联，本批不新增也不误删别的按钮。
    expect(screen.getByRole('button', { name: /置顶/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /解除关联/ })).toBeTruthy()
  })
})
