import { StrictMode, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChevronRight, Edit3, GripVertical, Star, StarOff, Trash2 } from 'lucide-react'

import '../../src/electron/renderer/index.css'
import './mockup.css'
import { Board, type GroupOrder } from './board'
import { HUES, PEOPLE, type Person } from './data'
import { INITIALS_CASES, initialsNext, initialsOld } from './initials'
import { Additions } from './goal'

/* ── 小工具 ─────────────────────────────────────────────────────── */

function Tip({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <span className="mk-tip">
      {children}
      <span className="mk-tip-bubble" role="tooltip">{label}</span>
    </span>
  )
}

function Avatar({ person, fixed }: { person: Person; fixed: boolean }): React.ReactElement {
  const hue = HUES[Number(person.id) % HUES.length]!
  const text = fixed ? initialsNext(person.name) : initialsOld(person.name)
  return (
    <span
      className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[11px] font-semibold tracking-tight text-white"
      style={{ background: hue }}
    >
      {text}
    </span>
  )
}

/* ── 干系人卡 ───────────────────────────────────────────────────── */

function StakeholderCard({
  person, dragging, handleProps, fixedInitials, onToggleTier
}: {
  person: Person
  dragging: boolean
  handleProps: Record<string, unknown>
  fixedInitials: boolean
  onToggleTier(): void
}): React.ReactElement {
  const isCore = person.tier === 'core'
  return (
    <article
      className={[
        'group/card relative flex h-full flex-col gap-2 rounded-[var(--r-card)] border p-3 transition-colors duration-fast',
        person.waiting ? 'border-warn/20 bg-warn/[0.04]' : 'border-ink-border bg-ink-2',
        dragging ? 'opacity-35' : ''
      ].join(' ')}
    >
      {/* 名字块恒留出右上角 4 颗图标的位置 —— 不靠 hover 才让位，
          否则长名字在静止时铺满、一 hover 就被图标压住。 */}
      <header className="flex items-start gap-2.5">
        <Avatar person={person} fixed={fixedInitials} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <h3 className="truncate text-body font-medium leading-5 text-ink-fg" title={person.name}>
              {person.name}
            </h3>
            {person.waiting ? (
              <Tip label="等待对方回复">
                <span className="block h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
              </Tip>
            ) : null}
          </div>
          <p className="truncate text-meta leading-[18px] text-ink-fg-3" title={person.org}>
            {person.org}
          </p>
        </div>
      </header>

      {/* 角色：正文文字，不再塞进药丸。长角色名换行到 2 行就收，
          不会像现状那样把一个圆角胶囊撑成两行还挤掉右边的「最近联系」。 */}
      <p className="line-clamp-2 text-meta leading-[18px] text-ink-fg-2">{person.role}</p>

      {/* 操作放底栏右侧：这里本来就是空位。放右上角就必须给名字恒留 ~96px，
          4 列密度下长名字会被挤成「Lucien Chen（…」—— owner 反馈的正是这个。 */}
      <footer className="mt-auto flex h-6 items-center justify-between gap-2 border-t border-ink-border pt-2">
        <span className="truncate text-meta text-ink-fg-3">
          最近联系 {person.lastContact ?? '—'}
        </span>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-fast focus-within:opacity-100 group-hover/card:opacity-100">
        <Tip label={isCore ? '移出核心' : '设为核心'}>
          <button type="button" onClick={onToggleTier}
            className="grid h-6 w-6 place-items-center rounded-[var(--r-ctl)] text-ink-fg-2 hover:bg-ink-3 hover:text-ink-fg">
            {isCore ? <StarOff size={13} /> : <Star size={13} />}
          </button>
        </Tip>
        <Tip label="编辑干系人">
          <button type="button"
            className="grid h-6 w-6 place-items-center rounded-[var(--r-ctl)] text-ink-fg-2 hover:bg-ink-3 hover:text-ink-fg">
            <Edit3 size={13} />
          </button>
        </Tip>
        <Tip label="移除干系人">
          <button type="button"
            className="grid h-6 w-6 place-items-center rounded-[var(--r-ctl)] text-ink-fg-2 hover:bg-fail/10 hover:text-fail">
            <Trash2 size={13} />
          </button>
        </Tip>
        <Tip label="拖动排序 / 换组">
          <button type="button" {...handleProps}
            className="grid h-6 w-6 cursor-grab place-items-center rounded-[var(--r-ctl)] text-ink-fg-3 hover:bg-ink-3 hover:text-ink-fg active:cursor-grabbing">
            <GripVertical size={13} />
          </button>
        </Tip>
        </div>
      </footer>
    </article>
  )
}

