// @vitest-environment happy-dom
//
// 设置 →「MCP 服务」tab。钉住的契约（每条都是"改错了用户会中招"的）：
//   1. serve-api 没在跑（远程访问开关关 / status 以 E_NETWORK 失败）→ 只出提示 + 去远程访问，
//      密钥 / 工具 / 调用记录三块**不发请求**。
//   2. 新建 / 修改权限共用一个弹窗：基础档默认「只读」、额外写权限默认不勾；额外写权限的
//      列表来自 `/scope-options`（前端不手抄 scope），高风险项用警示色；修改模式预填并走 PATCH；
//      命令行建的 custom 密钥没有修改入口。
//   3. 明文只在「密钥已生成」弹窗里出现；关闭后 DOM 里不再有，列表接口也不带明文 ⇒ 取不回。
//   4. 三个复制按钮写进剪贴板的都是真实明文；Notion 配置用公网地址，HTTP 客户端配置用本机地址。
//   5. 轮换复用同一个弹窗；撤销必须先过确认。
//   6. 公网地址保存前校验（https / 非本机地址 / 以 /mcp 结尾），不合法不保存；
//      没填公网地址时「复制 Notion 配置」不写剪贴板（不拿本机地址兜底）并展开引导；
//      「复制给 Agent」的任务说明用本机地址里的真实端口。
//   7. 对外工具按所需权限分组，组头标出拥有该权限的有效密钥数；写入组默认折叠。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type {
  McpApiKey,
  McpExposedTool,
  McpKeyWithPlaintext,
  McpScopeOptions,
  McpServiceStatus
} from '../../src/shared/api/types'

const { mcpApi, navigateMock } = vi.hoisted(() => ({
  mcpApi: {
    status: vi.fn(),
    getScopeOptions: vi.fn(),
    listKeys: vi.fn(),
    createKey: vi.fn(),
    updateKeyScopes: vi.fn(),
    rotateKey: vi.fn(),
    revokeKey: vi.fn(),
    tools: vi.fn(),
    audit: vi.fn(),
    probe: vi.fn()
  },
  navigateMock: vi.fn()
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ mcpService: mcpApi })
}))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock
}))
vi.mock('@shared/state/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }))
const { applyEnvPatchMock } = vi.hoisted(() => ({ applyEnvPatchMock: vi.fn() }))
vi.mock('@shared/state/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/state/env')>()),
  applyEnvPatch: applyEnvPatchMock
}))

import i18n from '@shared/i18n'
import { toastSuccess } from '@shared/state/toast'
import { McpServiceTab } from '../../src/shared/components/settings/tabs/McpServiceTab'
import { useEnvStore } from '@shared/state/env'

await i18n.changeLanguage('zh-CN')

// 端口有意不用 8200：引导与「复制给 Agent」必须取真实端口，不能写死默认值。
const LOCAL_URL = 'http://127.0.0.1:8231/mcp'
const PUBLIC_URL = 'https://mcp.example.test/mcp'
const PLAINTEXT = 'mak_TESTSECRET_0123456789abcdef'
const ROTATED = 'mak_ROTATED_fedcba9876543210'

function makeKey(over: Partial<McpApiKey> = {}): McpApiKey {
  return {
    id: 'k1',
    label: 'Notion Agent',
    key_prefix: 'mak_TEST',
    scopes: ['email:read'],
    preset: 'readonly',
    base: 'readonly',
    extra: [],
    custom: false,
    created_at: 1_700_000_000,
    last_used_at: null,
    expires_at: null,
    revoked_at: null,
    active: true,
    ...over
  }
}

const SCOPE_OPTIONS: McpScopeOptions = {
  bases: [
    { id: 'readonly', scopes: ['email:read'] },
    { id: 'handoff', scopes: ['email:read', 'report:run'] }
  ],
  extras: [
    { scope: 'email:draft', risk: 'low' },
    { scope: 'email:organize', risk: 'low' },
    { scope: 'matters:write', risk: 'low' },
    { scope: 'calendar:write', risk: 'high' },
    { scope: 'email:write', risk: 'high' }
  ]
}

