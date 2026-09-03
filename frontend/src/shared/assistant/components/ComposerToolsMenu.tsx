// WP-13 + WP-16b（task 08-05 P1）—— composer 的**滑块菜单**（快捷配置：外部连接 / 技能 /
// 去 AI 设置）。owner 参照 Notion composer 的「滑块」图标：`+` 管「加东西进这轮对话」，滑块
// 管「这轮对话能用哪些外部能力」。两个 composer 共用一个组件（icon / chip 双 variant，抄
// ModelPicker / ApprovalModePicker 先例）。
//
// 收编来源：
//   · 「外部连接」二级面板从 `ComposerPlusMenu` 整块搬来（内容组件 `ConnectorQuickContent`
//     逐字未动，连同「+」上那颗常驻 coral 点一起搬 —— 点表达的是「外部连接接着东西」，它跟着
//     外部连接走，不跟着「+」走）。**该点 08-06 已整个退役**（owner dogfood ③，理由见
//     `triggerBody` 上方那段）：它把「有 connector 启用」这个常态画成了「有新东西」。
//   · 「技能」二级是新的（WP-13 G2）：复用 `api.chat.listSkills()` / `setSkillEnabled`，后端全
//     现成，gateway 15s TTL 后对下一轮生效（toast 里说清，否则用户会反复开关一个「没反应」的东西）。
//
// 🔴 **不做**（WP-13 明确裁剪，理由记在案免得下一轮又被当成遗漏）：
//   · 一级 toggle 行（Memory / Web 之类）—— 它们背后是 env flag + 需重启，做成即时开关 = 说谎；
//   · 二级搜索框、分组折叠 —— connector 与 skill 都是个位数，规模撑不起（同 ModelPicker 的裁剪）。
//
// ── 响应式二级形态（WP-13 ④ 方案 C）────────────────────────────────────────────────
// 宽面板：一级留在原位，二级**并排**长在它右边（flyout）；窄面板：维持替换式（= 收编前的行为，
// 零回归）。判据是**量出来的可用宽度**，不是 variant —— chip 同时出现在 320px 侧栏与 704px
// agent 面，按 variant 分叉必然在其中一边错（研究 §5.4 方案 A 被否的正是这一条）。
//
// 🔴 **有意偏离计划书的一点：flyout 向右展开、不 portal**。计划书写的是「portal + 向左展开」，
// 其依据是研究 §5.2「横向 flyout 会被 `AgentThread` Viewport 的 overflow-x-hidden 裁掉」——
// 那条结论成立的前提是**向左溢出到容器之外**。本实现让二级长在一级右边、且开 flyout 的门槛
// （FLYOUT_MIN_ROOM）就是「容器内还剩得下二级」，于是弹层整体**始终在容器内**，既不会被裁，
// 也不必 portal。这直接消掉了计划书 §5 风险 10 记的两个坑：outside-click 单 ref `contains`
// 失效（二级仍在同一棵子树里，判据不用换）、以及 portal 后与浮窗 z-40 / FAB / BatchActionBar
// 的 z-index 重排（没 portal 就没这回事）。代价：极窄的「装得下二级但装不下并排」区间退回替换
// 式 —— 而那正是替换式本来就要覆盖的区间。
//
// 动效/材质：一级与二级各自一份 `useExitAnimation`，配方与 MentionPopover 逐字同款；二级在
// flyout 形态下 origin 'bottom left'（它从一级的右边缘长出来）。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { Blocks, ChevronLeft, ChevronRight, Puzzle, SlidersHorizontal } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { DUR } from '@shared/lib/gsap'
import { qk } from '@shared/lib/queryKeys'
import { errorMessage } from '@shared/lib/ipcErrors'
import { HoverTip } from '@shared/components/ui/HoverTip'
import { Switch } from '@shared/components/ui/switch'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { useConnectorQuickRows } from '@shared/hooks/useConnectorQuickRows'
import { useMailApi } from '@shared/hooks/useMailApi'
import { toastError, toastSuccess } from '@shared/state/toast'
import {
  AI_TAB_ANCHOR_IDS,
  scrollToAnchorWhenReady
} from '@shared/components/settings/aiTabAnchors'
import type { SkillSummary } from '@shared/api/types'

