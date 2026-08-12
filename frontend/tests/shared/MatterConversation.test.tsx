// @vitest-environment happy-dom
//
// 0812 —— 事项对话收口进主 AI Chat 后，「事项那几件事」的契约。前身是 MatterChatPanel.test.tsx
// （那套面板是设计稿明令禁止的第二套 chat UI，已删）；断言对象从「面板」换成 useMatterConversation
// 产出的绑定，覆盖面一条不减：
//   · 可移除的事项 chip（移除后不再自动重新 seed）
//   · 快照 fail-soft（读不到不挡对话）
//   · 上下文缺口卡 + 授权扩检索
//   · 写入回执 surface（没有它，matter 写入卡会退化成通用工具卡）
//   · 锚点二源：会话行自己的 anchor 优先于 dock 带的种子；种子只在空会话上采纳
//
// 不再覆盖 selectMatterSessions —— 会话发现现在整条走 serve-api 的 list-for-matter 端点
// （AssistantChatModal 里那个 effect），客户端不再有那份筛选函数。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import i18n from '@shared/i18n'
import type { MatterContextSnapshotPayload } from '@shared/api/matters'
import type { MatterChatTarget } from '@shared/state/ai-chat-panel'

const { chatApi, mattersApi, toastError } = vi.hoisted(() => ({
  chatApi: {
    contextSnapshot: vi.fn(),
    applyUndo: vi.fn()
  },
  mattersApi: {
    discoverResourceSuggestions: vi.fn()
  },
  toastError: vi.fn()
}))

vi.mock('@shared/components/matters/hooks', () => ({
  useMattersApi: () => mattersApi,
  useMatterChatApi: () => chatApi,
  useMattersEnabled: () => true
}))
vi.mock('@shared/state/toast', () => ({
  toastError,
  toastSuccess: vi.fn(),
  toastInfo: vi.fn()
}))

const { useMatterConversation, matterTargetFromSession, matterIdentityFromSession } =
  await import('@shared/components/matters/useMatterConversation')
type MatterConversationBinding = ReturnType<typeof useMatterConversation>
const { MatterContextGapCard } = await import('@shared/components/matters/MatterContextGapCard')

await i18n.changeLanguage('zh-CN')

const MATTER: MatterChatTarget = { id: 42, publicId: 'MAT-0042', title: 'Vendor launch' }

function snapshotPayload(): MatterContextSnapshotPayload {
  return {
    matter: {
      id: 42,
      public_id: 'MAT-0042',
      title: 'Vendor launch',
      type: null,
      tags: [],
      status: 'active',
      health: 'on_track',
      priority: 'p1',
      due_at: null,
      waiting_context: null,
      description: '',
      current_summary: null,
      version: 3,
      summary_accepted_at: 1
    },
    items: [
      { kind: 'action', title: 'a' },
      { kind: 'action', title: 'b' }
    ],
    stakeholders: [{ id: 1, display_name: 'Ann' }],
    resources: [
      {
        id: 5,
        kind: 'email',
        provider: 'mailagent',
        external_key: 'email:1',
        title: 'Vendor email',
        canonical_url: null,
        revision: null,
        access_policy: 'allowed',
        metadata: {},
        excerpt: 'excerpt'
      }
    ],
    events: [{ kind: 'item_added', happened_at: 2, actor_kind: 'user', summary: 'item_added' }]
  }
}

/** 观测面：把绑定里能脱离 thread 渲染的两块（chip / controls）摆出来，其余（anchor / surface /
 *  quickPrompts）写进 data-* 供断言 —— quickPrompts 里有 ThreadPrimitive.Suggestion，
 *  必须活在 runtime 里，这里只判它在不在。 */
interface HarnessProps {
  seed?: MatterChatTarget | null
  sessionMatter?: MatterChatTarget | null
  sessionMatterUnresolved?: boolean
  chatIsEmpty?: boolean
  navEpoch?: number
  sessionId?: number | null
}

/** 最近一次 render 的绑定 —— surface.runUndo / undoStates 没有 DOM 观测面，测试直接读它。 */
let lastBinding: MatterConversationBinding | null = null