const TOOLS: McpExposedTool[] = [
  {
    name: 'mailagent_email_search',
    title: 'Search emails',
    description: 'Search.',
    annotations: {
      title: 'Search emails',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    auth_scopes: ['email:read'],
    presets: ['readonly', 'handoff', 'drafter']
  },
  {
    name: 'mailagent_email_draft',
    title: 'Draft email',
    description: 'Draft.',
    annotations: {
      title: 'Draft email',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    },
    auth_scopes: ['email:draft'],
    presets: ['drafter']
  }
]

function setEnv(values: Record<string, string>): void {
  useEnvStore.setState({
    state: {
      status: 'ready',
      snapshot: { path: '/tmp/.env', exists: true, values, managedKeys: [], secretKeys: [] }
    }
  })
}

function status(over: Partial<McpServiceStatus> = {}): McpServiceStatus {
  return { local_url: LOCAL_URL, public_url: null, active_key_count: 1, ...over }
}

function renderTab(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <McpServiceTab />
    </QueryClientProvider>
  )
}

const clipboardWrite = vi.fn<(text: string) => Promise<void>>()

beforeEach(() => {
  clipboardWrite.mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWrite }
  })
  mcpApi.status.mockResolvedValue(status())
  mcpApi.getScopeOptions.mockResolvedValue(SCOPE_OPTIONS)
  mcpApi.listKeys.mockResolvedValue([makeKey()])
  mcpApi.tools.mockResolvedValue(TOOLS)
  mcpApi.audit.mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useEnvStore.setState({ state: { status: 'idle' } })
})

function networkError(): Error {
  return Object.assign(new Error('fetch failed'), { code: 'E_NETWORK' })
}

describe('serve-api 未运行', () => {
  test('远程访问开关关：不发任何请求，只出提示与入口', async () => {
    setEnv({ MAILAGENT_REMOTE_ACCESS_ENABLED: 'false' })
    renderTab()
    expect(await screen.findByText('MCP 服务未运行')).toBeTruthy()
    expect(mcpApi.status).not.toHaveBeenCalled()
    expect(mcpApi.listKeys).not.toHaveBeenCalled()
    expect(mcpApi.tools).not.toHaveBeenCalled()
    expect(mcpApi.audit).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '去远程访问' }))
    expect(navigateMock).toHaveBeenCalledWith({ to: '/settings', search: { tab: 'remote' } })
  })

  test('status 以 E_NETWORK 失败：其余三块不发请求', async () => {
    setEnv({})
    mcpApi.status.mockRejectedValue(networkError())
    renderTab()
    expect(await screen.findByText('MCP 服务未运行')).toBeTruthy()
    expect(mcpApi.status).toHaveBeenCalledTimes(1)
    expect(mcpApi.listKeys).not.toHaveBeenCalled()
    expect(mcpApi.tools).not.toHaveBeenCalled()
    expect(mcpApi.audit).not.toHaveBeenCalled()
    expect(screen.queryByText('访问密钥')).toBeNull()
  })

  test('运行中：四块都渲染', async () => {
    setEnv({})
    renderTab()
    expect(await screen.findByText(LOCAL_URL)).toBeTruthy()
    expect(await screen.findByText('Notion Agent')).toBeTruthy()
    expect(await screen.findByText('读邮件 · 1')).toBeTruthy()
    expect(await screen.findByText('还没有调用记录')).toBeTruthy()
  })
})

