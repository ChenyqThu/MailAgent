// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import i18n from '@shared/i18n'
import type { ReportAgentConfig } from '@shared/api/types'
import type {
  Matter,
  MatterResourceListItem,
  MatterRun,
  MatterUpdate
} from '@shared/api/types/matter'
import { MatterAgentConfigModal } from '@shared/components/matters/MatterAgentConfigModal'
import { MatterRunsPane } from '@shared/components/matters/MatterRunsPane'
import { MatterUpdateReview } from '@shared/components/matters/MatterUpdateReview'
import { resolveMatterCitationTarget } from '@shared/components/matters/navigation'
import { RunOverlay } from '@shared/components/matters/RunOverlay'

await i18n.changeLanguage('zh-CN')
afterEach(cleanup)

// 跟进配置模态会读全局 Matter Agent 的任务契约（「专属指令」旁的只读披露区），所以要
// 一个 QueryClient + 一个确定的响应。契约全文是本轮 dogfood 的正面诉求，必须真的渲染出来。
const CONTRACT_TEXT = '【任务契约】这是当前生效的全局任务契约全文。'

const renderModal = (ui: React.ReactElement): ReturnType<typeof render> => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: React.ReactNode }): React.ReactElement => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return render(ui, { wrapper })
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { content: '', defaultContent: CONTRACT_TEXT } })
    })
  )
})

afterEach(() => vi.unstubAllGlobals())

const run = (state: MatterRun['lifecycle_state'], updateId: number | null = null): MatterRun => ({
  id: 7,
  matter_id: 1,
  agent_profile_id: null,
  trigger_kind: 'manual',
  lifecycle_state: state,
  status: state === 'ok' || state === 'noop' || state === 'warn' || state === 'fail' ? state : null,
  model: null,
  usage: { tool_calls: 2 },
  cost_usd: null,
  error: state === 'fail' ? { message: 'boom' } : null,
  queued_at: 1,
  started_at: 1,
  completed_at: state === 'running' ? null : 1001,
  cancel_requested_at: null,
  canceled_at: state === 'canceled' ? 1001 : null,
  update_id: updateId,
  duration_ms: 1000
})

const matter: Matter = {
  id: 1,
  public_id: 'MAT-0001',
  title: 'Launch',
  background: '',
  goal: '',
  matter_type: null,
  tags: [],
  status: 'active',
  health: 'on_track',
  priority: 'p1',
  owner_id: null,
  source: 'desktop_ui',
  due_at: null,
  waiting_context: null,
  next_attention_at: null,
  attention_reason: null,
  last_activity_at: null,
  latest_accepted_update_id: null,
  current_summary: 'Old',
  summary_at: null,
  summary_by_kind: null,
  summary_by_id: null,
  version: 2,
  archived_at: null,
  archived_by_kind: null,
  archived_by_id: null,
  deleted_at: null,
  deleted_by_kind: null,
  deleted_by_id: null,
  purge_after: null,
  created_at: 1,
  updated_at: 1
}

const update: MatterUpdate = {
  id: 9,
  matter_id: 1,
  review_status: 'pending',
  summary: 'New',
  created_at: 2,
  change_count: 1,
  is_stale: false,
  agent_run_id: 7,
  confidence: 0.8,
  anchored_matter_version: 2,
  created_by_kind: 'agent',
  from_event_id: 1,
  to_event_id: 4,
  original_proposal: { open_questions: [] },
  reviewed_result: null,
  changes: [{ id: 'c1', kind: 'fact', text: 'Confirmed', sources: [] }],
  accepted_change_ids: null,
  citations: [],
  stale_at: null,
  stale_reason: null
}

const profile = {
  id: 'profile-1',
  type: 'custom',
  enabled: true,
  title: '客户推进 Agent'
} as ReportAgentConfig

