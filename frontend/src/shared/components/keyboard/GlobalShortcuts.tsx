// Sprint 7 D2 — registers the GLOBAL-scope keyboard bindings from
// `@shared/keymap` SSoT. Per-component handlers (J/K row nav, ⌘↩ send,
// ⌥B switch backend) stay where they are — those need access to local
// state. This component owns only the cross-cutting bindings that have
// no natural home:
//
//   - `?`     → open the help modal
//   - `⌘K`    → open the command palette
//   - `⌘,`    → navigate to /settings
//   - 标签工作区的 ⌘W / ⌘⇧T / ⌃⇥ / ⌘1-9（08-27 P2）—— 它们作用于全局标签 store，
//     没有哪个组件是天然的宿主。
//
// Mounted once at the App root next to ToastContainer.

import { useCallback, type ReactElement } from 'react'
import { useNavigate } from '@tanstack/react-router'
import i18n from '@shared/i18n'

import { useShortcut } from '@shared/hooks/useShortcut'
import {
  TAB_CLOSE_SPEC,
  TAB_CYCLE_NEXT_SPEC,
  TAB_CYCLE_PREV_SPEC,
  TAB_JUMP_SPECS,
  TAB_NEW_SPEC,
  TAB_REOPEN_SPEC
} from '@shared/keymap'
// ⌘, / ⌘O 的**目标**来自 nav registry（与侧栏、⌘K jump 同一条 entry），**组合键**仍来自
// keymap.ts（registry 只引用它的 binding id）—— 两者都不在本文件写死。
import { navEntry, navigateToNavEntry, navShortcutSpec } from '@shared/navigation/registry'
import { requestNewAgentSession, toggleChatModal } from '@shared/state/ai-chat-panel'
import { useCommandPalette } from '@shared/state/command-palette'
import { openKeyboardHelp } from '@shared/state/keyboard-help'
import { openNewCompose } from '@shared/state/compose-new'
import {
  closeActiveTab,
  cycleTab,
  jumpToSlot,
  openSearchTab,
  reopenClosedTab
} from '@shared/state/tab-commands'

// 模块级常量：entry 是静态数据，没必要每次 render 再查一次。
const settingsEntry = navEntry('settings')
const generalAgentEntry = navEntry('sessions')

/** ⌘1-9 各注册一条。写成叶子组件而不是在循环里调 hook —— 数组长度虽然恒定，
 *  循环里调 hook 仍然违反 hooks 规则（也过不了 eslint），而九个手写 `useShortcut`
 *  行会把「位置 = 下标 + 1」这条契约拆散在九处。 */
function TabJumpShortcut({ spec, position }: { spec: string; position: number }): null {
  const handler = useCallback(
    (evt: KeyboardEvent) => {
      evt.preventDefault()
      jumpToSlot(position)
      // 位置上没有标签时也消费掉：⌘3 在只开了两个标签时该是「无事发生」，
      // 不该漏给别的 handler。
      return true
    },
    [position]
  )
  useShortcut(spec, handler)
  return null
}