function Harness(props: HarnessProps): React.JSX.Element {
  const binding = useMatterConversation({
    seed: props.seed ?? null,
    sessionMatter: props.sessionMatter ?? null,
    sessionMatterUnresolved: props.sessionMatterUnresolved,
    chatIsEmpty: props.chatIsEmpty ?? true,
    navEpoch: props.navEpoch ?? 0,
    sessionId: props.sessionId ?? null,
    enabled: true,
    thinkingEnabled: false
  })
  lastBinding = binding
  return (
    <div
      data-testid="harness"
      data-anchor={binding.anchor?.publicId ?? ''}
      data-surface={binding.surface === null ? 'none' : binding.surface.publicId}
      data-prompts={binding.quickPrompts === null ? 'none' : 'present'}
    >
      {binding.controls}
      {binding.chip}
    </div>
  )
}

function renderBinding(props: HarnessProps = {}): {
  view: ReturnType<typeof render>
  rerender: (next: HarnessProps) => void
} {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  const view = render(
    <QueryClientProvider client={client}>
      <Harness {...props} />
    </QueryClientProvider>
  )
  return {
    view,
    rerender: (next) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <Harness {...next} />
        </QueryClientProvider>
      )
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  chatApi.contextSnapshot.mockResolvedValue(snapshotPayload())
  chatApi.applyUndo.mockResolvedValue({})
  mattersApi.discoverResourceSuggestions.mockResolvedValue({
    items: [],
    suppressed: [],
    local_candidate_count: 0,
    expanded: true
  })
})

afterEach(cleanup)

describe('useMatterConversation — 锚点与 chip', () => {
  test('dock 带的种子在空会话上变成一枚可移除 chip；移除后不再自动 seed', async () => {
    renderBinding({ seed: MATTER })
    expect(screen.getByText('MAT-0042 Vendor launch')).toBeTruthy()
    expect(screen.getByTestId('harness').dataset.anchor).toBe('MAT-0042')
    // 写入回执 surface 随锚点在场 —— 没有它 matter 写入卡会退化成通用工具卡。
    expect(screen.getByTestId('harness').dataset.surface).toBe('MAT-0042')
    // 快捷动作换成事项这一组（位置仍是全局面板的那个槽）。
    expect(screen.getByTestId('harness').dataset.prompts).toBe('present')

    fireEvent.click(screen.getByRole('button', { name: '移除上下文' }))
    await waitFor(() => expect(screen.queryByText('MAT-0042 Vendor launch')).toBeNull())
    // 种子被移除 → 这轮回落成普通对话（锚点没了，检索范围控件也跟着收起）。
    expect(screen.getByTestId('harness').dataset.anchor).toBe('')
    expect(screen.queryByTestId('matter-chat-controls')).toBeNull()
  })

  test('会话已经开始后不再采纳种子（chip 只在空会话上 seed）', () => {
    renderBinding({ seed: MATTER, chatIsEmpty: false })
    expect(screen.queryByText('MAT-0042 Vendor launch')).toBeNull()
    expect(screen.getByTestId('harness').dataset.anchor).toBe('')
  })

  test('历史里选中的事项会话按它自己的 anchor 认身份（与种子无关）', () => {
    // 关键回归：`anchor_type='matter'` 的历史会话此前会以 general 渲染 —— 丢事项上下文，
    // 也丢写入回执 surface。sessionMatter 就是那条修复路径的输入。
    renderBinding({ seed: null, sessionMatter: MATTER, chatIsEmpty: false })
    expect(screen.getByText('MAT-0042 Vendor launch')).toBeTruthy()
    expect(screen.getByTestId('harness').dataset.anchor).toBe('MAT-0042')
  })
})

describe('matterTargetFromSession — 历史会话认不认得出自己是事项对话', () => {
  const row = {
    anchor_type: 'matter',
    anchor_id: 42,
    matter_public_id: 'MAT-0042',
    matter_title: 'Vendor launch'
  }

  test('matter 行 → 完整身份', () => {
    expect(matterTargetFromSession(row)).toEqual(MATTER)
  })

  test('缺 public_id（老 serve-api / getSession 单行读）→ null，不拿 anchor_id 去猜编号', () => {
    expect(matterTargetFromSession({ ...row, matter_public_id: null })).toBeNull()
    expect(matterTargetFromSession({ ...row, matter_public_id: '' })).toBeNull()
  })

  test('非 matter 行恒 null —— email 的 anchor_id 与 matter.id 是两个 id 空间', () => {
    expect(matterTargetFromSession({ ...row, anchor_type: 'email' })).toBeNull()
    expect(matterTargetFromSession({ ...row, anchor_type: 'general' })).toBeNull()
    expect(matterTargetFromSession(null)).toBeNull()
  })
})

