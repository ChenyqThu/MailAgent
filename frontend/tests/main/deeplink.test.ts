// Sprint 19 island F6 — mailagent:// deeplink 解析 + cold-start buffer.
//
// parseDeeplink 纯函数 (email/calendar/kanban/llm/settings + 非法 url) +
// extractDeeplinkFromArgv (Win/Linux argv) + dispatch/sink buffer 时序.

import { afterEach, describe, expect, test } from 'vitest'

import {
  _resetDeeplinkStateForTest,
  dispatchDeeplink,
  extractDeeplinkFromArgv,
  parseDeeplink,
  setDeeplinkSink,
  type DeeplinkTarget
} from '../../src/electron/main/deeplink'

afterEach(() => {
  _resetDeeplinkStateForTest()
})

describe('parseDeeplink', () => {
  test('email with internal_id', () => {
    expect(parseDeeplink('mailagent://email/53675')).toEqual({ kind: 'email', id: 53675 })
  })

  test('email trailing slash / extra segment tolerated', () => {
    expect(parseDeeplink('mailagent://email/42/')).toEqual({ kind: 'email', id: 42 })
  })

  test('email non-numeric id → null', () => {
    expect(parseDeeplink('mailagent://email/abc')).toBeNull()
    expect(parseDeeplink('mailagent://email/')).toBeNull()
  })

  test('calendar with view', () => {
    expect(parseDeeplink('mailagent://calendar?view=week')).toEqual({
      kind: 'calendar',
      view: 'week'
    })
  })

  test('calendar without view', () => {
    expect(parseDeeplink('mailagent://calendar')).toEqual({ kind: 'calendar', view: undefined })
  })

  test('kanban / llm', () => {
    expect(parseDeeplink('mailagent://kanban')).toEqual({ kind: 'kanban' })
    expect(parseDeeplink('mailagent://llm')).toEqual({ kind: 'llm' })
  })

  test('settings with tab', () => {
    expect(parseDeeplink('mailagent://settings?tab=island')).toEqual({
      kind: 'settings',
      view: 'island'
    })
  })

  test('wrong scheme → null', () => {
    expect(parseDeeplink('https://email/1')).toBeNull()
    expect(parseDeeplink('notion://email/1')).toBeNull()
  })

  test('unknown host → null', () => {
    expect(parseDeeplink('mailagent://bogus/1')).toBeNull()
  })

  test('malformed / empty → null', () => {
    expect(parseDeeplink('')).toBeNull()
    expect(parseDeeplink('not a url')).toBeNull()
    // @ts-expect-error — runtime guard for non-string
    expect(parseDeeplink(null)).toBeNull()
  })
})

describe('extractDeeplinkFromArgv', () => {
  test('finds mailagent:// in argv', () => {
    const argv = ['/path/electron', '--flag', 'mailagent://email/7', 'other']
    expect(extractDeeplinkFromArgv(argv)).toBe('mailagent://email/7')
  })

  test('no deeplink → null', () => {
    expect(extractDeeplinkFromArgv(['/path/electron', '--flag'])).toBeNull()
    expect(extractDeeplinkFromArgv([])).toBeNull()
  })
})

describe('dispatch + sink buffer', () => {
  test('sink registered first → immediate dispatch', () => {
    const got: DeeplinkTarget[] = []
    setDeeplinkSink((t) => got.push(t))
    dispatchDeeplink('mailagent://email/100')
    expect(got).toEqual([{ kind: 'email', id: 100 }])
  })

  test('cold-start: dispatch before sink → buffered, flushed on sink register', () => {
    const got: DeeplinkTarget[] = []
    // dispatch arrives before sink (macOS open-url before app ready)
    dispatchDeeplink('mailagent://calendar?view=month')
    expect(got).toEqual([])
    // sink registers later (whenReady + createWindow)
    setDeeplinkSink((t) => got.push(t))
    expect(got).toEqual([{ kind: 'calendar', view: 'month' }])
  })

  test('invalid url not buffered', () => {
    const got: DeeplinkTarget[] = []
    dispatchDeeplink('mailagent://bogus/1')
    setDeeplinkSink((t) => got.push(t))
    expect(got).toEqual([])
  })

  test('only last pending target flushed (buffer holds one)', () => {
    const got: DeeplinkTarget[] = []
    dispatchDeeplink('mailagent://email/1')
    dispatchDeeplink('mailagent://email/2')
    setDeeplinkSink((t) => got.push(t))
    expect(got).toEqual([{ kind: 'email', id: 2 }])
  })
})
