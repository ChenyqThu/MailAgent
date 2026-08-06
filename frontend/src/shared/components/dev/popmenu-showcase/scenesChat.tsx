// 场景：Chat / AI 面板 + Chat 浮窗（盘点 §B 编号 21-30）。
// 这一组是「手搓最多、越界最多」的重灾区（#8 裸 useState + absolute + 手写 document
// 监听共 8 处），也是迁移收益最大的一块。

import { useRef, useState } from 'react'
import {
  Blocks,
  Brain,
  Check,
  Eye,
  Loader,
  Mail,
  MessagesSquare,
  Paperclip,
  Search,
  Shield,
  ShieldAlert,
  Trash2,
  Wrench,
  X
} from 'lucide-react'

import { ProviderBrandIcon } from '@shared/components/icons/providers'
import { Popmenu, type PopmenuItem } from '@shared/components/ui/Popmenu'
import { Switch } from '@shared/components/ui/switch'
import { cn } from '@shared/lib/cn'

import { MenuDemo, RichRow, ShowcaseCard, ShowcaseSection } from './ShowcaseKit'

// ── 21 模型选择器 ────────────────────────────────────────────────────────
interface DemoModel {
  id: string
  name: string
  provider: string
  ctx: string
  caps: readonly ('vision' | 'tools' | 'reasoning')[]
}

const MODEL_GROUPS: readonly { provider: string; label: string; models: readonly DemoModel[] }[] = [
  {
    provider: 'anthropic',
    label: 'default（主网关）',
    models: [
      {
        id: 'claude-fable-5',
        name: 'Claude Fable 5',
        provider: 'anthropic',
        ctx: '1M',
        caps: ['vision', 'tools', 'reasoning']
      },
      {
        id: 'claude-opus-4-8',
        name: 'Claude Opus 4.8',
        provider: 'anthropic',
        ctx: '200K',
        caps: ['vision', 'tools', 'reasoning']
      },
      {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        provider: 'anthropic',
        ctx: '200K',
        caps: ['vision', 'tools']
      }
    ]
  },
  {
    provider: 'openai',
    label: 'OpenAI',
    models: [
      { id: 'gpt-5.5', name: 'GPT-5.5', provider: 'openai', ctx: '400K', caps: ['vision', 'tools'] }
    ]
  },
  {
    provider: 'deepseek',
    label: 'DeepSeek',
    models: [
      {
        id: 'deepseek-r2',
        name: 'DeepSeek R2',
        provider: 'deepseek',
        ctx: '128K',
        caps: ['tools', 'reasoning']
      }
    ]
  }
]

const CAP_META = {
  vision: { label: '视觉', cls: 'bg-info/15 text-info', icon: Eye },
  tools: { label: '工具', cls: 'bg-ok/15 text-ok', icon: Wrench },
  reasoning: { label: '推理', cls: 'bg-ai/15 text-ai', icon: Brain }
} as const

function ModelPickerScene(): React.ReactElement {
  const [active, setActive] = useState('claude-fable-5')
  const activeModel = MODEL_GROUPS.flatMap((g) => g.models).find((m) => m.id === active)

  return (
    <MenuDemo
      ariaLabel="切换模型"
      width={280}
      maxHeight={320}
      align="start"
      label={
        <>
          <ProviderBrandIcon providerId={activeModel?.provider} className="size-3.5" />
          {activeModel?.name}
        </>
      }
      items={(close) =>
        MODEL_GROUPS.flatMap((g): PopmenuItem[] => [
          { kind: 'label', id: `g-${g.provider}`, label: g.label },
          ...g.models.map(
            (m): PopmenuItem => ({
              kind: 'custom',
              id: m.id,
              content: (
                <RichRow
                  active={active === m.id}
                  lead={<ProviderBrandIcon providerId={m.provider} className="size-3.5" />}
                  primary={m.name}
                  trailing={
                    <span className="flex flex-none items-center gap-1">
                      {m.caps.map((c) => {
                        const Icon = CAP_META[c].icon
                        return (
                          <span
                            key={c}
                            title={CAP_META[c].label}
                            aria-label={CAP_META[c].label}
                            className={cn(
                              'inline-flex h-[15px] w-[15px] items-center justify-center rounded',
                              CAP_META[c].cls
                            )}
                          >
                            <Icon size={9} />
                          </span>
                        )
                      })}
                      <span className="rounded bg-ink-3 px-1 font-mono text-[11px] text-ink-fg-2">
                        {m.ctx}
                      </span>
                    </span>
                  }
                  onClick={() => {
                    setActive(m.id)
                    close()
                  }}
                />
              )
            })
          )
        ])
      }
    />
  )
}

