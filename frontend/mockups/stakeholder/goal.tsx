import { useState } from 'react'
import { CircleCheckBig, Pencil, Target } from 'lucide-react'

/* ══ 增补 1 + 2 ═══════════════════════════════════════════════════
   本文件只服务 mockup 验收，不进主仓。两块内容：
   ① 「核心目标」→「背景与目标」：卡片承载 背景 / 目标 / 完成标志 三段。
   ② 待办项与完成标志换 CircleCheckBig（勾从右上角出圈）行式 checkbox（点整行切换）。
   ══════════════════════════════════════════════════════════════ */

interface Check {
  id: string
  text: string
  done: boolean
  meta?: string
}

const TODOS: Check[] = [
  { id: 't1', text: '跟 Echo 确认 Guard 侧的联调时间窗', done: true, meta: '行动项 · 曾东彪' },
  { id: 't2', text: '产出 Controller 管理端的接口对齐文档', done: true, meta: '行动项 · 郭诗力' },
  { id: 't3', text: '向孙晓宇确认平台侧排期是否顺延', done: false, meta: '行动项 · 等对方回复' },
  { id: 't4', text: '补一份 SaaS 2026 Plan 的风险清单', done: false, meta: '备注' },
  { id: 't5', text: '拿到 Gateway 侧的性能基线数据', done: false, meta: '里程碑 · 8/25 到期' }
]

const GOAL_CHECKS: Check[] = [
  { id: 'g1', text: '三方（ENBU / TP-Link / Omada）对联调方案达成一致', done: true },
  { id: 'g2', text: '联调环境可用，且跑通一轮端到端', done: true },
  { id: 'g3', text: '排期写进 2026 Plan 并由孙晓宇确认', done: false },
  { id: 'g4', text: 'Guard 侧性能基线达标（P95 低于 200ms）', done: false },
  { id: 'g5', text: '客户侧验收邮件已回', done: false }
]

/* ── checkbox 行 ────────────────────────────────────────────────
   一行 = CircleCheckBig + 文本，点整行切换。未完成图标 text-ink-fg-3，
   完成后 text-ok + 文本 line-through。全部走 duration-fast。 */

function CheckRow({ item, onToggle }: { item: Check; onToggle(): void }): React.ReactElement {
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={item.done}
        className="flex w-full items-center gap-2.5 rounded-[var(--r-ctl)] px-2 py-2 text-left transition-colors duration-fast ease-standard hover:bg-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
      >
        <CircleCheckBig
          size={16}
          strokeWidth={2}
          className={[
            'shrink-0 transition-[color,transform] duration-fast ease-standard',
            item.done ? 'scale-105 text-ok' : 'text-ink-fg-3'
          ].join(' ')}
        />
        <span className="min-w-0 flex-1">
          <span
            className={[
              'block break-words text-body transition-colors duration-fast ease-standard',
              item.done ? 'text-ink-fg-3 line-through' : 'text-ink-fg-1'
            ].join(' ')}
          >
            {item.text}
          </span>
          {item.meta ? (
            <span className="mt-0.5 block truncate text-meta text-ink-fg-3">{item.meta}</span>
          ) : null}
        </span>
      </button>
    </li>
  )
}

function Progress({ done, total }: { done: number; total: number }): React.ReactElement {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100)
  return (
    <div className="flex items-center gap-2.5">
      <span className="h-1 w-24 overflow-hidden rounded-full bg-ink-3">
        <span
          className="block h-full rounded-full bg-ok transition-[width] duration-base ease-standard"
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="shrink-0 tabular-nums text-meta text-ink-fg-2">
        已完成 {done} / {total}
      </span>
    </div>
  )
}

