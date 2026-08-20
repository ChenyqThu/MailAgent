// @vitest-environment happy-dom
//
// WP6 画像卡：
//   🔒 注入用例（§8-WP6 验收原文）—— summary / topics / evolution 里塞 <script> 与
//      markdown，界面必须**原样显示**（不解析、不执行、不加粗）。
//   四种「没有画像」的文案语义不混（未开 / 未达阈值 / 已达阈值等批处理 / 证据不足）。
//   阈值文案与判定读同一常量（前端不硬编码 50）。
//   建议值采纳 / 忽略 / 全部采纳 走对端点，失败时行留在原位（不乐观出队）。
//   手动更新失败保留旧画像并在 provenance 行标失败。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockRefresh, mockAdopt, mockIgnore, mockNavigate, mockSetActive, mockEvidenceMeta } =
  vi.hoisted(() => ({
    mockRefresh: vi.fn(),
    mockAdopt: vi.fn(),
    mockIgnore: vi.fn(),
    mockNavigate: vi.fn(),
    mockSetActive: vi.fn(),
    // (internalId, enabled) → 一份 useQuery 形状的替身。默认「还没查」，用例各自改。
    // 🔴 显式写出入参签名：`vi.fn(() => …)` 会推成零参，断言里读 `mock.calls[0][1]` 就会
    // 在 typecheck:tests 那道闸上红（vitest 3 的泛型形式是 `vi.fn<(a, b) => R>`）。
    mockEvidenceMeta: vi.fn<
      (
        internalId: number,
        enabled: boolean
      ) => { data?: { subject?: string } | null; isSuccess: boolean; isError: boolean }
    >(() => ({ data: undefined, isSuccess: false, isError: false }))
  }))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate
}))

vi.mock('@shared/state/active-email', () => ({
  useActiveEmail: (selector: (s: { setActive: typeof mockSetActive }) => unknown) =>
    selector({ setActive: mockSetActive })
}))

vi.mock('@shared/components/contacts/hooks', async () => {
  const { useMutation } = await import('@tanstack/react-query')
  return {
    useRefreshContactProfile: () => useMutation({ mutationFn: () => mockRefresh() }),
    useAdoptProfileSuggestion: () =>
      useMutation({ mutationFn: (input: unknown) => mockAdopt(input) }),
    useIgnoreProfileSuggestion: () =>
      useMutation({ mutationFn: (field: unknown) => mockIgnore(field) }),
    useEvidenceEmailMeta: (internalId: number, enabled: boolean) =>
      mockEvidenceMeta(internalId, enabled)
  }
})

import i18n from '@shared/i18n'
import type { ContactProfileDocument, ContactProfileDto } from '@shared/api/types/contact'
import { ContactProfileCard } from '@shared/components/contacts/ContactProfileCard'

await i18n.changeLanguage('zh-CN')

function documentOf(overrides: Partial<ContactProfileDocument> = {}): ContactProfileDocument {
  return {
    summary: '陈立是 NexPay 的技术负责人。',
    role_title: '技术负责人',
    formal_name: 'Li Chen',
    department: '平台技术部',
    topics: ['支付通道联调'],
    projects: ['灰度上线'],
    communication_style: '结论前置。',
    contact_info: { phone: '+86 138 0013 8000' },
    evolution: [{ at: '2026-05', text: '开始牵头灰度方案', ev: 53675 }],
    contradictions: ['签名档与自述职务不一致'],
    evidence_window: { from: 41230, to: 53675, mail_count: 24, mode: 'incremental' },
    ...overrides
  }
}

function profileOf(overrides: Partial<ContactProfileDto> = {}): ContactProfileDto {
  const document = overrides.document === undefined ? documentOf() : overrides.document
  return {
    profile_updated_at: Date.now() - 3 * 86_400_000,
    profile_mail_count: 24,
    profile_model: 'claude-sonnet',
    profile_status: 'ok',
    profile_attempted_at: null,
    profile_error: null,
    attempted_mail_count: null,
    status: 'ok',
    profile_min: 50,
    eligible: true,
    needed_mail_count: 0,
    suggestions: [],
    ...overrides,
    // `document` 与 `profile_json` 是后端同一个对象的两个键 —— 放在 spread 之后，
    // 保证调用方只覆写 document 时两者不会分叉。
    document,
    profile_json: document
  }
}

