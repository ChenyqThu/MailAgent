// Sprint 19 PR-1d.1 — Confirmation gate contract tests.

import { afterEach, describe, expect, test } from 'vitest'
import {
  __resetConfirmations,
  awaitConfirmation,
  cancelConfirmationsForSession,
  pendingConfirmationCount,
  resolveConfirmation
} from '../../../../src/shared/chat/tools/confirmation'

afterEach(() => {
  __resetConfirmations()
})

describe('awaitConfirmation + resolveConfirmation — happy path', () => {
  test('resolves with the renderer-supplied outcome', async () => {
    const ac = new AbortController()
    const promise = awaitConfirmation('toolu_1', 7, ac.signal)
    expect(pendingConfirmationCount()).toBe(1)
    const wasPending = resolveConfirmation('toolu_1', { approved: true })
    expect(wasPending).toBe(true)
    const outcome = await promise
    expect(outcome).toEqual({ approved: true })
    expect(pendingConfirmationCount()).toBe(0)
  })

  test('passes editedInput through verbatim (tier=edit dialogs)', async () => {
    const ac = new AbortController()
    const promise = awaitConfirmation('toolu_2', 7, ac.signal)
    resolveConfirmation('toolu_2', {
      approved: true,
      editedInput: { body_markdown: 'rewritten by user' }
    })
    const outcome = await promise
    expect(outcome.approved).toBe(true)
    expect(outcome.editedInput).toEqual({ body_markdown: 'rewritten by user' })
  })

  test('approved=false (Cancel click) resolves with denial', async () => {
    const ac = new AbortController()
    const promise = awaitConfirmation('toolu_3', 1, ac.signal)
    resolveConfirmation('toolu_3', { approved: false })
    const outcome = await promise
    expect(outcome).toEqual({ approved: false })
  })

  test('resolveConfirmation on a non-pending id returns false (late click)', () => {
    expect(resolveConfirmation('never_registered', { approved: true })).toBe(false)
  })
})

describe('awaitConfirmation — abort handling', () => {
  test('rejecting when the session abort signal fires mid-wait', async () => {
    const ac = new AbortController()
    const promise = awaitConfirmation('toolu_a', 9, ac.signal)
    setTimeout(() => ac.abort('user_left'), 5)
    await expect(promise).rejects.toThrow('E_ABORTED')
    expect(pendingConfirmationCount()).toBe(0)
  })

  test('synchronous reject when the signal is already aborted at call time', async () => {
    const ac = new AbortController()
    ac.abort('pre-aborted')
    await expect(awaitConfirmation('toolu_z', 1, ac.signal)).rejects.toThrow('E_ABORTED')
    expect(pendingConfirmationCount()).toBe(0)
  })

  test('cancelConfirmationsForSession resolves every pending entry for that session', async () => {
    const ac = new AbortController()
    const p1 = awaitConfirmation('toolu_s1_a', 100, ac.signal)
    const p2 = awaitConfirmation('toolu_s1_b', 100, ac.signal)
    const pOther = awaitConfirmation('toolu_s2_a', 200, ac.signal)
    expect(pendingConfirmationCount()).toBe(3)

    const n = cancelConfirmationsForSession(100)
    expect(n).toBe(2)
    expect(await p1).toEqual({ approved: false })
    expect(await p2).toEqual({ approved: false })

    // Other session untouched.
    expect(pendingConfirmationCount()).toBe(1)
    resolveConfirmation('toolu_s2_a', { approved: true })
    expect(await pOther).toEqual({ approved: true })
  })
})

describe('awaitConfirmation — duplicate guard', () => {
  test('registering the same toolUseId twice throws (protocol bug)', () => {
    const ac = new AbortController()
    void awaitConfirmation('toolu_dup', 1, ac.signal)
    expect(() => awaitConfirmation('toolu_dup', 1, ac.signal)).toThrow(/duplicate/i)
  })
})