function CheckList({
  items,
  onToggle,
  addLabel
}: {
  items: Check[]
  onToggle(id: string): void
  addLabel: string
}): React.ReactElement {
  return (
    <>
      <ul className="mt-2 space-y-0.5">
        {items.map((item) => (
          <CheckRow key={item.id} item={item} onToggle={() => onToggle(item.id)} />
        ))}
      </ul>
      <button
        type="button"
        className="mt-2 inline-flex rounded-[var(--r-ctl)] border border-dashed border-ink-border px-3 py-2 text-left text-meta text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-2 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
      >
        {addLabel}
      </button>
    </>
  )
}

/* ── 增补 1：「背景与目标」卡 ──────────────────────────────────── */

const BACKGROUND =
  'Omada / Guard 要在 2026 Plan 里跟 Controller 平台合并排期。8 月初 TP-Link 侧提出把联调提前到 Q3，' +
  'ENBU 三条线（平台 / 管理端 / Gateway）当前排期互相不认，邮件已经来回四轮没有结论。'

const GOAL =
  '拿到一份三方都认的联调与上线排期并写进 2026 Plan；Guard 的性能基线在联调开始前定死，避免上线前返工。'

function GoalSection(): React.ReactElement {
  const [editing, setEditing] = useState(false)
  const [background, setBackground] = useState(BACKGROUND)
  const [goal, setGoal] = useState(GOAL)
  const [checks, setChecks] = useState<Check[]>(GOAL_CHECKS)
  const done = checks.filter((c) => c.done).length

  const toggle = (id: string): void =>
    setChecks((cur) => cur.map((c) => (c.id === id ? { ...c, done: !c.done } : c)))

  return (
    <section className="rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-5">
      <div className="mb-3">
        <h2 className="text-body font-semibold">
          增补 1 —— 事项详情「核心目标」改名「背景与目标」
        </h2>
        <p className="mt-1 text-meta text-ink-fg-3">
          不只是换标题：卡片明确分成 <span className="text-ink-fg-2">背景 / 目标 / 完成标志</span>{' '}
          三段，编辑态也按两段收。
        </p>
      </div>

      {/* 区标签 —— 对应主仓 MatterSectionLabel */}
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-meta font-medium text-ink-fg-2">
          <Target size={12} className="shrink-0 text-ink-fg-2" />
          背景与目标
        </span>
        {!editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex shrink-0 items-center gap-1 rounded-[var(--r-ctl)] px-2 py-1 text-meta text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
          >
            <Pencil size={12} />
            编辑
          </button>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-[var(--r-card)] border border-ink-border bg-ink-1/75">
        {editing ? (
          <div className="space-y-4 p-4">
            <div>
              <label
                htmlFor="mk-bg"
                className="mb-1 block text-meta font-medium uppercase tracking-wide text-ink-fg-3"
              >
                背景
              </label>
              <textarea
                id="mk-bg"
                rows={4}
                value={background}
                onChange={(e) => setBackground(e.target.value)}
                placeholder="这件事是怎么来的？有哪些约束和已知结论？"
                className="w-full resize-y rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 text-body text-ink-fg outline-none transition-colors duration-fast ease-standard placeholder:text-ink-fg-3 focus-visible:border-coral/60 focus-visible:ring-2 focus-visible:ring-coral/70"
              />
            </div>
            <div>
              <label
                htmlFor="mk-goal"
                className="mb-1 block text-meta font-medium uppercase tracking-wide text-ink-fg-3"
              >
                目标
              </label>
              <textarea
                id="mk-goal"
                rows={3}
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="做完时什么成立？（怎么判断做完写在下面的完成标志里）"
                className="w-full resize-y rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 text-body text-ink-fg outline-none transition-colors duration-fast ease-standard placeholder:text-ink-fg-3 focus-visible:border-coral/60 focus-visible:ring-2 focus-visible:ring-coral/70"
              />
            </div>
            <p className="text-meta text-ink-fg-3">支持 Markdown。你写的这两段，Agent 不会改写。</p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setBackground(BACKGROUND)
                  setGoal(GOAL)
                  setEditing(false)
                }}
                className="rounded-[var(--r-ctl)] px-2.5 py-1.5 text-aux text-ink-fg-1 transition-colors duration-fast ease-standard hover:bg-ink-3"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded-[var(--r-ctl)] bg-coral/100 px-3 py-1.5 text-aux font-medium text-accent-fg transition-[background-color,transform] duration-fast ease-standard hover:bg-coral-hover active:scale-[0.96]"
              >
                保存
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="p-4">
              <h3 className="mb-1 text-meta font-medium uppercase tracking-wide text-ink-fg-3">
                背景
              </h3>
              <p className="text-body leading-6 text-ink-fg-1">{background}</p>
            </div>
            <div className="border-t border-ink-border-soft p-4">
              <h3 className="mb-1 text-meta font-medium uppercase tracking-wide text-ink-fg-3">
                目标
              </h3>
              <p className="text-body leading-6 text-ink-fg-1">{goal}</p>
            </div>
          </>
        )}

        {/* 完成标志 —— 同一张卡的第三段（底色略深 + 上分隔线），换 CircleCheckBig 行式。 */}
        <div className="border-t border-ink-border-soft bg-ink-fg/[0.02] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-meta font-medium text-ink-fg-2">完成标志</h3>
            <Progress done={done} total={checks.length} />
          </div>
          <CheckList
            items={checks}
            onToggle={toggle}
            addLabel="＋ 加一条可判定的完成标志，勾满即可推进到「已完成」"
          />
          {done === checks.length && checks.length > 0 ? (
            <div className="mt-3 flex items-start gap-2 rounded-[var(--r-ctl)] border border-ok/25 bg-ok/10 px-3 py-2 text-aux text-ok">
              <CircleCheckBig size={13} className="mt-0.5 shrink-0" />
              <span>完成标志已全部满足，可以把这件事推进到「已完成」</span>
            </div>
          ) : null}
        </div>
      </div>

      <p className="mt-3 border-t border-ink-border pt-3 text-meta leading-5 text-ink-fg-3">
        存储上有一处要 owner 拍板：这两段落地时可以仍存在同一个{' '}
        <code className="text-ink-fg-2">matter.description</code> 里（用{' '}
        <code className="text-ink-fg-2">## 背景</code> /{' '}
        <code className="text-ink-fg-2">## 目标</code> 两个 Markdown
        小标题分段，零迁移、Agent 的写权限与审批规则原样不动）， 也可以拆成两列（读起来更硬，但要
        DB 加列 + 迁移 + 提案面 / 审批卡 / 导出四处跟着改）。 上面这版画的是拆两段的编辑体验，两种存储方案都能这么呈现。
      </p>
    </section>
  )
}