describe('对外工具', () => {
  test('按所需权限分组，组头标出拥有该权限的有效密钥数；写入组默认折叠', async () => {
    setEnv({})
    mcpApi.listKeys.mockResolvedValue([
      makeKey({ id: 'a', scopes: ['email:read'] }),
      makeKey({
        id: 'b',
        scopes: ['email:read', 'email:draft'],
        base: 'readonly',
        extra: ['email:draft']
      }),
      // 已撤销的不算
      makeKey({ id: 'c', scopes: ['email:read', 'email:draft'], active: false, revoked_at: 1 })
    ])
    renderTab()
    const readHeader = await screen.findByRole('button', { name: /读邮件 · 1/ })
    const writeHeader = screen.getByRole('button', { name: /起草回复 · 1/ })
    expect(await within(readHeader).findByText('2 个有效密钥拥有此权限')).toBeTruthy()
    expect(within(writeHeader).getByText('1 个有效密钥拥有此权限')).toBeTruthy()
    expect(readHeader.getAttribute('aria-expanded')).toBe('true')
    expect(writeHeader.getAttribute('aria-expanded')).toBe('false')
    // 读组排在写组前面
    const groups = screen.getAllByTestId('mcp-tool-group')
    expect(groups.map((g) => g.querySelector('button')?.textContent)).toEqual([
      expect.stringContaining('读邮件'),
      expect.stringContaining('起草回复')
    ])
    fireEvent.click(writeHeader)
    expect(writeHeader.getAttribute('aria-expanded')).toBe('true')
    expect(within(groups[1]).getByText('建议：先确认')).toBeTruthy()
  })

  test('没有任何有效密钥拥有的权限，组头如实写「没有」', async () => {
    setEnv({})
    renderTab()
    const writeHeader = await screen.findByRole('button', { name: /起草回复 · 1/ })
    expect(await within(writeHeader).findByText('没有有效密钥拥有此权限')).toBeTruthy()
  })
})

async function openCreateDialog(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: '新建密钥' }))
  const dialog = await screen.findByRole('dialog')
  // 选项来自 /scope-options：加载完才出现基础档与额外权限。
  await within(dialog).findByRole('radio', { name: '只读' })
  return dialog
}

function extraCheckbox(dialog: HTMLElement, name: string): HTMLInputElement {
  return within(dialog).getByRole('checkbox', { name }) as HTMLInputElement
}

describe('新建密钥', () => {
  test('默认只读、不带额外写权限；不勾选时提交 extra 为空', async () => {
    setEnv({})
    const created: McpKeyWithPlaintext = {
      key: makeKey({ id: 'k2', label: 'My Agent' }),
      plaintext: PLAINTEXT
    }
    mcpApi.createKey.mockResolvedValue(created)
    renderTab()
    const dialog = await openCreateDialog()

    expect(within(dialog).getByRole('radio', { name: '只读' }).getAttribute('aria-checked')).toBe(
      'true'
    )
    expect(
      within(dialog).getByRole('radio', { name: '只读 + 运行' }).getAttribute('aria-checked')
    ).toBe('false')
    expect(
      within(dialog)
        .getAllByRole('checkbox')
        .every((c) => !(c as HTMLInputElement).checked)
    ).toBe(true)

    const submit = within(dialog).getByRole('button', { name: '新建' })
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: '  My Agent ' } })
    fireEvent.click(submit)

    await waitFor(() => expect(mcpApi.createKey).toHaveBeenCalledWith('My Agent', 'readonly', []))
    expect(await screen.findByText('密钥已生成')).toBeTruthy()
  })

  test('勾选额外写权限后 POST 带上它们，按接口给的顺序而不是勾选顺序', async () => {
    setEnv({})
    mcpApi.createKey.mockResolvedValue({ key: makeKey({ id: 'k2' }), plaintext: PLAINTEXT })
    renderTab()
    const dialog = await openCreateDialog()
    fireEvent.click(within(dialog).getByRole('radio', { name: '只读 + 运行' }))
    fireEvent.click(extraCheckbox(dialog, '日历写'))
    fireEvent.click(extraCheckbox(dialog, '起草回复'))
    fireEvent.click(extraCheckbox(dialog, '邮件整理'))
    fireEvent.click(extraCheckbox(dialog, '邮件整理')) // 勾了又取消
    fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: 'A' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '新建' }))
    await waitFor(() =>
      expect(mcpApi.createKey).toHaveBeenCalledWith('A', 'handoff', [
        'email:draft',
        'calendar:write'
      ])
    )
  })

  test('额外写权限的列表来自接口：多一个 scope 界面就多一项，没有文案时显示原始 scope', async () => {
    setEnv({})
    mcpApi.getScopeOptions.mockResolvedValue({
      ...SCOPE_OPTIONS,
      extras: [...SCOPE_OPTIONS.extras, { scope: 'future:write', risk: 'low' }]
    })
    renderTab()
    const dialog = await openCreateDialog()
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(6)
    expect(extraCheckbox(dialog, 'future:write')).toBeTruthy()
  })

  test('高风险项（日历写、发信）用警示色，发信说明提示邮件可能夹带指令', async () => {
    setEnv({})
    renderTab()
    const dialog = await openCreateDialog()
    const riskOf = (name: string): HTMLElement =>
      extraCheckbox(dialog, name).closest('[data-risk]') as HTMLElement
    for (const name of ['日历写', '发信']) {
      const row = riskOf(name)
      expect(row.getAttribute('data-risk')).toBe('high')
      expect(within(row).getByText(name).className).toContain('text-warn')
    }
    for (const name of ['起草回复', '邮件整理', '事项写']) {
      const row = riskOf(name)
      expect(row.getAttribute('data-risk')).toBe('low')
      expect(within(row).getByText(name).className).not.toContain('text-warn')
    }
    expect(within(riskOf('发信')).getByText(/邮件可能夹带指令.*先确认/)).toBeTruthy()
  })
})

