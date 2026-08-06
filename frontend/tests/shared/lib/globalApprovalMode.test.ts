// @vitest-environment happy-dom
//
// 07-16 approval-mode switcher — renderer store determinism (codex r1 P2-5, covering the P1-1 /
// P1-2 scenarios the gateway/API tests can't see):
//   - first read failure → mode stays UNKNOWN (null, never a guessed 'manual') + timer retry
//     converges once the backend is back;
//   - window focus / visibilitychange re-GETs (cross-window / remote-web staleness);
//   - pessimistic downgrade: while the PUT is pending the store still shows the confirmed mode
//     (bypass) + saving=true; only the server-canonical response flips it;
//   - concurrent mutations are serialized (second setMode while saving → false, ONE PUT);
//   - a failed/indeterminate PUT drops to unknown and re-GETs to converge (no stale rollback).
// codex r2 P1-a / P1-b negative paths:
//   - a refresh failure over an ALREADY-CONFIRMED mode drops to unknown immediately (never keeps
//     impersonating the stale value) and the retry loop converges on the new server truth;
//   - a PUT failure while an older GET is still hanging issues an immediate NEW GET (epoch-based
//     request management — no in-flight boolean gate, no 15s timer wait), and the hanging GET's
//     late settle is discarded;
//   - a never-settling GET times out (APPROVAL_MODE_GET_TIMEOUT_MS) → counted as a read failure,
//     and the retry loop keeps issuing fresh GETs that recover the store.
// codex r3 negative path:
//   - a never-settling PUT times out (same deadline) → `saving` clears (a hung PUT must not
//     permanently wedge the module-level store — focus/retry refreshes are gated on `saving`),
//     mode drops to unknown, and the immediate convergence re-GET recovers the server truth.
//
// useMailApi is mocked as a stable singleton whose chat face delegates to swappable vi.fn mocks
// (the store captures the api face per mount; tests swap implementations, not the object).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'

import {
  APPROVAL_MODE_GET_TIMEOUT_MS,
  APPROVAL_MODE_RETRY_MS,
  __resetGlobalApprovalModeForTests,
  useGlobalApprovalMode,
  type GlobalApprovalMode
} from '../../../src/shared/lib/globalApprovalMode'

const { stableMailApi, mockGet, mockSet } = vi.hoisted(() => {
  const mockGet = vi.fn<() => Promise<string>>()
  const mockSet = vi.fn<(mode: string) => Promise<string>>()
  const stableMailApi = {
    chat: {
      getApprovalMode: mockGet,
      setApprovalMode: mockSet
    }
  }
  return { stableMailApi, mockGet, mockSet }
})

vi.mock('../../../src/shared/hooks/useMailApi', () => ({
  useMailApi: () => stableMailApi
}))

/** A promise the test resolves/rejects by hand (pending-PUT control). */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: Error) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Flush pending microtasks under fake timers (await can't rely on real timers here). */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  __resetGlobalApprovalModeForTests()
  mockGet.mockReset()
  mockSet.mockReset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('first read failure → unknown + timer retry converges', () => {
  test('GET rejects → mode null (never manual); retry after APPROVAL_MODE_RETRY_MS converges', async () => {
    mockGet.mockRejectedValueOnce(new Error('serve-api down'))
    mockGet.mockResolvedValueOnce('bypass')
    const { result } = renderHook(() => useGlobalApprovalMode())
    await flush()
    // failed read: UNKNOWN — the chip must not claim Manual while the DB could hold bypass.
    expect(result.current.mode).toBeNull()
    expect(mockGet).toHaveBeenCalledTimes(1)
    // the retry timer re-GETs and converges on the real persisted value.
    await act(async () => {
      vi.advanceTimersByTime(APPROVAL_MODE_RETRY_MS)
    })
    await flush()
    expect(mockGet).toHaveBeenCalledTimes(2)
    expect(result.current.mode).toBe('bypass')
  })

  test('repeated failures keep retrying (backstop loop, no give-up after one attempt)', async () => {
    mockGet.mockRejectedValue(new Error('still down'))
    const { result } = renderHook(() => useGlobalApprovalMode())
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(APPROVAL_MODE_RETRY_MS)
    })
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(APPROVAL_MODE_RETRY_MS)
    })
    await flush()
    expect(mockGet).toHaveBeenCalledTimes(3)
    expect(result.current.mode).toBeNull()
  })
})