// ── 23「+」菜单 + 二级 connector 面板 ───────────────────────────────────
const CONNECTORS = [
  { id: 'notion', name: 'Notion', status: '工具 6/9', enabled: true, dot: 'bg-ok' },
  { id: 'linear', name: 'Linear', status: '已连接', enabled: false, dot: 'bg-ok' },
  { id: 'jira', name: 'Jira', status: '授权已失效', enabled: false, dot: 'bg-fail' }
]

function PlusMenuScene(): React.ReactElement {
  const [enabled, setEnabled] = useState<Record<string, boolean>>({
    notion: true,
    linear: false,
    jira: false
  })
  return (
    <MenuDemo
      ariaLabel="添加"
      width={268}
      align="start"
      label="＋ 添加"
      items={[
        {
          kind: 'action',
          id: 'attach',
          label: '添加附件',
          icon: <Paperclip size={13} />,
          onSelect: () => undefined
        },
        {
          kind: 'submenu',
          id: 'connectors',
          label: '外部连接',
          icon: <Blocks size={13} />,
          hint: '1 已启用',
          items: [
            ...CONNECTORS.map(
              (c): PopmenuItem => ({
                kind: 'custom',
                id: c.id,
                content: (
                  <div className="flex items-center gap-2.5 px-2 py-1.5">
                    <span className={cn('h-1.5 w-1.5 flex-none rounded-full', c.dot)} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink-fg">
                        {c.name}
                      </span>
                      <span className="block truncate text-xs text-ink-fg-3">{c.status}</span>
                    </span>
                    <span className="text-xs text-ink-fg-2">管理</span>
                    <Switch
                      checked={enabled[c.id] === true}
                      onCheckedChange={(v) => setEnabled((p) => ({ ...p, [c.id]: v }))}
                      aria-label={`启用此连接 · ${c.name}`}
                    />
                  </div>
                )
              })
            ),
            { kind: 'separator', id: 'sep' },
            {
              kind: 'custom',
              id: 'hint',
              content: (
                <p className="text-xs leading-snug text-ink-fg-3">
                  只读工具直接调用；写入类工具每次都会弹卡请你确认。
                </p>
              )
            }
          ]
        }
      ]}
    />
  )
}

// ── 24 审批模式（选 bypass → 同面板换成危险确认；08-05 WP-11 acceptEdits 退役 → 二档） ──
const APPROVAL_MODES = [
  {
    id: 'manual',
    title: '手动授权',
    desc: '按每个工具的审批档决定弹不弹卡（默认；档位在 设置 → AI 调整）',
    Icon: Shield
  },
  { id: 'bypass', title: '完全授权', desc: '所有操作直接执行，不再询问', Icon: ShieldAlert }
] as const