function renderCard(profile: ContactProfileDto, mailCount = 121): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  render(
    <QueryClientProvider client={queryClient}>
      <ContactProfileCard contactId={7} profile={profile} mailCount={mailCount} />
    </QueryClientProvider>
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ContactProfileCard · 纯文本渲染（§8-WP6 验收）', () => {
  // 🔒 画像正文是模型产物 —— 若哪天有人把它换成 markdown / dangerouslySetInnerHTML，
  // 这条必须红。断言三件事：原样文本在、没有 <script> 节点、没有被加粗成 <strong>。
  test('summary / topics / evolution 里的 <script> 与 markdown 原样显示，不解析不执行', () => {
    const injected = '<script>alert(1)</script> 与 **md** 都该原样出现'
    const profile = profileOf({
      document: documentOf({
        summary: injected,
        topics: ['<script>alert(2)</script>', '**topic**'],
        projects: ['<img src=x onerror=alert(3)>'],
        communication_style: '<b>style</b>',
        evolution: [{ at: '2026-05', text: '<script>alert(4)</script> **evo**', ev: null }],
        contradictions: ['<script>alert(5)</script>']
      })
    })
    const { container } = (() => {
      renderCard(profile)
      return { container: document.body }
    })()

    expect(screen.getByText(injected)).toBeTruthy()
    expect(screen.getByText('<script>alert(2)</script>')).toBeTruthy()
    expect(screen.getByText('**topic**')).toBeTruthy()
    expect(screen.getByText('<img src=x onerror=alert(3)>')).toBeTruthy()
    expect(screen.getByText('<b>style</b>')).toBeTruthy()
    expect(screen.getByText('<script>alert(4)</script> **evo**')).toBeTruthy()

    // 一个 script / img / b 节点都不许被真正建出来，markdown 也不许变成 strong/em。
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(container.querySelector('strong')).toBeNull()
    expect(container.querySelector('em')).toBeNull()
  })
})