describe('focus / visibility refresh (cross-window + remote-web staleness)', () => {
  test('window focus re-GETs and picks up a mode changed elsewhere', async () => {
    mockGet.mockResolvedValueOnce('manual')
    const { result } = renderHook(() => useGlobalApprovalMode())
    await flush()
    expect(result.current.mode).toBe('manual')
    // another window / the remote web switched the persisted mode to bypass.
    mockGet.mockResolvedValueOnce('bypass')
    await act(async () => {
      vi.advanceTimersByTime(2_000) // past the refresh throttle
      window.dispatchEvent(new Event('focus'))
    })
    await flush()
    expect(mockGet).toHaveBeenCalledTimes(2)
    expect(result.current.mode).toBe('bypass')
  })

  test('focus bursts within the throttle window do not spam the endpoint', async () => {
    mockGet.mockResolvedValue('manual')
    renderHook(() => useGlobalApprovalMode())
    await flush()
    expect(mockGet).toHaveBeenCalledTimes(1)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await flush()
    expect(mockGet).toHaveBeenCalledTimes(1) // throttled — the read just succeeded
  })
})

describe('pessimistic mutation (codex r1 P1-2)', () => {
  test('downgrade bypass→manual: shows bypass + saving until the server-canonical PUT resolves', async () => {
    mockGet.mockResolvedValueOnce('bypass')
    const put = deferred<string>()
    mockSet.mockReturnValueOnce(put.promise as Promise<string>)
    const { result } = renderHook(() => useGlobalApprovalMode())
    await flush()
    expect(result.current.mode).toBe('bypass')

    let settled: Promise<boolean>
    act(() => {
      settled = result.current.setMode('manual' as GlobalApprovalMode)
    })
    await flush()
    // PUT pending: the DISPLAYED mode is still the confirmed bypass — never an optimistic manual.
    expect(result.current.mode).toBe('bypass')
    expect(result.current.saving).toBe(true)
    await act(async () => {
      put.resolve('manual')
      await settled
    })
    expect(result.current.mode).toBe('manual')
    expect(result.current.saving).toBe(false)
  })

  test('the store converges on the SERVER-canonical response, not the requested value', async () => {
    mockGet.mockResolvedValueOnce('manual')
    // a hypothetical server normalization: the PUT for 'bypass' echoes back 'manual'
    // (08-05 WP-11 two-mode vocabulary — 'acceptEdits' no longer exists to echo).
    mockSet.mockResolvedValueOnce('manual')
    const { result } = renderHook(() => useGlobalApprovalMode())
    await flush()
    let ok = false
    await act(async () => {
      ok = await result.current.setMode('bypass' as GlobalApprovalMode)
    })
    expect(ok).toBe(true)
    expect(result.current.mode).toBe('manual')
    expect(mockSet).toHaveBeenCalledWith('bypass')
  })

  test('concurrent mutations serialize: second setMode while saving → false, exactly ONE PUT', async () => {
    mockGet.mockResolvedValueOnce('manual')
    const put = deferred<string>()
    mockSet.mockReturnValueOnce(put.promise as Promise<string>)
    const { result } = renderHook(() => useGlobalApprovalMode())
    await flush()

    let first: Promise<boolean>
    act(() => {
      first = result.current.setMode('bypass' as GlobalApprovalMode)
    })
    await flush()
    let second = true
    await act(async () => {
      second = await result.current.setMode('manual' as GlobalApprovalMode)
    })
    expect(second).toBe(false) // rejected while saving — no interleaved state
    expect(mockSet).toHaveBeenCalledTimes(1)
    await act(async () => {
      put.resolve('bypass')
      await first
    })
    expect(result.current.mode).toBe('bypass') // the first (only) PUT's canonical result stands
  })

  test('failed PUT → unknown (indeterminate persist) + immediate re-GET converges on server truth', async () => {
    mockGet.mockResolvedValueOnce('bypass')
    mockSet.mockRejectedValueOnce(new Error('PUT failed'))
    // the convergence re-GET reveals the server actually still holds bypass.
    mockGet.mockResolvedValueOnce('bypass')
    const { result } = renderHook(() => useGlobalApprovalMode())
    await flush()
    expect(result.current.mode).toBe('bypass')
    let ok = true
    await act(async () => {
      ok = await result.current.setMode('manual' as GlobalApprovalMode)
    })
    await flush()
    expect(ok).toBe(false)
    expect(result.current.saving).toBe(false)
    // converged back on the confirmed server value (never a stale optimistic rollback).
    // (no waitFor here — testing-library's waitFor polls on REAL timers, which vi.useFakeTimers
    // holds forever; the fire-and-forget re-GET settles within the flushed microtasks.)
    expect(result.current.mode).toBe('bypass')
    expect(mockGet).toHaveBeenCalledTimes(2)
  })

  test('a GET already in flight when a PUT starts can never clobber the canonical result', async () => {
    const get1 = deferred<string>()
    mockGet.mockReturnValueOnce(get1.promise as Promise<string>)
    mockSet.mockResolvedValueOnce('bypass')
    const { result } = renderHook(() => useGlobalApprovalMode())
    await flush()
    // PUT starts (and finishes) while the slow initial GET is still pending.
    await act(async () => {
      await result.current.setMode('bypass' as GlobalApprovalMode)
    })
    expect(result.current.mode).toBe('bypass')
    // the slow GET now resolves with the PRE-PUT value — it must be discarded (stale epoch).
    await act(async () => {
      get1.resolve('manual')
      await Promise.resolve()
    })
    expect(result.current.mode).toBe('bypass')
  })
})

