// D2b — watchResyncJob contract (batch resync 进度 watcher)。
//
// 真 toast store (zustand singleton, __resetToastStore between cases) + mock 的
// mailApi (events.onEvent 捕获 SSE handler / jobs.get) + queryClient。验证:
//   - sticky progress toast push + SSE/轮询驱动 progress fraction
//   - 终态 (succeeded/partial/failed) → dismiss progress + 终态 toast + invalidate + unsub
//   - 轮询兜底 (web 无 SSE) 单独能拿终态; 轮询 reject 不误终结
//   - job_id 过滤 (别的 job 事件不串扰)

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { __resetToastStore, useToastStore } from '../../src/shared/state/toast'
import { watchResyncJob, type TranslateFn } from '../../src/shared/state/resyncJob'
import type { MailApi, SseEvent } from '@shared/api/types'
import type { QueryClient } from '@tanstack/react-query'

// identity t — 断言看到 i18n key 本身 (不渲染 ICU 插值)。
const t: TranslateFn = (key) => key

let sseHandler: ((ev: SseEvent) => void) | null
let unsubSpy: ReturnType<typeof vi.fn>
let getJob: ReturnType<typeof vi.fn>
let invalidate: ReturnType<typeof vi.fn>
let mailApi: MailApi
let queryClient: QueryClient

function makeEvent(eventType: string, data: Record<string, unknown>): SseEvent {
  return { event_type: eventType, ts: 0, internal_id: null, data, source: 'job-worker' }
}

beforeEach(() => {
  __resetToastStore()
  vi.useFakeTimers()
  sseHandler = null
  unsubSpy = vi.fn()
  getJob = vi.fn()
  invalidate = vi.fn().mockResolvedValue(undefined)
  mailApi = {
    events: {
      onEvent: vi.fn((h: (ev: SseEvent) => void) => {
        sseHandler = h
        return unsubSpy
      })
    },
    jobs: { get: getJob }
  } as unknown as MailApi
  queryClient = { invalidateQueries: invalidate } as unknown as QueryClient
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('watchResyncJob — sticky progress + SSE terminal', () => {
  test('pushes a sticky progress toast on start', () => {
    watchResyncJob({ mailApi, queryClient, t, jobId: 7, total: 3 })
    const items = useToastStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0].progress).toBe(0)
    expect(items[0].title).toBe('batchbar.resync')
  })

  test('SSE job.progress updates the progress fraction', () => {
    watchResyncJob({ mailApi, queryClient, t, jobId: 7, total: 4 })
    sseHandler!(makeEvent('job.progress', { job_id: 7, done: 2, total: 4 }))
    expect(useToastStore.getState().items[0].progress).toBeCloseTo(0.5)
  })

  test('SSE job.done succeeded → dismiss progress + success toast + invalidate + unsub', () => {
    watchResyncJob({ mailApi, queryClient, t, jobId: 7, total: 3 })
    sseHandler!(
      makeEvent('job.done', {
        job_id: 7,
        status: 'succeeded',
        summary: { total: 3, succeeded: 3, failed: 0 }
      })
    )
    const items = useToastStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0].variant).toBe('success')
    expect(items[0].title).toBe('batchToast.ok')
    expect(items[0].progress).toBeUndefined() // 终态 toast 无进度条
    expect(unsubSpy).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['emails'] })
  })

  test('SSE job.done partial_failure → error toast with partial key', () => {
    watchResyncJob({ mailApi, queryClient, t, jobId: 7, total: 5 })
    sseHandler!(
      makeEvent('job.done', {
        job_id: 7,
        status: 'partial_failure',
        summary: { total: 5, succeeded: 3, failed: 2 }
      })
    )
    const items = useToastStore.getState().items
    expect(items[0].variant).toBe('error')
    expect(items[0].title).toBe('batchToast.partial')
  })

  test('SSE job.failed (runner crash, no summary) → error toast carrying the error', () => {
    watchResyncJob({ mailApi, queryClient, t, jobId: 5, total: 2 })
    sseHandler!(makeEvent('job.failed', { job_id: 5, error: 'NotionClient: boom' }))
    const items = useToastStore.getState().items
    expect(items[0].variant).toBe('error')
    expect(items[0].title).toBe('toolbarToast.resyncFailGeneric')
    expect(items[0].detail).toBe('NotionClient: boom')
  })

  test('ignores job.* events for a different job_id', () => {
    watchResyncJob({ mailApi, queryClient, t, jobId: 1, total: 5 })
    sseHandler!(makeEvent('job.done', { job_id: 999, status: 'succeeded', summary: {} }))
    const items = useToastStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0].progress).toBe(0) // 仍是 progress toast, 未终结
    expect(unsubSpy).not.toHaveBeenCalled()
    expect(invalidate).not.toHaveBeenCalled()
  })
})

describe('watchResyncJob — polling fallback (web: no SSE)', () => {
  test('polls GET /jobs/{id} and finishes on terminal status', async () => {
    getJob
      .mockResolvedValueOnce({
        status: 'running',
        progress_done: 1,
        progress_total: 4,
        result: null,
        last_error: null
      })
      .mockResolvedValueOnce({
        status: 'succeeded',
        progress_done: 4,
        progress_total: 4,
        result: { total: 4, succeeded: 4, failed: 0 },
        last_error: null
      })
    watchResyncJob({ mailApi, queryClient, t, jobId: 9, total: 4 })

    // first poll tick (1.5s) → running, progress updated, still tracking
    await vi.advanceTimersByTimeAsync(1500)
    expect(getJob).toHaveBeenCalledWith(9)
    expect(useToastStore.getState().items[0].progress).toBeCloseTo(0.25)

    // second poll tick → succeeded → terminal
    await vi.advanceTimersByTimeAsync(1500)
    const items = useToastStore.getState().items
    expect(items.some((i) => i.variant === 'success')).toBe(true)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['emails'] })
  })

  test('a poll rejection does not settle — keeps retrying', async () => {
    getJob.mockRejectedValueOnce(new Error('daemon unreachable')).mockResolvedValueOnce({
      status: 'succeeded',
      progress_done: 2,
      progress_total: 2,
      result: { total: 2, succeeded: 2, failed: 0 },
      last_error: null
    })
    watchResyncJob({ mailApi, queryClient, t, jobId: 3, total: 2 })

    await vi.advanceTimersByTimeAsync(1500) // rejects → still tracking
    expect(useToastStore.getState().items[0].progress).toBe(0)
    await vi.advanceTimersByTimeAsync(1500) // succeeds → terminal
    expect(useToastStore.getState().items.some((i) => i.variant === 'success')).toBe(true)
  })
})