// WP7 dogfood：画像 prompt 要求正文内联引用证据（`[id:123]`），前端此前按纯文本渲染 →
// owner 看到一屏 `[id:1000012991]` 字面量且点不动。切段成钮，但**只认这一个 token**。
//
// 0819 dogfood 二轮：钮上的「证据 N」文字满篇都是 → 弱化成纯图标角标，「证据 N」退到
// `aria-label`（原生 `title` 三轮时移除，改自绘 tooltip —— 见下面那组）。所以这一组一律按
// **aria-label** 找钮，正文里不该再出现那串文字。
describe('ContactProfileCard · 内联证据引用 `[id:N]`', () => {
  test('summary 里的 [id:N] 变成可点的证据角标，点击跳那封邮件', () => {
    renderCard(
      profileOf({
        document: documentOf({
          summary: '陈立牵头灰度方案 [id:53675]，并在上周确认排期 [id:41230]。',
          evolution: []
        })
      })
    )

    // 字面量不再出现；两个引用各成一个角标。
    expect(screen.queryByText(/\[id:53675\]/)).toBeNull()
    const first = screen.getByLabelText('证据 53675')
    expect(screen.getByLabelText('证据 41230')).toBeTruthy()
    // 🔒 弱化后正文里不许再有可见的「证据 N」文字（只剩 title / aria-label）。
    expect(screen.queryByText(/证据 53675/)).toBeNull()
    expect(first.getAttribute('aria-label')).toBe('证据 53675')
    // 周围的纯文本一段不少（切段没吃掉文字）。
    expect(screen.getByText(/陈立牵头灰度方案/)).toBeTruthy()
    expect(screen.getByText(/并在上周确认排期/)).toBeTruthy()

    fireEvent.click(first)
    // 🔴 navTarget：证据邮件常在列表加载窗口外，不豁免会被 active-reset 抢回列表第一封。
    expect(mockSetActive).toHaveBeenCalledWith(53675, { navTarget: true })
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/' })
  })

  test('沟通风格 / 待澄清 里的引用同样成角标', () => {
    renderCard(
      profileOf({
        document: documentOf({
          summary: '无引用。',
          communication_style: '结论前置 [id:900]。',
          contradictions: ['签名档与自述职务不一致 [id:901]'],
          evolution: []
        })
      })
    )

    expect(screen.getByLabelText('证据 900')).toBeTruthy()
    expect(screen.getByLabelText('证据 901')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('证据 901'))
    expect(mockSetActive).toHaveBeenCalledWith(901, { navTarget: true })
  })

  test('evolution.text 里的违规内联引用也兜底成角标（prompt 要求用 ev，但模型可能不听）', () => {
    renderCard(
      profileOf({
        document: documentOf({
          summary: '无引用。',
          evolution: [{ at: '2026-05', text: '开始牵头灰度方案 [id:777]', ev: null }]
        })
      })
    )

    expect(screen.getByLabelText('证据 777')).toBeTruthy()
    expect(screen.queryByText(/\[id:777\]/)).toBeNull()
  })

  test('chips 里剥掉标记而不是留字面量（原型 chips 是纯展示 span，塞不下钮）', () => {
    renderCard(
      profileOf({
        document: documentOf({
          summary: '无引用。',
          topics: ['支付通道联调 [id:555]'],
          projects: ['灰度上线 [id:556]'],
          evolution: []
        })
      })
    )

    expect(screen.getByText('支付通道联调')).toBeTruthy()
    expect(screen.getByText('灰度上线')).toBeTruthy()
    expect(screen.queryByText(/\[id:555\]/)).toBeNull()
    // chip 不给点击入口 —— 不产生「证据 555」角标。
    expect(screen.queryByLabelText('证据 555')).toBeNull()
    expect(screen.queryByLabelText('证据 556')).toBeNull()
  })

  // 0819 dogfood：模型实际写出来的是 `[id: 54216]`（冒号后有空格），旧正则不容空格 →
  // 一个都没匹配上，脏标记原样糊在界面上。容空格是原形态的超集，两条路径一起验。
  test('冒号后带空格的 `[id: N]` 一样认：正文成角标、chips 剥干净', () => {
    renderCard(
      profileOf({
        document: documentOf({
          summary: '陈立牵头灰度方案 [id: 54216]。',
          topics: ['支付通道联调 [id: 555]'],
          evolution: []
        })
      })
    )

    expect(screen.getByLabelText('证据 54216')).toBeTruthy()
    expect(screen.queryByText(/\[id: ?54216\]/)).toBeNull()
    expect(screen.getByText('支付通道联调')).toBeTruthy()
    expect(screen.queryByText(/\[id: ?555\]/)).toBeNull()
  })

  // 🔒 解析器是本文件唯一的富文本入口 —— 非法/敌意形态必须落回纯文本，不成钮也不炸。
  test('注入与非法形态：<script> / [id:abc] / [id:] / 超长数字 一律原样纯文本，不产生钮', () => {
    const hostile =
      '<script>alert(1)</script> [id:abc] 与 [id:] 与 [id:99999999999999999999] 都该原样出现'
    const { container } = (() => {
      renderCard(
        profileOf({
          document: documentOf({
            summary: hostile,
            topics: [],
            projects: [],
            communication_style: null,
            contradictions: [],
            evolution: []
          })
        })
      )
      return { container: document.body }
    })()

    // 整段一字不改地在（说明一个 token 都没被切走）。
    expect(screen.getByText(hostile)).toBeTruthy()
    // 一个证据角标都不该出现。
    expect(screen.queryByLabelText(/^证据 /)).toBeNull()
    // 依旧不解析 HTML。
    expect(container.querySelector('script')).toBeNull()
  })

  test('相邻两个引用之间的空格保留（不粘成一坨）', () => {
    renderCard(
      profileOf({
        document: documentOf({ summary: 'A [id:1] [id:2] B', evolution: [] })
      })
    )

    expect(screen.getByLabelText('证据 1')).toBeTruthy()
    expect(screen.getByLabelText('证据 2')).toBeTruthy()
    // 角标不带文字 → 段落文本只剩三段纯文本，两侧空格必须原样在（不粘成 'AB'）。
    const paragraph = screen.getByLabelText('证据 1').closest('p')
    expect(paragraph?.textContent).toBe('A   B')
  })
})