describe('codex r2 P1-a — refresh failure over a confirmed mode', () => {
  test('confirmed manual + focus GET reject → IMMEDIATE unknown, retry converges on bypass', async () => {
    mockGet.mockResolvedValueOnce('manual')
    const { result } = renderHook(() => useGlobalApprovalMode())
    await flush()
    expect(result.current.mode).toBe('manual')
    // another window switched the persisted mode to bypass, then this window's focus GET fails:
    // the stale 'manual' must NOT be kept on display (the DB may hold bypass).
    mockGet.mockRejectedValueOnce(new Error('serve-api down'))
    mockGet.mockResolvedValueOnce('bypass')
    await act(async () => {
      vi.advanceTimersByTime(2_000) // past the refresh throttle
      window.dispatchEvent(new Event('focus'))
    })
    await flush()
    expect(mockGet).toHaveBeenCalledTimes(2)
    expect(result.current.mode).toBeNull() // unknown NOW — not after a timer, not stale manual
    // the retry loop stays alive even though a mode had been confirmed before.
    await act(async () => {
      vi.advanceTimersByTime(APPROVAL_MODE_RETRY_MS)
    })
    await flush()
    expect(mockGet).toHaveBeenCalledTimes(3)
    expect(result.current.mode).toBe('bypass')
  })
})