const resource = (kind: 'email' | 'doc', externalKey: string): MatterResourceListItem => ({
  resource: {
    id: kind === 'email' ? 5 : 6,
    kind,
    provider: 'local',
    external_key: externalKey,
    canonical_url: null,
    title: kind === 'email' ? 'Source email' : 'Source doc',
    metadata: {},
    revision: null,
    content_hash: null,
    permission_state: null,
    sync_state: null,
    access_policy: 'private',
    last_checked_at: null,
    created_at: 1,
    updated_at: 1
  },
  link: {
    id: kind === 'email' ? 15 : 16,
    matter_id: 1,
    resource_id: kind === 'email' ? 5 : 6,
    relation_type: null,
    pinned: false,
    added_by_kind: 'user',
    added_by_id: null,
    confidence: null,
    provenance: {},
    confirmed_at: null,
    sub_state: 'active',
    deleted_at: null,
    created_at: 1,
    updated_at: 1
  }
})

describe('P4 renderer surfaces', () => {
  test('RunsPane renders terminal states and noop never offers review', () => {
    const review = vi.fn()
    render(
      <MatterRunsPane
        runs={[
          run('ok', 9),
          { ...run('noop'), id: 8 },
          { ...run('warn', 9), id: 10 },
          { ...run('fail'), id: 11 }
        ]}
        updates={[update]}
        onReview={review}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByText('完成')).toBeTruthy()
    expect(screen.getByText('无变化')).toBeTruthy()
    expect(screen.getAllByText('部分降级').length).toBeGreaterThan(0)
    expect(screen.getAllByText('失败').length).toBeGreaterThan(0)
    expect(screen.getAllByText('查看提案')).toHaveLength(1)
  })

  test('RunOverlay renders proposal terminal action', () => {
    render(<RunOverlay run={run('ok', 9)} update={update} onReview={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText(/已产出提案/)).toBeTruthy()
    expect(screen.getByText('审阅')).toBeTruthy()
  })

  test('ReviewModal disables stale acceptance and requires reject reason', () => {
    const reject = vi.fn()
    const view = render(
      <MatterUpdateReview
        matter={matter}
        update={{ ...update, is_stale: true }}
        onClose={vi.fn()}
        onAccept={vi.fn()}
        onReject={reject}
      />
    )
    expect((screen.getByText('全部接受') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByText('拒绝'))
    const confirm = screen.getByText('确认拒绝') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.change(view.container.querySelector('textarea:last-of-type') as HTMLTextAreaElement, {
      target: { value: 'Not accurate' }
    })
    expect(confirm.disabled).toBe(false)
  })

  // 0812 D-B：跟进配置从右栏绑定卡搬进 `MatterAgentConfigModal`（右栏 ≥1400px 才渲染，
  // 窗口小一点就没有任何入口）。三条断言跟着搬，语义不变。
  test('agent config modal binds a custom profile and enables it in one patch', () => {
    const patch = vi.fn().mockResolvedValue(undefined)
    renderModal(
      <MatterAgentConfigModal
        matter={matter}
        runs={[]}
        profiles={[profile]}
        onPatch={patch}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByText('跟进规则')).toBeTruthy()
    expect(screen.getByText('计划')).toBeTruthy()
    expect(screen.getByText('下次')).toBeTruthy()
    expect(screen.getByText('上次')).toBeTruthy()
    fireEvent.click(screen.getByRole('switch'))
    fireEvent.click(screen.getByText('高级 · 在全局配置之上追加'))
    // 0813 #10 起「高级」里有四个 select（执行的 Agent / 模型 / 思考强度 / 备用模型），
    // 按 id 取要改的那个 —— `getByRole('combobox')` 会因为多个匹配直接炸。
    fireEvent.click(document.getElementById('matter-agent-profile') as HTMLElement)
    fireEvent.click(screen.getByRole('option', { name: profile.title }))
    fireEvent.click(screen.getByText('保存规则'))
    // 第二个实参 = 打开模态时冻结的版本号（乐观锁的判据）。
    expect(patch).toHaveBeenCalledWith(
      {
        agent_profile_id: profile.id,
        agent_enabled: true,
        matter_instructions: null,
        schedule_json: null
      },
      matter.version
    )
  })

  test('agent config modal renders the bound toggle and three status rows', () => {
    const patch = vi.fn().mockResolvedValue(undefined)
    renderModal(
      <MatterAgentConfigModal
        matter={{ ...matter, agent_profile_id: profile.id, agent_enabled: true }}
        runs={[run('ok')]}
        profiles={[profile]}
        onPatch={patch}
        onClose={vi.fn()}
      />
    )

    // 绑定 profile 时它出现两处：顶部条带的标题 + 「高级」里 Agent 选择器的当前值。
    expect(screen.getAllByText(profile.title).length).toBeGreaterThan(0)
    expect(screen.getByText('计划')).toBeTruthy()
    expect(screen.getByText('下次')).toBeTruthy()
    expect(screen.getByText('上次')).toBeTruthy()
    // 没有排程时「计划」= 手动；页脚摘要句跟着当前草稿走。
    expect(screen.getByText(/将按「手动」触发/)).toBeTruthy()
    const toggle = screen.getByRole('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    expect(screen.getByText('已停用 · 不会自动运行')).toBeTruthy()
    fireEvent.click(screen.getByText('保存规则'))
    expect(patch).toHaveBeenCalledWith(
      expect.objectContaining({ agent_enabled: false }),
      matter.version
    )
  })

  test('agent config modal recommends weekdays at 09:00 and persists the shared rule shape', () => {
    const patch = vi.fn().mockResolvedValue(undefined)
    renderModal(
      <MatterAgentConfigModal
        matter={{ ...matter, agent_enabled: true }}
        runs={[]}
        profiles={[]}
        onPatch={patch}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('Matter Agent · 系统内置')).toBeTruthy()
    fireEvent.click(screen.getByText('推荐：每个工作日 09:00'))
    fireEvent.click(screen.getByText('保存规则'))
    const payload = patch.mock.calls[0]?.[0]
    // P6-B：保存写的是 v2 envelope（多条触发并存），排程只是其中一条 entry。
    // 🔴 envelope 是**对象**：pydantic 写侧要 dict，发字符串会在 FastAPI 校验层 422 把整条
    // PATCH 打掉（0812 dogfood「跟进规则保存必定失败」）。形状闸见 matterTriggerEnvelopeParity。
    const envelope = payload.schedule_json
    expect(typeof envelope).not.toBe('string')
    expect(envelope.v).toBe(2)
    const schedule = envelope.triggers.find((entry: { kind: string }) => entry.kind === 'schedule')
    expect(schedule).toBeTruthy()
    expect(schedule.enabled).toBe(true)
    expect(schedule.rule).toMatchObject({
      freq: 'weekly',
      weekdays: [1, 2, 3, 4, 5],
      hour: 9,
      minute: 0
    })
    expect(schedule.timezone).toBeTruthy()
  })

  // ── 0813 dogfood 轮 3 #10：模型 / 思考强度 / 备用模型三项覆盖 ──────────────────
  //
  // owner 原话：「跟进规则页面，matter agent 配置，仍然没有模型配置、effort 配置、fallback
  // 配置。高级里面也没有模型覆盖配置和 effort 配置」。三项都写进同一个 envelope 的 `agent` 块。
  test('agent config modal writes the model override into the envelope', async () => {
    const patch = vi.fn().mockResolvedValue(undefined)
    renderModal(
      <MatterAgentConfigModal
        matter={{ ...matter, agent_enabled: true }}
        runs={[]}
        profiles={[]}
        onPatch={patch}
        onClose={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('高级 · 在全局配置之上追加'))
    // 模型清单来自 /chat/config（这里 stub 成没有 enabledModels ⇒ 回落到 FALLBACK_MODELS）。
    await waitFor(() => expect(screen.getByText('跟随默认（执行的 Agent → 全局配置 → 系统模型）')).toBeTruthy())
    fireEvent.click(document.getElementById('matter-agent-model') as HTMLElement)
    fireEvent.click(screen.getByRole('option', { name: 'claude-sonnet-4-6' }))
    fireEvent.click(screen.getByText('保存规则'))
    expect(patch.mock.calls[0]?.[0].schedule_json.agent).toEqual({
      model: 'claude-sonnet-4-6'
    })
  })

  // 🔴 灰掉的控件必须把「为什么」说出来 —— 档位阶梯按模型能力给，没选模型就判不了。
  test('effort stays disabled with a stated reason until a model is picked', async () => {
    renderModal(
      <MatterAgentConfigModal
        matter={{ ...matter, agent_enabled: true }}
        runs={[]}
        profiles={[]}
        onPatch={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('高级 · 在全局配置之上追加'))
    const effort = document.getElementById('matter-agent-effort') as HTMLButtonElement
    expect(effort.disabled).toBe(true)
    expect(screen.getByText(/先在上面选定模型/)).toBeTruthy()

    await waitFor(() => expect(screen.getByText('跟随默认（执行的 Agent → 全局配置 → 系统模型）')).toBeTruthy())
    fireEvent.click(document.getElementById('matter-agent-model') as HTMLElement)
    fireEvent.click(screen.getByRole('option', { name: 'claude-sonnet-4-6' }))
    await waitFor(() =>
      expect((document.getElementById('matter-agent-effort') as HTMLButtonElement).disabled).toBe(
        false
      )
    )
  })

  // 🔴 「不设兜底」≠「跟随」：前者要压过绑定 Agent 的兜底链，所以必须落成显式空数组。
  test('“no backup” saves an explicit empty fallback list', async () => {
    const patch = vi.fn().mockResolvedValue(undefined)
    renderModal(
      <MatterAgentConfigModal
        matter={{ ...matter, agent_enabled: true }}
        runs={[]}
        profiles={[]}
        onPatch={patch}
        onClose={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('高级 · 在全局配置之上追加'))
    fireEvent.click(document.getElementById('matter-agent-fallback') as HTMLElement)
    fireEvent.click(screen.getByRole('option', { name: '不设兜底' }))
    fireEvent.click(screen.getByText('保存规则'))
    expect(patch.mock.calls[0]?.[0].schedule_json.agent).toEqual({ fallback_models: [] })
  })

  // 打开一个已经配过的事项：三个 select 回显库里的值（不回显 = 用户以为没配过，再点一次保存
  // 就把它抹了）。
  test('a saved override round-trips back into the three selects', async () => {
    const patch = vi.fn().mockResolvedValue(undefined)
    renderModal(
      <MatterAgentConfigModal
        matter={{
          ...matter,
          agent_enabled: true,
          schedule_json: JSON.stringify({
            v: 2,
            triggers: [],
            agent: {
              model: 'claude-opus-4-8',
              effort: 'high',
              fallback_models: ['claude-sonnet-4-6']
            }
          })
        }}
        runs={[]}
        profiles={[]}
        onPatch={patch}
        onClose={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('高级 · 在全局配置之上追加'))
    await waitFor(() => expect(screen.getByText('高')).toBeTruthy())
    fireEvent.click(screen.getByText('保存规则'))
    expect(patch.mock.calls[0]?.[0].schedule_json.agent).toEqual({
      model: 'claude-opus-4-8',
      effort: 'high',
      fallback_models: ['claude-sonnet-4-6']
    })
  })

  // 0812 dogfood：「留空使用默认」写在界面上，那个默认却从不显示 ⇒ owner 读成「完全没预设」。
  // 「专属指令」是**追加**在全局任务契约之后的，所以那份契约必须就地可读。
  test('agent config modal discloses the global task contract in effect', async () => {
    renderModal(
      <MatterAgentConfigModal
        matter={{ ...matter, agent_enabled: true }}
        runs={[]}
        profiles={[]}
        onPatch={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('高级 · 在全局配置之上追加'))
    // 文案不再说「覆盖」——那是与 run_spec.py 相反的谎话。
    expect(screen.getByText(/追加在全局任务契约之后/)).toBeTruthy()
    fireEvent.click(screen.getByText('查看当前生效的全局任务契约'))
    // 库里 content 为空 ⇒ 生效值 = defaultContent，界面必须显示它而不是留白。
    await waitFor(() => expect(screen.getByText(CONTRACT_TEXT)).toBeTruthy())
  })

  // codex 反例 #7：草稿只在挂载时初始化，保存却用父组件**当前最新**的版本号 ⇒ 期间别处
  // 改了排程也不触发乐观锁冲突，把那次改动静默覆盖回去。
  test('agent config modal saves with the version frozen at open time', () => {
    const patch = vi.fn().mockResolvedValue(undefined)
    const view = renderModal(
      <MatterAgentConfigModal
        matter={{ ...matter, version: 3, agent_enabled: true }}
        runs={[]}
        profiles={[]}
        onPatch={patch}
        onClose={vi.fn()}
      />
    )
    // 详情页刷新到 v4（别处把排程改成了别的东西），模态里还是 v3 时的草稿。
    view.rerender(
      <MatterAgentConfigModal
        matter={{
          ...matter,
          version: 4,
          agent_enabled: true,
          schedule_json: '{"v":2,"triggers":[]}'
        }}
        runs={[]}
        profiles={[]}
        onPatch={patch}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('这个事项在别处已被改动。直接保存会覆盖那次改动。')).toBeTruthy()
    fireEvent.click(screen.getByText('保存规则'))
    expect(patch.mock.calls[0]?.[1]).toBe(3)
  })

  // codex 反例 #8：原实现发起 mutation 后立即 onClose ⇒ 版本冲突/网络错误时四个字段的
  // 编辑全丢，用户只剩一个 toast。
  test('agent config modal keeps the draft and shows the error when the patch fails', async () => {
    const patch = vi.fn().mockRejectedValue(new Error('version conflict'))
    const close = vi.fn()
    renderModal(
      <MatterAgentConfigModal
        matter={{ ...matter, agent_enabled: true }}
        runs={[]}
        profiles={[]}
        onPatch={patch}
        onClose={close}
      />
    )
    fireEvent.click(screen.getByText('推荐：每个工作日 09:00'))
    fireEvent.click(screen.getByText('保存规则'))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(close).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('version conflict')
    // 草稿还在：重试一次发出去的排程与第一次逐字相同（不是被重置回 matter 的空排程）。
    fireEvent.click(screen.getByText('保存规则'))
    expect(patch).toHaveBeenCalledTimes(2)
    const first = patch.mock.calls[0]?.[0] as { schedule_json: { triggers: { kind: string }[] } }
    const second = patch.mock.calls[1]?.[0] as { schedule_json: { triggers: { kind: string }[] } }
    expect(first.schedule_json.triggers.some((entry) => entry.kind === 'schedule')).toBe(true)
    expect(second.schedule_json).toEqual(first.schedule_json)
  })

  // codex 反例 #9：声明了 aria-modal 却没有初始聚焦 / Esc / 焦点恢复，键盘用户能 Tab 到背景。
  test('agent config modal takes focus, closes on Esc, and restores focus on unmount', () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const close = vi.fn()
    const view = renderModal(
      <MatterAgentConfigModal
        matter={matter}
        runs={[]}
        profiles={[]}
        onPatch={vi.fn().mockResolvedValue(undefined)}
        onClose={close}
      />
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog.contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(close).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  test('ReviewModal citations call the resource opener', () => {
    const openResource = vi.fn()
    render(
      <MatterUpdateReview
        matter={matter}
        update={{
          ...update,
          changes: [{ ...update.changes[0], sources: [{ resource_id: 5 }] }]
        }}
        onClose={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onOpenResource={openResource}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '打开证据 #5' }))
    expect(openResource).toHaveBeenCalledWith(5)
  })

  test('ReviewModal renders conflict guidance and semantic field chips', () => {
    render(
      <MatterUpdateReview
        matter={matter}
        update={{
          ...update,
          change_count: 2,
          changes: [
            {
              id: 'status-change',
              kind: 'field',
              target: { field: 'status' },
              before: 'planned',
              after: 'active',
              sources: []
            },
            {
              id: 'health-change',
              kind: 'field',
              target: { field: 'health' },
              before: 'on_track',
              after: 'at_risk',
              sources: []
            }
          ]
        }}
        error="事项已被更新，已刷新最新版本。请重载后重试。"
        onClose={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
      />
    )

    expect(screen.getByRole('alert').textContent).toContain('请重载后重试')
    expect(screen.getByText('计划中')).toBeTruthy()
    expect(screen.getByText('进行中')).toBeTruthy()
    expect(screen.getByText('正常')).toBeTruthy()
    expect(screen.getByText('有风险')).toBeTruthy()
  })

  test('citation targets route emails to mail and other resources to the drawer', () => {
    expect(resolveMatterCitationTarget(resource('email', 'email:123'))).toEqual({
      kind: 'email',
      emailId: 123
    })
    const document = resource('doc', 'notion:page-1')
    expect(resolveMatterCitationTarget(document)).toEqual({ kind: 'resource', item: document })
  })
})