function ApprovalModeScene(): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'list' | 'confirm'>('list')
  const [mode, setMode] = useState('manual')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const close = (): void => {
    setOpen(false)
    setView('list')
  }
  const current = APPROVAL_MODES.find((m) => m.id === mode)

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded-[var(--r-ctl)] border border-ink-border bg-ink-3 px-2.5 text-sm transition-colors duration-fast hover:bg-ink-4',
          mode === 'bypass' ? 'text-fail' : 'text-ink-fg'
        )}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {current !== undefined && <current.Icon size={13} />}
        {current?.title}
      </button>
      <Popmenu
        open={open}
        onClose={close}
        ariaLabel="授权模式"
        triggerRef={triggerRef}
        width={248}
        align="start"
      >
        {view === 'list' ? (
          <div role="radiogroup" aria-label="授权模式">
            {APPROVAL_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={mode === m.id}
                className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-fast hover:bg-ink-4"
                onClick={() => {
                  if (m.id === 'bypass') {
                    setView('confirm')
                    return
                  }
                  setMode(m.id)
                  close()
                }}
              >
                <m.Icon size={14} className="mt-0.5 flex-none text-ink-fg-2" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-ink-fg">{m.title}</span>
                  <span className="mt-0.5 block text-xs leading-snug text-ink-fg-3">{m.desc}</span>
                </span>
                <span
                  className={cn(
                    'mt-1 h-2 w-2 flex-none rounded-full',
                    mode === m.id ? 'bg-coral/100' : 'bg-ink-4'
                  )}
                  aria-hidden
                />
              </button>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-2 px-1 py-1">
            <div className="flex items-center gap-1.5 text-sm font-medium text-fail">
              <ShieldAlert size={14} />
              切换到完全授权？
            </div>
            <p className="text-xs leading-snug text-ink-fg-2">
              包括真实发信、本地命令执行、Skill
              安装与日历改动在内的所有操作都将不再弹卡确认，且对之后的所有会话生效。
            </p>
            <div className="flex items-center justify-end gap-1.5">
              <button
                type="button"
                className="h-7 rounded-[var(--r-ctl)] px-2 text-xs text-ink-fg-1 hover:bg-ink-3"
                onClick={() => setView('list')}
              >
                取消
              </button>
              <button
                type="button"
                className="h-7 rounded-[var(--r-ctl)] bg-fail px-2 text-xs text-accent-fg"
                onClick={() => {
                  setMode('bypass')
                  close()
                }}
              >
                确认切换
              </button>
            </div>
          </div>
        )}
      </Popmenu>
    </div>
  )
}

// ── 25 会话历史（富列表 + 内联删除二次确认） ─────────────────────────────
const SESSIONS = [
  { id: 's1', title: '把这封周报总结成三条', meta: 'Claude Fable 5 · 刚刚', unread: true },
  {
    id: 's2',
    title: '帮我查 outbox 积压的根因',
    meta: 'Claude Opus 4.8 · 2 小时前',
    unread: false
  },
  { id: 's3', title: 'Notion Agent · 更新本周日程', meta: 'Notion Agent · 昨天', unread: false }
]

