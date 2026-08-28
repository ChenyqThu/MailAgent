// 场景：Agents 页 / 日历 / 设置页（盘点 §B 编号 32-47）+ 末尾「不建议直接迁」小节。

import { useState } from 'react'
import { Archive, ArchiveRestore, FolderPlus, Pencil, Pin, RefreshCw, Trash2 } from 'lucide-react'

import type { PopmenuItem } from '@shared/components/ui/Popmenu'

import { MenuDemo, RichRow, ShowcaseCard, ShowcaseNote, ShowcaseSection } from './ShowcaseKit'

function SessionRowMenuScene(): React.ReactElement {
  return (
    <MenuDemo
      ariaLabel="更多"
      width={168}
      // 全仓唯一 side="right" 的菜单：Popmenu 用 anchorClassName 表达，不需要新 API。
      anchorClassName="left-[calc(100%+0.375rem)] top-0"
      label="⋯ 会话行菜单"
      items={[
        {
          kind: 'action',
          id: 'rename',
          label: '重命名',
          icon: <Pencil size={14} />,
          onSelect: () => undefined
        },
        {
          kind: 'action',
          id: 'pin',
          label: '置顶',
          icon: <Pin size={14} />,
          onSelect: () => undefined
        },
        {
          kind: 'action',
          id: 'archive',
          label: '归档',
          icon: <Archive size={14} />,
          onSelect: () => undefined
        },
        {
          kind: 'action',
          id: 'restore',
          label: '恢复',
          icon: <ArchiveRestore size={14} />,
          disabled: true,
          onSelect: () => undefined
        },
        { kind: 'separator', id: 'sep' },
        {
          kind: 'action',
          id: 'del',
          label: '删除',
          icon: <Trash2 size={14} />,
          tone: 'danger',
          onSelect: () => undefined
        }
      ]}
    />
  )
}

const CALENDARS = [
  { name: '工作', dot: 'bg-info' },
  { name: '个人', dot: 'bg-ok' },
  { name: '会议邀请', dot: 'bg-urg' },
  { name: '节假日', dot: 'bg-low' }
]

function CalendarFilterScene(): React.ReactElement {
  const [sel, setSel] = useState<string[]>([])
  return (
    <MenuDemo
      ariaLabel="日历筛选"
      width={224}
      label={sel.length === 0 ? '全部日历' : `${sel.length} 个日历`}
      items={[
        {
          kind: 'radio',
          id: 'all',
          label: '全部日历',
          checked: sel.length === 0,
          onSelect: () => setSel([])
        },
        { kind: 'separator', id: 'sep' },
        ...CALENDARS.map(
          (c): PopmenuItem => ({
            kind: 'checkbox',
            id: c.name,
            label: c.name,
            checked: sel.includes(c.name),
            dotClassName: c.dot,
            onToggle: () =>
              setSel((p) => (p.includes(c.name) ? p.filter((x) => x !== c.name) : [...p, c.name]))
          })
        )
      ]}
    />
  )
}

const DAY_EVENTS = [
  { id: 'e1', time: '09:30', title: 'Q3 渠道复盘', dot: 'bg-info' },
  { id: 'e2', time: '11:00', title: 'DavMail 迁移站会', dot: 'bg-ok' },
  { id: 'e3', time: '14:00', title: '未命名事件', dot: 'bg-ink-fg-3' },
  { id: 'e4', time: '全天', title: '公司年会', dot: 'bg-urg' }
]

function MonthMoreScene(): React.ReactElement {
  return (
    <MenuDemo
      ariaLabel="8 月 5 日"
      title="8 月 5 日"
      width={256}
      maxHeight={220}
      label="+4 更多"
      items={DAY_EVENTS.map(
        (e): PopmenuItem => ({
          kind: 'custom',
          id: e.id,
          content: (
            <RichRow
              lead={<span className={`h-1.5 w-1.5 rounded-full ${e.dot}`} aria-hidden />}
              primary={
                <>
                  <span className="mr-1.5 font-mono text-xs text-ink-fg-2">{e.time}</span>
                  {e.title}
                </>
              }
            />
          )
        })
      )}
    />
  )
}

