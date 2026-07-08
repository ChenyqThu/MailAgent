// @vitest-environment happy-dom
//
// fe-review P2-9 — ErrorBoundary contract: prop-less default screen
// (backward compat with the App.tsx root usage), render-prop fallback with a
// working `reset` handle (children come back as a fresh mount), resetKeys
// auto-reset on content-identity change, and console label attribution.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'

import { ErrorBoundary } from '../../src/shared/components/ErrorBoundary'

let armed = true
let mounts = 0

function Bomb(): React.ReactElement {
  mounts += 1
  if (armed) throw new Error('boom')
  return <div data-testid="alive">alive</div>
}

beforeEach(() => {
  armed = true
  mounts = 0
  // React and the boundary both log the caught error — silence the noise and
  // let the label test read the recorded call args.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ErrorBoundary', () => {
  test('prop-less usage renders the default full-screen dump (root compat)', () => {
    const { getByText } = render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>
    )
    expect(getByText('Render error')).toBeTruthy()
    expect(getByText('boom')).toBeTruthy()
  })

  test('fallback render-prop receives the error and a reset that remounts children', () => {
    const { getByText, getByTestId, queryByTestId } = render(
      <ErrorBoundary
        fallback={({ error, reset }) => (
          <button type="button" onClick={reset}>
            retry:{error.message}
          </button>
        )}
      >
        <Bomb />
      </ErrorBoundary>
    )
    expect(queryByTestId('alive')).toBeNull()
    const mountsAtCrash = mounts
    armed = false
    fireEvent.click(getByText('retry:boom'))
    // Children are back, and as a NEW mount — React unmounted the crashed
    // subtree on catch, so clearing the error is the remount the chat panel
    // relies on (no extra key machinery).
    expect(getByTestId('alive')).toBeTruthy()
    expect(mounts).toBeGreaterThan(mountsAtCrash)
  })

  test('resetKeys change while crashed auto-clears the error; same keys keep it held', () => {
    const ui = (key: string): React.ReactElement => (
      <ErrorBoundary resetKeys={[key]} fallback={() => <div data-testid="fallback" />}>
        <Bomb />
      </ErrorBoundary>
    )
    const { rerender, getByTestId, queryByTestId } = render(ui('session-a'))
    expect(getByTestId('fallback')).toBeTruthy()
    armed = false
    rerender(ui('session-a'))
    expect(queryByTestId('alive')).toBeNull()
    rerender(ui('session-b'))
    expect(getByTestId('alive')).toBeTruthy()
  })

  test('label prefixes the console attribution', () => {
    render(
      <ErrorBoundary label="chat-panel" fallback={() => <div />}>
        <Bomb />
      </ErrorBoundary>
    )
    const calls = vi.mocked(console.error).mock.calls
    expect(calls.some((args) => args[0] === '[ErrorBoundary:chat-panel]')).toBe(true)
  })
})
