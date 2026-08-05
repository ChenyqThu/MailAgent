// 场景：Composer（盘点 §B 编号 12-20）。
// 撰写面是全 app 弹层形态最杂的一块：单选组 / 色板 / 网格 / 内联表单 / combobox /
// caret 锚定的 TipTap 菜单都在这里。

import { useMemo, useRef, useState } from 'react'
import {
  Ban,
  Check,
  Copy,
  Flag,
  Globe,
  Heading1,
  Heading2,
  Heading3,
  ImageUp,
  Link2,
  List,
  ListOrdered,
  Minus,
  Pencil,
  SquareCode,
  TextQuote,
  Trash2,
  Unlink
} from 'lucide-react'

import { Popmenu, type PopmenuItem } from '@shared/components/ui/Popmenu'
import { cn } from '@shared/lib/cn'

import { MenuDemo, RichRow, ShowcaseCard, ShowcaseSection } from './ShowcaseKit'

/* eslint-disable mailagent/no-raw-hex -- 与 ComposeEditor.tsx:115 同一理由：swatch 是
   邮件正文里发出去的内容色常量（收件人客户端解析），不是 theme token。 */
const TEXT_COLORS: readonly string[] = [
  '#4DA6F0',
  '#5EC26A',
  '#F2D440',
  '#F2913D',
  '#EE6B60',
  '#B76BE0',
  '#1667C2',
  '#188A3C',
  '#D4B016',
  '#DB6B10',
  '#CC2F24',
  '#8833B8',
  '#10498C',
  '#0F6129',
  '#9C8010',
  '#A34F0C',
  '#941F17',
  '#622585'
]
const TEXT_NEUTRALS: readonly string[] = ['#D9D9D9', '#A6A6A6', '#737373', '#404040', '#000000']
const HIGHLIGHTS: readonly string[] = [
  '#FCE7A2',
  '#C6EBCB',
  '#C9E0FB',
  '#F7CFE0',
  '#FBDCB6',
  '#C9EFEF',
  '#F5E342',
  '#6FD383',
  '#6FAEF2',
  '#EE7FB2',
  '#F5A44A',
  '#5ED3D3'
]
/* eslint-enable mailagent/no-raw-hex */

function radioItems(
  opts: readonly { id: string; label: string }[],
  value: string,
  set: (v: string) => void
): PopmenuItem[] {
  return opts.map((o) => ({
    kind: 'radio',
    id: o.id,
    label: o.label,
    checked: value === o.id,
    onSelect: () => set(o.id)
  }))
}

function FormatDropdownsScene(): React.ReactElement {
  const [block, setBlock] = useState('')
  const [font, setFont] = useState('')
  const [size, setSize] = useState('')
  const [lh, setLh] = useState('')

  const blocks = [
    { id: '', label: '正文' },
    { id: '1', label: '标题 1' },
    { id: '2', label: '标题 2' },
    { id: '3', label: '标题 3' }
  ]
  const fonts = [
    { id: '', label: '默认字体' },
    { id: 'system', label: '系统' },
    { id: 'serif', label: '衬线' },
    { id: 'mono', label: '等宽' }
  ]
  const sizes = [
    { id: '', label: '默认（14）' },
    { id: '12px', label: '12' },
    { id: '13px', label: '13' },
    { id: '14px', label: '14' },
    { id: '16px', label: '16' },
    { id: '18px', label: '18' },
    { id: '24px', label: '24' },
    { id: '30px', label: '30' }
  ]
  const lhs = [
    { id: '', label: '默认（1.5）' },
    { id: '1.15', label: '1.15' },
    { id: '1.3', label: '1.3' },
    { id: '1.5', label: '1.5' },
    { id: '1.75', label: '1.75' },
    { id: '2.0', label: '2.0' }
  ]
  const labelOf = (opts: readonly { id: string; label: string }[], v: string): string =>
    opts.find((o) => o.id === v)?.label ?? ''

  return (
    <>
      <MenuDemo
        ariaLabel="标题格式"
        width={168}
        align="start"
        label={labelOf(blocks, block)}
        items={radioItems(blocks, block, setBlock)}
      />
      <MenuDemo
        ariaLabel="字体"
        width={168}
        align="start"
        label={labelOf(fonts, font)}
        items={radioItems(fonts, font, setFont)}
      />
      <MenuDemo
        ariaLabel="字号"
        width={168}
        align="start"
        label={labelOf(sizes, size)}
        items={radioItems(sizes, size, setSize)}
      />
      <MenuDemo
        ariaLabel="行距"
        width={168}
        align="start"
        label={labelOf(lhs, lh)}
        items={radioItems(lhs, lh, setLh)}
      />
    </>
  )
}

