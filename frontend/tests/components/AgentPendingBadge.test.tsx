// @vitest-environment happy-dom
//
// S6 W2（P5 红点链）— per-agent 待审批计数徽标。
//   - AgentPendingCountBadge：count<=0 不渲染；count>0 渲染「待审批 N」（i18n key 存在）。
//
// 原来的 TitleBar 全局徽标用例随 `TitleBarAgentPendingBadge` 一起退场（M3 批 C5 收编进
// 统一通知中心）——「待审批 → 铃铛」那条链现在由 NotificationBellBadge 的待办点覆盖，
// 见 tests/shared/NotificationBellBadge.test.tsx。

import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import i18n from '@shared/i18n'
import { AgentPendingCountBadge } from '@shared/components/agents/AgentPendingBadge'

await i18n.changeLanguage('zh-CN')

afterEach(cleanup)

describe('AgentPendingCountBadge', () => {
  test('count<=0 → renders nothing', () => {
    const { container } = render(<AgentPendingCountBadge count={0} />)
    expect(container.firstChild).toBeNull()
  })

  test('count>0 → renders the localized 「待审批 N」 label (i18n key exists)', () => {
    render(<AgentPendingCountBadge count={3} />)
    expect(screen.getByText('待审批 3')).toBeTruthy()
  })
})
