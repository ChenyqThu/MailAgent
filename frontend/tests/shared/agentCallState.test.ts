import { describe, expect, test } from 'vitest'
import { projectAgentCallState } from '../../src/shared/lib/agentCallState'

const cases = [
  ['queued', 'queued'],
  ['running', 'running'],
  ['paused_pending', 'waiting_approval'],
  ['completed', 'completed'],
  ['paused_approved', 'completed'],
  ['paused_rejected', 'completed'],
  ['paused_expired', 'failed'],
  ['skipped', 'failed'],
  ['failed', 'failed']
] as const

describe('projectAgentCallState', () => {
  for (const [state, status] of cases) {
    test(`${state} -> ${status}`, () => {
      expect(projectAgentCallState({ state }).status).toBe(status)
    })
  }
  test('stopped error overrides failed state', () => {
    expect(projectAgentCallState({ state: 'failed', lastError: 'E_RUN_STOPPED' }).status).toBe('stopped')
  })
})
