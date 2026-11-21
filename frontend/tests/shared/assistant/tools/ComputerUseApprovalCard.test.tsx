// @vitest-environment happy-dom
//
// Wave 4 (Computer Use MCP Epic §5.4) — ComputerUseApprovalCard (`computer_use_run`) 单测。
// 显式切 `await i18n.changeLanguage('zh-CN')` 验真中文文案：暂停审批态必须展示真实按钮（不落入无按钮
// ToolTraceCard）、goal / target_hint / allowed_apps / allowed_domains / stop_before_submit、
// 诚实像素隐私告知（privacyMaskMiddleware 仅脱敏文本），以及 awaiting_confirmation / scope_violation 终态。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import i18n from '@shared/i18n'
import { componentRegistry } from '@shared/assistant/tools/ComponentRegistry'
import { buildToolA2UIPayload, componentForTool } from '@shared/assistant/tools/a2ui'
import { ComputerUseApprovalCard } from '@shared/assistant/tools/generic/ComputerUseApprovalCard'
import { ToolTraceCard } from '@shared/assistant/tools/generic/ToolTraceCard'

await i18n.changeLanguage('zh-CN')

function mockProps(over: Partial<ToolCallMessagePartProps>): ToolCallMessagePartProps {
  return {
    type: 'tool-call',
    toolName: 'computer_use_run',
    toolCallId: 'cu-1',
    args: {},
    argsText: '{}',
    result: undefined,
    isError: undefined,
    status: { type: 'requires-action', reason: 'interrupt' },
    approval: { id: 'apr-cu-1' },
    addResult: vi.fn(),
    resume: vi.fn(),
    respondToApproval: vi.fn(),
    ...over
  } as unknown as ToolCallMessagePartProps
}

afterEach(() => {
  cleanup()
})

describe('ComputerUseApprovalCard — A2UI 与 ComponentRegistry 接线', () => {
  test('computer_use_run 已注册专属卡片（绝不退回无按钮 ToolTraceCard）', () => {
    expect(componentForTool('computer_use_run')).toBe('ComputerUseApprovalCard')
    const card = componentRegistry.resolve('computer_use_run')
    expect(card).toBe(ComputerUseApprovalCard)
    expect(card).not.toBe(ToolTraceCard)

    const payload = buildToolA2UIPayload('computer_use_run', {
      args: {
        goal: '在 OA 填写报销单',
        target_hint: 'browser',
        allowed_domains: ['oa.company.com'],
        stop_before_submit: true,
        max_steps: 12
      }
    })
    expect(payload).not.toBeNull()
    expect(payload!.component).toBe('ComputerUseApprovalCard')
    expect(payload!.audit?.requiresApproval).toBe(true)
    expect(payload!.audit?.risk).toBe('edit')
  })
})

describe('ComputerUseApprovalCard — pending 审批态', () => {
  test('渲染 goal / target / allowed_apps / allowed_domains / stop_before_submit / 像素告知并支持批准', () => {
    const respondToApproval = vi.fn()
    render(
      <ComputerUseApprovalCard
        {...mockProps({
          respondToApproval,
          args: {
            goal: '在报销系统填入 10 月差旅明细',
            target_hint: 'browser',
            allowed_apps: ['Google Chrome'],
            allowed_domains: ['oa.internal.test'],
            stop_before_submit: true,
            max_steps: 15
          }
        })}
      />
    )

    expect(screen.getByText('操作桌面与浏览器')).toBeTruthy()
    expect(screen.getByText('在报销系统填入 10 月差旅明细')).toBeTruthy()
    expect(screen.getByText('浏览器')).toBeTruthy()
    expect(screen.getByText('Google Chrome')).toBeTruthy()
    expect(screen.getByText('oa.internal.test')).toBeTruthy()
    expect(screen.getByText(/已开启 · 遇到提交/)).toBeTruthy()
    expect(screen.getByText('15 步')).toBeTruthy()
    expect(screen.getByText('画面像素不经文本脱敏')).toBeTruthy()
    expect(screen.getByText(/privacyMaskMiddleware 仅脱敏文本类入参和出参/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '允许并执行' }))
    expect(respondToApproval).toHaveBeenCalledWith({ approved: true })
  })

  test('两段拒绝支持文字指导，流式 argsText 解析与无白名单警告正常', () => {
    const respondToApproval = vi.fn()
    render(
      <ComputerUseApprovalCard
        {...mockProps({
          respondToApproval,
          args: undefined,
          argsText: JSON.stringify({
            goal: '打开 Teams 发送提醒',
            target_hint: 'desktop',
            stop_before_submit: false
          })
        })}
      />
    )

    expect(screen.getByText('打开 Teams 发送提醒')).toBeTruthy()
    expect(screen.getByText('桌面应用')).toBeTruthy()
    expect(screen.getByText('未限定应用/域名白名单')).toBeTruthy()
    expect(screen.getByText(/已关闭 · 允许执行终态提交动作/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: '请限定在 Microsoft Teams' } })
    fireEvent.click(screen.getByRole('button', { name: '确认拒绝' }))
    expect(respondToApproval).toHaveBeenCalledWith({
      approved: false,
      reason: '请限定在 Microsoft Teams'
    })
  })
})