/* ── 增补 2：待办项列表 ────────────────────────────────────────── */

function TodoSection(): React.ReactElement {
  const [items, setItems] = useState<Check[]>(TODOS)
  const done = items.filter((i) => i.done).length
  const toggle = (id: string): void =>
    setItems((cur) => cur.map((i) => (i.id === id ? { ...i, done: !i.done } : i)))

  return (
    <section className="rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-5">
      <div className="mb-3">
        <h2 className="text-body font-semibold">增补 2 —— 待办项换行式 checkbox</h2>
        <p className="mt-1 text-meta text-ink-fg-3">
          点整行切换；未完成图标 <code className="text-ink-fg-2">text-ink-fg-3</code>，完成后转{' '}
          <code className="text-ink-fg-2">text-ok</code> + 文本 line-through，过渡走{' '}
          <code className="text-ink-fg-2">duration-fast</code>。
        </p>
      </div>

      <div className="rounded-[var(--r-card)] border border-ink-border bg-ink-1/75 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-meta font-medium text-ink-fg-2">待办项</h3>
          <Progress done={done} total={items.length} />
        </div>
        <CheckList items={items} onToggle={toggle} addLabel="＋ 添加待办项" />
      </div>
    </section>
  )
}

/* ── 增补 1 附表：给 Agent 的说明怎么改 ────────────────────────── */