function SwatchGrid({
  colors,
  neutrals,
  clearLabel,
  onPick
}: {
  colors: readonly string[]
  neutrals: readonly string[]
  clearLabel: string
  onPick: (c: string | null) => void
}): React.ReactElement {
  return (
    <div className="grid grid-cols-6 gap-1.5 py-1">
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          title={c}
          aria-label={c}
          className="h-5 w-5 rounded border border-ink-border-soft"
          style={{ backgroundColor: c }}
          onClick={() => onPick(c)}
        />
      ))}
      <button
        type="button"
        title={clearLabel}
        aria-label={clearLabel}
        className="flex h-5 w-5 items-center justify-center rounded border border-ink-border-soft text-ink-fg-3"
        onClick={() => onPick(null)}
      >
        <Ban size={11} />
      </button>
      {neutrals.map((c) => (
        <button
          key={c}
          type="button"
          title={c}
          aria-label={c}
          className="h-5 w-5 rounded border border-ink-border-soft"
          style={{ backgroundColor: c }}
          onClick={() => onPick(c)}
        />
      ))}
    </div>
  )
}

function SwatchScene(): React.ReactElement {
  const [text, setText] = useState<string | null>(null)
  const [hl, setHl] = useState<string | null>(null)
  return (
    <>
      <MenuDemo
        ariaLabel="字体颜色"
        title="字体颜色"
        width={196}
        align="start"
        label={
          <>
            <span
              className="h-3 w-3 rounded border border-ink-border-soft"
              style={text === null ? undefined : { backgroundColor: text }}
              aria-hidden
            />
            字体颜色
          </>
        }
        items={(close) => [
          {
            kind: 'custom',
            id: 'grid',
            content: (
              <SwatchGrid
                colors={TEXT_COLORS}
                neutrals={TEXT_NEUTRALS}
                clearLabel="默认"
                onPick={(c) => {
                  setText(c)
                  close()
                }}
              />
            )
          },
          { kind: 'separator', id: 'sep' },
          { kind: 'action', id: 'more', label: '更多颜色', onSelect: () => undefined }
        ]}
      />
      <MenuDemo
        ariaLabel="高亮"
        title="高亮"
        width={196}
        align="start"
        label={
          <>
            <span
              className="h-3 w-3 rounded border border-ink-border-soft"
              style={hl === null ? undefined : { backgroundColor: hl }}
              aria-hidden
            />
            高亮
          </>
        }
        items={(close) => [
          {
            kind: 'custom',
            id: 'grid',
            content: (
              <SwatchGrid
                colors={HIGHLIGHTS}
                neutrals={TEXT_NEUTRALS}
                clearLabel="无"
                onPick={(c) => {
                  setHl(c)
                  close()
                }}
              />
            )
          },
          { kind: 'separator', id: 'sep' },
          { kind: 'action', id: 'more', label: '更多颜色', onSelect: () => undefined }
        ]}
      />
    </>
  )
}

function TableInsertScene(): React.ReactElement {
  const [hover, setHover] = useState({ r: 2, c: 2 })
  return (
    <MenuDemo
      ariaLabel="插入表格"
      title="插入表格"
      width={216}
      align="start"
      label="插入表格"
      items={(close) => [
        {
          kind: 'custom',
          id: 'grid',
          content: (
            <div>
              <div
                className="grid grid-cols-8 gap-0.5"
                onMouseLeave={() => setHover({ r: 2, c: 2 })}
              >
                {Array.from({ length: 64 }, (_, i) => {
                  const r = Math.floor(i / 8) + 1
                  const c = (i % 8) + 1
                  const on = r <= hover.r && c <= hover.c
                  return (
                    <button
                      key={i}
                      type="button"
                      aria-label={`${r} 行 × ${c} 列`}
                      title={`${r} 行 × ${c} 列`}
                      className={cn(
                        'h-4 w-4 rounded-[2px] border',
                        on ? 'border-coral bg-coral/30' : 'border-ink-border bg-ink-3'
                      )}
                      onMouseEnter={() => setHover({ r, c })}
                      onClick={close}
                    />
                  )
                })}
              </div>
              <p className="mt-2 text-center text-xs text-ink-fg-2">
                {hover.r} 行 × {hover.c} 列
              </p>
            </div>
          )
        }
      ]}
    />
  )
}

