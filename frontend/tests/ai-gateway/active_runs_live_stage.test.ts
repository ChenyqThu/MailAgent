import { describe, expect, test } from 'vitest'

import { ActiveRunRegistry } from '../../src/ai-gateway/activeRuns'

describe('ActiveRunRegistry.updateStage', () => {
  test('tracks liveStage for the active run and returns it in getActive', () => {
    let clock = 1_000
    const registry = new ActiveRunRegistry({ now: () => clock })
    const reg = registry.register(42, new AbortController())
    expect(reg).not.toBeNull()

    clock = 1_500
    registry.updateStage(42, reg!.runId, { stage: 'calling-tool', toolName: 'email_search_fulltext' })
    const snap = registry.getActive(42)
    expect(snap?.liveStage).toEqual({
      stage: 'calling-tool',
      toolName: 'email_search_fulltext',
      updatedAt: 1_500
    })

    // Redundant identical update keeps original updatedAt timestamp.
    clock = 2_000
    registry.updateStage(42, reg!.runId, { stage: 'calling-tool', toolName: 'email_search_fulltext' })
    expect(registry.getActive(42)?.liveStage?.updatedAt).toBe(1_500)
  })

  test('ignores stale runId updates after a run is replaced', () => {
    const registry = new ActiveRunRegistry()
    const c1 = new AbortController()
    const r1 = registry.register(9, c1)!
    c1.abort()
    const r2 = registry.register(9, new AbortController())!

    registry.updateStage(9, r2.runId, { stage: 'writing' })
    registry.updateStage(9, r1.runId, { stage: 'thinking' })

    expect(registry.getActive(9)?.liveStage?.stage).toBe('writing')
  })
})
