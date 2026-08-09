// SystemCapabilitiesSection 六个非核心邮件能力族的 toolCount 漂移守护。
// 展示层保留轻量手抄常量，测试从 gateway canonical 工具名清单实算，任一边漏改即变红。

import { describe, expect, test } from 'vitest'

import {
  CALENDAR_TOOL_COUNT,
  CONFIG_TOOL_COUNT,
  KOS_TOOL_COUNT,
  SELF_MOUNT_TOOL_COUNT,
  SESSION_TOOL_COUNT,
  WEB_TOOL_COUNT
} from '../../src/shared/components/settings/custom-ai/SystemCapabilitiesSection'
import {
  GATEWAY_DEFAULT_TOOL_NAMES,
  GATEWAY_READ_TOOL_NAMES
} from '../../src/ai-gateway/tools'
import {
  GATEWAY_CALENDAR_READ_TOOL_NAMES,
  GATEWAY_CALENDAR_WRITE_TOOL_NAMES
} from '../../src/ai-gateway/tools/calendar'
import { GATEWAY_PROFILE_TOOL_NAMES } from '../../src/ai-gateway/tools/profile'
import { GATEWAY_SELF_MOUNT_TOOL_NAMES } from '../../src/ai-gateway/tools/self_mount'
import { GATEWAY_SESSION_TOOL_NAMES } from '../../src/ai-gateway/tools/sessions'
import { GATEWAY_WEB_TOOL_NAMES } from '../../src/ai-gateway/tools/web'

describe('SystemCapabilitiesSection — toolCount parity guards', () => {
  test('web count matches the web gateway family', () => {
    expect(WEB_TOOL_COUNT).toBe(GATEWAY_WEB_TOOL_NAMES.length)
  })

  test('KOS count matches the kos_-prefixed default read family', () => {
    const kosTools = GATEWAY_READ_TOOL_NAMES.filter((name) => name.startsWith('kos_'))
    expect(KOS_TOOL_COUNT).toBe(kosTools.length)
    expect(kosTools.every((name) => GATEWAY_DEFAULT_TOOL_NAMES.includes(name))).toBe(true)
  })

  test('session count matches the session gateway family', () => {
    expect(SESSION_TOOL_COUNT).toBe(GATEWAY_SESSION_TOOL_NAMES.length)
  })

  test('config count matches the profile gateway family', () => {
    expect(CONFIG_TOOL_COUNT).toBe(GATEWAY_PROFILE_TOOL_NAMES.length)
  })

  test('self-mount count matches the self-mount gateway family', () => {
    expect(SELF_MOUNT_TOOL_COUNT).toBe(GATEWAY_SELF_MOUNT_TOOL_NAMES.length)
  })

  test('calendar count matches the calendar read and write gateway families', () => {
    expect(CALENDAR_TOOL_COUNT).toBe(
      GATEWAY_CALENDAR_READ_TOOL_NAMES.length + GATEWAY_CALENDAR_WRITE_TOOL_NAMES.length
    )
  })
})