describe('matterIdentityFromSession — 🔴「缺元数据」与「普通会话」必须是两个态', () => {
  const row = {
    anchor_type: 'matter',
    anchor_id: 42,
    matter_public_id: 'MAT-0042',
    matter_title: 'Vendor launch'
  }

  test('拿得到编号 → resolved', () => {
    expect(matterIdentityFromSession(row)).toEqual({ state: 'resolved', target: MATTER })
  })

  test('缺编号 → unresolved（不是 none）—— 这正是 codex #2 的核心', () => {
    // 单条 getSession 曾不带 join 投影；两者都塌成 null 时，用户会在一个看起来正常的对话里
    // 以全局范围操作，可能命中错误的事项。
    expect(matterIdentityFromSession({ ...row, matter_public_id: null })).toEqual({
      state: 'unresolved',
      anchorId: 42
    })
    expect(matterIdentityFromSession({ ...row, matter_public_id: '' })).toEqual({
      state: 'unresolved',
      anchorId: 42
    })
    // 连内部 id 都没有的坏行同样不许当普通会话糊过去。
    expect(matterIdentityFromSession({ anchor_type: 'matter' }).state).toBe('unresolved')
  })

  test('非 matter 行 → none', () => {
    expect(matterIdentityFromSession({ ...row, anchor_type: 'email' })).toEqual({ state: 'none' })
    expect(matterIdentityFromSession({ ...row, anchor_type: 'general' })).toEqual({ state: 'none' })
    expect(matterIdentityFromSession(null)).toEqual({ state: 'none' })
  })
})

describe('useMatterConversation — 身份未就绪时整个绑定惰性', () => {
  test('unresolved → 无 chip / 无控件 / 无 surface / 无快捷 prompt', () => {
    renderBinding({ seed: MATTER, sessionMatterUnresolved: true })
    const harness = screen.getByTestId('harness')
    expect(harness.dataset.anchor).toBe('')
    expect(harness.dataset.surface).toBe('none')
    expect(harness.dataset.prompts).toBe('none')
    expect(screen.queryByTestId('matter-chat-controls')).toBeNull()
  })

  test('🔴 unresolved 时**绝不**退回去采纳 dock 带的种子（那会绑到另一件事上）', () => {
    // 半个事项 UI（chip 显示 B、这条历史其实锚在 A）比没有更危险：它让用户以为上下文就位了。
    renderBinding({ seed: MATTER, sessionMatterUnresolved: true, chatIsEmpty: true })
    expect(screen.queryByText('MAT-0042 Vendor launch')).toBeNull()
  })
})

describe('useMatterConversation — 快照 fail-soft', () => {
  test('快照读不到 → 说一句「读不到」，chip 与控件照常在（不挡对话）', async () => {
    chatApi.contextSnapshot.mockRejectedValue(
      Object.assign(new Error('nope'), { code: 'E_HTTP_500' })
    )
    renderBinding({ seed: MATTER })
    await waitFor(() => expect(screen.getByText('上下文计数暂时读不到，不影响对话。')).toBeTruthy())
    expect(screen.getByTestId('matter-chat-controls')).toBeTruthy()
    expect(screen.getByText('MAT-0042 Vendor launch')).toBeTruthy()
  })
})

describe('useMatterConversation — 检索范围开关已移除（恒全库）', () => {
  test('composer 上方不再有任何检索范围控件', async () => {
    renderBinding({ seed: MATTER })
    await waitFor(() => expect(screen.getByText('MAT-0042 Vendor launch')).toBeTruthy())
    // 0812 owner拍板：「单搞一个事项的检索范围没意义」。控件、两句说明、以及它背后的
    // recordChatScope 审计链一并退役 —— 事项对话恒全库。
    for (const label of ['检索范围', '本事项', '全库', '已允许全库检索', '检索范围限于本事项']) {
      expect(screen.queryByText(label), label).toBeNull()
    }
    // 缺口卡 / 快照失败提示都不在时，这一格整块不渲染（不留空容器）。
    expect(screen.queryByTestId('matter-chat-controls')).toBeNull()
  })
})

