// active-chat 状态测试（09-02 对话域拆分：`chats` 升对象域，一个会话 = 一个标签）。
//
// 钉的是 C lane 的四件事：临时负 id 的开法、首发换锚（标签身份延续 + mountKey 不翻）、
// 冷启动丢弃负 id 标签、popout / 轻窗的本地降级。反向订阅与被拒回滚照 active-email 的口径。
//
// The zustand store instance touches localStorage on construction, which we stub at
// module level so the test stays in the node-environment pool (no jsdom).

import { beforeEach, describe, expect, test, vi } from 'vitest'

const memoryStore: Record<string, string> = {}
const localStorageStub = {
  getItem: (k: string) => (k in memoryStore ? memoryStore[k] : null),
  setItem: (k: string, v: string) => {
    memoryStore[k] = v
  },
  removeItem: (k: string) => {
    delete memoryStore[k]
  },
  clear: () => {
    for (const k of Object.keys(memoryStore)) delete memoryStore[k]
  }
}
vi.stubGlobal('localStorage', localStorageStub)
// tab-workspace 的持久化走 `window.localStorage`（`typeof window === 'undefined'` 短路）——
// node 池里补一个最小 window，冷启动恢复的用例才有存取面。
vi.stubGlobal('window', { localStorage: localStorageStub })

const {
  adoptChatSession,
  nextTempChatId,
  openChatTab,
  openNewChatTab,
  readChatTabDraft,
  saveChatTabDraft,
  useActiveChat
} = await import('../../src/shared/state/active-chat')
const { MAIN_SLOT, useTabWorkspace } = await import('../../src/shared/state/tab-workspace')
const { _resetTabBridgeForTest } = await import('../../src/shared/state/tab-workspace-bridge')
const { usePopoutMode } = await import('../../src/shared/state/popout-mode')

function resetTabs(): void {
  useTabWorkspace.setState({
    tabs: [],
    active: MAIN_SLOT,
    mainPage: 'today',
    mainBreadcrumb: null,
    maxTabs: 10,
    closedStack: []
  })
}

const tabIds = (): string[] => useTabWorkspace.getState().tabs.map((t) => t.id)

beforeEach(() => {
  for (const k of Object.keys(memoryStore)) delete memoryStore[k]
  resetTabs()
  _resetTabBridgeForTest()
  usePopoutMode.setState({ isPopout: false, emailId: null })
  useActiveChat.setState({ activeChatTargetId: null, mountKey: null })
})

describe('nextTempChatId', () => {
  test('递减负数，互不相同', () => {
    const a = nextTempChatId()
    const b = nextTempChatId()
    expect(a).toBeLessThan(0)
    expect(b).toBe(a - 1)
  })
})

describe('openNewChatTab / openChatTab — 开标签并投影', () => {
  test('连按三次 = 三个 chat 标签，临时 id 各不相同且为负；投影与 mountKey 指向最新那张', () => {
    openNewChatTab()
    openNewChatTab()
    openNewChatTab()
    const tabs = useTabWorkspace.getState().tabs
    expect(tabs).toHaveLength(3)
    expect(tabs.every((t) => t.kind === 'chat' && t.targetId < 0)).toBe(true)
    expect(new Set(tabs.map((t) => t.targetId)).size).toBe(3)
    const last = tabs[2].targetId
    expect(useTabWorkspace.getState().active).toBe(`chat:${last}`)
    expect(useActiveChat.getState()).toEqual({ activeChatTargetId: last, mountKey: last })
  })

  test('点会话行：openChatTab(真 id) 开标签带标题；再点同一条只激活不重复开', () => {
    openChatTab(42, '续约确认')
    openChatTab(7)
    openChatTab(42)
    expect(tabIds()).toEqual(['chat:42', 'chat:7'])
    expect(useTabWorkspace.getState().active).toBe('chat:42')
    expect(useTabWorkspace.getState().tabs[0].title).toBe('续约确认')
    expect(useActiveChat.getState()).toEqual({ activeChatTargetId: 42, mountKey: 42 })
  })

  test('被拒回滚：满且全锁定 → 投影不落新值（否则详情区与标签条高亮劈叉）', () => {
    useTabWorkspace.setState({ maxTabs: 4 })
    for (let i = 1; i <= 4; i++) openChatTab(i)
    for (const t of useTabWorkspace.getState().tabs) {
      useTabWorkspace.getState().updateTab(t.id, { locked: true })
    }
    openChatTab(99)
    expect(tabIds()).not.toContain('chat:99')
    expect(useActiveChat.getState()).toEqual({ activeChatTargetId: 4, mountKey: 4 })
  })
})