const SYNC_ROWS: readonly [string, string][] = [
  ['bridge', 'DavMail · :1080'],
  ['last_full_sync', '2026-08-05 09:41:02'],
  ['ctag', '7f3a91c2'],
  ['window', '−30d / +180d'],
  ['schema', 'calendar_event v15'],
  ['calendar', '工作 + 3']
]

function SyncPopScene(): React.ReactElement {
  return (
    <MenuDemo
      ariaLabel="同步与后台详情"
      title="同步与后台"
      width={288}
      anchorClassName="left-0 bottom-[calc(100%+0.375rem)]"
      label="同步与后台"
      render={() => (
        <dl className="flex flex-col gap-1 px-1 py-0.5">
          {SYNC_ROWS.map(([k, v]) => (
            <div key={k} className="flex items-baseline gap-2">
              <dt className="w-[112px] flex-none font-mono text-[11px] text-ink-fg-3">{k}</dt>
              <dd className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-fg-1">{v}</dd>
            </div>
          ))}
        </dl>
      )}
    />
  )
}

const MODEL_IDS = ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5', 'gpt-5.5']

function EnabledModelsScene(): React.ReactElement {
  const [on, setOn] = useState<string[]>(['claude-fable-5'])
  return (
    <MenuDemo
      ariaLabel="启用模型列表"
      title="启用模型列表"
      width={280}
      maxHeight={280}
      label={on.length === 0 ? '全部默认' : `已启用 ${on.length} 个模型`}
      items={[
        {
          kind: 'action',
          id: 'refresh',
          label: '刷新模型列表',
          icon: <RefreshCw size={13} />,
          // 「留在原地继续操作」的行 —— 基座默认 action 点完关，这里 opt-out。
          keepOpen: true,
          onSelect: () => undefined
        },
        { kind: 'separator', id: 'sep' },
        ...MODEL_IDS.map(
          (m): PopmenuItem => ({
            kind: 'checkbox',
            id: m,
            label: m,
            checked: on.includes(m),
            onToggle: () => setOn((p) => (p.includes(m) ? p.filter((x) => x !== m) : [...p, m]))
          })
        )
      ]}
    />
  )
}

function TitleModelScene(): React.ReactElement {
  const [v, setV] = useState('claude-sonnet-4-6')
  return (
    <MenuDemo
      ariaLabel="标题模型"
      width={240}
      label={v}
      items={MODEL_IDS.map(
        (m): PopmenuItem => ({
          kind: 'radio',
          id: m,
          label: m,
          checked: v === m,
          onSelect: () => setV(m)
        })
      )}
    />
  )
}

const TEMPLATES: readonly { group: string; items: readonly string[] }[] = [
  { group: 'anthropic', items: ['Anthropic', '自定义 Anthropic-compatible'] },
  { group: 'openai', items: ['OpenAI'] },
  { group: 'google', items: ['Google Gemini'] },
  { group: 'deepseek', items: ['DeepSeek'] },
  {
    group: 'openai-compatible',
    items: [
      '通义千问 DashScope',
      '智谱 GLM',
      'Moonshot Kimi',
      'MiniMax',
      '豆包方舟',
      'SiliconFlow',
      '自定义 OpenAI-compatible'
    ]
  },
  { group: 'openrouter', items: ['OpenRouter'] }
]

function TemplateSelectScene(): React.ReactElement {
  const [v, setV] = useState('Anthropic')
  return (
    <MenuDemo
      ariaLabel="模板"
      width={272}
      maxHeight={320}
      label={v}
      items={TEMPLATES.flatMap((g): PopmenuItem[] => [
        { kind: 'label', id: `g-${g.group}`, label: g.group },
        ...g.items.map(
          (it): PopmenuItem => ({
            kind: 'radio',
            id: it,
            label: it,
            checked: v === it,
            closeOnSelect: true,
            onSelect: () => setV(it)
          })
        )
      ])}
    />
  )
}

