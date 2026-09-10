// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useTodayClock } from '@shared/components/today/useTodayClock'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
test('无网络成功也跨午夜前进，后台暂停，恢复时刷新当前时间', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-09T23:59:30Z'))
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const client = new QueryClient()
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const { result } = renderHook(useTodayClock, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
  })
  act(() => vi.advanceTimersByTime(60000))
  expect(new Date(result.current).toISOString()).toBe('2026-09-10T00:00:30.000Z')
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  act(() => vi.advanceTimersByTime(120000))
  expect(new Date(result.current).toISOString()).toBe('2026-09-10T00:00:30.000Z')
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  act(() => window.dispatchEvent(new Event('focus')))
  expect(new Date(result.current).toISOString()).toBe('2026-09-10T00:02:30.000Z')
  expect(invalidate).toHaveBeenCalled()
  vi.restoreAllMocks()
  client.clear()
})
