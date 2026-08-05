// Popmenu showcase 页（dev-only）—— 全 app 弹层统一迁到 `ui/Popmenu` 之前的审批物。
//
// 内容 = 2026-08-05 全 app popover 盘点（50 个场景 / 13 种实现）里**能迁**的那部分，
// 逐个用 Popmenu 重建，文案与选项顺序照抄现实现；迁不动的集中在页尾「不建议直接迁」。
// 卡片上的「现状」一句话来自盘点，用来对照「换基座之后白拿到什么」。
//
// 打开方式见 ../PopmenuShowcaseMount.tsx。打包产物零渲染（import.meta.env.DEV 门控）。

import { X } from 'lucide-react'

import { ChatScenes } from './scenesChat'
import { ComposerScenes } from './scenesComposer'
import { RestScenes } from './scenesRest'
import { ShellScenes } from './scenesShell'

const NAV: readonly [string, string][] = [
  ['titlebar', 'TitleBar'],
  ['sidebar', 'Sidebar'],
  ['maillist', '邮件列表 / 工具栏'],
  ['composer', 'Composer'],
  ['chat', 'Chat 面板'],
  ['chatmodal', 'Chat 浮窗'],
  ['agents', 'Agents'],
  ['calendar', '日历'],
  ['settings', '设置'],
  ['boundary', '边界']
]

const KINDS: readonly [string, string][] = [
  ['action', '动作行（默认点完关，keepOpen 可留）'],
  ['radio', '单选（默认不关）'],
  ['checkbox', '多选（+ count / dotClassName）'],
  ['submenu', '下钻一层（无深度限制，morph）'],
  ['label / separator', '分节标题 / 分隔线'],
  ['custom', '任意 React 内容（不进键盘序列）'],
  ['children', '整个根面板自绘（基座不接管键盘）']
]

export default function PopmenuShowcase({ onClose }: { onClose: () => void }): React.ReactElement {
  return (
    <div className="fixed inset-0 z-[9000] overflow-y-auto bg-ink-0">
      <header className="sticky top-0 z-[1] border-b border-ink-border bg-ink-0/95 px-6 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center gap-4">
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-ink-fg">Popmenu Showcase</h1>
            <p className="mt-0.5 text-xs text-ink-fg-2">
              全 app 弹层统一迁到 ui/Popmenu 的审批物 · 每张卡 = 一个真实场景 ·
              标题栏可切主题，本页全走 ink/coral token
            </p>
          </div>
          {/* 用 scrollIntoView 而不是 <a href="#id"> —— 本页活在 TanStack Router 的
              browser history 里，改 location.hash 会和路由抢地址栏。 */}
          <nav className="ml-auto hidden flex-wrap items-center gap-1 lg:flex">
            {NAV.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className="rounded-[var(--r-ctl)] px-2 py-1 text-xs text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
                onClick={() =>
                  document
                    .getElementById(id)
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }
              >
                {label}
              </button>
            ))}
          </nav>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭 showcase"
            className="flex h-7 w-7 flex-none items-center justify-center rounded-[var(--r-ctl)] text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
          >
            <X size={15} />
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-6 pb-24">
        <section className="mt-5 rounded-[var(--r-card)] border border-ink-border bg-ink-1/60 p-4">
          <h2 className="text-sm font-medium text-ink-fg">基座提供的 7 种行 + 1 个逃生舱</h2>
          <ul className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 md:grid-cols-2 xl:grid-cols-3">
            {KINDS.map(([k, d]) => (
              <li key={k} className="flex items-baseline gap-2">
                <code className="shrink-0 rounded bg-ink-3 px-1 font-mono text-[11px] text-coral">
                  {k}
                </code>
                <span className="text-xs text-ink-fg-2">{d}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs leading-relaxed text-ink-fg-3">
            键盘：↑↓ 循环 · Home/End · →/Enter 进子面板 · ←/Backspace/Esc 回上层（根面板 Esc = 关）·
            Tab 关。用键盘走一遍下钻菜单是这次评审的重点 —— 现状 25 个手搓弹层里只有旧 DrillMenu
            有完整键盘。
          </p>
        </section>

        <ShellScenes />
        <ComposerScenes />
        <ChatScenes />
        <RestScenes />
      </main>
    </div>
  )
}
