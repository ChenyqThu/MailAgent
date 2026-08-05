// 场景：TitleBar / Sidebar / 邮件列表 / 邮件工具栏（盘点 §B 编号 1-10）。
// 文案与选项顺序照抄各自现实现，仅把承载它们的弹层换成 Popmenu。

import { useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Archive,
  CornerUpLeft,
  Forward,
  Info,
  Mail,
  Monitor,
  Moon,
  Plus,
  ReplyAll,
  ShieldAlert,
  Sun
} from 'lucide-react'

import type { PopmenuItem } from '@shared/components/ui/Popmenu'
import { cn } from '@shared/lib/cn'

import { MenuDemo, RichRow, ShowcaseCard, ShowcaseSection } from './ShowcaseKit'

const ACCENTS = [
  'coral',
  'cobalt',
  'teal',
  'rose',
  'slate',
  'olive',
  'amber',
  'emerald',
  'violet'
] as const

function AccentScene(): React.ReactElement {
  const [accent, setAccent] = useState<string>('coral')
  return (
    <MenuDemo
      ariaLabel="强调色"
      title="强调色"
      width={264}
      label={
        <>
          <span className={cn('h-3 w-3 rounded-full', `swatch-${accent}`)} aria-hidden />
          强调色
        </>
      }
      items={(close) => [
        {
          kind: 'custom',
          id: 'grid',
          content: (
            <div className="grid grid-cols-3 gap-3 py-1" role="radiogroup" aria-label="强调色">
              {ACCENTS.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={accent === id}
                  aria-label={id}
                  title={id}
                  className={cn('swatch', `swatch-${id}`)}
                  onClick={() => {
                    setAccent(id)
                    close()
                  }}
                />
              ))}
            </div>
          )
        },
        { kind: 'separator', id: 'sep' },
        {
          kind: 'custom',
          id: 'note',
          content: (
            <p className="text-xs leading-snug text-ink-fg-3">
              影响工具栏 · 标签 · 选中行 · 灵动岛 · 仅本机保存
            </p>
          )
        }
      ]}
    />
  )
}

function SurfaceScene(): React.ReactElement {
  const [surface, setSurface] = useState<'frosted' | 'solid'>('frosted')
  const opts = [
    { id: 'frosted', label: '磨砂' },
    { id: 'solid', label: '实色' }
  ] as const
  return (
    <MenuDemo
      ariaLabel="界面材质"
      title="界面材质"
      width={220}
      label={
        <>
          <span className={cn('surface-swatch', `surface-swatch-${surface}`)} aria-hidden />
          {surface === 'frosted' ? '磨砂' : '实色'}
        </>
      }
      items={[
        ...opts.map(
          (o): PopmenuItem => ({
            kind: 'radio',
            id: o.id,
            label: o.label,
            checked: surface === o.id,
            icon: <span className={cn('surface-swatch', `surface-swatch-${o.id}`)} aria-hidden />,
            onSelect: () => setSurface(o.id)
          })
        ),
        { kind: 'separator', id: 'sep' },
        {
          kind: 'custom',
          id: 'note',
          content: (
            <p className="text-xs leading-snug text-ink-fg-3">
              影响 chrome 与所有面板的背景 · 仅本机保存
            </p>
          )
        }
      ]}
    />
  )
}

function ThemeScene(): React.ReactElement {
  const [theme, setTheme] = useState('system')
  const opts = [
    { id: 'system', label: '跟随系统', icon: <Monitor size={14} /> },
    { id: 'light', label: '浅色', icon: <Sun size={14} /> },
    { id: 'dark', label: '深色', icon: <Moon size={14} /> }
  ]
  return (
    <MenuDemo
      ariaLabel="主题"
      width={200}
      label="主题"
      items={opts.map(
        (o): PopmenuItem => ({
          kind: 'radio',
          id: o.id,
          label: o.label,
          checked: theme === o.id,
          icon: o.icon,
          onSelect: () => setTheme(o.id)
        })
      )}
    />
  )
}

