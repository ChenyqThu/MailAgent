// Sprint 9 D3 — handlers/island.ts payload guards + register lifecycle.
//
// We mock electron's `ipcMain` so we can inspect what channels got
// registered + drive the `on`/`handle` callbacks directly. The probe loop
// is skipped via `devDisabled: true` so tests don't open real sockets.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

type Listener = (event: unknown, ...args: unknown[]) => unknown

const handleMap = new Map<string, Listener>()
const onMap = new Map<string, Listener>()
const handlerSend = vi.fn()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: Listener) => {
      handleMap.set(channel, listener)
    },
    on: (channel: string, listener: Listener) => {
      onMap.set(channel, listener)
    }
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { send: handlerSend }
      }
    ]
  }
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: { dev: false }
}))

// Stub the inner socket sender so probeOnce()/island:appearance handlers
// don't try to open a real connection.
const sendEnvelopeSpy = vi.fn()
vi.mock('../../src/electron/main/island/sender', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/electron/main/island/sender')
  >('../../src/electron/main/island/sender')
  return {
    ...actual,
    sendEnvelope: (...args: unknown[]) => {
      sendEnvelopeSpy(...args)
      return Promise.resolve({ ok: true, response: null })
    }
  }
})

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    existsSync: () => true // probe loop assumes the socket is present
  }
})

const { registerIslandHandlers, __resetForTesting, __testing } = await import(
  '../../src/electron/main/handlers/island'
)
const probeModule = await import('../../src/electron/main/island/probe')

beforeEach(() => {
  handleMap.clear()
  onMap.clear()
  handlerSend.mockClear()
  sendEnvelopeSpy.mockClear()
  __resetForTesting()
  probeModule.__resetForTesting('/tmp/island.sock')
})

afterEach(() => {
  __resetForTesting()
})

describe('registerIslandHandlers: channel registration', () => {
  test('registers 3 invoke + 4 send channels', () => {
    registerIslandHandlers({ devDisabled: true })
    expect(handleMap.has('island:status')).toBe(true)
    expect(handleMap.has('island:testConnection')).toBe(true)
    expect(handleMap.has('island:setEnabled')).toBe(true)
    expect(onMap.has('island:appearance')).toBe(true)
    expect(onMap.has('island:aiDraftStart')).toBe(true)
    expect(onMap.has('island:aiDraftStream')).toBe(true)
    expect(onMap.has('island:aiDraftReady')).toBe(true)
  })

  test('idempotent — second call is a no-op', () => {
    registerIslandHandlers({ devDisabled: true })
    const handleCount = handleMap.size
    registerIslandHandlers({ devDisabled: true })
    expect(handleMap.size).toBe(handleCount)
  })

  test('devDisabled state surfaces via island:status', async () => {
    registerIslandHandlers({ devDisabled: true })
    const handler = handleMap.get('island:status') as Listener
    const status = (await handler(null)) as { state: string }
    expect(status.state).toBe('dev-disabled')
  })
})

describe('payload guards: silent no-op on malformed input', () => {
  beforeEach(() => {
    registerIslandHandlers({ devDisabled: true })
    // Out of dev-disabled so operable check passes.
    void probeModule.setIslandEnabled(true)
  })

  test('island:appearance accepts {accent, theme} and rejects shapeless input', () => {
    const appearance = onMap.get('island:appearance') as Listener
    appearance(null, { accent: 'coral', theme: 'dark' })
    expect(sendEnvelopeSpy).toHaveBeenCalledTimes(1)
    sendEnvelopeSpy.mockClear()
    appearance(null, { accent: 'coral' }) // missing theme
    appearance(null, { theme: 'dark' }) // missing accent
    appearance(null, { accent: 'coral', theme: 'midnight' }) // bad theme value
    appearance(null, 'string-not-object')
    appearance(null, null)
    expect(sendEnvelopeSpy).not.toHaveBeenCalled()
  })

  test('island:aiDraftStart requires emailId + prompt', () => {
    const start = onMap.get('island:aiDraftStart') as Listener
    start(null, { emailId: 53675, senderName: null, subject: null, prompt: 'hi' })
    expect(sendEnvelopeSpy).toHaveBeenCalledTimes(1)
    sendEnvelopeSpy.mockClear()
    start(null, { emailId: 'not-number', prompt: 'hi' })
    start(null, { emailId: 53675 })
    start(null, { emailId: 53675, prompt: 7 })
    expect(sendEnvelopeSpy).not.toHaveBeenCalled()
  })

  test('island:aiDraftStream requires numeric emailId + streamedChars', () => {
    const stream = onMap.get('island:aiDraftStream') as Listener
    stream(null, { emailId: 1, streamedChars: 100 })
    expect(sendEnvelopeSpy).toHaveBeenCalledTimes(1)
    sendEnvelopeSpy.mockClear()
    stream(null, { emailId: 1, streamedChars: NaN })
    stream(null, { emailId: 1 })
    expect(sendEnvelopeSpy).not.toHaveBeenCalled()
  })

  test('island:aiDraftReady requires emailId + preview', () => {
    const ready = onMap.get('island:aiDraftReady') as Listener
    ready(null, { emailId: 1, senderName: 'X', subject: 'Y', preview: 'Hi' })
    expect(sendEnvelopeSpy).toHaveBeenCalledTimes(1)
    sendEnvelopeSpy.mockClear()
    ready(null, { emailId: 1, preview: 42 })
    ready(null, { emailId: 'one', preview: 'Hi' })
    expect(sendEnvelopeSpy).not.toHaveBeenCalled()
  })
})

