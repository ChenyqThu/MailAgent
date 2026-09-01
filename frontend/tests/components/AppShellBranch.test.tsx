// @vitest-environment happy-dom
//
// App 的三个顶层壳分支（task 08-27 P5 起从两个变三个）：轻窗 / popout / 主 shell 互斥，
// 且前两者**都不挂 AppRouter**。不挂 router 是「轻窗」形态 B 的地基 —— ⌘W 因此不被
// GlobalShortcuts（只挂在 RootLayout 里）吃掉，跨窗标签态也就无从写起。
//
// 三个壳一律 mock 成哨兵：本用例只验分支选择，内容分派另见 DetachedShell.test.tsx。

import { beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('@shared/router', () => ({
  AppRouter: (): React.ReactElement => <div data-testid="app-router" />
}))
vi.mock('@shared/components/chat/PopoutShell', () => ({
  PopoutShell: (): React.ReactElement => <div data-testid="popout-shell" />
}))
vi.mock('@shared/components/DetachedShell', () => ({
  DetachedShell: (): React.ReactElement => <div data-testid="detached-shell" />
}))
vi.mock('@shared/components/UpdateReadyBanner', () => ({
  UpdateReadyBanner: (): null => null
}))
vi.mock('@shared/state/appearance', () => ({ bootAppearance: (): void => {} }))
vi.mock('@shared/lib/fileDropGuard', () => ({ installFileDropGuard: () => (): void => {} }))
vi.mock('@shared/hooks/useEventBridge', () => ({ useEventBridge: (): void => {} }))
vi.mock('@shared/hooks/useApiReadyRefresh', () => ({ useApiReadyRefresh: (): void => {} }))
vi.mock('@shared/hooks/useStartupPrefetch', () => ({ useStartupPrefetch: (): void => {} }))
vi.mock('@shared/api/factory', () => ({
  makeMailApi: () => ({
    updater: { status: async () => ({}), onEvent: () => (): void => {} },
    island: { status: async () => ({}), onEvent: () => (): void => {} }
  })
}))

const App = (await import('../../src/electron/renderer/App')).default
const { usePopoutMode } = await import('../../src/shared/state/popout-mode')
const { useDetachedMode } = await import('../../src/shared/state/detached-mode')

beforeEach(() => {
  cleanup()
  usePopoutMode.setState({ isPopout: false, emailId: null })
  useDetachedMode.setState({ isDetached: false, target: null })
})

describe('App 壳分支', () => {
  test('既非轻窗也非 popout → 主 shell（AppRouter）', async () => {
    render(<App />)
    expect(await screen.findByTestId('app-router')).toBeTruthy()
    expect(screen.queryByTestId('detached-shell')).toBeNull()
    expect(screen.queryByTestId('popout-shell')).toBeNull()
  })

  test('popout → PopoutShell，不挂 AppRouter', async () => {
    usePopoutMode.setState({ isPopout: true, emailId: 1 })
    render(<App />)
    expect(await screen.findByTestId('popout-shell')).toBeTruthy()
    expect(screen.queryByTestId('app-router')).toBeNull()
  })

  test('轻窗 → DetachedShell，不挂 AppRouter', async () => {
    useDetachedMode.setState({ isDetached: true, target: { kind: 'email', emailId: 7 } })
    render(<App />)
    expect(await screen.findByTestId('detached-shell')).toBeTruthy()
    expect(screen.queryByTestId('app-router')).toBeNull()
    expect(screen.queryByTestId('popout-shell')).toBeNull()
  })

  test('两个 query 同时在场（只可能来自手敲 URL）→ 轻窗优先', async () => {
    usePopoutMode.setState({ isPopout: true, emailId: 1 })
    useDetachedMode.setState({ isDetached: true, target: { kind: 'report', reportId: 'r1' } })
    render(<App />)
    expect(await screen.findByTestId('detached-shell')).toBeTruthy()
    expect(screen.queryByTestId('popout-shell')).toBeNull()
  })
})