export function GlobalShortcuts(): ReactElement {
  const navigate = useNavigate()

  const openHelp = useCallback(() => {
    openKeyboardHelp()
  }, [])

  // Sprint 9 D4.2 (Sprint 7 review LOW #1) — ⌘K now toggles the palette
  // instead of just opening it, so a second ⌘K dismisses without forcing
  // Esc. The `toggle()` method existed on the zustand store since Sprint 7
  // but was unreachable (dead code) until now.
  const togglePalette = useCallback(() => {
    useCommandPalette.getState().toggle()
  }, [])

  const goSettings = useCallback(() => {
    // Sprint 18 PR C — `/settings` now requires a `tab` search param
    // (validateSearch in router-instance.tsx). ⌘, lands the user on the
    // first tab; switching sections is the domain panel's job.
    navigateToNavEntry(navigate, settingsEntry)
  }, [navigate])

  // assistant-modal: ⌘J 开关 chat dock（⌘L 的旧侧边面板 toggle 随 legacy 面板退役）。
  // 与上面 ⌘K 同理 —— 只开不关会逼用户改用 Esc / 点 FAB 才能收回，第二次 ⌘J 应该收回。
  // ⌘ 组合键自动跳过 editable-target gating（useShortcut），所以在 chat 输入框里打字时
  // 按 ⌘J 一样能收起 dock。
  const toggleModal = useCallback(() => {
    toggleChatModal()
  }, [])

  // ⌘O — 切到对话页 (/sessions) **并新建一个会话**（08-27 P2；原来只是导航过去，
  // 落在上一次的会话上）。两半分工：导航走 registry 的同一条 entry（与侧栏 / ⌘K jump
  // 同源），新建会话经 ai-chat-panel 排一次请求给 AgentViewLayout 消费 —— 会话引擎
  // (useGeneralChat) 的状态在那个组件实例里，这里够不着。
  // 🔴 ⌘O 不开对象标签：对话是主标签的八种承载之一。
  const openNewChat = useCallback(() => {
    navigateToNavEntry(navigate, generalAgentEntry)
    requestNewAgentSession()
  }, [navigate])

  // ── 标签工作区（08-27 P2）───────────────────────────────────────────────
  // ⌘W —— 关掉当前对象标签。🔴 恒 preventDefault + 恒消费，包括主标签激活（关不掉）
  // 那一支：macOS windowMenu 的 close role 也绑 ⌘W，不拦下来就成了「想关标签，
  // 结果关了整个窗口」。同款「renderer preventDefault 盖过菜单加速键」的先例是
  // useCalendarShortcuts 的 ⌘R（viewMenu reload role）。关窗仍走红绿灯 / ⌘Q。
  // dogfood 波3：closeActiveTab 内部经 bridge 关闭守卫 —— dirty 草稿标签先弹确认。
  const closeTab = useCallback((evt: KeyboardEvent) => {
    evt.preventDefault()
    closeActiveTab()
    return true
  }, [])

  const reopenTab = useCallback((evt: KeyboardEvent) => {
    evt.preventDefault()
    reopenClosedTab()
    return true
  }, [])

  // ⌘T —— 打开「新标签页」（搜索单例；已开着则只激活）。preventDefault 防浏览器语义
  // 残留（Electron 无 tab role，但 ⌘ 组合恒消费与 ⌘W 同口径）。
  const newTab = useCallback((evt: KeyboardEvent) => {
    evt.preventDefault()
    openSearchTab()
    return true
  }, [])

  // ⌃⇥ / ⌃⇧⇥ —— 循环切标签。useShortcut 的 `ctrl` 是跨平台别名（⌘ 也算），这里要的是
  // **严格 ⌃**，故在 handler 里补一道 ctrlKey 判据；不匹配就不消费，让给后面的注册项。
  const cycleNext = useCallback((evt: KeyboardEvent) => {
    if (!evt.ctrlKey) return false
    evt.preventDefault()
    cycleTab(1)
    return true
  }, [])
  const cyclePrev = useCallback((evt: KeyboardEvent) => {
    if (!evt.ctrlKey) return false
    evt.preventDefault()
    cycleTab(-1)
    return true
  }, [])

  // Sprint 11 V1.4 — locale toggle（同批的 ⌥B 折叠导航随二级栏定宽退役）。
  const toggleLocale = useCallback(() => {
    const cur = (i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN') as 'zh-CN' | 'en-US'
    const next: 'zh-CN' | 'en-US' = cur === 'zh-CN' ? 'en-US' : 'zh-CN'
    void i18n.changeLanguage(next)
  }, [])

  // `?` requires shift on US/UK keyboards; the parser already keys on the
  // resolved char (which is '?' after shift), so spec='?' matches without
  // having to write 'shift+/'.
  useShortcut('?', openHelp)
  useShortcut('cmd+k', togglePalette)
  useShortcut(navShortcutSpec(settingsEntry), goSettings)
  useShortcut('cmd+j', toggleModal)
  useShortcut(navShortcutSpec(generalAgentEntry), openNewChat)
  // ⌘N — 写新邮件 (居中模态, ComposeNewModal 挂 RootLayout)。global scope: 任意
  // 页面可开, 与全局侧边栏「写邮件」按钮一致。editable context 默认 short-circuit,
  // chat / 主题输入框打字不误触。
  useShortcut('cmd+n', () => openNewCompose())
  useShortcut('alt+g', toggleLocale)
  useShortcut(TAB_NEW_SPEC, newTab)
  useShortcut(TAB_CLOSE_SPEC, closeTab)
  useShortcut(TAB_REOPEN_SPEC, reopenTab)
  useShortcut(TAB_CYCLE_NEXT_SPEC, cycleNext)
  useShortcut(TAB_CYCLE_PREV_SPEC, cyclePrev)

  return (
    <>
      {TAB_JUMP_SPECS.map((spec, idx) => (
        <TabJumpShortcut key={spec} spec={spec} position={idx + 1} />
      ))}
    </>
  )
}