/* ── 页面 ───────────────────────────────────────────────────────── */

function App(): React.ReactElement {
  const [people, setPeople] = useState<Person[]>(PEOPLE)
  const [othersOpen, setOthersOpen] = useState(true)
  const [snapBackBug, setSnapBackBug] = useState(false)
  const [latency, setLatency] = useState(600)
  const [fixedInitials, setFixedInitials] = useState(true)
  const [pending, setPending] = useState(false)

  const core = useMemo(() => people.filter((p) => p.tier === 'core'), [people])
  const normal = useMemo(() => people.filter((p) => p.tier === 'normal'), [people])

  /** 模拟真实链路：本地不立刻改，等「服务端」返回后才更新 props（就是现状的写法）。 */
  const commit = (order: readonly GroupOrder[]): void => {
    const byId = new Map(people.map((p) => [p.id, p]))
    const next: Person[] = []
    for (const g of order)
      for (const id of g.itemIds) {
        const p = byId.get(id)
        if (p) next.push({ ...p, tier: g.id as Person['tier'] })
      }
    setPending(true)
    window.setTimeout(() => { setPeople(next); setPending(false) }, latency)
  }

  const toggleTier = (id: string): void => {
    setPending(true)
    window.setTimeout(() => {
      setPeople((cur) => cur.map((p) => (p.id === id ? { ...p, tier: p.tier === 'core' ? 'normal' : 'core' } : p)))
      setPending(false)
    }, latency)
  }

  return (
    <div className="min-h-screen bg-ink-1 px-8 py-7 text-ink-fg">
      <div className="mx-auto max-w-[1180px] space-y-6">
        <header className="space-y-1">
          <h1 className="text-lg font-semibold">干系人区 — mockup</h1>
          <p className="text-meta text-ink-fg-3">
            真 dnd-kit + 主仓 design token。验收通过后按此移植回 <code className="text-ink-fg-2">MatterStakeholderSection</code>。
          </p>
        </header>

        <section className="flex flex-wrap items-center gap-x-5 gap-y-2.5 rounded-[var(--r-card)] border border-ink-border bg-ink-2 px-4 py-3 text-meta">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={snapBackBug} onChange={(e) => setSnapBackBug(e.target.checked)} />
            <span>复现现状缺陷（落下先回弹）</span>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={fixedInitials} onChange={(e) => setFixedInitials(e.target.checked)} />
            <span>头像取字用修复版</span>
          </label>
          <label className="flex items-center gap-2">
            <span>模拟服务端延迟</span>
            <select value={latency} onChange={(e) => setLatency(Number(e.target.value))}
              className="rounded-[var(--r-ctl)] border border-ink-border bg-ink-1 px-2 py-1">
              <option value={0}>0ms</option>
              <option value={600}>600ms</option>
              <option value={1500}>1500ms</option>
            </select>
          </label>
          <span className={pending ? 'text-ai' : 'text-ink-fg-3'}>{pending ? '● 写入中…' : '○ 空闲'}</span>
          <button type="button" onClick={() => setPeople(PEOPLE)}
            className="ml-auto rounded-[var(--r-ctl)] border border-ink-border px-2.5 py-1 hover:bg-ink-3">
            重置
          </button>
        </section>

        <section className="rounded-[var(--r-card)] border border-ink-border bg-ink-1 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-body font-semibold">干系人 · {people.length}</h2>
            <button type="button" className="rounded-[var(--r-ctl)] border border-ink-border px-3 py-1.5 text-meta hover:bg-ink-3">
              ＋ 添加干系人
            </button>
          </div>

          <Board<Person>
            groups={[
              { id: 'core', items: core },
              { id: 'normal', items: normal, collapsed: !othersOpen }
            ]}
            getId={(p) => p.id}
            onReorder={commit}
            onRequestExpand={(gid) => { if (gid === 'normal') setOthersOpen(true) }}
            snapBackBug={snapBackBug}
            renderEmpty={(g, { isOver }) =>
              g.id === 'core' ? (
                <div className={[
                  'grid min-h-[92px] place-items-center rounded-[var(--r-card)] border border-dashed px-4 text-center transition-colors duration-fast',
                  isOver ? 'border-ai/50 bg-ai/[0.07] text-ai' : 'border-ink-border text-ink-fg-3'
                ].join(' ')}>
                  <p className="text-meta">
                    {isOver ? '松手设为核心干系人' : '把决定这件事走向的人拖到这里，或点卡片右上角的 ☆'}
                  </p>
                </div>
              ) : <div className="min-h-[2.5rem]" />
            }
            renderGroup={({ group, children, headerRef, isOver }) =>
              group.id === 'core' ? (
                <section key="core" className="mb-4">
                  <h4 className="mb-2 flex items-center gap-1.5 text-meta font-medium text-ink-fg-2">
                    核心干系人
                    <span className="tabular-nums text-ink-fg-3">{group.items.length}</span>
                  </h4>
                  {children}
                </section>
              ) : (
                <section key="normal">
                  <button ref={headerRef} type="button" onClick={() => setOthersOpen((o) => !o)}
                    aria-expanded={othersOpen}
                    className={[
                      'mb-2 flex w-full items-center gap-1.5 rounded-[var(--r-ctl)] px-1 py-1 text-meta font-medium transition-colors duration-fast',
                      isOver && !othersOpen ? 'bg-ai/[0.08] text-ai' : 'text-ink-fg-2 hover:text-ink-fg'
                    ].join(' ')}>
                    <ChevronRight size={13} className={othersOpen ? 'rotate-90 transition-transform' : 'transition-transform'} />
                    其他干系人
                    <span className="tabular-nums text-ink-fg-3">{group.items.length}</span>
                    {!othersOpen && isOver ? <span className="ml-1 text-meta text-ai">松手展开</span> : null}
                  </button>
                  {children}
                </section>
              )
            }
            renderOverlay={(p) => (
              <div className="mk-lifted rotate-[1.5deg] rounded-[var(--r-card)]">
                <StakeholderCard person={p} dragging={false} handleProps={{}} fixedInitials={fixedInitials} onToggleTier={() => {}} />
              </div>
            )}
            renderItem={(p, { dragging, handleProps }) => (
              <StakeholderCard person={p} dragging={dragging} handleProps={handleProps}
                fixedInitials={fixedInitials} onToggleTier={() => toggleTier(p.id)} />
            )}
          />
        </section>

        <section className="rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-5">
          <h2 className="mb-3 text-body font-semibold">头像取字 — 用例对照</h2>
          <table className="w-full text-meta">
            <thead className="text-ink-fg-3">
              <tr className="text-left">
                <th className="pb-2 font-medium">输入</th>
                <th className="pb-2 font-medium">现状</th>
                <th className="pb-2 font-medium">修复后</th>
                <th className="pb-2 font-medium">期望</th>
              </tr>
            </thead>
            <tbody>
              {INITIALS_CASES.map(([name, want]) => {
                const old = initialsOld(name)
                const next = initialsNext(name)
                return (
                  <tr key={name} className="border-t border-ink-border">
                    <td className="py-1.5 text-ink-fg">{name}</td>
                    <td className={old === want ? 'text-ink-fg-3' : 'text-fail'}>{old}</td>
                    <td className={next === want ? 'text-ok' : 'text-fail'}>{next}</td>
                    <td className="text-ink-fg-3">{want}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>

        {/* 增补：背景与目标 / Agent 说明对照 / 待办项 checkbox（goal.tsx） */}
        <Additions />
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