describe('adoptChatSession — 首发换锚', () => {
  test('临时 id → 真 id：标签身份延续（title·draft·位置保留，active 跟随），投影换真 id，mountKey 不变', () => {
    openChatTab(10, '前一张')
    openNewChatTab()
    openChatTab(20, '后一张')
    const temp = useTabWorkspace.getState().tabs[1].targetId
    expect(temp).toBeLessThan(0)
    useTabWorkspace.getState().activateTab(`chat:${temp}`)
    useTabWorkspace.getState().updateTab(`chat:${temp}`, {
      title: '新对话',
      draft: { text: '写了一半' }
    })
    expect(useActiveChat.getState()).toEqual({ activeChatTargetId: temp, mountKey: temp })

    adoptChatSession(temp, 4242)

    const ws = useTabWorkspace.getState()
    // 位置不变（仍在中间），id / targetId 换成真 id
    expect(ws.tabs.map((t) => t.id)).toEqual(['chat:10', 'chat:4242', 'chat:20'])
    expect(ws.tabs[1]).toMatchObject({
      targetId: 4242,
      title: '新对话',
      draft: { text: '写了一半' }
    })
    expect(ws.active).toBe('chat:4242')
    // 投影换成真 id；mountKey 仍是临时 id —— 换锚发生在首发流式输出当口，key 翻了会把会话卸载重挂
    expect(useActiveChat.getState()).toEqual({ activeChatTargetId: 4242, mountKey: temp })
  })

  test('真 id 已有同类标签 → 合并：保留带着会话现场的临时那张，重复者移除且不进最近关闭栈', () => {
    openChatTab(4242, '旧的')
    openNewChatTab()
    const temp = useActiveChat.getState().activeChatTargetId as number
    useTabWorkspace.getState().updateTab(`chat:${temp}`, { draft: { text: 'x' } })
    adoptChatSession(temp, 4242)
    const ws = useTabWorkspace.getState()
    expect(ws.tabs.map((t) => t.id)).toEqual(['chat:4242'])
    expect(ws.tabs[0].draft).toEqual({ text: 'x' })
    expect(ws.closedStack).toEqual([])
    expect(useActiveChat.getState()).toEqual({ activeChatTargetId: 4242, mountKey: temp })
  })

  test('宿主已切走（投影不是它）→ 标签照样换锚，投影不动', () => {
    openNewChatTab()
    const temp = useActiveChat.getState().activeChatTargetId as number
    openChatTab(5)
    adoptChatSession(temp, 4242)
    expect(tabIds()).toEqual(['chat:4242', 'chat:5'])
    expect(useTabWorkspace.getState().active).toBe('chat:5')
    expect(useActiveChat.getState()).toEqual({ activeChatTargetId: 5, mountKey: 5 })
  })
})

