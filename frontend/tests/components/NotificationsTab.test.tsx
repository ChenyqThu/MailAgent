// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

import i18n from '@shared/i18n'
import type { NotificationPreferences } from '@shared/api/types/notifications'

const hoisted = vi.hoisted(() => {
  const settingsSetMock = vi.fn(async (patch: Record<string, unknown>) => ({
    dbPath: null,
    attachmentDir: null,
    pollIntervalSec: 5,
    notionAgentPageId: null,
    notionAgentName: null,
    customApiEndpoint: null,
    autoDownloadUpdates: false,
    userEmail: 'alice@example.com',
    signature: null,
    trayEnabled: true,
    dockBadgeEnabled: true,
    suppressBannerWhenFocused: true,
    notificationAuthState: 'unknown',
    notificationLastTestedAt: null,
    notificationChannelPrefs: {
      action_required: 'banner',
      reviews: 'center_only',
      results: 'center_only',
      system: 'center_only'
    },
    ...patch
  }))
  const reqPermMock = vi.fn(async () => ({
    ok: true,
    shown: true,
    authState: 'delivered' as const
  }))
  const openSysMock = vi.fn(async () => ({ ok: true }))
  const sysStatusMock = vi.fn(async () => ({
    supported: true,
    platform: 'darwin',
    authState: 'unknown' as const,
    lastTestedAt: null
  }))
  const prefsUpdateMock = vi.fn()
  return {
    settingsSetMock,
    reqPermMock,
    openSysMock,
    sysStatusMock,
    prefsUpdateMock
  }
})

let currentPrefs: NotificationPreferences = {
  mailDelivery: 'both',
  mailScope: 'urgent_and_important',
  mailActionsEnabled: true,
  meetingDelivery: 'both',
  meetingLeadMinutes: 10,
  meetingActionsEnabled: true,
  meetingPrepEnabled: false,
  meetingPrepMode: 'on_demand',
  meetingPrepLeadMinutes: 30,
  agentResultsDelivery: 'center_only',
  systemAlertsDelivery: 'center_only',
  suppressBannerWhenFocused: true,
  skipBannerWhenFeishuSent: true
}

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    settings: {
      get: async () => hoisted.settingsSetMock({}),
      set: hoisted.settingsSetMock,
      systemNotificationStatus: hoisted.sysStatusMock,
      requestNotificationPermission: hoisted.reqPermMock,
      openNotificationSystemSettings: hoisted.openSysMock
    }
  })
}))

vi.mock('@shared/components/matters/hooks', () => ({
  useMatterFlags: () => ({ mattersEnabled: false }),
  useNotifyLevel: () => ({ data: { level: 'high' }, isLoading: false }),
  useSetNotifyLevel: () => ({ mutate: vi.fn(), isPending: false })
}))

vi.mock('@shared/components/settings/parts/EnvField', () => ({
  EnvField: ({ envKey }: { envKey: string }) => <div data-testid={`env-${envKey}`} />
}))

vi.mock('@shared/components/notifications/hooks', () => ({
  useNotificationPreferences: () => ({ data: currentPrefs }),
  useUpdateNotificationPreferences: () => ({
    isPending: false,
    mutate: (patch: Partial<NotificationPreferences>) => {
      currentPrefs = { ...currentPrefs, ...patch }
      hoisted.prefsUpdateMock(patch)
    }
  })
}))

import { NotificationsTab } from '../../src/shared/components/settings/tabs/NotificationsTab'

await i18n.changeLanguage('zh-CN')

function renderTab(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(createElement(QueryClientProvider, { client: qc }, createElement(NotificationsTab)))
}

describe('NotificationsTab (channels, macOS permission & meeting prep preset)', () => {
  beforeEach(() => {
    currentPrefs = {
      mailDelivery: 'both',
      mailScope: 'urgent_and_important',
      mailActionsEnabled: true,
      meetingDelivery: 'both',
      meetingLeadMinutes: 10,
      meetingActionsEnabled: true,
      meetingPrepEnabled: false,
      meetingPrepMode: 'on_demand',
      meetingPrepLeadMinutes: 30,
      agentResultsDelivery: 'center_only',
      systemAlertsDelivery: 'center_only',
      suppressBannerWhenFocused: true,
      skipBannerWhenFeishuSent: true
    }
    hoisted.settingsSetMock.mockClear()
    hoisted.reqPermMock.mockClear()
    hoisted.openSysMock.mockClear()
    hoisted.sysStatusMock.mockClear()
    hoisted.prefsUpdateMock.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  test('triggers macOS permission request & opens System Settings', async () => {
    renderTab()
    const permBtn = await screen.findByRole('button', { name: '申请权限并测试横幅' })
    fireEvent.click(permBtn)
    await waitFor(() => expect(hoisted.reqPermMock).toHaveBeenCalledOnce())

    const sysBtn = screen.getByRole('button', { name: '打开系统设置' })
    fireEvent.click(sysBtn)
    await waitFor(() => expect(hoisted.openSysMock).toHaveBeenCalledOnce())
  })

  test('changes per-scenario delivery to system_only and auto-requests unknown macOS permission', async () => {
    renderTab()
    const mailSelect = await screen.findByLabelText('邮件通知')
    fireEvent.change(mailSelect, { target: { value: 'system_only' } })

    expect(hoisted.prefsUpdateMock).toHaveBeenCalledWith({ mailDelivery: 'system_only' })
    await waitFor(() => expect(hoisted.reqPermMock).toHaveBeenCalledOnce())
  })

  test('enabling meeting prep preset reveals mode selector and updates preferences', async () => {
    currentPrefs = {
      ...currentPrefs,
      meetingPrepEnabled: true,
      meetingPrepMode: 'auto_before',
      meetingPrepLeadMinutes: 30
    }
    renderTab()

    const modeSelect = await screen.findByLabelText('会前准备执行方式')
    expect((modeSelect as HTMLSelectElement).value).toBe('auto_before')

    const leadSelect = screen.getByLabelText('自动准备提前量')
    fireEvent.change(leadSelect, { target: { value: '60' } })
    expect(hoisted.prefsUpdateMock).toHaveBeenCalledWith({ meetingPrepLeadMinutes: 60 })
  })
})
