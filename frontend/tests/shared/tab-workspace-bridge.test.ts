// tab-workspace-bridge 接线层测试（08-27 P2 Lane W）：结局 toast、跨类 replace 保护、
// locked 的三来源重算（compose / 抽屉聊过 / draft 快照）、per-tab 抽屉开合记录与恢复、
// popout 全线 no-op。

import { beforeEach, describe, expect, test, vi } from 'vitest'

const memoryStore: Record<string, string> = {}
vi.stubGlobal('localStorage', {
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
})

// bridge 的 toast 文案走 i18next 单例；先经 @shared/i18n 完成 init（i18n.md 惯例），
// 中文字面量断言才成立。
const i18n = (await import('../../src/shared/i18n')).default
await i18n.changeLanguage('zh-CN')

const { MAIN_SLOT, useTabWorkspace } = await import('../../src/shared/state/tab-workspace')
const bridge = await import('../../src/shared/state/tab-workspace-bridge')
const { useComposeStore } = await import('../../src/shared/state/compose')
const { useAIChatPanel } = await import('../../src/shared/state/ai-chat-panel')
const { usePopoutMode } = await import('../../src/shared/state/popout-mode')
const { useToastStore, __resetToastStore } = await import('../../src/shared/state/toast')

function resetTabs(): void {
  useTabWorkspace.setState({
    tabs: [],
    active: MAIN_SLOT,
    mainPage: 'today',
    mainBreadcrumb: null,
    maxTabs: 8,
    closedStack: []
  })
}

beforeEach(() => {
  for (const k of Object.keys(memoryStore)) delete memoryStore[k]
  resetTabs()
  bridge._resetTabBridgeForTest()
  useComposeStore.setState({ open: false, internalId: null, mode: 'reply' })
  useAIChatPanel.setState({ visible: false })
  usePopoutMode.setState({ isPopout: false, emailId: null })
  __resetToastStore()
})

describe('openObjectTab / replaceObjectTab', () => {
  test('open 去重激活；replace 原位换目标', () => {
    bridge.openObjectTab('email', 1, 'A')
    bridge.openObjectTab('email', 1, 'A')
    expect(useTabWorkspace.getState().tabs).toHaveLength(1)
    bridge.replaceObjectTab('email', 2, 'B')
    expect(useTabWorkspace.getState().tabs.map((t) => t.id)).toEqual(['email:2'])
  })

  test('🔴 跨类 replace 保护：激活位是另一类对象标签时退回 openTab（不吃掉那个标签）', () => {
    bridge.openObjectTab('matter', 5, '事项五')
    // 冷启动自动续选 / J-K 语义在邮件侧发起，但激活位还挂着事项标签
    bridge.replaceObjectTab('email', 1, '邮件一')
    const ids = useTabWorkspace.getState().tabs.map((t) => t.id)
    expect(ids).toContain('matter:5')
    expect(ids).toContain('email:1')
  })

  test('LRU 淘汰出 toast（报被关标签名）；满且全锁定出「先关一个」toast', () => {
    useTabWorkspace.setState({ maxTabs: 4 })
    for (let i = 1; i <= 4; i++) bridge.openObjectTab('email', i, `邮件${i}`)
    bridge.openObjectTab('email', 5, '邮件5')
    let toasts = useToastStore.getState().items
    expect(toasts).toHaveLength(1)
    expect(toasts[0].title).toContain('邮件1')
    // 全锁定：淘汰不了 → rejected toast
    __resetToastStore()
    for (const t of useTabWorkspace.getState().tabs) {
      useTabWorkspace.getState().updateTab(t.id, { locked: true })
    }
    bridge.openObjectTab('email', 9, '邮件9')
    toasts = useToastStore.getState().items
    expect(toasts).toHaveLength(1)
    expect(useTabWorkspace.getState().tabs.some((t) => t.id === 'email:9')).toBe(false)
  })

  test('一次淘汰多个（用户把上限调低后再开）→ 走 evictedMany 文案，含个数', () => {
    useTabWorkspace.setState({ maxTabs: 8 })
    for (let i = 1; i <= 6; i++) bridge.openObjectTab('email', i, `邮件${i}`)
    // 调低上限不追溯（store 契约），下一次开新标签时一次收敛到位 —— 6 → 3 要连关 4 个。
    useTabWorkspace.getState().setMaxTabs(4)
    __resetToastStore()
    bridge.openObjectTab('email', 7, '邮件7')
    expect(useTabWorkspace.getState().tabs).toHaveLength(4)
    const [toast] = useToastStore.getState().items
    // 🔴 `count` 选项会让 i18next 先找 `..._other`，词表里没有那一支 —— 这条断言同时钉住
    //   「多个」文案确实回落到基础键（漏了就渲染成 key 原文，不是中文）。
    expect(toast.title).toContain('邮件1')
    expect(toast.title).toContain('3')
    expect(toast.title).not.toContain('evictedMany')
  })
})