function FolderMenuScene(): React.ReactElement {
  return (
    <MenuDemo
      ariaLabel="管理文件夹"
      width={176}
      label="⋯ 管理文件夹"
      items={[
        {
          kind: 'action',
          id: 'new',
          label: '新建子文件夹',
          icon: <FolderPlus size={14} />,
          onSelect: () => undefined
        },
        {
          kind: 'action',
          id: 'rename',
          label: '重命名',
          icon: <Pencil size={14} />,
          onSelect: () => undefined
        },
        { kind: 'separator', id: 'sep' },
        {
          kind: 'action',
          id: 'del',
          label: '删除',
          icon: <Trash2 size={14} />,
          tone: 'danger',
          onSelect: () => undefined
        }
      ]}
    />
  )
}

export function RestScenes(): React.ReactElement {
  return (
    <>
      <ShowcaseSection id="agents" title="Agents 页" hint="盘点 32-35">
        <ShowcaseCard
          code="32"
          name="会话行 ⋯ 菜单"
          status="现状：#1（Radix Popover）side=right —— 全仓唯一一个向右展开的；trigger 是 opacity-0 group-hover，open 时要强制可见。"
          note="side=right 用 anchorClassName 就够（无需新 API）。但「open 时 trigger 强制可见」需要调用方自己拿 open 态 —— MenuDemo 这里用 data-open 属性驱动，真迁移时同理。"
        >
          <SessionRowMenuScene />
        </ShowcaseCard>
      </ShowcaseSection>

      <ShowcaseSection id="calendar" title="日历" hint="盘点 36-41">
        <ShowcaseCard
          code="36"
          name="日历筛选"
          status="现状：#8 z-30，menuitemcheckbox 多选 + 互斥「全部」；无键盘导航。"
          note="互斥「全部日历」用 radio 行 + separator 表达（真实实现是 menuitemcheckbox）。⚠️ 真实实现的行**没有**色点、也没有数量 —— 这里的色点是为了演示 dotClassName，迁移时按现状取舍。"
        >
          <CalendarFilterScene />
        </ShowcaseCard>

        <ShowcaseCard
          code="37"
          name="月视图 +N 更多"
          status="现状：#7 + .more-pop，全仓唯一自实现垂直 flip（240-268）；三 ref 合并 + useFocusTrap。"
          note="🔴 基座只做横向夹取 + 纵向按可用空间压 max-height，**没有垂直翻转**。月视图底部那几行迁过去会退化成「面板内滚动」而不是向上翻 —— 这条要 owner 拍板接受还是给基座补 flip。"
        >
          <MonthMoreScene />
        </ShowcaseCard>

        <ShowcaseCard
          code="40"
          name="状态栏同步详情"
          status="现状：#13（CSS-only :hover 浮层），bottom 写死向上。"
          note="换成点击触发即可键盘可达；向上展开同样是 anchorClassName（bottom-[calc(100%+…)]）。"
        >
          <SyncPopScene />
        </ShowcaseCard>
      </ShowcaseSection>

      <ShowcaseSection
        id="settings"
        title="设置页"
        hint="盘点 42-47 · 现状 #1 / #2（Radix Select）为主"
      >
        <ShowcaseCard
          code="42"
          name="启用模型多选"
          status="现状：#1，trigger 手抄了一串 SelectTrigger 类名字符串（294-302）。"
          note="刷新行用 keepOpen 的 action —— 基座默认「action 点完关」，这类留在原地的行必须显式 opt-out。"
        >
          <EnabledModelsScene />
        </ShowcaseCard>

        <ShowcaseCard
          code="43"
          name="标题模型 Select"
          status="现状：#2（Radix Select），含孤儿值兜底（当前值不在列表时追加一项）。"
          note="⚠️ Radix Select 家族共 14 处：它们自带 typeahead（敲首字母跳选项）和「选中项对齐触发器」定位，基座都没有。批量迁 Select 前建议先确认这两条没人依赖。"
        >
          <TitleModelScene />
        </ShowcaseCard>

        <ShowcaseCard
          code="44"
          name="Provider 模板 Select"
          status="现状：#2，260px 单选组（13 项）。"
          note="这里按 protocol 分了组（真实实现是平铺 + 行尾 protocol 标注）—— label 行是基座自带的，顺手能把长列表收拾清楚。"
        >
          <TemplateSelectScene />
        </ShowcaseCard>

        <ShowcaseCard
          code="47"
          name="文件夹管理 ⋯"
          status="现状：#8，z-20 实心 bg-ink-1（全仓第 5 种材质）；无 outside-click 无 Esc；在长树的滚动容器里。"
          note="🔴 基座是 absolute 不 portal：留在滚动容器里能自然跟随滚动（好），但父级一旦 overflow:hidden 就会被裁。迁 FolderPicker 前要确认那棵树的容器只是 overflow-y:auto。"
        >
          <FolderMenuScene />
        </ShowcaseCard>
      </ShowcaseSection>

      <ShowcaseSection
        id="boundary"
        title="不建议直接迁 / 需专门适配"
        hint="以下不在本次统一迁移范围内"
      >
        <ShowcaseNote
          code="33"
          name="assistant-ui Unstable_TriggerPopover（Agents @ / slash）"
          reason="行为整个在库里（trigger 解析、定位、键盘都由 assistant-ui 拥有）。换基座 = 重写 AgentComposer 的 trigger 适配层，属于独立一件事，不该混进这一批。"
        />
        <ShowcaseNote
          code="35"
          name="418 项 IANA 时区原生 select（ScheduleBuilder）"
          reason="代码注释里写明「故意用原生」：418 个 option 在自绘弹层里必须虚拟化才不掉帧，而基座是纯 DOM 列表。没有虚拟化方案之前不能动。"
        />
        <ShowcaseNote
          code="19 / 20"
          name="TipTap slash / @mention 菜单"
          reason="锚点是 caret rect，不是 DOM 元素 —— 基座的 absolute + triggerRef 模型接不上。壳可以换（形态见上面 19/20 卡），但要先给基座加一种「virtual anchor」定位。"
        />
        <ShowcaseNote
          code="22"
          name="模型能力卡（hover 跟随）"
          reason="三条硬要求同时不成立：必须 portal（双层 overflow hidden）、必须 pointer-events-none（否则会把模型选择器 outside-click 误关）、必须锚在弹层底边而不是某个 trigger。它是 hover 卡不是菜单。"
        />
        <ShowcaseNote
          code="49 / 27"
          name="hover tooltip 家族（HoverTip 22 处 + Radix Tooltip 1 处）"
          reason="Popmenu 是「点击打开、吃焦点、role=menu」的菜单基座；tooltip 是「hover 显示、绝不吃焦点」。合并会把 tooltip 变成可聚焦元素。要不要把 HoverTip 与 Radix Tooltip 双轨收成一套，是另一件事。"
        />
        <ShowcaseNote
          code="48"
          name="Onboarding 的原生 select ×2"
          reason="onboarding 是独立渲染入口、不吃主 index.css 的 token，迁过去会一起把整套主题变量拖进去。优先级最低。"
        />
        <ShowcaseNote
          code="38 / 39"
          name="CSS-only :hover 浮层（.cal-legend-tip）"
          reason="恒挂载、零 JS。换成受控组件是净增运行时成本；键盘可达已用 :focus-within 解决。"
        />
      </ShowcaseSection>
    </>
  )
}