describe('useMatterConversation — 撤销回执的身份（codex #6）', () => {
  const DESCRIPTOR = { tool: 'matter_update', input: { public_id: 'MAT-0042' }, label: '还原标题' }

  test('换会话（同一件事）→ 上一场的回执状态不继承', async () => {
    const { rerender } = renderBinding({ sessionMatter: MATTER, chatIsEmpty: false, sessionId: 1 })
    act(() => lastBinding!.surface!.runUndo('tc-1', DESCRIPTOR))
    await waitFor(() => expect(lastBinding!.surface!.undoStates['tc-1']).toBe('done'))
    // 只按 navEpoch 复位时，这里会把上一场的 'done' 带进新会话。
    rerender({ sessionMatter: MATTER, chatIsEmpty: false, sessionId: 2 })
    expect(lastBinding!.surface!.undoStates).toEqual({})
  })

  test('换事项 → 同样复位', async () => {
    const { rerender } = renderBinding({ sessionMatter: MATTER, chatIsEmpty: false, sessionId: 1 })
    act(() => lastBinding!.surface!.runUndo('tc-1', DESCRIPTOR))
    await waitFor(() => expect(lastBinding!.surface!.undoStates['tc-1']).toBe('done'))
    rerender({
      sessionMatter: { id: 99, publicId: 'MAT-0099', title: 'Другое' },
      chatIsEmpty: false,
      sessionId: 1
    })
    expect(lastBinding!.surface!.undoStates).toEqual({})
  })

  test('🔴 拿着**旧** surface 触发撤销（卡片渲染于切换之前）→ 不对新事项执行反向操作', async () => {
    const { rerender } = renderBinding({ sessionMatter: MATTER, chatIsEmpty: false, sessionId: 1 })
    const staleSurface = lastBinding!.surface!
    rerender({
      sessionMatter: { id: 99, publicId: 'MAT-0099', title: 'Другое' },
      chatIsEmpty: false,
      sessionId: 1
    })
    await waitFor(() => expect(lastBinding!.surface!.publicId).toBe('MAT-0099'))
    act(() => staleSurface.runUndo('tc-stale', DESCRIPTOR))
    expect(chatApi.applyUndo).not.toHaveBeenCalled()
  })
})

describe('MatterContextGapCard — 显式授权才扩检索', () => {
  test('渲染警告卡与它的授权动作', () => {
    const onExpand = vi.fn()
    render(<MatterContextGapCard onExpand={onExpand} />)
    expect(screen.getByText('上下文缺口 · 需要你授权扩大检索')).toBeTruthy()
    fireEvent.click(screen.getByText('授权扩检索'))
    expect(onExpand).toHaveBeenCalledTimes(1)
  })

  test('点了才检索，并把「此前已标记不相关」的命中如实说出来', async () => {
    const payload = snapshotPayload()
    payload.resources = []
    chatApi.contextSnapshot.mockResolvedValue(payload)
    mattersApi.discoverResourceSuggestions.mockResolvedValue({
      items: [{}, {}],
      suppressed: [{ external_key: 'email:9', reason: 'rejected_same_evidence' }],
      local_candidate_count: 1,
      expanded: true
    })
    renderBinding({ seed: MATTER })
    await waitFor(() => expect(screen.getByTestId('matter-context-gap')).toBeTruthy())
    expect(mattersApi.discoverResourceSuggestions).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('授权扩检索'))
    await waitFor(() =>
      expect(mattersApi.discoverResourceSuggestions).toHaveBeenCalledWith('MAT-0042', {
        query: 'Vendor launch',
        expandReason: 'context_gap',
        limit: 10
      })
    )
    expect(
      await screen.findByText('已加入 2 条建议态资源 · 1 条此前已标记不相关，已跳过')
    ).toBeTruthy()
  })
})