import { ConnectorQuickContent } from './ConnectorQuickPanel'
import { toolsFlyoutFits } from './composerToolsMenu.lib'

const ICON_BTN =
  'grid h-7 w-7 place-items-center rounded-md transition-[color,background-color,transform] duration-fast'

const MENU_ITEM =
  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-meta transition-colors duration-fast'

// 阴影由 `.glass-pop` 自带的 `--pop-shadow` 提供 —— 这里**不能**再挂 `shadow-[…]`：authored 的
// `.glass-pop` 排在 `@tailwind utilities` 之后，同特异度下源码序后者胜（死类）。
const POPOVER_SHELL = 'absolute bottom-full z-50 mb-1.5 rounded-[var(--r-ctl)] py-1 glass-pop'

// 🔴 几何写成 Tailwind **字面量类**、算式在 `composerToolsMenu.lib`：弹层挂在
// useExitAnimation 的 GSAP scope 上，其 reduced-motion 分支 `clearProps:'all'` 会清空内联
// style（实测：`style.left` 变空 → 二级叠在一级上面）。一致性闸在 composer_tools_menu.test.tsx。
const MENU_W_CLASS = 'w-[208px]'
const PANEL_W_CLASS = 'w-[268px]'
const FLYOUT_POS_CLASS = 'left-[214px] w-[268px]'

type ToolsView = 'root' | 'connectors' | 'skills'

/** 技能二级内容：一行一个 skill（名称 + 工具数 + 开关）。判据与设置页同一条后端位
 *  （`setSkillEnabled` → agent_config.db），成功后 invalidate `qk.skills()` —— 与设置页
 *  **同一个缓存键**，两处即时同步，不存在「这里开了、设置页还显示关」的分裂。 */
function SkillsQuickContent(): React.JSX.Element {
  const { t } = useTranslation()
  const api = useMailApi()
  const qc = useQueryClient()
  const [saving, setSaving] = React.useState<string | null>(null)

  // 🔴 这份 query 的 `enabled` 由**父组件的 open** 决定（见 useSkillRows）：菜单没开就不该
  // 为了一个 N/M 数字打请求。这里的组件挂载即代表二级已展开，直接读缓存。
  const { data: skills, isLoading } = useQuery<SkillSummary[]>({
    queryKey: qk.skills(),
    queryFn: () => api.chat.listSkills(),
    staleTime: 30_000,
    retry: false
  })

  async function handleToggle(skill: SkillSummary, next: boolean): Promise<void> {
    setSaving(skill.name)
    try {
      await api.chat.setSkillEnabled(skill.name, next)
      await qc.invalidateQueries({ queryKey: qk.skills() })
      toastSuccess(
        t('chat.tools.skillSaved', { name: skill.title }),
        // gateway 对 /chat/config 有 15s TTL：落库 ≠ 模型当场看得见。
        t('chat.tools.skillSavedDetail')
      )
    } catch (err) {
      toastError(t('chat.tools.skillSaveFailed'), errorMessage(err))
    } finally {
      setSaving(null)
    }
  }

  if (isLoading) {
    return <p className="px-3 py-3 text-micro text-ink-fg-3">{t('chat.tools.skillsLoading')}</p>
  }
  if (!skills || skills.length === 0) {
    return <p className="px-3 py-3 text-micro text-ink-fg-3">{t('chat.tools.skillsEmpty')}</p>
  }
  return (
    <div className="scrollbar-thin max-h-[280px] overflow-y-auto">
      {skills.map((skill) => (
        <div key={skill.name} className="flex items-center gap-2 px-3 py-1.5">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-meta font-medium text-ink-fg-1">
              {skill.title}
            </span>
            <span className="block truncate text-micro text-ink-fg-3">
              {skill.available
                ? t('settings.skills.toolCount', { n: skill.toolCount })
                : t('settings.skills.unavailable', { reason: skill.unavailableReason ?? '' })}
            </span>
          </span>
          <Switch
            checked={skill.enabled}
            // 不可用的技能（KOS 凭证缺失 / CLI 不在 …）开了也不会注册工具 —— 灰掉，
            // 别让用户以为自己打开了一个其实用不了的东西。
            disabled={!skill.available || saving === skill.name}
            onCheckedChange={(next) => void handleToggle(skill, next)}
            aria-label={`${t('settings.skills.enabled')} · ${skill.title}`}
            className="shrink-0"
          />
        </div>
      ))}
    </div>
  )
}