interface CopyRow {
  where: string
  now: string
  next: string
}

/** Agent 真正读到的文案（工具 describe / 任务契约）。这几条不改，Agent 还会往「核心目标」填。 */
const AGENT_ROWS: CopyRow[] = [
  {
    where: 'ai-gateway/tools/schemas.ts:255\nmatterCreateSchema.description',
    now: "The Matter's goal and background (shown to the owner as 「核心目标 / 目的与背景」): why this is being pursued, what success looks like, and the minimum context needed to judge progress later. …",
    next: "Background and goal — the field the owner sees as 「背景与目标」. Write it in two labelled parts: 「背景」 how this came about, who is involved, the constraints and decisions already made; 「目标」 what must be true when this is finished. Do NOT put the checklist here — that is goal_checks（完成标志）. …（其余「不要抄邮件正文 / 之后改要审批」原样保留）"
  },
  {
    where: 'ai-gateway/tools/schemas.ts:337\nmatterPatchSchema.description',
    now: "Rewrite the Matter's goal and background（核心目标）. This is the owner's own statement of intent — change it ONLY when the user has just told you the goal or scope moved. …",
    next: "Rewrite the Matter's 背景与目标 (background and goal). This is the owner's own statement of intent — change it ONLY when the user has just told you the background or the goal moved. …（后半段照旧）"
  },
  {
    where: 'ai-gateway/tools/schemas.ts:309\nmatterCreateSchema.goal_checks',
    now: 'Definition of done（完成标志）: a short checklist of how the owner will know this Matter is complete … Set it at creation when the user has stated or implied what done means.',
    next: 'Definition of done（完成标志）— the third block of the 「背景与目标」 card, kept separate from the prose in `description`: a short checklist of how the owner will know this Matter is complete …（其余照旧）'
  },
  {
    where: 'ai-gateway/tools/schemas.ts:348\nmatterPatchSchema.goal_checks',
    now: 'Replace the definition of done（完成标志）— the whole checklist, not a delta. … Same approval + follow-up-run rules as description.',
    next: '同上，末句改成 Same approval + follow-up-run rules as 背景与目标（`description`）.'
  },
  {
    where: 'ai-gateway/tools/matters.ts:383\nmatter_create tool description',
    now: 'Fill `description` (the goal and background: why this is pursued and what success looks like) with real substance, and set `goal_checks` when the user can state what done means …',
    next: 'Fill `description`（背景与目标）with two parts — 背景: how this came about and what constrains it; 目标: what must be true when it is done — and set `goal_checks`（完成标志）when the user can state how done is judged …'
  },
  {
    where: 'ai-gateway/tools/matters.ts:409\nmatter_update tool description',
    now: "…: `description` (the core goal) and `goal_checks` (definition of done) — change them only when the user has just said the goal or the finish line moved …",
    next: "…: `description`（背景与目标）and `goal_checks`（完成标志）— change them only when the user has just said the background, the goal, or the finish line moved …"
  },
  {
    where: 'src/matters/run_spec.py:128\n跟进 run 任务契约',
    now: '用户写的核心目标不可改写，也不要在摘要里复述。',
    next: '用户写的背景与目标不可改写，也不要在摘要里复述；完成标志同理，只能在提案里建议增删。'
  },
  {
    where: 'src/matters/create_research.py:_description()\n创建对话框预填草稿',
    now: '背景：围绕邮件「…」推进此事。\\n来信要点：…',
    next: '## 背景\\n围绕邮件「…」推进此事。来信要点：…\\n\\n## 目标\\n（留空给 owner 写）—— 这条链路没有 LLM，写不出目标，但两段小标题先摆好，owner 只需补下半段。'
  }
]

