import { describe, expect, test, vi } from 'vitest'

import { refreshAfterCompact } from '../../../src/shared/assistant/compactRefresh'

describe('refreshAfterCompact', () => {
  test('reloads rows, invalidates message cache, then remounts runtime', async () => {
    const order: string[] = []
    await refreshAfterCompact(
      vi.fn(async () => order.push('reload')),
      vi.fn(async () => order.push('invalidate')),
      vi.fn(() => order.push('remount'))
    )
    expect(order).toEqual(['reload', 'invalidate', 'remount'])
  })
})