describe('ComputerUseApprovalCard — 终态与错误态', () => {
  test('done 态正确展示 awaiting_confirmation 停靠详情与 filled_fields', () => {
    render(
      <ComputerUseApprovalCard
        {...mockProps({
          status: { type: 'complete' },
          approval: { id: 'apr-cu-1', approved: true },
          args: {
            goal: '填写报销单',
            target_hint: 'browser',
            allowed_domains: ['oa.internal.test'],
            stop_before_submit: true
          },
          result: {
            status: 'awaiting_confirmation',
            current_url_or_app: 'https://oa.internal.test/expense/42',
            pending_action: '点击【提交审批】按钮',
            filled_fields: ['出差城市: 上海', '金额: 1280']
          }
        })}
      />
    )

    expect(screen.getByText('已停靠 · 等待你的最终确认')).toBeTruthy()
    expect(screen.getByText('https://oa.internal.test/expense/42')).toBeTruthy()
    expect(screen.getByText('点击【提交审批】按钮')).toBeTruthy()
    expect(screen.getByText('出差城市: 上海, 金额: 1280')).toBeTruthy()
    // 终态不出现像素警示或操作按钮
    expect(screen.queryByRole('button', { name: '允许并执行' })).toBeNull()
  })

  test('done 态 scope_violation 与 error / rejected 态准确渲染', () => {
    const { rerender } = render(
      <ComputerUseApprovalCard
        {...mockProps({
          status: { type: 'complete' },
          approval: { id: 'apr-cu-1', approved: true },
          args: { goal: '访问内网', allowed_domains: ['oa.internal.test'] },
          result: { status: 'scope_violation', current_url_or_app: 'https://evil.test' }
        })}
      />
    )
    expect(screen.getByText('已熔断 · 检测到越界应用或域名')).toBeTruthy()

    rerender(
      <ComputerUseApprovalCard
        {...mockProps({
          status: { type: 'incomplete', reason: 'error' },
          isError: true,
          approval: { id: 'apr-cu-1', approved: true },
          args: { goal: '访问内网' }
        })}
      />
    )
    expect(screen.getByText('操作执行失败')).toBeTruthy()

    rerender(
      <ComputerUseApprovalCard
        {...mockProps({
          status: { type: 'complete' },
          approval: { id: 'apr-cu-1', approved: false },
          args: { goal: '访问内网' }
        })}
      />
    )
    expect(screen.getByText('已拒绝，未执行该操作。')).toBeTruthy()
  })

  test('clean completed and authorized states render as a collapsed-by-default compact row with expandable details', () => {
    render(
      <ComputerUseApprovalCard
        {...mockProps({
          status: { type: 'complete' },
          approval: { id: 'apr-cu-clean', approved: true },
          args: {
            goal: '在内部系统查询本周订单',
            target_hint: 'browser',
            allowed_domains: ['erp.internal.test']
          },
          result: {
            status: 'completed',
            current_url_or_app: 'https://erp.internal.test/orders',
            filled_fields: ['周期: 本周']
          }
        })}
      />
    )

    const toggle = screen.getByRole('button', { name: /操作桌面与浏览器/ })
    const region = document.getElementById(toggle.getAttribute('aria-controls') ?? '')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(region?.hasAttribute('inert')).toBe(true)
    expect(screen.getAllByText('在内部系统查询本周订单').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByRole('button', { name: '允许并执行' })).toBeNull()

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(region?.hasAttribute('inert')).toBe(false)
    expect(screen.getByText('已完成')).toBeTruthy()
    expect(screen.getByText('周期: 本周')).toBeTruthy()
    expect(screen.getByText('erp.internal.test')).toBeTruthy()

    cleanup()
    render(
      <ComputerUseApprovalCard
        {...mockProps({
          status: { type: 'running' },
          approval: { id: 'apr-cu-run', approved: true },
          args: {
            goal: '正在打开页面',
            target_hint: 'browser',
            allowed_domains: ['erp.internal.test']
          },
          result: undefined
        })}
      />
    )
    const runningToggle = screen.getByRole('button', { name: /操作桌面与浏览器/ })
    expect(runningToggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getAllByText('正在打开页面').length).toBeGreaterThanOrEqual(1)
  })
})
