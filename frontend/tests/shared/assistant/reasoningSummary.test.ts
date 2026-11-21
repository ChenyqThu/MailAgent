// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'

import {
  extractReasoningHeading,
  useThrottledReasoningHeading
} from '@shared/assistant/runtime/reasoningSummary'

describe('extractReasoningHeading', () => {
  test('prefers the latest bold or markdown heading from bottom up', () => {
    const text = [
      '**Step 1: Inspecting inbox**',
      'Searching recent threads...',
      '### Comparing attachment versions：',
      'Checking timestamps'
    ].join('\n')
    expect(extractReasoningHeading(text)).toBe('Comparing attachment versions')
  })

  test('ignores filler openings and unclosed markdown bold markers', () => {
    expect(extractReasoningHeading('好的，让我想想怎么回答')).toBeNull()
    expect(extractReasoningHeading('Let me analyze the email first')).toBeNull()
    expect(extractReasoningHeading('**Checking')).toBeNull()
  })

  test('accepts concise informative first line when no heading syntax exists', () => {
    expect(extractReasoningHeading('核对合同金额与付款节点。')).toBe('核对合同金额与付款节点')
  })
})

describe('useThrottledReasoningHeading', () => {
  test('surfaces first heading immediately and paces subsequent updates', () => {
    vi.useFakeTimers()
    try {
      const { result, rerender } = renderHook(
        ({ text, active }: { text: string; active: boolean }) =>
          useThrottledReasoningHeading(text, active, 600),
        { initialProps: { text: '**First step**', active: true } }
      )
      expect(result.current).toBe('First step')

      rerender({ text: '**First step**\n\n**Second step**', active: true })
      expect(result.current).toBe('First step')

      act(() => vi.advanceTimersByTime(600))
      expect(result.current).toBe('Second step')

      rerender({ text: '**First step**\n\n**Second step**', active: false })
      expect(result.current).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
