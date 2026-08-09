// @vitest-environment happy-dom
//
// task 07-07 R4 — 系统能力区「联网」卡（SystemCapabilitiesSection 的 WebCapabilityRow）。覆盖：
//   • 真开关 checked 反映 .env 意图值（未设 → 默认 ON；'false' → OFF）——envBool 镜像。
//   • 开关 ON → 联动渲染 Tavily key（EnvField password）；OFF → 不渲染。
//   • 拨动开关 → applyEnvPatch 写 MAILAGENT_OPENNESS_WEB_TOOLS，但不误拉只重启 mail-sync 的横幅。
//   • Tavily reveal：已配置态 placeholder + reveal 切 password↔text。
//   • Tavily 清除按钮（codex medium fix）：有值时在场 → 点击 applyEnvPatch({TAVILY_API_KEY:null})。
//
// applyEnvPatch 走真实实现（会乐观 setLocal/unsetLocal 真 store）；只 mock api factory 的 env.set。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { EnvSetResult } from '@shared/api/types'

const mockEnvSet = vi.fn<(patch: Record<string, string | null>) => Promise<EnvSetResult>>()
vi.mock('@shared/api/factory', () => ({
  makeMailApi: () => ({ env: { set: mockEnvSet, get: vi.fn() } })
}))

import i18n from '@shared/i18n'
import { WebCapabilityRow } from '../../src/shared/components/settings/CustomAiSection'
import { useEnvStore } from '@shared/state/env'
import { useRestartStore } from '@shared/state/restart'

await i18n.changeLanguage('zh-CN')

function setEnv(values: Record<string, string>, secretKeys: string[] = ['TAVILY_API_KEY']): void {
  useEnvStore.setState({
    state: {
      status: 'ready',
      snapshot: {
        path: '/tmp/.env',
        exists: true,
        values,
        managedKeys: ['MAILAGENT_OPENNESS_WEB_TOOLS', 'TAVILY_API_KEY'],
        secretKeys
      }
    }
  })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useEnvStore.setState({ state: { status: 'idle' } })
  useRestartStore.setState({ required: false, changedKeys: [], lastError: null })
})

describe('WebCapabilityRow — 联网真开关 + Tavily key', () => {
  test('未设 MAILAGENT_OPENNESS_WEB_TOOLS → 开关默认 ON，联动显示 Tavily 字段', () => {
    setEnv({}) // 未设 → envBool 默认 true
    render(<WebCapabilityRow />)
    const sw = screen.getByRole('switch')
    expect(sw.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByLabelText('Tavily API Key')).toBeTruthy()
  })

  test("值 'false' → 开关 OFF，Tavily 字段不渲染", () => {
    setEnv({ MAILAGENT_OPENNESS_WEB_TOOLS: 'false' })
    render(<WebCapabilityRow />)
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByLabelText('Tavily API Key')).toBeNull()
  })

  test('拨动开关 → 写 MAILAGENT_OPENNESS_WEB_TOOLS，不触发 mail-sync 重启横幅', async () => {
    mockEnvSet.mockResolvedValue({
      ok: true,
      path: '/tmp/.env',
      changedKeys: ['MAILAGENT_OPENNESS_WEB_TOOLS'],
      restartRequired: true
    })
    setEnv({ MAILAGENT_OPENNESS_WEB_TOOLS: 'true' })
    render(<WebCapabilityRow />)
    fireEvent.click(screen.getByRole('switch')) // true → 拨到 false
    await waitFor(() =>
      expect(mockEnvSet).toHaveBeenCalledWith({ MAILAGENT_OPENNESS_WEB_TOOLS: 'false' })
    )
    expect(useRestartStore.getState().required).toBe(false)
    expect(useRestartStore.getState().changedKeys).not.toContain('MAILAGENT_OPENNESS_WEB_TOOLS')
  })

  test('Tavily 已配置（***）→ secretSet placeholder + reveal 切换 password↔text', () => {
    setEnv({ MAILAGENT_OPENNESS_WEB_TOOLS: 'true', TAVILY_API_KEY: '***' })
    render(<WebCapabilityRow />)
    const input = screen.getByLabelText('Tavily API Key') as HTMLInputElement
    expect(input.getAttribute('placeholder')).toBe(i18n.t('settings.envField.secretSet'))
    expect(input.getAttribute('type')).toBe('password')
    // 输入内容后 reveal 才可用（reveal 作用于正在输入的明文，非 store）。
    fireEvent.change(input, { target: { value: 'tvly-typing' } })
    fireEvent.click(screen.getByLabelText(i18n.t('settings.envField.reveal')))
    expect(input.getAttribute('type')).toBe('text')
  })

  test('Tavily 清除按钮：有值 → 在场 → 点击 unset（applyEnvPatch null）', async () => {
    mockEnvSet.mockResolvedValue({
      ok: true,
      path: '/tmp/.env',
      changedKeys: ['TAVILY_API_KEY'],
      restartRequired: true
    })
    setEnv({ MAILAGENT_OPENNESS_WEB_TOOLS: 'true', TAVILY_API_KEY: '***' })
    render(<WebCapabilityRow />)
    const clearBtn = screen.getByLabelText(i18n.t('settings.envField.clear'))
    fireEvent.click(clearBtn)
    await waitFor(() => expect(mockEnvSet).toHaveBeenCalledWith({ TAVILY_API_KEY: null }))
  })

  test('Tavily 未配置 → 清除按钮不在场（只在有值时显示）', () => {
    setEnv({ MAILAGENT_OPENNESS_WEB_TOOLS: 'true' }) // TAVILY 未设
    render(<WebCapabilityRow />)
    expect(screen.queryByLabelText(i18n.t('settings.envField.clear'))).toBeNull()
  })
})