// 0819 dogfood 三轮：owner 报「引用确实精炼了，但是 hover 没显示」。根因是原生 `title` 在
// Electron 下延迟长到没用，而且只能给一行「证据 N」——owner 要的是**不点进去就知道引的是哪封**。
// 改自绘 tooltip（Radix）+ hover 懒查邮件 meta。这一组钉：懒（没 hover 不查）、查到显示主题、
// 查不到说人话。
describe('ContactProfileCard · 证据 hover tooltip', () => {
  /** Radix TooltipTrigger 对键盘 focus 也开 —— 比在 happy-dom 里模拟 pointer 序列稳。 */
  function hover(badge: HTMLElement): void {
    fireEvent.focus(badge)
  }

  test('🔴 懒查：没 hover 时 enabled=false（十几个角标不许在渲染时全部预取）', () => {
    renderCard(
      profileOf({
        document: documentOf({
          summary: '陈立牵头灰度方案 [id:53675]，并在上周确认排期 [id:41230]。',
          evolution: []
        })
      })
    )

    // 两个角标都调了 hook（React 规则），但 enabled 必须全是 false。
    expect(mockEvidenceMeta).toHaveBeenCalled()
    for (const call of mockEvidenceMeta.mock.calls) {
      expect(call[1], `id=${call[0]} 不该在未 hover 时开查`).toBe(false)
    }
  })

  test('hover 后对该 id 开查，tooltip 显示「证据 N」+ 邮件主题', async () => {
    mockEvidenceMeta.mockImplementation((_internalId, enabled) =>
      enabled
        ? { data: { subject: '灰度方案排期确认' }, isSuccess: true, isError: false }
        : { data: undefined, isSuccess: false, isError: false }
    )
    renderCard(
      profileOf({
        document: documentOf({ summary: '陈立牵头灰度方案 [id:53675]。', evolution: [] })
      })
    )

    hover(screen.getByLabelText('证据 53675'))

    // 开查的是这个 id，且 enabled 翻成了 true。
    await waitFor(() => expect(mockEvidenceMeta).toHaveBeenCalledWith(53675, true))
    // tooltip 里两行都在：id 行（让 owner 能对上号）+ 主题行（不点进去就能确认）。
    await waitFor(() => expect(screen.getAllByRole('tooltip').length).toBeGreaterThan(0))
    const tip = screen.getAllByRole('tooltip')[0]!
    expect(tip.textContent).toContain('证据 53675')
    expect(tip.textContent).toContain('灰度方案排期确认')
  })

  test('邮件已删（查到 null）→ 说人话，不显示空白主题行', async () => {
    mockEvidenceMeta.mockImplementation((_id, enabled) =>
      enabled
        ? { data: null, isSuccess: true, isError: false }
        : { data: undefined, isSuccess: false, isError: false }
    )
    renderCard(
      profileOf({ document: documentOf({ summary: '引自一封已删邮件 [id:999]。', evolution: [] }) })
    )

    hover(screen.getByLabelText('证据 999'))

    await waitFor(() => expect(screen.getAllByRole('tooltip').length).toBeGreaterThan(0))
    const tip = screen.getAllByRole('tooltip')[0]!
    expect(tip.textContent).toContain('证据 999')
    expect(tip.textContent).toContain('邮件不存在或已删除')
  })

  test('主题还在路上 → tooltip 先只出 id 行（不先塞「加载中」再抖一下）', async () => {
    mockEvidenceMeta.mockImplementation(() => ({
      data: undefined,
      isSuccess: false,
      isError: false
    }))
    renderCard(
      profileOf({
        document: documentOf({ summary: '陈立牵头灰度方案 [id:53675]。', evolution: [] })
      })
    )

    hover(screen.getByLabelText('证据 53675'))

    await waitFor(() => expect(screen.getAllByRole('tooltip').length).toBeGreaterThan(0))
    const tip = screen.getAllByRole('tooltip')[0]!
    expect(tip.textContent).toContain('证据 53675')
    expect(tip.textContent).not.toContain('邮件不存在或已删除')
  })

  // 🔒 原生 title 必须移除 —— 留着会和自绘 tooltip 叠成两层。
  test('角标不再带原生 title（避免双 tooltip 叠加），aria-label 保留', () => {
    renderCard(
      profileOf({
        document: documentOf({ summary: '陈立牵头灰度方案 [id:53675]。', evolution: [] })
      })
    )

    const badge = screen.getByLabelText('证据 53675')
    expect(badge.getAttribute('title')).toBeNull()
    expect(badge.getAttribute('aria-label')).toBe('证据 53675')
  })
})

