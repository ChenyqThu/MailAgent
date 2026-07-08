// @vitest-environment happy-dom
//
// fe-review P2-9 — ChatPanelBoundary: the chat surfaces' local boundary shows
// the recover fallback (not the root dump), the reset button brings the panel
// back, and switching the session identity (resetKeys) auto-recovers.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'

import i18n from '@shared/i18n'
import { ChatPanelBoundary } from '@shared/components/chat/ChatPanelBoundary'

await i18n.changeLanguage('zh-CN')

let armed = true

function Bomb(): React.ReactElement {
  if (armed) throw new Error('stream exploded')
  return <div data-testid="panel-alive">panel</div>
}

beforeEach(() => {
  armed = true
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ChatPanelBoundary', () => {
  test('crash shows the recover fallback with the error excerpt', () => {
    const { getByText } = render(
      <ChatPanelBoundary>
        <Bomb />
      </ChatPanelBoundary>
    )
    expect(getByText('AI 对话面板出错了')).toBeTruthy()
    expect(getByText('stream exploded')).toBeTruthy()
    expect(getByText('重置面板')).toBeTruthy()
  })

  test('reset button remounts the panel in place', () => {
    const { getByText, getByTestId } = render(
      <ChatPanelBoundary>
        <Bomb />
      </ChatPanelBoundary>
    )
    armed = false
    fireEvent.click(getByText('重置面板'))
    expect(getByTestId('panel-alive')).toBeTruthy()
  })

  test('switching session id while crashed auto-recovers (resetKeys)', () => {
    const ui = (sessionId: string): React.ReactElement => (
      <ChatPanelBoundary resetKeys={[sessionId]}>
        <Bomb />
      </ChatPanelBoundary>
    )
    const { rerender, getByText, getByTestId } = render(ui('s1'))
    expect(getByText('AI 对话面板出错了')).toBeTruthy()
    armed = false
    rerender(ui('s2'))
    expect(getByTestId('panel-alive')).toBeTruthy()
  })
})