/** 界面与产物侧的同名文案。改了 Agent 说明而这些没跟，两边就分裂成两个词。 */
const UI_ROWS: CopyRow[] = [
  { where: 'i18n matters.state.descriptionLabel', now: '核心目标', next: '背景与目标' },
  {
    where: 'i18n matters.state.noDescription',
    now: '还没有填写核心目标。',
    next: '还没有填写背景与目标。'
  },
  {
    where: 'i18n matters.state.descriptionPlaceholder',
    now: '这件事的背景是什么，要达成什么？',
    next: '背景：这件事怎么来的、有哪些约束；目标：做完时什么成立。'
  },
  { where: 'i18n matters.eventField.description', now: '核心目标', next: '背景与目标' },
  {
    where: 'i18n matters.create.description（创建对话框）',
    now: '目的与背景',
    next: '背景与目标（同一概念固定同一个词，别再留两种叫法）'
  },
  {
    where: 'i18n matters.chat.prompts.updateSummaryPrompt',
    now: '…也不要复述核心目标。',
    next: '…也不要复述背景与目标。'
  },
  { where: 'src/matters/export.py:124（Markdown 导出）', now: '## 核心目标', next: '## 背景与目标' },
  {
    where: 'frontend/tests/shared/MatterChatSurfaces.test.tsx:318',
    now: "getByRole('textbox', { name: /核心目标/ })",
    next: '跟着改成 /背景与目标/，否则测试红'
  }
]

function CopyTable({ rows }: { rows: CopyRow[] }): React.ReactElement {
  return (
    <table className="w-full table-fixed border-collapse text-meta">
      <thead className="text-ink-fg-3">
        <tr className="text-left align-bottom">
          <th className="w-[22%] pb-2 pr-3 font-medium">位置</th>
          <th className="w-[39%] pb-2 pr-3 font-medium">现在怎么写</th>
          <th className="w-[39%] pb-2 font-medium">建议改成</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.where} className="border-t border-ink-border align-top">
            <td className="whitespace-pre-line break-all py-2.5 pr-3 font-mono text-[11px] leading-4 text-ink-fg-2">
              {row.where}
            </td>
            <td className="whitespace-pre-line break-words py-2.5 pr-3 leading-5 text-ink-fg-3">{row.now}</td>
            <td className="whitespace-pre-line break-words py-2.5 leading-5 text-ink-fg-1">{row.next}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function AgentCopySection(): React.ReactElement {
  return (
    <section className="rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-5">
      <div className="mb-3">
        <h2 className="text-body font-semibold">
          增补 1 附表 —— 给 Agent 的说明怎么改（只列建议文案，源码未动）
        </h2>
        <p className="mt-1 text-meta leading-5 text-ink-fg-3">
          Agent 不看界面，只看工具 describe 和跟进 run 的任务契约。界面改成「背景与目标」而这几段还写着
          goal / 核心目标，Agent 就会继续只填一段目标、不写背景。
        </p>
      </div>
      <CopyTable rows={AGENT_ROWS} />

      <h3 className="mb-2 mt-6 text-meta font-medium text-ink-fg-2">界面与产物侧的同名文案</h3>
      <CopyTable rows={UI_ROWS} />

      <p className="mt-3 border-t border-ink-border pt-3 text-meta leading-5 text-ink-fg-3">
        字段名不动（仍是 <code className="text-ink-fg-2">description</code> /{' '}
        <code className="text-ink-fg-2">goal_checks</code>）：改列名要连带迁移、提案白名单{' '}
        <code className="text-ink-fg-2">PROPOSAL_FIELD_WHITELIST</code>、事件字段表、导出与一堆测试，
        而 owner 要的是展示与说明口径一致，不是换 schema。
      </p>
    </section>
  )
}

export function Additions(): React.ReactElement {
  return (
    <>
      <GoalSection />
      <AgentCopySection />
      <TodoSection />
    </>
  )
}