describe('反向订阅 — 标签 store 侧的激活变化', () => {
  test('标签条激活另一张 chat 标签 → 投影与 mountKey 都换', () => {
    openChatTab(1)
    openChatTab(2)
    useTabWorkspace.getState().activateTab('chat:1')
    expect(useActiveChat.getState()).toEqual({ activeChatTargetId: 1, mountKey: 1 })
  })

  test('激活主标签 / 邮件标签 → chat 投影清空', () => {
    openChatTab(1)
    useTabWorkspace.getState().activateMain()
    expect(useActiveChat.getState()).toEqual({ activeChatTargetId: null, mountKey: null })
    useTabWorkspace.getState().activateTab('chat:1')
    useTabWorkspace.getState().openTab('email', 9)
    expect(useActiveChat.getState()).toEqual({ activeChatTargetId: null, mountKey: null })
  })

  test('关掉激活的 chat 标签 → 最近用过的 chat 标签接管并投影', () => {
    openChatTab(1)
    openChatTab(2)
    useTabWorkspace.getState().closeTab('chat:2')
    expect(useActiveChat.getState()).toEqual({ activeChatTargetId: 1, mountKey: 1 })
  })

  test('无关提交（updateTab）不碰投影', () => {
    openChatTab(1)
    useActiveChat.setState({ activeChatTargetId: 1, mountKey: -7 })
    useTabWorkspace.getState().updateTab('chat:1', { title: '改名' })
    expect(useActiveChat.getState()).toEqual({ activeChatTargetId: 1, mountKey: -7 })
  })
})

describe('草稿快照', () => {
  test('save / read 往返；空串清除；没有标签时不抛', () => {
    openChatTab(3)
    expect(readChatTabDraft(3)).toBe('')
    saveChatTabDraft(3, '写到一半')
    expect(readChatTabDraft(3)).toBe('写到一半')
    expect(useTabWorkspace.getState().tabs[0].draft).toEqual({ text: '写到一半' })
    saveChatTabDraft(3, '')
    expect(useTabWorkspace.getState().tabs[0].draft).toBeUndefined()
    expect(() => saveChatTabDraft(404, 'x')).not.toThrow()
  })
})

describe('popout / 轻窗降级 — 本窗口没有标签条', () => {
  test('popout 下 openChatTab 只落本地投影，标签 store 一个字不写', () => {
    usePopoutMode.getState().setPopout(1)
    openChatTab(8, '弹出窗里')
    expect(useActiveChat.getState()).toEqual({ activeChatTargetId: 8, mountKey: 8 })
    expect(tabIds()).toEqual([])
    expect(memoryStore['mailagent.tabs.v1']).toBeUndefined()
  })

  test('popout 下标签 store 的变化不反向投影', () => {
    usePopoutMode.getState().setPopout(1)
    useActiveChat.setState({ activeChatTargetId: 8, mountKey: 8 })
    useTabWorkspace.getState().openTab('chat', 9)
    expect(useActiveChat.getState()).toEqual({ activeChatTargetId: 8, mountKey: 8 })
  })
})

describe('冷启动恢复', () => {
  const stored = (targetId: number, title: string): Record<string, unknown> => ({
    kind: 'chat',
    targetId,
    title,
    lastActiveAt: 5,
    locked: false,
    drawerOpen: false,
    scrollTop: 0
  })

  test('负 id 的 chat 标签不恢复（未发送的空会话）；正 id 照常恢复并成为初值', async () => {
    memoryStore['mailagent.tabs.v1'] = JSON.stringify({
      v: 1,
      tabs: [stored(-3, '新对话'), stored(42, '恢复的会话')],
      active: 'chat:42',
      mainPage: 'today',
      maxTabs: 10
    })
    vi.resetModules()
    const fresh = await import('../../src/shared/state/active-chat')
    const freshWs = await import('../../src/shared/state/tab-workspace')
    expect(freshWs.useTabWorkspace.getState().tabs.map((t) => t.id)).toEqual(['chat:42'])
    expect(fresh.useActiveChat.getState()).toEqual({ activeChatTargetId: 42, mountKey: 42 })
  })

  test('存档里激活的是负 id 标签 → 丢弃后回主标签，投影 null', async () => {
    memoryStore['mailagent.tabs.v1'] = JSON.stringify({
      v: 1,
      tabs: [stored(-1, '新对话'), stored(7, '别的')],
      active: 'chat:-1',
      mainPage: 'today',
      maxTabs: 10
    })
    vi.resetModules()
    const fresh = await import('../../src/shared/state/active-chat')
    const freshWs = await import('../../src/shared/state/tab-workspace')
    expect(freshWs.useTabWorkspace.getState().active).toBe(freshWs.MAIN_SLOT)
    expect(fresh.useActiveChat.getState()).toEqual({ activeChatTargetId: null, mountKey: null })
  })
})
