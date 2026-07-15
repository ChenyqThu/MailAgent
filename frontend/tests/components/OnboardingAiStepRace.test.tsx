// @vitest-environment happy-dom
//
// 发版终审 M1（codex MEDIUM-1，批 2 MEDIUM-5 的遗留竞态）— onboarding「AI 模型」步的
// provider registry flag 查询竞态：离开 sync 时查询未决 → 3s 超时按 off 放行进 plugins；
// **迟到的 true 只要用户还没走到 done 就必须采纳**——停在 plugins 时插步 = 当前索引原地
// 变成 'ai'（等价跳转，plugins 仍是下一步）；已到 done 则永久放弃（步序不再动）。
// 步骤组件全部 stub 成「一颗 next 按钮」，只测 OnboardingRoot 的步序状态机。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement as h } from 'react'
import type { JSX, ReactNode } from 'react'

const { mockLlmProviderStatus } = vi.hoisted(() => ({ mockLlmProviderStatus: vi.fn() }))

vi.mock('../../src/electron/renderer/onboarding/ipc', () => ({
  status: vi.fn(async () => ({ state: 'new' })),
  detectLegacy: vi.fn(async () => ({ found: false })),
  llmProviderStatus: mockLlmProviderStatus
}))

vi.mock('../../src/electron/renderer/onboarding/steps', () => {
  const stub =
    (name: string) =>
    (props: { onNext?: () => void }): JSX.Element =>
      h('button', { 'data-testid': `step-${name}`, onClick: props.onNext }, name)
  return {
    StepWelcome: stub('welcome'),
    StepFDA: stub('fda'),
    StepBackend: stub('backend'),
    StepConfig: stub('config'),
    StepFolders: stub('folders'),
    StepSync: stub('sync'),
    StepAiModel: stub('ai'),
    StepPlugins: stub('plugins'),
    StepDone: stub('done'),
    buildCompleteConfig: vi.fn()
  }
})

vi.mock('../../src/electron/renderer/onboarding/branches', () => ({
  LegacyFlow: () => null,
  HalfFlow: () => null,
  DBCorruptScreen: () => null,
  RollbackScreen: () => null
}))

vi.mock('../../src/electron/renderer/onboarding/components', () => ({
  OnboardingShell: (props: { children?: ReactNode }) => h('div', null, props.children),
  StepRail: () => null
}))

const OnboardingRoot = (await import('../../src/electron/renderer/onboarding/OnboardingRoot'))
  .default

/** 手控 llmProviderStatus 的 deferred。 */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** welcome → fda → backend → config → sync（applescript 默认无 folders 步）。 */
async function walkToSync(): Promise<void> {
  for (const key of ['welcome', 'fda', 'backend', 'config']) {
    fireEvent.click(screen.getByTestId(`step-${key}`))
    await act(async () => {})
  }
  expect(screen.getByTestId('step-sync')).toBeTruthy()
}

/** 点 sync 的下一步（查询未决 → 进 race 分支）并放 3s 超时到点。 */
async function advancePastSyncViaTimeout(): Promise<void> {
  fireEvent.click(screen.getByTestId('step-sync'))
  await act(async () => {
    vi.advanceTimersByTime(3_000)
  })
  expect(screen.getByTestId('step-plugins')).toBeTruthy()
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('OnboardingRoot AI-step flag race (M1)', () => {
  test('late true while sitting on plugins → the AI step is inserted and shown in place', async () => {
    const d = deferred<{ enabled: boolean }>()
    mockLlmProviderStatus.mockReturnValue(d.promise)
    render(h(OnboardingRoot))
    await act(async () => {})

    await walkToSync()
    await advancePastSyncViaTimeout()

    // 迟到的 true：用户还停在 plugins（未提交完成）→ 插回 AI 步，当前索引原地变 'ai'。
    await act(async () => {
      d.resolve({ enabled: true })
    })
    expect(screen.getByTestId('step-ai')).toBeTruthy()

    // plugins 仍是下一步，流程完整走得完。
    fireEvent.click(screen.getByTestId('step-ai'))
    await act(async () => {})
    expect(screen.getByTestId('step-plugins')).toBeTruthy()
    fireEvent.click(screen.getByTestId('step-plugins'))
    await act(async () => {})
    expect(screen.getByTestId('step-done')).toBeTruthy()
  })

  test('late true after reaching done → NOT adopted (step order frozen at completion)', async () => {
    const d = deferred<{ enabled: boolean }>()
    mockLlmProviderStatus.mockReturnValue(d.promise)
    render(h(OnboardingRoot))
    await act(async () => {})

    await walkToSync()
    await advancePastSyncViaTimeout()
    fireEvent.click(screen.getByTestId('step-plugins'))
    await act(async () => {})
    expect(screen.getByTestId('step-done')).toBeTruthy()

    await act(async () => {
      d.resolve({ enabled: true })
    })
    // done 不动：不插步、不跳转。
    expect(screen.getByTestId('step-done')).toBeTruthy()
    expect(screen.queryByTestId('step-ai')).toBeNull()
  })

  test('in-flight true resolving before the user leaves sync → AI step follows sync (pre-existing path)', async () => {
    const d = deferred<{ enabled: boolean }>()
    mockLlmProviderStatus.mockReturnValue(d.promise)
    render(h(OnboardingRoot))
    await act(async () => {})

    await walkToSync()
    await act(async () => {
      d.resolve({ enabled: true })
    })
    fireEvent.click(screen.getByTestId('step-sync'))
    await act(async () => {})
    expect(screen.getByTestId('step-ai')).toBeTruthy()
  })
})