describe('locked 三来源', () => {
  test('compose 打开指向标签 → locked；关闭且无其他来源 → 解锁', () => {
    bridge.openObjectTab('email', 1)
    useComposeStore.getState().openCompose(1, 'reply')
    expect(useTabWorkspace.getState().tabs[0].locked).toBe(true)
    useComposeStore.getState().closeCompose()
    expect(useTabWorkspace.getState().tabs[0].locked).toBe(false)
  })

  test('抽屉聊过（notifyTabChatActivity）→ locked，且 compose 开合不误清', () => {
    bridge.openObjectTab('email', 1)
    bridge.notifyTabChatActivity('email', 1)
    expect(useTabWorkspace.getState().tabs[0].locked).toBe(true)
    useComposeStore.getState().openCompose(1, 'reply')
    useComposeStore.getState().closeCompose()
    // 聊过的锁不随 compose 关闭消失
    expect(useTabWorkspace.getState().tabs[0].locked).toBe(true)
  })

  test('draft 快照在场 → locked；清快照后解锁', () => {
    bridge.openObjectTab('email', 1)
    bridge.saveObjectTabDraft('email', 1, { kind: 'compose' })
    expect(useTabWorkspace.getState().tabs[0].locked).toBe(true)
    bridge.clearObjectTabDraft('email', 1)
    expect(useTabWorkspace.getState().tabs[0].locked).toBe(false)
  })
})

describe('per-tab 抽屉开合', () => {
  test('抽屉开合记到激活对象标签；切标签按记录恢复', () => {
    bridge.openObjectTab('email', 1)
    useAIChatPanel.getState().setVisible(true)
    expect(useTabWorkspace.getState().tabs.find((t) => t.id === 'email:1')?.drawerOpen).toBe(true)
    // 新开标签继承当前 visible（种子），不硬关抽屉
    bridge.openObjectTab('email', 2)
    expect(useTabWorkspace.getState().tabs.find((t) => t.id === 'email:2')?.drawerOpen).toBe(true)
    // 在 2 上关抽屉 → 记到 2；切回 1 → 恢复开
    useAIChatPanel.getState().setVisible(false)
    expect(useTabWorkspace.getState().tabs.find((t) => t.id === 'email:2')?.drawerOpen).toBe(false)
    useTabWorkspace.getState().activateTab('email:1')
    expect(useAIChatPanel.getState().visible).toBe(true)
  })
})

describe('标题 / 滚动位置', () => {
  test('setObjectTabTitle 同值不写（每次 updateTab 都落 localStorage）', () => {
    bridge.openObjectTab('email', 1, 'A')
    const before = useTabWorkspace.getState().tabs
    bridge.setObjectTabTitle('email', 1, 'A')
    expect(useTabWorkspace.getState().tabs).toBe(before)
    bridge.setObjectTabTitle('email', 1, 'B')
    expect(useTabWorkspace.getState().tabs[0].title).toBe('B')
  })

  test('saveObjectTabScroll / getObjectTabScroll 往返', () => {
    bridge.openObjectTab('matter', 3)
    bridge.saveObjectTabScroll('matter', 3, 123.6)
    expect(bridge.getObjectTabScroll('matter', 3)).toBe(124)
  })
})

describe('openSearchTab（P2 补批 Lane S）', () => {
  test('开搜索单例并带当前语言的标题快照（给淘汰 toast / closedStack 用）', () => {
    bridge.openSearchTab()
    const tabs = useTabWorkspace.getState().tabs
    expect(tabs.map((t) => t.id)).toEqual(['search:0'])
    expect(tabs[0].title).toBe('新标签页')
    expect(useTabWorkspace.getState().active).toBe('search:0')
  })
})

describe('popout no-op', () => {
  test('popout 下所有入口不碰标签 store（防覆盖主窗持久化标签集）', () => {
    usePopoutMode.setState({ isPopout: true, emailId: 1 })
    bridge.openObjectTab('email', 1)
    bridge.replaceObjectTab('email', 2)
    bridge.notifyTabChatActivity('email', 1)
    bridge.openSearchTab()
    expect(useTabWorkspace.getState().tabs).toHaveLength(0)
  })
})
