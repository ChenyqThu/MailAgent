// tab-workspace-bridge 接线层测试（08-27 P2 Lane W）：结局 toast、跨类 replace 保护、
// locked 的三来源重算（compose / 抽屉聊过 / draft 快照）、per-tab 抽屉开合记录与恢复、
// popout 全线 no-op。

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
// node 池没有 window —— tab-workspace 的持久化走 `window.localStorage`（typeof window
// 短路），「重启回灌与归一」用例要重新 hydrate 存档，补一个最小 window（active-email
// 测试同款先例）。
vi.stubGlobal('window', { localStorage: localStorageStub })

// bridge 的 toast 文案走 i18next 单例；先经 @shared/i18n 完成 init（i18n.md 惯例），
// 中文字面量断言才成立。
const i18n = (await import('../../src/shared/i18n')).default
await i18n.changeLanguage('zh-CN')

const { MAIN_SLOT, useTabWorkspace } = await import('../../src/shared/state/tab-workspace')
const bridge = await import('../../src/shared/state/tab-workspace-bridge')
const { useComposeStore } = await import('../../src/shared/state/compose')
const { useAIChatPanel } = await import('../../src/shared/state/ai-chat-panel')
const { usePopoutMode } = await import('../../src/shared/state/popout-mode')
const { useDetachedMode } = await import('../../src/shared/state/detached-mode')
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
  useDetachedMode.setState({ isDetached: false, target: null })
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

  test('LRU 驱逐静默（dogfood 轮4）：满员开新零 toast，新标签在场并激活，被挤掉的可 ⌘⇧T 找回', () => {
    useTabWorkspace.setState({ maxTabs: 4 })
    for (let i = 1; i <= 4; i++) bridge.openObjectTab('email', i, `邮件${i}`)
    __resetToastStore()
    expect(bridge.openObjectTab('email', 5, '邮件5')).toBe(true)
    // 驱逐不再出声（此前每次满员都弹「顺带关掉了谁」，owner 判为噪音）
    expect(useToastStore.getState().items).toHaveLength(0)
    const ws = useTabWorkspace.getState()
    expect(ws.tabs.some((t) => t.id === 'email:5')).toBe(true)
    expect(ws.active).toBe('email:5')
    expect(ws.tabs.some((t) => t.id === 'email:1')).toBe(false)
    // 被挤掉的进最近关闭栈 —— 静默的前提是找得回来
    expect(ws.closedStack.at(-1)).toEqual({ kind: 'email', targetId: 1, title: '邮件1' })
    useTabWorkspace.getState().reopenLastClosed()
    expect(useTabWorkspace.getState().tabs.some((t) => t.id === 'email:1')).toBe(true)
  })

  test('满且全锁定（极端路径）→ 仍拒绝 + 「先关一个」toast，openObjectTab 返回 false（回滚链判据）', () => {
    useTabWorkspace.setState({ maxTabs: 4 })
    for (let i = 1; i <= 4; i++) bridge.openObjectTab('email', i, `邮件${i}`)
    for (const t of useTabWorkspace.getState().tabs) {
      useTabWorkspace.getState().updateTab(t.id, { locked: true })
    }
    __resetToastStore()
    // 返回 false = active-email / matters 的被拒回滚投影链在这条极端路径继续工作
    expect(bridge.openObjectTab('email', 9, '邮件9')).toBe(false)
    const toasts = useToastStore.getState().items
    expect(toasts).toHaveLength(1)
    expect(toasts[0].title).toContain('先关一个')
    expect(useTabWorkspace.getState().tabs.some((t) => t.id === 'email:9')).toBe(false)
  })

  test('一次驱逐多个（用户把上限调低后再开）同样静默：零 toast，按新上限收敛到位', () => {
    useTabWorkspace.setState({ maxTabs: 8 })
    for (let i = 1; i <= 6; i++) bridge.openObjectTab('email', i, `邮件${i}`)
    // 调低上限不追溯（store 契约），下一次开新标签时一次收敛到位 —— 6 → 3 要连关 4 个。
    useTabWorkspace.getState().setMaxTabs(4)
    __resetToastStore()
    bridge.openObjectTab('email', 7, '邮件7')
    expect(useToastStore.getState().items).toHaveLength(0)
    expect(useTabWorkspace.getState().tabs).toHaveLength(4)
    expect(useTabWorkspace.getState().active).toBe('email:7')
    // 被挤掉的三个全部进 closedStack（⌘⇧T 逐个可找回）
    const stacked = useTabWorkspace.getState().closedStack.map((e) => e.targetId)
    expect(stacked).toEqual(expect.arrayContaining([1, 2, 3]))
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

  test('draft 快照 dirty → locked；清快照后解锁（check 波3：判据 dirty-only）', () => {
    bridge.openObjectTab('email', 1)
    bridge.saveObjectTabDraft('email', 1, { kind: 'compose', dirty: true })
    expect(useTabWorkspace.getState().tabs[0].locked).toBe(true)
    bridge.clearObjectTabDraft('email', 1)
    expect(useTabWorkspace.getState().tabs[0].locked).toBe(false)
  })

  test('clean 快照（保存过的草稿）不锁 —— 快照保留在场但参与 LRU；dirty 不可淘汰', () => {
    useTabWorkspace.setState({ maxTabs: 4 })
    bridge.openObjectTab('email', 1, '存过的草稿')
    bridge.saveObjectTabDraft('email', 1, { kind: 'compose', dirty: false, lastSavedAtMs: 1 })
    // 快照在场但 clean → 不锁（旧判据「在场即锁」会让保存过的草稿永久锁死）
    const tab1 = useTabWorkspace.getState().tabs.find((t) => t.id === 'email:1')
    expect(tab1?.locked).toBe(false)
    expect(tab1?.draft).toBeDefined()
    for (let i = 2; i <= 4; i++) bridge.openObjectTab('email', i, `邮件${i}`)
    bridge.openObjectTab('email', 5, '邮件5')
    // email:1 是最老且未锁 → 被 LRU 淘汰，快照随标签消亡（草稿在服务端，重开走 detail）
    expect(useTabWorkspace.getState().tabs.some((t) => t.id === 'email:1')).toBe(false)
    // 对照：dirty 快照锁死，同局面不被淘汰（淘汰目标落到下一个未锁的）
    resetTabs()
    bridge._resetTabBridgeForTest()
    useTabWorkspace.setState({ maxTabs: 4 })
    bridge.openObjectTab('email', 1, '写一半的草稿')
    bridge.saveObjectTabDraft('email', 1, { kind: 'compose', dirty: true })
    for (let i = 2; i <= 4; i++) bridge.openObjectTab('email', i, `邮件${i}`)
    bridge.openObjectTab('email', 5, '邮件5')
    expect(useTabWorkspace.getState().tabs.some((t) => t.id === 'email:1')).toBe(true)
    expect(useTabWorkspace.getState().tabs.some((t) => t.id === 'email:2')).toBe(false)
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

// task 08-27 P5 —— 轻窗（?detach=email|report）同样不渲染标签条，与主窗共用同一个
// localStorage 键 ⇒ 判据必须与 popout 同款收在 tabsInert()，否则「在新窗口打开一封邮件」
// 会把主窗的整份标签集覆盖掉（tab-workspace 有意不挂 storage 监听，主窗察觉不到）。
describe('detached（轻窗）no-op', () => {
  test('轻窗下所有入口不碰标签 store，且一个字节都不落 localStorage', () => {
    useDetachedMode.setState({ isDetached: true, target: { kind: 'email', emailId: 1 } })
    bridge.openObjectTab('email', 1)
    bridge.replaceObjectTab('email', 2)
    bridge.notifyTabChatActivity('email', 1)
    bridge.openSearchTab()
    bridge.setObjectTabTitle('email', 1, '标题')
    bridge.saveObjectTabScroll('email', 1, 120)
    bridge.closeObjectTab('email', 1)
    expect(useTabWorkspace.getState().tabs).toHaveLength(0)
    expect(memoryStore['mailagent.tabs.v1']).toBeUndefined()
  })

  test('tabsInert() 认 popout 与轻窗两种；两者都不在时为 false', () => {
    expect(bridge.tabsInert()).toBe(false)
    useDetachedMode.setState({ isDetached: true, target: { kind: 'report', reportId: 'r1' } })
    expect(bridge.tabsInert()).toBe(true)
    useDetachedMode.setState({ isDetached: false, target: null })
    usePopoutMode.setState({ isPopout: true, emailId: 1 })
    expect(bridge.tabsInert()).toBe(true)
  })

  test('轻窗下 requestCloseTab 不消费按键、也不关标签（⌘W 该落回窗口的关闭语义）', () => {
    // 先在「有标签条」的前提下真开一个 —— 否则 requestCloseTab 会因为「标签不存在」
    // 提前返回 false，测出来的是空壳而不是 inert。
    bridge.openObjectTab('email', 1, '一封邮件')
    expect(useTabWorkspace.getState().tabs).toHaveLength(1)
    useDetachedMode.setState({ isDetached: true, target: { kind: 'email', emailId: 1 } })
    expect(bridge.requestCloseTab('email:1')).toBe(false)
    expect(useTabWorkspace.getState().tabs).toHaveLength(1)
  })
})

describe('requestCloseTab（dogfood 波3 关闭守卫入口）', () => {
  test('非 dirty 标签 → 维持 closeTab 原语义（直接关，消费按键）', () => {
    bridge.openObjectTab('email', 1, '普通邮件')
    expect(bridge.requestCloseTab('email:1')).toBe(true)
    expect(useTabWorkspace.getState().tabs).toHaveLength(0)
    expect(bridge.useTabCloseGuard.getState().pending).toBeNull()
  })

  test('dirty 草稿标签 → 先激活再挂请求，不直接关；弹框期间再请求不叠', () => {
    bridge.openObjectTab('email', 1, '草稿')
    bridge.openObjectTab('email', 2, '别的')
    bridge.saveObjectTabDraft('email', 1, { kind: 'compose', dirty: true })
    expect(useTabWorkspace.getState().active).toBe('email:2')
    expect(bridge.requestCloseTab('email:1')).toBe(true)
    // 拍板：先激活再弹框 —— 标签仍在、激活槽切到它、请求挂起
    expect(useTabWorkspace.getState().tabs.some((t) => t.id === 'email:1')).toBe(true)
    expect(useTabWorkspace.getState().active).toBe('email:1')
    expect(bridge.useTabCloseGuard.getState().pending?.tabId).toBe('email:1')
    // 第二次请求（⌘W 连按）：消费但什么也不做
    expect(bridge.requestCloseTab('email:1')).toBe(true)
    expect(useTabWorkspace.getState().tabs.some((t) => t.id === 'email:1')).toBe(true)
  })

  test('dirty=false 的快照不拦（只有 dirty 位才弹确认）', () => {
    bridge.openObjectTab('email', 1, '存过的草稿')
    bridge.saveObjectTabDraft('email', 1, { kind: 'compose', dirty: false })
    bridge.requestCloseTab('email:1')
    expect(useTabWorkspace.getState().tabs).toHaveLength(0)
  })

  test('请求作废清理：目标标签消失 / 激活槽离开目标 → pending 清空', () => {
    bridge.openObjectTab('email', 1, '草稿')
    bridge.openObjectTab('email', 2, '别的')
    bridge.saveObjectTabDraft('email', 1, { kind: 'compose', dirty: true })
    bridge.requestCloseTab('email:1')
    expect(bridge.useTabCloseGuard.getState().pending).not.toBeNull()
    // 弹窗前/下切走（⌘1-9 / ⌃⇥）→ 承接弹窗的面板随详情卸载，请求必须作废
    useTabWorkspace.getState().activateTab('email:2')
    expect(bridge.useTabCloseGuard.getState().pending).toBeNull()
    // 目标被别的路径关掉（404 核销等）同样作废
    bridge.requestCloseTab('email:1')
    expect(bridge.useTabCloseGuard.getState().pending).not.toBeNull()
    useTabWorkspace.getState().closeTab('email:1')
    expect(bridge.useTabCloseGuard.getState().pending).toBeNull()
  })
})

describe('retargetObjectTab（dogfood 波3 replace 换锚接线）', () => {
  test('标签换锚 + 聊天锁集合跟迁（重算 locked 不丢聊天锁）', () => {
    bridge.openObjectTab('email', 99, '草稿')
    bridge.notifyTabChatActivity('email', 99)
    expect(useTabWorkspace.getState().tabs[0].locked).toBe(true)
    bridge.retargetObjectTab('email', 99, 200)
    const tabs = useTabWorkspace.getState().tabs
    expect(tabs.map((t) => t.id)).toEqual(['email:200'])
    // 聊天锁按 tab id 键控 —— 不迁的话这里的重算会把锁抹掉
    expect(tabs[0].locked).toBe(true)
  })

  test('待关闭请求跟迁（guard 保存路径换锚后 finish 关的是新 id）', () => {
    bridge.openObjectTab('email', 99, '草稿')
    bridge.saveObjectTabDraft('email', 99, { kind: 'compose', dirty: true })
    bridge.requestCloseTab('email:99')
    expect(bridge.useTabCloseGuard.getState().pending?.tabId).toBe('email:99')
    bridge.retargetObjectTab('email', 99, 200)
    expect(bridge.useTabCloseGuard.getState().pending?.tabId).toBe('email:200')
  })

  test('popout 下 requestCloseTab / retargetObjectTab 全 no-op', () => {
    bridge.openObjectTab('email', 1, 'A')
    usePopoutMode.setState({ isPopout: true, emailId: 1 })
    expect(bridge.requestCloseTab('email:1')).toBe(false)
    bridge.retargetObjectTab('email', 1, 2)
    usePopoutMode.setState({ isPopout: false, emailId: null })
    expect(useTabWorkspace.getState().tabs.map((t) => t.id)).toEqual(['email:1'])
  })
})

describe('重启回灌与归一（check 波3：dirty-only 判据对存量档案生效）', () => {
  test('locked+clean 快照放平；locked 无快照回灌聊天锁；locked+dirty 维持', async () => {
    // 直接写存档 → resetModules → 重新 import：tab-workspace 先 hydrate，bridge 模块
    // init 跑「聊天锁回灌 + 启动归一」。旧判据「快照在场即锁」写下的 locked+clean 行
    // 必须在这里放平，否则存量库的 LRU 满拒要等到某次 recompute 才收敛。
    memoryStore['mailagent.tabs.v1'] = JSON.stringify({
      v: 1,
      tabs: [
        { kind: 'email', targetId: 1, locked: true, draft: { kind: 'compose', dirty: false } },
        { kind: 'email', targetId: 2, locked: true },
        { kind: 'email', targetId: 3, locked: true, draft: { kind: 'compose', dirty: true } }
      ],
      active: 'main'
    })
    vi.resetModules()
    const freshWs = await import('../../src/shared/state/tab-workspace')
    await import('../../src/shared/state/tab-workspace-bridge')
    const tabs = freshWs.useTabWorkspace.getState().tabs
    // clean 快照：锁放平（快照本身保留 —— lastSavedAtMs/锚还在）
    const t1 = tabs.find((t) => t.id === 'email:1')
    expect(t1?.locked).toBe(false)
    expect(t1?.draft).toBeDefined()
    // 无快照：归因聊天锁，保留
    expect(tabs.find((t) => t.id === 'email:2')?.locked).toBe(true)
    // dirty：维持
    expect(tabs.find((t) => t.id === 'email:3')?.locked).toBe(true)
  })
})
