// @vitest-environment happy-dom
//
// MCP connector PR4 T3 —— CapabilityCards 第七「外部服务」卡（connector 级 grant，
// 档位 关/只读/可写）。钉住的语义：
//   • 存量 'write' 显示为「可写」档 active（display 向上取整，绝不低报权限）
//   • 点击当前显示档 = no-op（防存量 'write' 被 canonical 写入无声升成 'update'）
//   • 点「可写」→ canonical 写入 'update'（天花板）
//   • 已断开 / registry 已消失但有存量 grant 的 connector 行仍可见可改（标「未连接」）
//   • flags.connectorToolsEnabled=false → 档位禁用 + 提示
//   • 无行 → 空态文案
//   • zh / en connectors 子树 key 对齐（含 tier 三档字面量）
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'

import i18n from '@shared/i18n'
import { CapabilityCards } from '../../src/shared/components/agents/custom-agent/CapabilityCards'
import zhCommon from '../../src/shared/i18n/locales/zh-CN/common.json'
import enCommon from '../../src/shared/i18n/locales/en-US/common.json'

await i18n.changeLanguage('zh-CN')

afterEach(cleanup)

type Props = ComponentProps<typeof CapabilityCards>

function renderCards(over: Partial<Props> = {}): Props {
  const props: Props = {
    selectedTools: [],
    onSelectedToolsChange: vi.fn(),
    grantWeb: 'off',
    onGrantWebChange: vi.fn(),
    grantExec: false,
    onGrantExecChange: vi.fn(),
    grantSessions: 'own',
    onGrantSessionsChange: vi.fn(),
    agentTitle: '测试 Agent',
    triggerKind: null,
    flags: {},
    toolOptions: { tools: [], defaults: [] },
    connectorOptions: [{ id: 'notion', label: 'Notion', status: 'connected' }],
    grantConnectors: {},
    onGrantConnectorsChange: vi.fn(),
    ...over
  }
  render(<CapabilityCards {...props} />)
  return props
}

describe('CapabilityCards — 第七「外部服务」卡（connector grant 三档）', () => {
  test("存量 'write' 显示「可写」active；点当前档 no-op（不升成 update），换档仍可用", () => {
    const onChange = vi.fn()
    renderCards({
      grantConnectors: { notion: 'write' },
      onGrantConnectorsChange: onChange
    })
    const writable = screen.getByRole('button', { name: 'Notion: 可写' })
    expect(writable.getAttribute('aria-pressed')).toBe('true')
    // 🔴 no-op 闸：点当前显示档不发 onChange —— 否则 'write' 会被 canonical 写入升成 'update'
    fireEvent.click(writable)
    expect(onChange).not.toHaveBeenCalled()
    // 可写档在场 → danger warn 文案（引用 connectorCeiling 语汇的权限上限说明）
    expect(screen.getByText(/权限上限/)).toBeTruthy()
    // 换档仍可用：点「只读」→ 'read'
    fireEvent.click(screen.getByRole('button', { name: 'Notion: 只读' }))
    expect(onChange).toHaveBeenCalledWith({ notion: 'read' })
  })

  test("点「可写」→ canonical 写入 'update'（天花板档）", () => {
    const onChange = vi.fn()
    renderCards({ onGrantConnectorsChange: onChange })
    fireEvent.click(screen.getByRole('button', { name: 'Notion: 可写' }))
    expect(onChange).toHaveBeenCalledWith({ notion: 'update' })
  })

  test('已断开 / registry 已消失但有存量 grant 的行仍可见可改（标「未连接」）', () => {
    const onChange = vi.fn()
    renderCards({
      connectorOptions: [{ id: 'notion', label: 'Notion', status: 'disconnected' }],
      grantConnectors: { notion: 'read', ghost_svc: 'update' },
      onGrantConnectorsChange: onChange
    })
    // notion（registry 在、已断开）与 ghost_svc（registry 都没有 → label 退化为 id）都在场
    expect(screen.getByRole('button', { name: 'Notion: 只读' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
    expect(
      screen.getByRole('button', { name: 'ghost_svc: 可写' }).getAttribute('aria-pressed')
    ).toBe('true')
    expect(screen.getAllByText('未连接')).toHaveLength(2)
    // 仍可改：关掉 ghost_svc → map 只剩 notion（绝不静默丢 grant，删除是显式操作）
    fireEvent.click(screen.getByRole('button', { name: 'ghost_svc: 关' }))
    expect(onChange).toHaveBeenCalledWith({ notion: 'read' })
  })

  test('flags.connectorToolsEnabled=false → 档位禁用 + 提示', () => {
    const onChange = vi.fn()
    renderCards({
      flags: { connectorToolsEnabled: false },
      grantConnectors: { notion: 'read' },
      onGrantConnectorsChange: onChange
    })
    const btn = screen.getByRole('button', { name: 'Notion: 关' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText(/外部服务连接未开启/)).toBeTruthy()
  })

  test('无已连接服务且无 grant → 空态文案（未连接的 registry 项不成行）', () => {
    renderCards({
      connectorOptions: [{ id: 'notion', label: 'Notion', status: 'disconnected' }]
    })
    expect(screen.getByText(/尚未连接任何外部服务/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Notion:/ })).toBeNull()
  })

  test('zh / en connectors 子树 key 对齐（tier 钉死 off/read/write 三档）', () => {
    const zh = zhCommon.agents.custom.capabilityCards.connectors
    const en = enCommon.agents.custom.capabilityCards.connectors
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    expect(Object.keys(zh.tier).sort()).toEqual(Object.keys(en.tier).sort())
    expect(Object.keys(zh.tier).sort()).toEqual(['off', 'read', 'write'])
  })
})