function InlineLinkScene(): React.ReactElement {
  const [url, setUrl] = useState('')
  return (
    <MenuDemo
      ariaLabel="插入链接"
      width={288}
      align="start"
      label={
        <>
          <Link2 size={13} />
          插入链接
        </>
      }
      render={(close) => (
        <form
          className="flex flex-col gap-2 p-1"
          onSubmit={(e) => {
            e.preventDefault()
            close()
          }}
        >
          <input
            type="url"
            autoFocus
            value={url}
            placeholder="链接地址"
            onChange={(e) => setUrl(e.target.value)}
            className="h-8 w-full rounded-[var(--r-ctl)] border border-ink-border bg-ink-3 px-2 text-sm text-ink-fg outline-none focus:border-coral"
          />
          <div className="flex items-center gap-1.5">
            <button
              type="submit"
              className="inline-flex h-7 items-center gap-1 rounded-[var(--r-ctl)] bg-coral/100 px-2 text-xs text-accent-fg"
            >
              <Check size={12} />
              应用
            </button>
            <button
              type="button"
              onClick={close}
              className="inline-flex h-7 items-center gap-1 rounded-[var(--r-ctl)] bg-ink-3 px-2 text-xs text-ink-fg-1"
            >
              <Unlink size={12} />
              移除链接
            </button>
            <button
              type="button"
              onClick={close}
              className="ml-auto inline-flex h-7 items-center gap-1 rounded-[var(--r-ctl)] px-2 text-xs text-ink-fg-2 hover:bg-ink-3"
            >
              <ImageUp size={12} />
              从文件选择
            </button>
          </div>
        </form>
      )}
    />
  )
}

function ImportanceScene(): React.ReactElement {
  const [v, setV] = useState('normal')
  const opts = [
    { id: 'high', label: '高' },
    { id: 'normal', label: '普通' },
    { id: 'low', label: '低' }
  ]
  return (
    <MenuDemo
      ariaLabel="重要性"
      width={140}
      align="start"
      label={
        <>
          <Flag size={13} className={v === 'high' ? 'text-warn' : undefined} />
          {opts.find((o) => o.id === v)?.label}
        </>
      }
      items={radioItems(opts, v, setV)}
    />
  )
}

const CONTACTS = [
  { name: '陈元泉', email: 'chenyuanquan@omadanetworks.com', external: false },
  { name: '张伟', email: 'zhangwei@omadanetworks.com', external: false },
  { name: 'Alex Chen', email: 'alex.chen@partner.example', external: true },
  { name: '李娜', email: 'lina@omadanetworks.com', external: false },
  { name: 'Support', email: 'support@vendor.example', external: true }
]

/** 收件人补全 —— combobox 焦点模型：焦点全程留在 input，弹层只做 listbox。 */
function RecipientComboboxScene(): React.ReactElement {
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState(false)
  const [rawActive, setActive] = useState(0)
  const [chips, setChips] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  const list = useMemo(
    () =>
      CONTACTS.filter(
        (c) =>
          chips.includes(c.email) === false &&
          (query === '' ||
            c.name.toLowerCase().includes(query.toLowerCase()) ||
            c.email.toLowerCase().includes(query.toLowerCase()))
      ),
    [query, chips]
  )
  const open = focused && list.length > 0
  // 列表变短时在 render 里夹取，而不是拿 effect 把 active 归零（后者是级联渲染）。
  const active = list.length === 0 ? 0 : Math.min(rawActive, list.length - 1)

  const pick = (email: string): void => {
    setChips((c) => [...c, email])
    setQuery('')
    inputRef.current?.focus()
  }

  return (
    <div className="relative w-full">
      <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-[var(--r-ctl)] border border-ink-border bg-ink-3 px-1.5 py-1">
        {chips.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setChips((prev) => prev.filter((x) => x !== c))}
            className="rounded-full bg-ink-4 px-2 py-0.5 text-xs text-ink-fg"
          >
            {c.split('@')[0]} ×
          </button>
        ))}
        <input
          ref={inputRef}
          value={query}
          placeholder="添加收件人 · 输入邮箱后回车"
          role="combobox"
          aria-expanded={open}
          aria-controls="showcase-recipient-list"
          aria-autocomplete="list"
          aria-activedescendant={open ? `showcase-recipient-${active}` : undefined}
          className="min-w-[160px] flex-1 bg-transparent text-sm text-ink-fg outline-none placeholder:text-ink-fg-3"
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onFocus={() => setFocused(true)}
          onKeyDown={(e) => {
            if (!open) return
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((i) => (i + 1) % list.length)
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) => (i - 1 + list.length) % list.length)
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const hit = list[active]
              if (hit) pick(hit.email)
            }
          }}
        />
      </div>
      {/* input 自己就是 triggerRef —— 点它不算 outside-click，Esc 关闭后焦点也还给它。 */}
      <Popmenu
        open={open}
        onClose={() => setFocused(false)}
        ariaLabel="收件人建议"
        triggerRef={inputRef}
        width={300}
        maxHeight={220}
        anchorClassName="left-0 top-[calc(100%+0.375rem)]"
      >
        <ul id="showcase-recipient-list" role="listbox" aria-label="收件人建议">
          {list.map((c, i) => (
            <li
              key={c.email}
              id={`showcase-recipient-${i}`}
              role="option"
              aria-selected={i === active}
            >
              <RichRow
                active={i === active}
                lead={
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-ink-4 text-[9px] text-ink-fg-1">
                    {c.name.slice(0, 1)}
                  </span>
                }
                primary={
                  <>
                    {c.name}
                    {c.external && (
                      <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-warn align-middle" />
                    )}
                  </>
                }
                secondary={c.email}
                onClick={() => pick(c.email)}
              />
            </li>
          ))}
        </ul>
      </Popmenu>
    </div>
  )
}