describe('ContactProfileCard · 四种「没有画像」文案语义不混', () => {
  test('未开启：只给「到 Agents 页开启」，不给「立即生成」', () => {
    renderCard(profileOf({ document: null, status: 'unconfigured', eligible: false }))

    expect(screen.getByText('AI 画像未开启')).toBeTruthy()
    expect(screen.getByText('到 Agents 页开启画像 Agent')).toBeTruthy()
    expect(screen.queryByText('立即生成')).toBeNull()
    expect(screen.queryByText('再试一次')).toBeNull()
  })

  test('未达阈值：文案读后端的 profile_min / needed_mail_count，不是前端写死的 50', () => {
    renderCard(
      profileOf({
        document: null,
        status: 'below_threshold',
        eligible: false,
        profile_min: 80,
        needed_mail_count: 68
      }),
      12
    )

    expect(screen.getByText('还没到画像阈值')).toBeTruthy()
    // 三个数都来自投影：满 80 封、当前 12 封、还差 68 封。若前端硬编码 50 这条必红。
    expect(screen.getByText(/往来满 80 封后自动生成（当前 12 封，还差 68 封）/)).toBeTruthy()
    expect(screen.getByText('立即生成')).toBeTruthy()
  })

  test('已达阈值等批处理：换成 queued 文案，不再说「还没到阈值」', () => {
    renderCard(
      profileOf({ document: null, status: 'pending_batch', eligible: true, needed_mail_count: 0 }),
      121
    )

    expect(screen.getByText('已达阈值 · 等下一轮批处理')).toBeTruthy()
    expect(screen.queryByText('还没到画像阈值')).toBeNull()
    expect(screen.getByText(/往来 121 封，已过 50 封阈值/)).toBeTruthy()
  })

  test('证据不足：「已读过 n 封」读 attempted_mail_count 而不是往来总数', () => {
    renderCard(
      profileOf({
        document: null,
        status: 'skipped',
        profile_status: 'skipped',
        attempted_mail_count: 20
      }),
      121
    )

    expect(screen.getByText('往来内容尚不足以生成画像')).toBeTruthy()
    // 读过的是 20 封（本轮取证数），不是 121 封（往来总数）。
    expect(screen.getByText(/已读过 20 封往来/)).toBeTruthy()
    expect(screen.getByText('再试一次')).toBeTruthy()
  })
})