describe('修改权限', () => {
  test('预填当前基础档与额外权限，提交走 PATCH，不弹明文窗', async () => {
    setEnv({})
    const key = makeKey({
      scopes: ['email:read', 'report:run', 'email:draft'],
      preset: null,
      base: 'handoff',
      extra: ['email:draft']
    })
    mcpApi.listKeys.mockResolvedValue([key])
    mcpApi.updateKeyScopes.mockResolvedValue({ ...key, extra: ['email:draft', 'email:organize'] })
    renderTab()
    // 列表行的权限是「基础档 · 额外权限」的组合描述
    expect(await screen.findByText(/只读 \+ 运行 · 起草回复/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '修改权限' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('修改「Notion Agent」的权限')).toBeTruthy()
    await within(dialog).findByRole('radio', { name: '只读 + 运行' })
    expect(
      within(dialog).getByRole('radio', { name: '只读 + 运行' }).getAttribute('aria-checked')
    ).toBe('true')
    expect(extraCheckbox(dialog, '起草回复').checked).toBe(true)
    expect(extraCheckbox(dialog, '邮件整理').checked).toBe(false)
    expect(within(dialog).queryByLabelText('名称')).toBeNull()

    const listCalls = mcpApi.listKeys.mock.calls.length
    fireEvent.click(extraCheckbox(dialog, '邮件整理'))
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(mcpApi.updateKeyScopes).toHaveBeenCalledWith('k1', 'handoff', [
        'email:draft',
        'email:organize'
      ])
    )
    expect(mcpApi.createKey).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByText('密钥已生成')).toBeNull()
    expect(toastSuccess).toHaveBeenCalledWith('已更新「Notion Agent」的权限')
    await waitFor(() => expect(mcpApi.listKeys.mock.calls.length).toBeGreaterThan(listCalls))
  })

  test('命令行建的 custom 密钥没有修改入口，显示原始 scope 与说明', async () => {
    setEnv({})
    mcpApi.listKeys.mockResolvedValue([
      makeKey({
        scopes: ['email:read', 'attachment:read', 'email:draft'],
        preset: 'drafter',
        base: null,
        extra: [],
        custom: true
      })
    ])
    renderTab()
    const note = await screen.findByTestId('mcp-key-custom-scopes')
    expect(note.textContent).toBe(
      '权限：email:read, attachment:read, email:draft。这个密钥由命令行创建，权限组合无法在这里修改。'
    )
    expect(screen.getByText(/mak_TEST… · 自定义/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '修改权限' })).toBeNull()
    // 其余操作照旧
    expect(screen.getByRole('button', { name: '轮换' })).toBeTruthy()
  })

  test('已撤销的密钥没有修改入口', async () => {
    setEnv({})
    mcpApi.listKeys.mockResolvedValue([makeKey({ active: false, revoked_at: 1_700_000_100 })])
    renderTab()
    await screen.findByText('已撤销')
    expect(screen.queryByRole('button', { name: '修改权限' })).toBeNull()
  })
})