function RecipientDetailScene(): React.ReactElement {
  return (
    <MenuDemo
      ariaLabel="收件人详情"
      width={272}
      align="start"
      label="chenyuanquan ⌄"
      render={(close) => (
        <div className="flex flex-col gap-2.5 p-1">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-ink-4 text-sm text-ink-fg">
              陈
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-ink-fg">陈元泉</span>
              <span className="block truncate font-mono text-[11px] text-ink-fg-2">
                chenyuanquan@omadanetworks.com
              </span>
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-ink-fg-2">
            <Globe size={12} />
            内部联系人
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={close}
              className="inline-flex h-7 items-center gap-1 rounded-[var(--r-ctl)] bg-ink-3 px-2 text-xs text-ink-fg-1"
            >
              <Pencil size={12} />
              编辑
            </button>
            <button
              type="button"
              onClick={close}
              className="inline-flex h-7 items-center gap-1 rounded-[var(--r-ctl)] bg-ink-3 px-2 text-xs text-ink-fg-1"
            >
              <Copy size={12} />
              复制
            </button>
            <button
              type="button"
              onClick={close}
              className="ml-auto inline-flex h-7 items-center gap-1 rounded-[var(--r-ctl)] px-2 text-xs text-fail hover:bg-fail/10"
            >
              <Trash2 size={12} />
              移除
            </button>
          </div>
        </div>
      )}
    />
  )
}

function SlashMenuScene(): React.ReactElement {
  const rows = [
    { id: 'h1', label: '标题 1', hint: '大号章节标题', icon: <Heading1 size={14} /> },
    { id: 'h2', label: '标题 2', hint: '中号小标题', icon: <Heading2 size={14} /> },
    { id: 'h3', label: '标题 3', hint: '小标题', icon: <Heading3 size={14} /> },
    { id: 'ul', label: '无序列表', hint: '圆点项目符号', icon: <List size={14} /> },
    { id: 'ol', label: '有序列表', hint: '编号列表', icon: <ListOrdered size={14} /> },
    { id: 'quote', label: '引用块', hint: '引用块 blockquote', icon: <TextQuote size={14} /> },
    { id: 'code', label: '代码块', hint: '等宽代码', icon: <SquareCode size={14} /> },
    { id: 'hr', label: '分割线', hint: '水平分隔线', icon: <Minus size={14} /> }
  ]
  return (
    <MenuDemo
      ariaLabel="基础块"
      width={272}
      maxHeight={320}
      align="start"
      label="输入 /"
      items={[
        { kind: 'label', id: 'g', label: '基础块' },
        ...rows.map(
          (r): PopmenuItem => ({
            kind: 'action',
            id: r.id,
            label: r.label,
            hint: r.hint,
            icon: r.icon,
            onSelect: () => undefined
          })
        )
      ]}
    />
  )
}

function MentionContactScene(): React.ReactElement {
  return (
    <MenuDemo
      ariaLabel="提及联系人"
      width={272}
      maxHeight={240}
      align="start"
      label="输入 @"
      items={CONTACTS.map(
        (c): PopmenuItem => ({
          kind: 'action',
          id: c.email,
          label: c.name,
          hint: c.email.split('@')[0],
          icon: (
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-ink-4 text-[9px] text-ink-fg-1">
              {c.name.slice(0, 1)}
            </span>
          ),
          onSelect: () => undefined
        })
      )}
    />
  )
}