/** 一级行右侧的 `N/M` 摘要（未展开菜单不打请求：query 由 `enabled` 门控）。 */
function useSkillSummary(open: boolean): { enabled: number; total: number } | null {
  const api = useMailApi()
  const { data } = useQuery<SkillSummary[]>({
    queryKey: qk.skills(),
    queryFn: () => api.chat.listSkills(),
    enabled: open,
    staleTime: 30_000,
    retry: false
  })
  if (!data || data.length === 0) return null
  return { enabled: data.filter((s) => s.enabled && s.available).length, total: data.length }
}

export function ComposerToolsMenu({ variant }: { variant: 'icon' | 'chip' }): React.JSX.Element {
  const { t } = useTranslation()
  // 🔴 `useRouter({ warn: false })` 而不是 `useNavigate()`（抄 ModelPicker 的同款理由）：菜单
  // 的触发器一挂载就在树上，而两个 composer 的既有单测常常没有 RouterProvider —— useNavigate
  // 在无 router 时会 console.warn 三行并返回一个调用即炸的回调。拿不到 router 就把「AI 设置」
  // 那一行整个不渲染，不留一个点了会炸的入口。
  const router = useRouter({ warn: false })
  const [open, setOpen] = React.useState(false)
  const [view, setView] = React.useState<ToolsView>('root')
  // flyout = 量出来的可用宽度够并排（见文件头）。默认 false ⇒ 量不到（happy-dom / 首帧）
  // 一律走替换式，即收编前的行为。
  const [flyout, setFlyout] = React.useState(false)
  const ref = React.useRef<HTMLDivElement>(null)
  // 🔴 与 skill 摘要同一条纪律：**未展开不打请求**。触发器一挂载就在工具条上，这个 hook 若
  // 无条件跑，每渲染一次 composer 就是两发 loopback（flag + list）—— 复核实测
  // `composer_plus_menu.test.tsx` 一轮打 7 发。`enabled=false` 仍读共享缓存（设置页拉过就有
  // 数据），代价是常驻强调点降级成「知道了才亮」，见 useConnectorQuickRows 文件头。
  const connectors = useConnectorQuickRows(open)
  const skillSummary = useSkillSummary(open)

  const subOpen = open && view !== 'root'
  const { shouldRender, scopeRef: popRef } = useExitAnimation<HTMLDivElement>(open, {
    backdrop: false,
    from: { autoAlpha: 0, y: 4, scale: 0.98, transformOrigin: 'bottom left' },
    enterDuration: DUR.fast
  })
  // flyout 形态的二级是**独立弹层**（一级不换内容），所以它有自己的一份出入场；替换式形态下
  // 这份恒不渲染（`flyout &&` 守着），二级的进退场由一级那层承担。
  const { shouldRender: flyRender, scopeRef: flyRef } = useExitAnimation<HTMLDivElement>(
    flyout && subOpen,
    {
      backdrop: false,
      from: { autoAlpha: 0, y: 4, scale: 0.98, transformOrigin: 'bottom left' },
      enterDuration: DUR.fast
    }
  )

  // 🔴 view 复位放在**开**的那一侧（不在 close()）：接了退场动画之后，关闭时把 view 拨回
  // 'root' 会让二级面板在淡出的 120ms 里当场变回一级菜单（ComposerPlusMenu 的同款教训，
  // ConnectorQuickPanel.test.tsx 有专门的时序闸钉它）。
  const close = React.useCallback((): void => setOpen(false), [])
  const toggle = React.useCallback((): void => {
    if (open) {
      close()
    } else {
      setView('root')
      setOpen(true)
    }
  }, [open, close])

  // 量可用宽度：从本弹层的左锚点到 composer 容器右缘还剩多少。容器取 composer 的 form
  // （两个 composer 的 ComposerPrimitive.Root 都是 form），拿不到就退到 offsetParent。
  // 侧栏可拖宽（320↔720），所以开着的时候用 ResizeObserver 跟着量。
  React.useLayoutEffect(() => {
    if (!open) return undefined
    const wrap = ref.current
    if (!wrap) return undefined
    const host = (wrap.closest('form') ?? wrap.offsetParent) as HTMLElement | null
    if (!host) return undefined
    const measure = (): void => {
      const room = host.getBoundingClientRect().right - wrap.getBoundingClientRect().left
      setFlyout(toolsFlyoutFits(room))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    return (): void => ro.disconnect()
  }, [open])

  React.useEffect(() => {
    if (!open) return undefined
    // 二级在 flyout 形态下仍是本子树里的兄弟节点（没 portal），所以单 ref `contains` 仍然
    // 是对的判据 —— 这是文件头那条「不 portal」决定省下的坑之一。
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    // Escape 收整个弹层（两级都收）；回上一级走面板里的「返回」钮 —— 兄弟 picker 全是
    // 「Escape = 关」，独创「Escape = 回上一级」只会让肌肉记忆落空。
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return (): void => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  const label = t('chat.tools.label')
  const connectorsLabel = t('chat.connectors.label')
  const skillsLabel = t('chat.tools.skills')
  const subLabel = view === 'connectors' ? connectorsLabel : skillsLabel
  const tipText = connectors.anyActive ? `${label} · ${t('chat.connectors.activeHint')}` : label

  const openSettings = (): void => {
    if (!router) return
    close()
    void router.navigate({ to: '/settings', search: { tab: 'ai' } })
    scrollToAnchorWhenReady(AI_TAB_ANCHOR_IDS.skills)
  }

  const connectorSummary =
    connectors.rows.length > 0
      ? {
          enabled: connectors.rows.filter((c) => c.enabled && c.status === 'connected').length,
          total: connectors.rows.length
        }
      : null

  // 08-06 owner dogfood ③ —— **触发器上那颗 coral 常驻点已删**（原 `data-testid="tools-connector-dot"`）。
  // owner 原话：「快捷配置那里不要有 connector 就带固定右上角高亮点，会有误解，高亮点是用作提示的，
  // 很容易导致用户频繁点开。」病根是**语义借用**：本 app 的角标点一贯表示「有新东西值得看」
  // （会话未读点、审批待办），而这里表达的是「有 connector 处于启用态」这个**常态** —— 一旦连上
  // 就永远亮着，把一个没有新信息的入口训练成需要反复点开的东西。
  // 「接着什么」这件事仍然可知：hover 文案（activeHint）+ 菜单里那行 `N/M` 摘要，两处都是**要去看
  // 才出现**的，不抢注意力。
  const triggerBody = <SlidersHorizontal size={variant === 'icon' ? 13 : 15} strokeWidth={2} />

  const trigger = (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      aria-expanded={open}
      aria-haspopup="menu"
      className={cn(
        variant === 'icon'
          ? ICON_BTN
          : 'grid size-7 shrink-0 place-items-center rounded-full transition-[color,background-color,transform] duration-fast',
        open
          ? 'bg-coral/10 text-coral active:scale-[0.96]'
          : 'text-ink-fg-2 hover:bg-ink-4 hover:text-ink-fg active:scale-[0.96]'
      )}
    >
      {triggerBody}
    </button>
  )

  /** 一级行：图标 + 名称 + `N/M` 摘要 + 展开箭头。
   *  08-06 ③：这行原来在摘要右边还挂一颗同款 coral 点（判据也是 `connectors.anyActive`）——
   *  与触发器上那颗一起删。它与紧挨着的 `N/M` 说的是同一件事，而 `2/3` 既更准也不冒充「有新东西」。 */
  const row = (
    id: ToolsView,
    Icon: typeof Blocks,
    text: string,
    summary: { enabled: number; total: number } | null
  ): React.JSX.Element => (
    <button
      type="button"
      role="menuitem"
      // 🔴 显式 aria-label：否则可及名会把「N/M」摘要拼进去（读屏念成「外部连接 2/3」，
      // 且测试按名取元素时会随摘要漂移）。
      aria-label={text}
      aria-haspopup="dialog"
      aria-expanded={view === id}
      onClick={() => setView(id)}
      className={cn(
        MENU_ITEM,
        // flyout 形态下一级仍在屏幕上 → 当前展开的那一行高亮（否则看不出二级是谁的）；
        // 替换式形态下一级已被换掉，高亮无处可显，也就不上色。
        view === id && flyout
          ? 'bg-coral/10 font-medium text-coral'
          : 'text-ink-fg-1 hover:bg-ink-4 hover:text-ink-fg'
      )}
    >
      <Icon size={13} strokeWidth={2} className="shrink-0 text-ink-fg-3" />
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {summary !== null && (
        <span className="shrink-0 text-micro tabular-nums text-ink-fg-3">
          {t('chat.tools.summary', { enabled: summary.enabled, total: summary.total })}
        </span>
      )}
      <ChevronRight size={12} strokeWidth={2} className="shrink-0 text-ink-fg-3" />
    </button>
  )

  const subContent =
    view === 'connectors' ? (
      <ConnectorQuickContent rows={connectors.rows} onClose={close} />
    ) : (
      <SkillsQuickContent />
    )

  return (
    // 定宽图标钮 → shrink-0（同 EffortPicker 的注释）：窄宽度下该被压的是旁边的模型 / 授权 chip。
    <div className="relative shrink-0" ref={ref}>
      <HoverTip text={tipText} side="top">
        {trigger}
      </HoverTip>
      {shouldRender && (
        <div
          ref={popRef}
          role={flyout || view === 'root' ? 'menu' : 'dialog'}
          aria-label={flyout || view === 'root' ? label : subLabel}
          className={cn(
            POPOVER_SHELL,
            'left-0',
            flyout || view === 'root' ? MENU_W_CLASS : PANEL_W_CLASS
          )}
        >
          {flyout || view === 'root' ? (
            <>
              {connectors.available && row('connectors', Blocks, connectorsLabel, connectorSummary)}
              {row('skills', Puzzle, skillsLabel, skillSummary)}
              {router && (
                <div className="mt-1 border-t border-ink-border-soft pt-1">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={openSettings}
                    className={cn(MENU_ITEM, 'text-ink-fg-2 hover:bg-ink-4 hover:text-ink-fg')}
                  >
                    <span className="min-w-0 flex-1 truncate">{t('chat.tools.settingsLink')}</span>
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              {/* 替换式（窄面板）：二级顶上是返回钮，回一级仍在同一颗触发器上。 */}
              <div className="mb-1 flex items-center gap-1 border-b border-ink-border-soft px-1.5 pb-1">
                <button
                  type="button"
                  onClick={() => setView('root')}
                  aria-label={t('chat.composer.back')}
                  className="grid size-5 shrink-0 place-items-center rounded-[var(--r-ctl)] text-ink-fg-3 transition-colors duration-fast hover:bg-ink-4 hover:text-ink-fg"
                >
                  <ChevronLeft size={13} strokeWidth={2} />
                </button>
                <span className="truncate text-meta font-medium text-ink-fg-1">{subLabel}</span>
              </div>
              {subContent}
            </>
          )}
        </div>
      )}
      {flyout && flyRender && (
        <div
          ref={flyRef}
          role="dialog"
          aria-label={subLabel}
          // 并排：贴着一级的右缘长出来（同一个 relative 容器里的绝对定位兄弟，见文件头
          // 「不 portal」的理由）。
          className={cn(POPOVER_SHELL, FLYOUT_POS_CLASS)}
        >
          <div className="mb-1 border-b border-ink-border-soft px-3 pb-1">
            <span className="truncate text-meta font-medium text-ink-fg-1">{subLabel}</span>
          </div>
          {subContent}
        </div>
      )}
    </div>
  )
}