describe('disabled state: handlers no-op even with valid payload', () => {
  test('aiDraftStart skipped when state=disabled', () => {
    registerIslandHandlers({ devDisabled: true })
    void probeModule.setIslandEnabled(false) // park in disabled
    const start = onMap.get('island:aiDraftStart') as Listener
    start(null, { emailId: 1, senderName: null, subject: null, prompt: 'hi' })
    expect(sendEnvelopeSpy).not.toHaveBeenCalled()
  })

  test('appearance skipped when state=dev-disabled', () => {
    registerIslandHandlers({ devDisabled: true })
    // Status starts as dev-disabled, never re-enabled.
    const appearance = onMap.get('island:appearance') as Listener
    appearance(null, { accent: 'coral', theme: 'dark' })
    expect(sendEnvelopeSpy).not.toHaveBeenCalled()
  })
})

describe('island:setEnabled control surface', () => {
  test('toggling disabled→enabled→disabled rounds back to disabled state', async () => {
    registerIslandHandlers({ devDisabled: true })
    const setEnabled = handleMap.get('island:setEnabled') as Listener
    const offRes = (await setEnabled(null, false)) as { state: string }
    expect(offRes.state).toBe('disabled')
    // Re-enabling parks at idle then runs a probe; since we mocked
    // existsSync=true + sendEnvelope=ok, the probe should land on 'connected'
    // synchronously (the probe is microtask-bound, not timer-bound).
    const onRes = (await setEnabled(null, true)) as { state: string }
    expect(['idle', 'connected']).toContain(onRes.state)
  })

  test('non-boolean payload returns current status unchanged', async () => {
    registerIslandHandlers({ devDisabled: true })
    const setEnabled = handleMap.get('island:setEnabled') as Listener
    const before = (await setEnabled(null, 'maybe')) as { state: string }
    expect(before.state).toBe('dev-disabled')
  })
})

describe('payload-guard helpers (exported via __testing)', () => {
  test('isAppearancePayload accepts dark + light theme strings', () => {
    expect(__testing.isAppearancePayload({ accent: 'coral', theme: 'dark' })).toBe(true)
    expect(__testing.isAppearancePayload({ accent: 'cobalt', theme: 'light' })).toBe(true)
    expect(__testing.isAppearancePayload({ accent: 'coral', theme: 'auto' })).toBe(false)
  })

  test('isStartPayload validates senderName as string | null', () => {
    expect(
      __testing.isStartPayload({ emailId: 1, senderName: null, subject: null, prompt: 'hi' })
    ).toBe(true)
    expect(
      __testing.isStartPayload({ emailId: 1, senderName: 7, subject: null, prompt: 'hi' })
    ).toBe(false)
  })

  test('isStreamPayload rejects non-finite numbers', () => {
    expect(__testing.isStreamPayload({ emailId: 1, streamedChars: 100 })).toBe(true)
    expect(__testing.isStreamPayload({ emailId: 1, streamedChars: Infinity })).toBe(false)
    expect(__testing.isStreamPayload({ emailId: NaN, streamedChars: 100 })).toBe(false)
  })

  test('isReadyPayload requires preview as string', () => {
    expect(
      __testing.isReadyPayload({
        emailId: 1,
        senderName: null,
        subject: null,
        preview: ''
      })
    ).toBe(true)
    expect(__testing.isReadyPayload({ emailId: 1, preview: 0 })).toBe(false)
  })
})
