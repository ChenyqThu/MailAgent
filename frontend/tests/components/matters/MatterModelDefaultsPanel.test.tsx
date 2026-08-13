// @vitest-environment happy-dom
//
// 0813 dogfood 轮 3 · B10 —— 全局跟进 Agent 的**模型默认**（持久化那一半）。
//
// owner 反馈：「跟进规则的全局 matter agent 配置，仍然没有模型配置啊，看设计，override
// 倒是有了」。三道闸各管一段，合起来才算闭环：
//   · 生效链路 → `tests/matters/test_matter_agent_defaults.py`（全局默认真的进了 run spec）
//   · 转换与门 → `tests/components/matters/matterModelFields.test.tsx`
//   · 本文件   → 界面显示的、点下去存的、存不进去时退回的，是不是同一个东西
//
// 🔴 `MatterModelFields` 在这里被换成一个探针：Radix Select 的选中在 happy-dom 里驱动不
// 起来（仓内所有 Select 测试都只断言选项、从不真的选一个），真去点会得到一个"什么都没测到
// 却全绿"的文件。共用的 `useMatterModelFields` 保持真身 —— 存进去的那个块正是它算出来的。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import i18n from '@shared/i18n'

const { models, toastError } = vi.hoisted(() => ({
  models: { value: [] as Record<string, unknown>[] },
  toastError: vi.fn()
}))

vi.mock('@shared/hooks/useComposerModels', () => ({
  useComposerModels: () => models.value
}))
vi.mock('@shared/state/toast', () => ({
  toastError,
  toastSuccess: vi.fn(),
  toastInfo: vi.fn()
}))

// 只换掉那个渲染 Radix Select 的组件；判定层 `matterModelDraft.ts` 用真身 —— 存进去的那个
// 块正是它算出来的。
vi.mock('@shared/components/matters/MatterModelFields', () => ({
  MatterModelFields: ({
    draft,
    onDraftChange,
    disabled
  }: {
    draft: { model: string; effort: string; fallback: string }
    onDraftChange(next: { model: string; effort: string; fallback: string }): void
    disabled?: boolean
  }) => (
    <div>
      <span data-testid="draft">{JSON.stringify(draft)}</span>
      <span data-testid="disabled">{String(Boolean(disabled))}</span>
      <button
        type="button"
        data-testid="pick-thinker"
        onClick={() => onDraftChange({ ...draft, model: 'default:thinker' })}
      >
        thinker
      </button>
      <button
        type="button"
        data-testid="pick-plain"
        onClick={() => onDraftChange({ ...draft, model: 'default:plain' })}
      >
        plain
      </button>
      <button
        type="button"
        data-testid="pick-no-fallback"
        onClick={() => onDraftChange({ ...draft, fallback: '__no_fallback__' })}
      >
        no fallback
      </button>
    </div>
  )
}))

const { MatterModelDefaultsPanel } = await import(
  '@shared/components/matters/MatterModelDefaultsPanel'
)

await i18n.changeLanguage('zh-CN')

function option(ref: string, reasoning: boolean): Record<string, unknown> {
  return {
    ref,
    providerId: 'default',
    providerLabel: null,
    protocol: 'anthropic',
    modelId: ref.split(':').pop(),
    displayName: ref,
    capabilities: { reasoning },
    maxOutput: null,
    contextWindow: null,
    catalogMeta: null
  }
}

const stored = { value: {} as Record<string, unknown> }
const getOk = { value: true }
const putOk = { value: true }
const putBodies: unknown[] = []
let resolveGet: (() => void) | null = null

function envelope(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ data }) } as unknown as Response
}

beforeEach(() => {
  vi.clearAllMocks()
  models.value = [option('default:thinker', true), option('default:plain', false)]
  stored.value = {}
  getOk.value = true
  putOk.value = true
  putBodies.length = 0
  resolveGet = null
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = String(input)
      if (url.includes('/matters/agent-defaults')) {
        if ((init?.method ?? 'GET') === 'PUT') {
          const body = JSON.parse(init?.body ?? '{}') as { defaults?: Record<string, unknown> }
          putBodies.push(body.defaults)
          if (!putOk.value) return { ok: false, status: 500 } as unknown as Response
          stored.value = body.defaults ?? {}
          return envelope({ defaults: stored.value })
        }
        if (!getOk.value) return { ok: false, status: 500 } as unknown as Response
        if (resolveGet) await new Promise<void>((r) => (resolveGet = r))
        return envelope({ defaults: stored.value })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderPanel(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MatterModelDefaultsPanel />
    </QueryClientProvider>
  )
}

describe('MatterModelDefaultsPanel —— 全局模型默认', () => {
  test('服务端已有默认 → 草稿就是它（不是一个本地初值）', async () => {
    stored.value = { model: 'default:thinker', effort: 'high' }
    renderPanel()
    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId('draft').textContent ?? '{}')).toEqual({
        model: 'default:thinker',
        effort: 'high',
        fallback: '__follow__'
      })
    )
  })

  test('🔴 还没读回来时不渲染那三个控件（未加载的草稿与「没配过」长得一模一样）', async () => {
    resolveGet = () => {}
    renderPanel()
    expect(screen.queryByTestId('draft')).toBeNull()
    expect(screen.getByText('加载中…')).toBeTruthy()
  })

  test('改一项 → 当场 PUT 回去（不用等页脚的保存）', async () => {
    renderPanel()
    await screen.findByTestId('draft')
    fireEvent.click(screen.getByTestId('pick-thinker'))
    await waitFor(() => expect(putBodies).toEqual([{ model: 'default:thinker' }]))
    // 写回缓存的是**服务端返回**的那份，于是「显示的 == 存进去的」结构上永真
    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId('draft').textContent ?? '{}').model).toBe(
        'default:thinker'
      )
    )
  })

  test('🔴 换成没有 reasoning 能力的模型 → 思考强度一起从存储块里消失', async () => {
    stored.value = { model: 'default:thinker', effort: 'high' }
    renderPanel()
    await screen.findByTestId('draft')
    fireEvent.click(screen.getByTestId('pick-plain'))
    // 不是 {model:'default:plain', effort:'high'} —— 那一档对这个模型存了也不生效，
    // 还可能让整轮 run 400（16b 契约）。
    await waitFor(() => expect(putBodies).toEqual([{ model: 'default:plain' }]))
  })

  test('「不设兜底」存的是空数组（与「不设默认」是两种不同的空）', async () => {
    renderPanel()
    await screen.findByTestId('draft')
    fireEvent.click(screen.getByTestId('pick-no-fallback'))
    await waitFor(() => expect(putBodies).toEqual([{ fallback_models: [] }]))
  })

  test('🔴 保存失败 → toast 报错 + 显示退回服务端事实（不留一个没存进去的值）', async () => {
    putOk.value = false
    stored.value = { model: 'default:thinker' }
    renderPanel()
    await screen.findByTestId('draft')
    fireEvent.click(screen.getByTestId('pick-plain'))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId('draft').textContent ?? '{}').model).toBe(
        'default:thinker'
      )
    )
  })

  test('🔴 读失败 → 如实说出来，且锁住控件（空草稿存下去等于清空别人的配置）', async () => {
    getOk.value = false
    renderPanel()
    expect(await screen.findByText(/读取失败/)).toBeTruthy()
    expect(screen.getByTestId('disabled').textContent).toBe('true')
  })
})
