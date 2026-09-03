// @vitest-environment happy-dom
//
// 0903 dogfood — AI 侧栏（AssistantChatModal 的 sidebar 形态）最小宽度下限 350。
// 两条路径各一条：拖窄走 clampSidebarWidth，重新打开走 readSidebarWidthPref（旧
// localStorage 里 <350 的值必须被抬上来，没有迁移脚本，全靠读出来即 clamp）。
//
// localStorage 用内存 stub：happy-dom 注解并不保证这里有可用的 localStorage
// （Node 22+ 的实验性同名全局是 undefined，vitest 不会覆盖已存在的 node 全局），
// 范式同 assistant-modal-state.test.ts。

import { afterEach, describe, expect, test, vi } from 'vitest'

const memory: Record<string, string> = {}
vi.stubGlobal('localStorage', {
  getItem: (k: string) => (k in memory ? memory[k] : null),
  setItem: (k: string, v: string) => {
    memory[k] = v
  },
  removeItem: (k: string) => {
    delete memory[k]
  },
  clear: () => {
    for (const k of Object.keys(memory)) delete memory[k]
  }
})

const PREF_KEY = 'mailagent.chat.dockSidebarWidth'

const { clampSidebarWidth, readSidebarWidthPref } =
  await import('@shared/assistant/modal/sidebarWidth')

afterEach(() => {
  localStorage.clear()
})

describe('AI 侧栏宽度下限', () => {
  test('拖窄停在 350，下限之上逐像素放行', () => {
    expect(clampSidebarWidth(0)).toBe(350)
    expect(clampSidebarWidth(349)).toBe(350)
    expect(clampSidebarWidth(351)).toBe(351)
  })

  test('缓存里 <350 的旧值读出来被抬到 350；合法值原样返回', () => {
    localStorage.setItem(PREF_KEY, '320')
    expect(readSidebarWidthPref()).toBe(350)

    localStorage.setItem(PREF_KEY, '400')
    expect(readSidebarWidthPref()).toBe(400)
  })
})