const ALERTS = [
  {
    id: 'a1',
    level: 'critical' as const,
    title: 'DavMail token 即将失效',
    message: 'refresh_token 已 89 天未轮换，到期后同步会整链停摆。',
    source: 'davmail',
    time: '09:41'
  },
  {
    id: 'a2',
    level: 'warning' as const,
    title: 'outbox 积压 24 条',
    message: 'FanoutWorker 最近一轮派发耗时 12.4s。',
    source: 'outbox',
    time: '09:12'
  },
  {
    id: 'a3',
    level: 'info' as const,
    title: '雷达轮询恢复',
    message: 'STATUS (UIDNEXT) 往返回到 180ms。',
    source: 'radar',
    time: '08:55'
  }
]

function AlertScene(): React.ReactElement {
  return (
    <MenuDemo
      ariaLabel="系统告警"
      title="系统告警"
      width={300}
      maxHeight={320}
      label={
        <>
          <AlertTriangle size={13} className="text-warn" />
          系统告警
          <span className="rounded bg-fail/15 px-1 font-mono text-[11px] text-fail">1</span>
        </>
      }
      items={[
        ...ALERTS.map(
          (a): PopmenuItem => ({
            kind: 'custom',
            id: a.id,
            content: (
              <RichRow
                lead={
                  a.level === 'critical' ? (
                    <ShieldAlert size={14} className="text-fail" />
                  ) : a.level === 'warning' ? (
                    <AlertTriangle size={14} className="text-warn" />
                  ) : (
                    <Info size={14} className="text-ink-fg-2" />
                  )
                }
                primary={a.title}
                secondary={a.message}
                trailing={
                  <span className="flex-none font-mono text-[11px] text-ink-fg-3">
                    {a.source} · {a.time}
                  </span>
                }
              />
            )
          })
        ),
        { kind: 'separator', id: 'sep' },
        {
          kind: 'action',
          id: 'board',
          label: '前往系统看板',
          icon: <ArrowRight size={14} />,
          hint: '更新于 09:41',
          onSelect: () => undefined
        }
      ]}
    />
  )
}

function PendingScene(): React.ReactElement {
  const runs = [
    { id: 'r1', title: '每日安全巡检', age: '3 分钟前' },
    { id: 'r2', title: '周报汇总 Agent', age: '1 小时前' }
  ]
  return (
    <MenuDemo
      ariaLabel="待审批执行"
      title="待审批执行"
      width={300}
      label={
        <>
          待审批执行
          <span className="rounded bg-coral/15 px-1 font-mono text-[11px] text-coral">2</span>
        </>
      }
      items={runs.map(
        (r): PopmenuItem => ({
          kind: 'custom',
          id: r.id,
          content: (
            <RichRow
              lead={<span className="h-1.5 w-1.5 rounded-full bg-fail" aria-hidden />}
              primary={r.title}
              secondary={r.age}
            />
          )
        })
      )}
    />
  )
}

function AccountScene(): React.ReactElement {
  return (
    <div className="w-[220px] rounded-[var(--r-card)] border border-ink-border-soft bg-ink-1 p-2">
      <MenuDemo
        ariaLabel="账户"
        width={204}
        anchorClassName="left-0 top-[calc(100%+0.375rem)]"
        triggerClassName="w-full justify-between"
        label={
          <>
            <span className="truncate">chenyq</span>
            <span className="rounded bg-coral/15 px-1 font-mono text-[11px] text-coral">EX</span>
          </>
        }
        items={[
          {
            kind: 'radio',
            id: 'acct-1',
            label: 'chenyq',
            checked: true,
            hint: 'Exchange',
            onSelect: () => undefined
          },
          { kind: 'separator', id: 'sep' },
          {
            kind: 'action',
            id: 'add',
            label: '添加账户...',
            icon: <Plus size={13} />,
            onSelect: () => undefined
          }
        ]}
      />
    </div>
  )
}

