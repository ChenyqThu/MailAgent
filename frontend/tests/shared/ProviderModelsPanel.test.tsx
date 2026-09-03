// @vitest-environment happy-dom
//
// 设置-AI「模型服务」区的 per-provider 模型面板 —— 09-02 接上模型元数据目录。
//
// 盯两件事：
//   ① `capabilities_json` 为 NULL 的行（真实机器上几乎全是）也能显示能力 chip 与上下文，
//      数据来自 models.dev 目录快照，与 composer 选择器同一个 `composeComposerModelOption`。
//   ② 🔴 目录值只进**只读位**（chip + placeholder），绝不进 Input 的 value —— 进了 value
//      就会被 blur 当成用户手填值 PUT 回 DB，把一个猜测变成事实。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

import type { LlmProviderModel } from '../../src/shared/hooks/useLlmProviders'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))
vi.mock('@shared/state/toast', () => ({ toastError: vi.fn() }))

const { models } = vi.hoisted(() => ({ models: { rows: [] as unknown[] } }))
vi.mock('@shared/hooks/useLlmProviders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/hooks/useLlmProviders')>()),
  useLlmProviderModels: () => ({ models: models.rows, isLoading: false })
}))

import { ProviderModelsPanel } from '../../src/shared/components/settings/providers/ProviderModelsPanel'

function row(partial: Partial<LlmProviderModel> & { id: string }): LlmProviderModel {
  return {
    displayName: null,
    groupName: null,
    enabled: false,
    capabilities: null,
    maxOutput: null,
    contextWindow: null,
    source: 'fetched',
    fetchedAt: null,
    ...partial
  }
}

function mount(rows: LlmProviderModel[]): void {
  models.rows = rows
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(ProviderModelsPanel, {
        providerId: 'default',
        protocol: 'anthropic',
        readOnly: false
      })
    )
  )
}

afterEach(cleanup)

describe('ProviderModelsPanel × 模型元数据目录', () => {
  test('DB 行元数据全 NULL 时，能力 chip 与上下文来自目录', () => {
    mount([row({ id: 'claude-sonnet-4-5' })])
    // caps: tools / reasoning / vision（目录 anthropic/claude-sonnet-4-5）
    expect(screen.getByText('settings.providers.models.cap.tools')).toBeTruthy()
    expect(screen.getByText('settings.providers.models.cap.vision')).toBeTruthy()
    expect(screen.getByText('settings.providers.models.cap.reasoning')).toBeTruthy()

    const ctx = screen.getByLabelText('settings.providers.models.contextWindowAria')
    const out = screen.getByLabelText('settings.providers.models.maxOutputAria')
    // 🔴 目录值走 placeholder，value 保持空 —— blur 才不会把它写进 DB
    expect((ctx as HTMLInputElement).value).toBe('')
    expect((ctx as HTMLInputElement).placeholder).toBe('1M')
    expect((out as HTMLInputElement).value).toBe('')
    expect((out as HTMLInputElement).placeholder).toBe('64K')
  })

  test('DB 行有值时行赢：value 是手填值，placeholder 不改写它', () => {
    mount([row({ id: 'claude-sonnet-4-5', maxOutput: 8192, contextWindow: 131072 })])
    const ctx = screen.getByLabelText('settings.providers.models.contextWindowAria')
    const out = screen.getByLabelText('settings.providers.models.maxOutputAria')
    expect((ctx as HTMLInputElement).value).toBe('131072')
    expect((out as HTMLInputElement).value).toBe('8192')
  })

  test('目录未命中 → 与接目录之前逐字一样（无 chip，placeholder 是字面提示）', () => {
    mount([row({ id: 'my-relay-private-model-x' })])
    expect(screen.queryByText('settings.providers.models.cap.tools')).toBeNull()
    const ctx = screen.getByLabelText('settings.providers.models.contextWindowAria')
    expect((ctx as HTMLInputElement).placeholder).toBe(
      'settings.providers.models.contextWindowPlaceholder'
    )
  })
})