describe('ContactProfileCard · provenance 与手动更新', () => {
  test('provenance 渲染证据窗 / 模型 / 增量尾缀', () => {
    renderCard(profileOf())

    expect(screen.getByText(/基于 41230~53675 的 24 封邮件/)).toBeTruthy()
    expect(screen.getByText(/claude-sonnet/)).toBeTruthy()
    expect(screen.getByText(/· 增量/)).toBeTruthy()
  })

  test('证据窗两端为 null 时退到不带窗口的那句（不渲染 null~null）', () => {
    renderCard(
      profileOf({
        document: documentOf({
          evidence_window: { from: null, to: null, mail_count: 0, mode: 'first' }
        })
      })
    )

    expect(screen.getByText(/基于 0 封邮件/)).toBeTruthy()
    expect(screen.queryByText(/null/)).toBeNull()
    expect(screen.getByText(/· 首轮/)).toBeTruthy()
  })

  test('失败态：保留旧画像正文，同时在 provenance 行挂「上次更新失败」', () => {
    renderCard(profileOf({ status: 'failed', profile_status: 'failed' }))

    // 旧画像还在（失败不清空）。
    expect(screen.getByText('陈立是 NexPay 的技术负责人。')).toBeTruthy()
    expect(screen.getByText('上次更新失败')).toBeTruthy()
  })

  test('生成中：卡头出 pip、刷新钮换「生成中…」并禁用', () => {
    renderCard(profileOf({ status: 'running', profile_status: 'running' }))

    expect(screen.getAllByText('生成中…').length).toBeGreaterThan(0)
    const refreshButton = screen
      .getAllByRole('button')
      .find((node) => node.textContent?.includes('生成中…'))
    expect(refreshButton?.hasAttribute('disabled')).toBe(true)
    expect(screen.queryByText('立即更新画像')).toBeNull()
  })

  test('「立即更新画像」调 refresh 端点', async () => {
    mockRefresh.mockResolvedValue({ contact_id: 7, status: 'running', started: true })
    renderCard(profileOf())

    fireEvent.click(screen.getByText('立即更新画像'))
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1))
  })

  // 0819 dogfood 投诉的大头就是这里：轨迹的 `ev` 早先是独立一行的斜体「⟨"⟩ 证据 53675」，
  // 一屏三四条全是。现在与内联引用共用同一个角标，且**紧跟轨迹文本行尾**。
  test('轨迹的 `ev` 是紧跟文本行尾的角标（不再独占一行、不再有可见文字）', () => {
    renderCard(profileOf())

    const badge = screen.getByLabelText('证据 53675')
    // 🔒 不再有可见的「证据 N」文字 —— 只剩 title / aria-label。
    expect(screen.queryByText(/证据 53675/)).toBeNull()
    expect(badge.getAttribute('aria-label')).toBe('证据 53675')
    // 🔒 与轨迹正文同一个块（早先是正文块的**兄弟**，自成一行）→ inline 紧跟行尾。
    const textBlock = screen.getByText(/开始牵头灰度方案/).closest('div')
    expect(textBlock?.contains(badge)).toBe(true)
    // 与 InlineRefs 是同一个角标件：形态一致（9px Quote，无文字）。
    expect(badge.textContent).toBe('')
    expect(badge.querySelector('svg')?.getAttribute('width')).toBe('9')

    fireEvent.click(badge)
    // navTarget 豁免 useEmailListRows 的 active-reset（证据邮件常在列表加载窗口外）。
    expect(mockSetActive).toHaveBeenCalledWith(53675, { navTarget: true })
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/' })
  })
})