async function openRevealedViaCreate(): Promise<HTMLElement> {
  mcpApi.createKey.mockResolvedValue({
    key: makeKey({ id: 'k2', label: 'My Agent' }),
    plaintext: PLAINTEXT
  })
  renderTab()
  const createDialog = await openCreateDialog()
  fireEvent.change(within(createDialog).getByLabelText('名称'), { target: { value: 'My Agent' } })
  fireEvent.click(within(createDialog).getByRole('button', { name: '新建' }))
  await screen.findByText('密钥已生成')
  return screen.getByRole('dialog')
}

describe('密钥已生成弹窗', () => {
  test('三个复制按钮都带真实明文；Notion 用公网地址，HTTP 客户端用本机地址', async () => {
    setEnv({ MAILAGENT_MCP_PUBLIC_URL: PUBLIC_URL })
    const dialog = await openRevealedViaCreate()
    expect(within(dialog).getByText(PLAINTEXT)).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: '复制密钥' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '复制 Notion 配置' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '复制 HTTP 客户端配置' }))

    expect(clipboardWrite).toHaveBeenCalledTimes(3)
    const [key, notion, http] = clipboardWrite.mock.calls.map((c) => c[0])
    expect(key).toBe(PLAINTEXT)
    expect(notion).toBe(`URL: ${PUBLIC_URL}\nAuthorization: Bearer ${PLAINTEXT}`)
    expect(JSON.parse(http)).toEqual({
      mcpServers: {
        mailagent: {
          type: 'http',
          url: LOCAL_URL,
          headers: { Authorization: `Bearer ${PLAINTEXT}` }
        }
      }
    })
    // 有公网地址、也没有不通过的检测结果：两条提示都不出
    expect(within(dialog).queryByText(/Notion 需要公网地址/)).toBeNull()
    expect(within(dialog).queryByText(/最近一次检测未通过/)).toBeNull()
  })

  test('没填公网地址：复制 Notion 配置不写剪贴板，提示并展开引导', async () => {
    setEnv({})
    const dialog = await openRevealedViaCreate()
    // 模态弹窗把背景标成 aria-hidden，所以背景里的引导开关要带 hidden 查。
    const toggle = screen.getByRole('button', { name: '如何获得公网地址', hidden: true })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(within(dialog).getByRole('button', { name: '复制 Notion 配置' }))
    expect(clipboardWrite).not.toHaveBeenCalled()
    expect(within(dialog).getByText(/Notion 需要公网地址，先配置公网地址/)).toBeTruthy()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  test('公网地址最近一次检测未通过：仍可复制，但弹窗里有警示', async () => {
    setEnv({ MAILAGENT_MCP_PUBLIC_URL: PUBLIC_URL })
    mcpApi.probe.mockResolvedValue({ result: 'access_blocked', detail: '302' })
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '检测' }))
    expect(
      await screen.findByText('被 Cloudflare Access 拦截，请去掉该主机名的 Access 应用')
    ).toBeTruthy()
    expect(mcpApi.probe).toHaveBeenCalledWith(PUBLIC_URL)

    mcpApi.createKey.mockResolvedValue({ key: makeKey({ id: 'k2' }), plaintext: PLAINTEXT })
    const createDialog = await openCreateDialog()
    fireEvent.change(within(createDialog).getByLabelText('名称'), { target: { value: 'A' } })
    fireEvent.click(within(createDialog).getByRole('button', { name: '新建' }))
    await screen.findByText('密钥已生成')
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/最近一次检测未通过/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '复制 Notion 配置' }))
    expect(clipboardWrite).toHaveBeenCalledWith(
      `URL: ${PUBLIC_URL}\nAuthorization: Bearer ${PLAINTEXT}`
    )
  })

  test('关闭后明文不在页面上，也没有入口再取回', async () => {
    setEnv({})
    const dialog = await openRevealedViaCreate()
    expect(within(dialog).getByText('关闭后无法再次查看这个密钥，请现在复制保存。')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '完成' }))

    await waitFor(() => expect(screen.queryByText('密钥已生成')).toBeNull())
    expect(document.body.textContent).not.toContain(PLAINTEXT)
    // 列表刷新后也只有前缀
    await waitFor(() => expect(mcpApi.listKeys.mock.calls.length).toBeGreaterThan(1))
    expect(document.body.textContent).not.toContain(PLAINTEXT)
  })

  test('轮换先确认；取消不调接口', async () => {
    setEnv({})
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '轮换' }))
    const confirm = await screen.findByRole('dialog')
    expect(within(confirm).getByText(/旧密钥立即失效/)).toBeTruthy()
    fireEvent.click(within(confirm).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(mcpApi.rotateKey).not.toHaveBeenCalled()
  })

  test('确认轮换后复用同一个弹窗，展示新明文', async () => {
    setEnv({})
    mcpApi.rotateKey.mockResolvedValue({ key: makeKey(), plaintext: ROTATED })
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '轮换' }))
    const confirm = await screen.findByRole('dialog')
    fireEvent.click(within(confirm).getByRole('button', { name: '轮换' }))
    await waitFor(() => expect(mcpApi.rotateKey).toHaveBeenCalledWith('k1'))
    await waitFor(() => expect(screen.getByText('密钥已生成')).toBeTruthy())
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('密钥已生成')).toBeTruthy()
    expect(within(dialog).getByText(ROTATED)).toBeTruthy()
  })
})