export function ComposerScenes(): React.ReactElement {
  return (
    <ShowcaseSection
      id="composer"
      title="Composer"
      hint="盘点 12-20 · 现状实现 #1 / #8 / #10 / #11 混用"
    >
      <ShowcaseCard
        code="12"
        name="段落 / 字体 / 字号 / 行距 4 下拉"
        status="现状：#1（Radix Popover）listbox；不用原生 select 因 Electron modal 会误关 backdrop；trigger 全挂 onMouseDown preventDefault 保 TipTap 选区。"
        note="🔴 迁移必做：基座的 trigger 由调用方提供（保留 onMouseDown preventDefault 即可）；但基座面板内的行是 <button>，点击前会抢焦点 —— 编辑器场景要在行上补 onMouseDown preventDefault，基座目前没有这个开关。"
        span
      >
        <FormatDropdownsScene />
      </ShowcaseCard>

      <ShowcaseCard
        code="13"
        name="文字色 / 高亮色板"
        status="现状：#1；<input type=color> 必须挂在 Popover 外（系统取色面板会关 popover）。"
        note="「更多颜色」在这里做成普通 action 行；真迁移时它仍要触发挂在弹层外的隐藏 input。"
      >
        <SwatchScene />
      </ShowcaseCard>

      <ShowcaseCard
        code="14"
        name="插入表格 8×8"
        status="现状：#1，z-[70] 单独抬高（有层级冲突史）。"
        note="基座固定 z-40。撰写面板本身层级更高时需要调用方在 anchorClassName 里覆盖 z（基座没暴露 z 参数）。"
      >
        <TableInsertScene />
      </ShowcaseCard>

      <ShowcaseCard
        code="15"
        name="链接 / 图片内联输入"
        status="现状：#8，z-20 过低，无 outside-click。"
        note="children 逃生舱：给了 children 后基座不接管键盘，autoFocus 的 input 不会被抢焦点，Esc / outside-click 照常关。表单场景完全可用。"
      >
        <InlineLinkScene />
      </ShowcaseCard>

      <ShowcaseCard
        code="16"
        name="重要性下拉"
        status="现状：#8，最脆的一个 —— onBlur + 120ms 定时器关闭，无 outside-click / Esc / 键盘。"
        note="纯收益迁移：3 行 radio，一次换完拿到键盘导航 + Esc + outside-click。"
      >
        <ImportanceScene />
      </ShowcaseCard>

      <ShowcaseCard
        code="17"
        name="收件人自动补全（combobox）"
        status="现状：#8，完整 combobox a11y（aria-activedescendant），焦点全程留在 input。"
        note="✅ 装得进：input 当 triggerRef，列表走 children。基座在 children 模式下不注册 role=menu、不接管 onKeyDown、开菜单时不抢焦点 —— ↑↓/Enter 与 aria-activedescendant 由调用方保留原实现即可。代价：基座的行键盘导航这条完全不参与（本来也不该参与）。"
        span
      >
        <RecipientComboboxScene />
      </ShowcaseCard>

      <ShowcaseCard
        code="18"
        name="收件人 chip 详情卡"
        status="现状：#10（手算 viewport fixed），capture 阶段 Esc + stopImmediatePropagation 防冒泡关掉整个 composer。"
        note="🔴 基座 Esc 只做 stopPropagation（同为 document 监听时挡不住先注册的 capture 监听）。嵌在 composer 里的这一层要么保留自己的 capture 拦截，要么基座补一个 Esc 层级栈。"
      >
        <RecipientDetailScene />
      </ShowcaseCard>

      <ShowcaseCard
        code="19"
        name="slash 块菜单"
        status="现状：#11（TipTap Suggestion + ReactRenderer 手挂 body），caret rect 锚定。"
        note="形状可换壳，锚定不行 —— 基座是 absolute 锚在 trigger 父元素上，caret 没有 DOM 元素可当 trigger。真实文案是两行（标题 + 副标题），基座行是单行 min-h-9，这里把副标题降级成行尾 hint；要保两行需 custom 行（不进键盘序列）。"
      >
        <SlashMenuScene />
      </ShowcaseCard>

      <ShowcaseCard
        code="20"
        name="@mention 联系人"
        status="现状：同 19，同一套 caret 锚定 + useImperativeHandle 键盘桥。"
      >
        <MentionContactScene />
      </ShowcaseCard>
    </ShowcaseSection>
  )
}