function ChatHistoryScene(): React.ReactElement {
  const [confirming, setConfirming] = useState<string | null>(null)
  return (
    <MenuDemo
      ariaLabel="会话历史"
      title="Custom Agent · 最近会话"
      width={272}
      maxHeight={300}
      label="会话历史"
      render={() => (
        <div>
          <ul>
            {SESSIONS.map((s) => (
              <li key={s.id} className="group flex items-center gap-1">
                <RichRow
                  primary={
                    <>
                      {s.unread && (
                        <span
                          className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-coral/100 align-middle"
                          aria-label="有未读内容"
                        />
                      )}
                      {s.title}
                    </>
                  }
                  secondary={s.meta}
                />
                {confirming === s.id ? (
                  <span className="flex flex-none items-center gap-0.5 pr-1">
                    <button
                      type="button"
                      aria-label="确认删除 · 该操作不可撤销"
                      className="rounded bg-fail/15 p-1 text-fail"
                      onClick={() => setConfirming(null)}
                    >
                      <Check size={12} />
                    </button>
                    <button
                      type="button"
                      aria-label="取消"
                      className="rounded p-1 text-ink-fg-2 hover:bg-ink-4"
                      onClick={() => setConfirming(null)}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    aria-label="删除会话"
                    className="flex-none rounded p-1 text-ink-fg-3 opacity-0 transition-opacity duration-fast hover:bg-ink-4 hover:text-fail group-hover:opacity-100"
                    onClick={() => setConfirming(s.id)}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-1 border-t border-ink-border-soft pt-1.5 text-xs text-ink-fg-3">
            两个 Agent 不共享会话历史
          </p>
        </div>
      )}
    />
  )
}

// ── 26 @mention 邮件搜索（弹层内 input 拿焦点） ──────────────────────────
const MAILS = [
  { id: 53675, subject: 'Re: Q3 渠道复盘会议纪要', from: 'zhangwei@omadanetworks.com' },
  { id: 53612, subject: 'DavMail token 轮换通知', from: 'it-notify@omadanetworks.com' },
  { id: 53544, subject: '(无主题)', from: 'support@vendor.example' }
]

function MentionMailScene(): React.ReactElement {
  const [q, setQ] = useState('')
  const hits = MAILS.filter((m) => q === '' || m.subject.includes(q))
  return (
    <MenuDemo
      ariaLabel="引用邮件"
      width={288}
      maxHeight={260}
      align="start"
      label="＠ 引用邮件"
      render={() => (
        <div>
          <div className="mb-1 flex items-center gap-1.5 border-b border-ink-border-soft px-1 pb-1.5">
            <Search size={11} className="flex-none text-ink-fg-3" />
            <input
              autoFocus
              value={q}
              placeholder="按关键字搜索邮件…"
              aria-label="搜索要引用的邮件"
              className="min-w-0 flex-1 bg-transparent text-sm text-ink-fg outline-none placeholder:text-ink-fg-3"
              onChange={(e) => setQ(e.target.value)}
            />
            {q !== '' && <Loader size={11} className="flex-none animate-spin text-ink-fg-3" />}
          </div>
          {hits.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-ink-fg-3">未找到与「{q}」相关的邮件</p>
          ) : (
            <ul role="listbox" aria-label="引用邮件">
              {hits.map((m) => (
                <li key={m.id}>
                  <RichRow primary={m.subject} secondary={`${m.from} · #${m.id}`} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    />
  )
}

// ── 29 / 30 Chat 浮窗 ───────────────────────────────────────────────────
function ModeMenuScene(): React.ReactElement {
  const [mode, setMode] = useState('floating')
  return (
    <MenuDemo
      ariaLabel="切换显示模式"
      width={176}
      label="显示模式"
      items={[
        {
          kind: 'radio',
          id: 'floating',
          label: '悬浮窗',
          checked: mode === 'floating',
          onSelect: () => setMode('floating')
        },
        {
          kind: 'radio',
          id: 'sidebar',
          label: '侧边栏',
          checked: mode === 'sidebar',
          onSelect: () => setMode('sidebar')
        },
        { kind: 'separator', id: 'sep' },
        { kind: 'action', id: 'full', label: '全屏', onSelect: () => undefined }
      ]}
    />
  )
}

function ModalHistoryScene(): React.ReactElement {
  const rows: readonly {
    g: string
    items: readonly { id: string; label: string; mail: boolean }[]
  }[] = [
    {
      g: '今天',
      items: [
        { id: 'h1', label: 'Re: Q3 渠道复盘会议纪要', mail: true },
        { id: 'h2', label: '把 outbox 积压查一下', mail: false }
      ]
    },
    { g: '昨天', items: [{ id: 'h3', label: '周报草稿润色', mail: false }] },
    { g: '更早', items: [{ id: 'h4', label: '未命名会话', mail: false }] }
  ]
  return (
    <MenuDemo
      ariaLabel="历史对话"
      width={288}
      maxHeight={320}
      align="start"
      label="历史对话"
      items={rows.flatMap((r): PopmenuItem[] => [
        { kind: 'label', id: `g-${r.g}`, label: r.g },
        ...r.items.map(
          (it): PopmenuItem => ({
            kind: 'action',
            id: it.id,
            label: it.label,
            icon: it.mail ? <Mail size={13} /> : <MessagesSquare size={13} />,
            onSelect: () => undefined
          })
        )
      ])}
    />
  )
}

export function ChatScenes(): React.ReactElement {
  return (
    <>
      <ShowcaseSection
        id="chat"
        title="Chat / AI 面板"
        hint="盘点 21-28 · 现状实现 #8 为主（8 处裸手搓）"
      >
        <ShowcaseCard
          code="21"
          name="模型选择器"
          status="现状：#8 向上展开 w-264，布局红线是「面板 360px、右缘 348」手算；无方向键。"
          note="🔴 富行只能走 custom（基座的 action 行只有单行 label + hint + shortcut），而 custom 行不进键盘序列 —— 迁完这颗菜单仍然没有 ↑↓。真要补，基座得加一种「rich action 行」或允许 custom 行声明 focusable。"
          span
        >
          <ModelPickerScene />
        </ShowcaseCard>

        <ShowcaseCard
          code="23"
          name="「+」菜单 + connector 二级面板"
          status="现状：#8，一级 196px、二级 268px 同锚点换内容；toggle 必须走 close() 重置 view（血泪注释在 61-66）。"
          note="✅ 手搓的换 view 可以整个删掉：改成原生 submenu 就白拿 morph + 返回箭头 + Esc 回上层 + 「关菜单必清栈」。⚠️ 但基座所有层同宽（这里统一 268），原来的 196→268 变宽做不到。"
        >
          <PlusMenuScene />
        </ShowcaseCard>

        <ShowcaseCard
          code="24"
          name="审批模式选择器"
          status="现状：#8 居中锚定 w-248（left-0 时右缘 388 > 348 越界的补丁）；选 bypass 时整面板换成危险确认。"
          note="换 view 由 children + 调用方 state 承担（不是 submenu —— 触发点是「选中某一项」而非 chevron 行）。onClose 里必须一起 setView('list')，否则下次打开直接是确认页。"
        >
          <ApprovalModeScene />
        </ShowcaseCard>

        <ShowcaseCard
          code="25"
          name="会话历史"
          status="现状：手搓 + tailwindcss-animate（全仓第 3 套动效）；outside-click 靠 DOM 属性选择器 [data-chat-history-toggle]；z-30 偏低。"
          note="triggerRef 直接替掉属性选择器那套。行内二次确认在 children 里自管，基座不干预。"
        >
          <ChatHistoryScene />
        </ShowcaseCard>

        <ShowcaseCard
          code="26"
          name="@mention 邮件搜索"
          status="现状：#7，故意不透明；autofocus input（combobox 焦点模型）+ 200ms debounce。"
          note="✅ 弹层内 input 也能拿焦点：基座只在 drill / pop 后主动 focus 行，开菜单那一下不抢。"
        >
          <MentionMailScene />
        </ShowcaseCard>
      </ShowcaseSection>

      <ShowcaseSection
        id="chatmodal"
        title="Chat 浮窗 Modal"
        hint="盘点 29-30 · 现状实现 #9（透明全屏遮罩）"
      >
        <ShowcaseCard
          code="29"
          name="停靠模式菜单"
          status="现状：#9，无 Esc 无键盘导航；实心 bg-ink-2 + hairline（全仓第 4 种材质配方）。"
        >
          <ModeMenuScene />
        </ShowcaseCard>

        <ShowcaseCard
          code="30"
          name="浮窗会话历史下拉"
          status="现状：#9，与 25 是同一件事的第二套实现；today/yesterday/earlier 分组，max-h 60vh。"
          note="分组直接用基座的 label 行；两套实现合并成一套的最好机会。"
        >
          <ModalHistoryScene />
        </ShowcaseCard>
      </ShowcaseSection>
    </>
  )
}