describe('撤销', () => {
  test('先确认再撤销；取消不调接口', async () => {
    setEnv({})
    mcpApi.revokeKey.mockResolvedValue(makeKey({ active: false, revoked_at: 1_700_000_100 }))
    renderTab()

    fireEvent.click(await screen.findByRole('button', { name: '撤销' }))
    let dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('撤销「Notion Agent」？')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(mcpApi.revokeKey).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '撤销' }))
    await waitFor(() => expect(mcpApi.revokeKey).toHaveBeenCalledWith('k1'))
  })
})

describe('公网地址校验与引导', () => {
  async function typeAndSave(value: string): Promise<void> {
    renderTab()
    const input = await screen.findByLabelText('公网地址')
    fireEvent.change(input, { target: { value } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
  }

  test.each([
    ['http://mcp.example.test/mcp', '必须以 https:// 开头'],
    ['https://localhost/mcp', '不能用 localhost、127.0.0.1 这类本机地址，请填公网主机名'],
    ['https://127.0.0.1:8231/mcp', '不能用 localhost、127.0.0.1 这类本机地址，请填公网主机名'],
    ['https://mcp.example.test/', '路径必须以 /mcp 结尾，例如 https://mcp.example.com/mcp']
  ])('%s 不合法：红字提示且不保存', async (value, message) => {
    setEnv({})
    await typeAndSave(value)
    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect(applyEnvPatchMock).not.toHaveBeenCalled()
  })

  test('合法地址照常保存', async () => {
    setEnv({})
    applyEnvPatchMock.mockResolvedValue({ ok: true, changedKeys: [], restartRequired: false })
    await typeAndSave(` ${PUBLIC_URL} `)
    await waitFor(() =>
      expect(applyEnvPatchMock).toHaveBeenCalledWith({ MAILAGENT_MCP_PUBLIC_URL: PUBLIC_URL })
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('「复制给 Agent」用本机地址里的真实端口，主机名未知时用占位符', async () => {
    setEnv({})
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '如何获得公网地址' }))
    expect(screen.getByText(/Service 填 http:\/\/localhost:8231。/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '复制给 Agent' }))
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1))
    const text = clipboardWrite.mock.calls[0][0]
    expect(text).toContain('http://localhost:8231/mcp')
    expect(text).toContain('Service 填 http://localhost:8231。')
    expect(text).toContain('https://<你的主机名>/mcp')
    expect(text).toContain('curl -i https://<你的主机名>/mcp')
    expect(text).not.toContain('8200')
  })

  test('已填公网地址且没检测：不出引导', async () => {
    setEnv({ MAILAGENT_MCP_PUBLIC_URL: PUBLIC_URL })
    renderTab()
    await screen.findByText(LOCAL_URL)
    expect(screen.queryByRole('button', { name: '如何获得公网地址' })).toBeNull()
  })
})
