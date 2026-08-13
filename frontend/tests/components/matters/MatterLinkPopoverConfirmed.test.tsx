// @vitest-environment happy-dom
//
// 2a review MEDIUM 的第二个手动关联出口：`MatterCreateDialog` 的「加入该事项」
//（`onUseExisting`）。它不在浮层的可见树里（要先开创建弹窗、再命中重复候选），所以把
// `MatterCreateDialog` 换成一个直接调 `onUseExisting` 的桩 —— 单独成文件，免得这份 mock
// 影响 `MatterLinkPopoverPortal.test.tsx` 里那几条形态用例。
//
// 判据同另一处：`ResourceRow` 以 `confirmed_at === null` 当「Agent 建议」态，手动关联落成
// 待确认的建议 = 用户自己挂的邮件带着「确认 / 忽略」两颗钮出现在事项里。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useRef } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import i18n from '@shared/i18n'

const { mattersApi, navigate } = vi.hoisted(() => ({
  mattersApi: {
    lookupResourceLinks: vi.fn(async () => ({ results: {} })),
    list: vi.fn(async () => ({ items: [] })),
    get: vi.fn(),
    create: vi.fn(),
    linkResource: vi.fn(),
    unlinkResource: vi.fn(),
    patchResource: vi.fn()
  },
  navigate: vi.fn()
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@shared/components/matters/hooks', () => ({
  useMattersApi: () => mattersApi,
  useMatterChatApi: () => ({ contextSnapshot: vi.fn(), applyUndo: vi.fn() })
}))
vi.mock('@shared/state/toast', () => ({
  useToastStore: { getState: () => ({ push: vi.fn(), dismiss: vi.fn() }) },
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn()
}))
vi.mock('@shared/components/matters/MatterCreateDialog', () => ({
  MatterCreateDialog: ({
    onUseExisting
  }: {
    onUseExisting(
      candidate: { matter: { public_id: string; title: string } },
      linkScope: 'thread' | 'single'
    ): void
  }) => (
    <button
      type="button"
      data-testid="use-existing"
      onClick={() =>
        onUseExisting({ matter: { public_id: 'MAT-0042', title: 'Vendor launch' } }, 'thread')
      }
    >
      加入该事项
    </button>
  )
}))

const { MatterLinkPopover } = await import('@shared/components/matters/MatterLinkPopover')

await i18n.changeLanguage('zh-CN')

function Host(): React.ReactElement {
  const anchorRef = useRef<HTMLDivElement>(null)
  return (
    <div ref={anchorRef} className="relative">
      <MatterLinkPopover
        open
        anchorRef={anchorRef}
        source={{
          internalId: 42,
          threadId: 'thread-9',
          subject: 'Vendor launch',
          sender: 'a@b.test',
          receivedAt: null,
          threadCount: 3
        }}
        onClose={vi.fn()}
      />
    </div>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mattersApi.lookupResourceLinks.mockResolvedValue({ results: {} })
  mattersApi.list.mockResolvedValue({ items: [] })
  mattersApi.get.mockResolvedValue({ matter: { public_id: 'MAT-0042', version: 7 } })
  mattersApi.linkResource.mockResolvedValue({ matter: { version: 8 } })
})

afterEach(cleanup)

describe('MatterLinkPopover — 「加入该事项」带 confirmed', () => {
  test('onUseExisting → linkResource 带 confirmed: true', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    })
    render(
      <QueryClientProvider client={client}>
        <Host />
      </QueryClientProvider>
    )
    fireEvent.click(await screen.findByTestId('use-existing'))
    await waitFor(() => expect(mattersApi.linkResource).toHaveBeenCalledTimes(1))
    const [publicId, payload, options] = mattersApi.linkResource.mock.calls[0]
    expect(publicId).toBe('MAT-0042')
    expect(payload.confirmed).toBe(true)
    expect(payload.source_resource.link_scope).toBe('thread')
    expect(options.reason).toBe('user_selected_duplicate_matter')
  })
})