describe('codex r2 P1-b — epoch-managed requests (no in-flight boolean gate)', () => {
  test('PUT fails while the initial GET still hangs → an immediate NEW GET is issued', async () => {
    const hangingGet = deferred<string>()
    mockGet.mockReturnValueOnce(hangingGet.promise as Promise<string>) // initial GET: hangs
    mockSet.mockRejectedValueOnce(new Error('PUT failed'))
    mockGet.mockResolvedValueOnce('bypass') // the post-PUT-failure convergence re-GET
    const { result } = renderHook(() => useGlobalApprovalMode())
    await flush()
    expect(result.current.mode).toBeNull()
    expect(mockGet).toHaveBeenCalledTimes(1)
    // user explicitly picks a mode from the unknown state; the PUT fails.
    let ok = true
    await act(async () => {
      ok = await result.current.setMode('bypass' as GlobalApprovalMode)
    })
    await flush()
    expect(ok).toBe(false)
    // the re-GET fired IMMEDIATELY despite the old GET still pending — no APPROVAL_MODE_RETRY_MS
    // timer wait (the old single-boolean fetch gate would have skipped it).
    expect(mockGet).toHaveBeenCalledTimes(2)
    expect(result.current.mode).toBe('bypass')
    // the hanging pre-PUT GET finally settles with a stale value — discarded (stale epoch).
    await act(async () => {
      hangingGet.resolve('manual')
      await Promise.resolve()
    })
    expect(result.current.mode).toBe('bypass')
  })

  test('a never-settling GET times out → unknown read failure, retry loop recovers the store', async () => {
    const hangingGet = deferred<string>()
    mockGet.mockReturnValueOnce(hangingGet.promise as Promise<string>) // never settles
    mockGet.mockResolvedValueOnce('manual')
    const { result } = renderHook(() => useGlobalApprovalMode())
    await flush()
    expect(result.current.mode).toBeNull()
    // the per-GET deadline fires: the read counts as failed and schedules the retry backstop.
    await act(async () => {
      vi.advanceTimersByTime(APPROVAL_MODE_GET_TIMEOUT_MS)
    })
    await flush()
    expect(result.current.mode).toBeNull()
    // the retry issues a FRESH GET (new epoch) that converges — the wedged transport is obsolete.
    await act(async () => {
      vi.advanceTimersByTime(APPROVAL_MODE_RETRY_MS)
    })
    await flush()
    expect(mockGet).toHaveBeenCalledTimes(2)
    expect(result.current.mode).toBe('manual')
  })
})

describe('codex r3 — a never-settling PUT times out (saving must never wedge the store)', () => {
  test('PUT hangs → deadline clears saving, mode drops to unknown, re-GET converges', async () => {
    mockGet.mockResolvedValueOnce('bypass')
    const hangingPut = deferred<string>()
    mockSet.mockReturnValueOnce(hangingPut.promise as Promise<string>) // never settles
    mockGet.mockResolvedValueOnce('bypass') // the post-timeout convergence re-GET
    const { result } = renderHook(() => useGlobalApprovalMode())
    await flush()
    expect(result.current.mode).toBe('bypass')

    let settled: Promise<boolean>
    act(() => {
      settled = result.current.setMode('manual' as GlobalApprovalMode)
    })
    await flush()
    // PUT pending: pessimistic display + saving=true (pickers disabled).
    expect(result.current.mode).toBe('bypass')
    expect(result.current.saving).toBe(true)

    // the per-request deadline fires: the hung PUT counts as indeterminate. `saving` MUST clear
    // — while it is true, refreshApprovalMode early-returns, so a wedged PUT would disable the
    // picker AND kill focus/visibility/retry refreshes forever (module-level state: remount
    // doesn't recover). The store drops to unknown and immediately re-GETs the server truth.
    let ok = true
    await act(async () => {
      vi.advanceTimersByTime(APPROVAL_MODE_GET_TIMEOUT_MS)
      ok = await settled
    })
    await flush()
    expect(ok).toBe(false)
    expect(result.current.saving).toBe(false)
    expect(mockGet).toHaveBeenCalledTimes(2)
    expect(result.current.mode).toBe('bypass') // server truth — never the optimistic 'manual'
    // the wedged PUT finally settles with the requested value — discarded (the race already
    // settled; its rejection/late-resolve arm is swallowed), no state change.
    await act(async () => {
      hangingPut.resolve('manual')
      await Promise.resolve()
    })
    expect(result.current.mode).toBe('bypass')
    expect(result.current.saving).toBe(false)
  })
})

describe('partial api face (component-test mocks / degraded ElectronApi)', () => {
  test('missing methods → unknown mode, setMode false, nothing throws', async () => {
    const chatBackup = { ...stableMailApi.chat }
    // simulate a partial face by removing both methods from the stable singleton.
    delete (stableMailApi.chat as Partial<typeof stableMailApi.chat>).getApprovalMode
    delete (stableMailApi.chat as Partial<typeof stableMailApi.chat>).setApprovalMode
    try {
      const { result } = renderHook(() => useGlobalApprovalMode())
      await flush()
      expect(result.current.mode).toBeNull()
      let ok = true
      await act(async () => {
        ok = await result.current.setMode('bypass' as GlobalApprovalMode)
      })
      expect(ok).toBe(false)
    } finally {
      Object.assign(stableMailApi.chat, chatBackup)
    }
  })
})