function NestedDepthScene(): React.ReactElement {
  const [pick, setPick] = useState('近 7 天')
  return (
    <MenuDemo
      ariaLabel="多级下钻"
      width={260}
      label="三级下钻"
      items={[
        {
          kind: 'submenu',
          id: 'time',
          label: '时间范围',
          hint: pick,
          items: [
            {
              kind: 'submenu',
              id: 'rel',
              label: '相对时间',
              items: [
                {
                  kind: 'radio',
                  id: 'd7',
                  label: '近 7 天',
                  checked: pick === '近 7 天',
                  onSelect: () => setPick('近 7 天')
                },
                {
                  kind: 'radio',
                  id: 'd30',
                  label: '近 30 天',
                  checked: pick === '近 30 天',
                  onSelect: () => setPick('近 30 天')
                },
                {
                  kind: 'submenu',
                  id: 'more',
                  label: '更长区间',
                  items: [
                    {
                      kind: 'radio',
                      id: 'd90',
                      label: '近 90 天',
                      checked: pick === '近 90 天',
                      onSelect: () => setPick('近 90 天')
                    },
                    {
                      kind: 'radio',
                      id: 'y1',
                      label: '近一年',
                      checked: pick === '近一年',
                      onSelect: () => setPick('近一年')
                    }
                  ]
                }
              ]
            },
            {
              kind: 'radio',
              id: 'all',
              label: '不限',
              checked: pick === '不限',
              onSelect: () => setPick('不限')
            }
          ]
        },
        {
          kind: 'submenu',
          id: 'pri',
          label: '优先级',
          hint: '3/5',
          items: [
            {
              kind: 'action',
              id: 'all-pri',
              label: '全选',
              keepOpen: true,
              onSelect: () => undefined
            },
            { kind: 'separator', id: 'sep' },
            {
              kind: 'checkbox',
              id: 'crit',
              label: 'Critical',
              checked: true,
              count: 4,
              dotClassName: 'bg-crit',
              onToggle: () => undefined
            },
            {
              kind: 'checkbox',
              id: 'urg',
              label: 'Urgent',
              checked: true,
              count: 11,
              dotClassName: 'bg-urg',
              onToggle: () => undefined
            },
            {
              kind: 'checkbox',
              id: 'impt',
              label: 'Important',
              checked: true,
              count: 38,
              dotClassName: 'bg-impt',
              onToggle: () => undefined
            },
            {
              kind: 'checkbox',
              id: 'norm',
              label: 'Normal',
              checked: false,
              count: 402,
              dotClassName: 'bg-norm',
              onToggle: () => undefined
            },
            {
              kind: 'checkbox',
              id: 'low',
              label: 'Low',
              checked: false,
              count: 156,
              dotClassName: 'bg-low',
              onToggle: () => undefined
            }
          ]
        }
      ]}
    />
  )
}

function ReplySplitScene(): React.ReactElement {
  return (
    <MenuDemo
      ariaLabel="回复"
      width={200}
      align="start"
      label="回复 ⌄"
      items={[
        {
          kind: 'action',
          id: 'reply',
          label: '回复',
          icon: <CornerUpLeft size={14} />,
          shortcut: 'R',
          onSelect: () => undefined
        },
        {
          kind: 'action',
          id: 'reply-all',
          label: '回复所有',
          icon: <ReplyAll size={14} />,
          shortcut: '⇧R',
          onSelect: () => undefined
        },
        {
          kind: 'action',
          id: 'forward',
          label: '转发',
          icon: <Forward size={14} />,
          shortcut: 'F',
          onSelect: () => undefined
        }
      ]}
    />
  )
}

function MailRowActionsScene(): React.ReactElement {
  return (
    <MenuDemo
      ariaLabel="邮件操作"
      width={224}
      align="start"
      label="邮件操作（未上线形态）"
      items={[
        {
          kind: 'action',
          id: 'read',
          label: '标为已读',
          icon: <Mail size={14} />,
          shortcut: 'U',
          onSelect: () => undefined
        },
        {
          kind: 'action',
          id: 'archive',
          label: '归档',
          icon: <Archive size={14} />,
          shortcut: 'E',
          onSelect: () => undefined
        },
        { kind: 'separator', id: 'sep' },
        {
          kind: 'submenu',
          id: 'move',
          label: '移动到',
          items: [
            { kind: 'radio', id: 'f1', label: '收件箱', checked: true, onSelect: () => undefined },
            { kind: 'radio', id: 'f2', label: '存档', checked: false, onSelect: () => undefined },
            {
              kind: 'radio',
              id: 'f3',
              label: 'Projects/Omada',
              checked: false,
              onSelect: () => undefined
            }
          ]
        },
        { kind: 'separator', id: 'sep2' },
        { kind: 'action', id: 'del', label: '删除', tone: 'danger', onSelect: () => undefined }
      ]}
    />
  )
}