describe('ContactProfileCard · 建议值（D7 / §4.2）', () => {
  const withSuggestions = (): ContactProfileDto =>
    profileOf({
      suggestions: [
        { field: 'department', value: '平台技术部' },
        { field: 'phone', value: '+86 138 0013 8000' }
      ]
    })

  test('逐项渲染 label + 值 + 采纳/忽略，并带写入语义说明', () => {
    renderCard(withSuggestions())

    expect(screen.getByText('部门')).toBeTruthy()
    expect(screen.getByText('平台技术部')).toBeTruthy()
    expect(screen.getByText('电话')).toBeTruthy()
    expect(screen.getAllByText('采纳')).toHaveLength(2)
    expect(screen.getAllByText('忽略')).toHaveLength(2)
    expect(screen.getByText(/采纳会写入身份字段并锁定该字段/)).toBeTruthy()
  })

  test('采纳带上 field + value（后端据此写字段并落锁）', async () => {
    mockAdopt.mockResolvedValue({})
    renderCard(withSuggestions())

    fireEvent.click(screen.getAllByText('采纳')[0]!)
    await waitFor(() =>
      expect(mockAdopt).toHaveBeenCalledWith({ field: 'department', value: '平台技术部' })
    )
  })

  test('忽略只带 field（不写身份字段）', async () => {
    mockIgnore.mockResolvedValue({})
    renderCard(withSuggestions())

    fireEvent.click(screen.getAllByText('忽略')[1]!)
    await waitFor(() => expect(mockIgnore).toHaveBeenCalledWith('phone'))
  })

  test('全部采纳：串行逐条调 adopt（并发会互相覆盖锁）', async () => {
    mockAdopt.mockResolvedValue({})
    renderCard(withSuggestions())

    fireEvent.click(screen.getByText('全部采纳'))
    await waitFor(() => expect(mockAdopt).toHaveBeenCalledTimes(2))
    expect(mockAdopt).toHaveBeenNthCalledWith(1, { field: 'department', value: '平台技术部' })
    expect(mockAdopt).toHaveBeenNthCalledWith(2, { field: 'phone', value: '+86 138 0013 8000' })
  })

  // 🔒 §4.2「写入失败 → 建议项保留原位（不乐观更新掉）」。
  test('采纳失败时建议行仍在（零乐观更新）', async () => {
    mockAdopt.mockRejectedValue(new Error('boom'))
    renderCard(withSuggestions())

    fireEvent.click(screen.getAllByText('采纳')[0]!)
    await waitFor(() => expect(mockAdopt).toHaveBeenCalledTimes(1))
    expect(screen.getByText('平台技术部')).toBeTruthy()
    expect(screen.getAllByText('采纳')).toHaveLength(2)
  })

  // 0819 dogfood：老数据的建议值里混进了内联引证（`平台技术部 [id: 54216]`）。
  const dirtySuggestions = (): ContactProfileDto =>
    profileOf({
      suggestions: [
        { field: 'department', value: '平台技术部 [id: 54216]' },
        { field: 'phone', value: '+86 138 0013 8000 [id:41230]' }
      ]
    })

  test('建议值里的 [id: N] 尾巴显示侧剥掉（含冒号后带空格的形态）', () => {
    renderCard(dirtySuggestions())

    expect(screen.getByText('平台技术部')).toBeTruthy()
    expect(screen.getByText('+86 138 0013 8000')).toBeTruthy()
    expect(screen.queryByText(/\[id:/)).toBeNull()
  })

  // 🔒 显示干净但写进去脏 = 更坏：脏标记会落进身份字段并锁上。写路径也得剥。
  test('采纳发出去的是剥后值，不是原始脏值（逐条 + 全部采纳两条路径）', async () => {
    mockAdopt.mockResolvedValue({})
    renderCard(dirtySuggestions())

    fireEvent.click(screen.getAllByText('采纳')[0]!)
    await waitFor(() =>
      expect(mockAdopt).toHaveBeenCalledWith({ field: 'department', value: '平台技术部' })
    )

    cleanup()
    vi.clearAllMocks()
    mockAdopt.mockResolvedValue({})
    renderCard(dirtySuggestions())

    fireEvent.click(screen.getByText('全部采纳'))
    await waitFor(() => expect(mockAdopt).toHaveBeenCalledTimes(2))
    expect(mockAdopt).toHaveBeenNthCalledWith(1, { field: 'department', value: '平台技术部' })
    expect(mockAdopt).toHaveBeenNthCalledWith(2, {
      field: 'phone',
      value: '+86 138 0013 8000'
    })
  })

  // 「框架外」= 建议值不在 owner 预设的组织架构框架里。后端只在 true 时才写这个键，
  // 所以缺键 / false 都不该出标记。
  test('out_of_frame 为 true 才出「框架外」标记，缺键不出', () => {
    renderCard(
      profileOf({
        suggestions: [
          { field: 'department', value: '平台技术部', out_of_frame: true },
          { field: 'phone', value: '+86 138 0013 8000' }
        ] as ContactProfileDto['suggestions']
      })
    )

    // 两行里只有一个标记。
    expect(screen.getAllByText('框架外')).toHaveLength(1)
    // 🔴 不是警告态：解释走 title，悬停能看到为什么。
    expect(screen.getByText('框架外').getAttribute('title')).toBe(
      '建议值不在你预设的组织架构框架内，可先补框架再采纳'
    )
  })

  test('没有建议时整个建议值区不渲染', () => {
    renderCard(profileOf({ suggestions: [] }))

    expect(screen.queryByText('建议值')).toBeNull()
    expect(screen.queryByText('全部采纳')).toBeNull()
  })
})