export function ShellScenes(): React.ReactElement {
  return (
    <>
      <ShowcaseSection
        id="titlebar"
        title="TitleBar"
        hint="盘点 1-5 · 现状实现 #6（portal + useExitAnimation）"
      >
        <ShowcaseCard
          code="01"
          name="强调色选择器"
          status="现状：portal 到 body（TitleBar 的 backdrop-filter 造 stacking context），3×3 色板无方向键。"
          note="迁移形态：custom 行装 3×3 网格。色板本身仍需自管焦点 —— custom 行不进基座的键盘序列。"
        >
          <AccentScene />
        </ShowcaseCard>

        <ShowcaseCard
          code="02"
          name="材质选择器"
          status="现状：宽 220 inline 覆盖 .theme-popover 的 264，与 01/03 三份复制的 outside-click + Esc。"
          note="迁移形态：radio 行 + icon 槽放 mini preview；宽度直接给 width prop。"
        >
          <SurfaceScene />
        </ShowcaseCard>

        <ShowcaseCard
          code="03"
          name="主题选择器"
          status="现状：同 01/02 的第 6 类实现，各自复制一份关闭逻辑。"
        >
          <ThemeScene />
        </ShowcaseCard>

        <ShowcaseCard
          code="04"
          name="系统告警详情"
          status="现状：role=dialog 但无 focus trap；富内容列表。"
          note="三行富内容用 custom；末尾「前往系统看板」是普通 action（可键盘到达）。"
        >
          <AlertScene />
        </ShowcaseCard>

        <ShowcaseCard
          code="05"
          name="Agent 待审批"
          status="现状：宽 320，开才拉的懒加载语义要保留。"
        >
          <PendingScene />
        </ShowcaseCard>
      </ShowcaseSection>

      <ShowcaseSection id="sidebar" title="Sidebar" hint="盘点 6-7">
        <ShowcaseCard
          code="06"
          name="账户切换"
          status="现状：#7（absolute 无 portal），用 left-2 right-2 stretch 到容器宽；折叠态另有专门 CSS。"
          note="🔴 基座缺口：width 只收 px 数，没有 stretch 模式。这里靠调用方硬传 204（容器 220 − 2×8）。真迁移建议给基座补 width: 'stretch'。"
        >
          <AccountScene />
        </ShowcaseCard>
      </ShowcaseSection>

      <ShowcaseSection id="maillist" title="邮件列表 / 邮件工具栏" hint="盘点 8-11">
        <ShowcaseCard
          code="08"
          name="筛选下钻菜单（已真实上线）"
          status="现状：已是 Popmenu 的第一个真实消费方（EmailListHeader，13 行 + 两级下钻 + 计数 + kbd）。"
          note="这里放的是一个三级下钻的缩微演示，用来看「无深度限制」这条能力 —— 真功能请直接在邮件列表头部的漏斗按钮上验。"
        >
          <NestedDepthScene />
        </ShowcaseCard>

        <ShowcaseCard
          code="10"
          name="回复分裂菜单"
          status="现状：#7，故意用实心 bg-ink-2 不用 glass-pop（半透明透正文发脏，EmailToolbar:411-414 注释）。"
          note="基座面板是 bg-popover(=ink-2) 实心，正好满足这条硬约束 —— 不需要 surface 开关。"
        >
          <ReplySplitScene />
        </ShowcaseCard>

        <ShowcaseCard
          code="—"
          name="行右键菜单（全仓尚无）"
          status="现状：仓库里 onContextMenu 零命中，邮件行没有上下文菜单。"
          note="基座的 action + danger + submenu 组合天然适配，附上一个形态草案供 owner 判断要不要顺手补。"
        >
          <MailRowActionsScene />
        </ShowcaseCard>
      </ShowcaseSection>
    </>
  )
}
