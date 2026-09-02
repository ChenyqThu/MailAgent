// F Agent 侧（design §5 §1.4 §9.3 §9.4）

import * as React from 'react'
import {
  AlertTriangle,
  Ban,
  Bot,
  Check,
  ChevronDown,
  FileText,
  FolderTree,
  Hand,
  Lock,
  Paperclip,
  Search,
  Send,
  Sparkles,
  TerminalSquare,
  X
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { Button } from '@shared/components/ui/button'
import { CollapseChevron, CollapsibleRegion } from '@shared/components/ui/collapsible'
import {
  SegIconSelect,
  ToolCategoryGroup,
  type SegOption
} from '@shared/components/connectors/parts'

import { fileById, HITS, RECENT_FILE_IDS } from '../fixtures'
import { S } from '../strings'
import { Demo, Notice, Pill, SceneHead, StateBar, StateSwitch } from '../parts/kit'
import { displayName, toneOf } from '../parts/fileMeta'
import { HitRow } from './e-search'

/* ── F1 第 8 张能力卡 ──────────────────────────────────────────── */

type LibTier = 'off' | 'read' | 'write'

function CapabilityCard({
  icon,
  title,
  description,
  danger = false,
  children
}: {
  icon: React.ReactNode
  title: string
  description: string
  danger?: boolean
  children: React.ReactNode
}): React.ReactElement {
  // 逐属性照 agents/custom-agent/CapabilityCards.tsx 的 CapabilityCard（那是文件内
  // 私有组件，import 不到；类名一字不改地重排，落地时删掉这份、直接加进原文件）。
  return (
    <section
      className={cn(
        'flex min-h-[178px] flex-col rounded-[var(--r-card)] border p-3.5',
        danger ? 'border-fail/30 bg-fail/5' : 'border-ink-border bg-ink-1/50'
      )}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            'grid size-8 shrink-0 place-items-center rounded-lg border',
            danger
              ? 'border-fail/25 bg-fail/10 text-fail'
              : 'border-ink-border-soft bg-ink-1/75 text-ink-fg-1'
          )}
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className={cn('text-body font-semibold', danger ? 'text-fail' : 'text-ink-fg')}>
            {title}
          </h3>
          <p className="mt-0.5 text-meta leading-relaxed text-ink-fg-3">{description}</p>
        </div>
      </div>
      <div className="mt-auto pt-3">{children}</div>
    </section>
  )
}

function TierButtons({
  tiers,
  value,
  onChange,
  label
}: {
  tiers: readonly LibTier[]
  value: LibTier
  onChange(t: LibTier): void
  label(t: LibTier): string
}): React.ReactElement {
  return (
    <div className="grid auto-cols-fr grid-flow-col gap-1 rounded-lg bg-ink-1/70 p-1">
      {tiers.map((tier) => {
        const active = tier === value
        return (
          <button
            key={tier}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(tier)}
            className={cn(
              'min-h-8 rounded-md border px-2 text-meta font-medium transition-colors duration-fast',
              active
                ? 'border-coral/50 bg-coral/12 text-coral'
                : 'border-transparent text-ink-fg-2 hover:border-ink-border hover:bg-ink-3'
            )}
          >
            {label(tier)}
          </button>
        )
      })}
    </div>
  )
}

const TIER_LABEL: Record<LibTier, string> = {
  off: S.agent.tierOff,
  read: S.agent.tierRead,
  write: S.agent.tierWrite
}

export function F1(): React.ReactElement {
  const [tier, setTier] = React.useState<LibTier>('read')
  const [trigger, setTrigger] = React.useState<'manual' | 'headless'>('manual')

  return (
    <>
      <StateBar>
        <StateSwitch
          label="档位"
          value={tier}
          options={[
            { value: 'off', label: '关闭' },
            { value: 'read', label: '只读' },
            { value: 'write', label: '可写' }
          ]}
          onChange={(v) => setTier(v as LibTier)}
        />
        <StateSwitch
          label="触发源"
          value={trigger}
          options={[
            { value: 'manual', label: '手动对话' },
            { value: 'headless', label: '定时 / 无人值守' }
          ]}
          onChange={(v) => setTrigger(v as typeof trigger)}
        />
      </StateBar>

      <div className="mk-stage-body">
        <SceneHead
          id="F1"
          title="custom agent 配置页第 8 张能力卡"
          design="§5.2（L12）"
          note="三档逐级 superset。write 档可写 Agents 文档 + rw 挂载根，**不含**我的文档（那是人的地盘）。旁边把现有 files 卡（grant_exec）改名「命令与本机文件」——不改的话两张卡语义相撞（一张说「文件」一张也说「文件」）。"
        />

        <div className="grid max-w-[820px] grid-cols-2 gap-3">
          <CapabilityCard
            icon={<FolderTree size={16} strokeWidth={1.9} aria-hidden />}
            title={S.agent.capabilityTitle}
            description={S.agent.capabilityDesc}
          >
            <TierButtons
              tiers={['off', 'read', 'write']}
              value={tier}
              onChange={setTier}
              label={(t) => TIER_LABEL[t]}
            />
            <p className="mt-2 text-meta leading-relaxed text-ink-fg-3">
              {tier === 'off'
                ? '7 个 library 工具都不注册给模型。'
                : tier === 'read'
                  ? `library_list / library_read / library_search。${S.agent.readScope}`
                  : `再加 library_append / write / move / delete。${S.agent.writeScope}`}
            </p>
            {tier === 'write' ? (
              <p className="mt-1.5 text-meta leading-relaxed text-warn">
                {trigger === 'headless'
                  ? S.agent.headlessNote
                  : '手动对话里 append / write 出厂免卡（auto），move / delete 出厂弹卡（ask）。'}
              </p>
            ) : null}
          </CapabilityCard>

          <CapabilityCard
            icon={<TerminalSquare size={16} strokeWidth={1.9} aria-hidden />}
            title={S.agent.filesCardTitle}
            description={S.agent.filesCardDesc}
            danger
          >
            <div className="flex items-center gap-2">
              <span className="rounded-md border border-fail/30 bg-fail/10 px-2 py-1 text-meta font-medium text-fail">
                关闭
              </span>
              <span className="text-meta text-ink-fg-3">原名「文件」→ 改名（一行 i18n，L12）</span>
            </div>
            <p className="mt-2 text-meta leading-relaxed text-ink-fg-3">
              这张卡管的是 <code className="font-mono">file_read / file_write / run_command</code>：
              任意绝对路径、manual only、恒弹卡。资料库卡管的是「已授权根内、有索引有 id 有历史」
              的那一套，两者分工不同。
            </p>
          </CapabilityCard>
        </div>

        <div className="mt-4 max-w-[820px]">
          <Notice tone="info">
            档位向上取整的纪律照旧：显示的档恒 ⊇ 实际启用的工具集（闸在
            <code className="mx-1 font-mono">
              frontend/tests/shared/customAgentCapabilities.test.ts
            </code>
            ）。 library 组不进默认安全集 —— 新建 agent 出厂是「关闭」。
          </Notice>
        </div>
      </div>
    </>
  )
}

/* ── F2 工具审批档 ─────────────────────────────────────────────── */

interface ToolRow {
  name: string
  tier: 'silent' | 'edit'
  cls: 'read' | 'domain_write'
  factory: 'auto' | 'ask'
  danger?: boolean
  note: string
}

const LIBRARY_TOOLS: ToolRow[] = [
  {
    name: 'library_list',
    tier: 'silent',
    cls: 'read',
    factory: 'auto',
    note: '列目录。silent，不出卡片。'
  },
  {
    name: 'library_read',
    tier: 'silent',
    cls: 'read',
    factory: 'auto',
    note: '读正文。非文本类返回的是解析版 markdown（附 extractor / truncated），二进制永不进模型。输出恒套 fenceUntrusted(LIBRARY_FILE) —— 库里有邮件附件正文。'
  },
  {
    name: 'library_search',
    tier: 'silent',
    cls: 'read',
    factory: 'auto',
    note: '纯关键词（P3 起混合）。工具描述明说「无字段语法」，不抄邮件 DSL 说明。'
  },
  {
    name: 'library_append',
    tier: 'edit',
    cls: 'domain_write',
    factory: 'auto',
    note: '只追加，冲突面为零。三条 belt（事项跟进 / 行动项 / 通讯录治理）按名放行它。'
  },
  {
    name: 'library_write',
    tier: 'edit',
    cls: 'domain_write',
    factory: 'auto',
    note: 'mode: create_new | overwrite；overwrite 必带 expected_hash。editableFields: [path, content]。'
  },
  {
    name: 'library_move',
    tier: 'edit',
    cls: 'domain_write',
    factory: 'ask',
    note: '改路径 = 别人手里的路径字符串可能失效（id 不变）。不进无人值守免卡通道。'
  },
  {
    name: 'library_delete',
    tier: 'edit',
    cls: 'domain_write',
    factory: 'ask',
    danger: true,
    note: '进 .trash（软删可恢复），所以是 danger_auto 而不是 configurable=false。不进无人值守免卡通道。'
  }
]

export function F2(): React.ReactElement {
  const [prefs, setPrefs] = React.useState<Record<string, 'auto' | 'ask' | 'deny'>>(
    Object.fromEntries(LIBRARY_TOOLS.map((t) => [t.name, t.factory]))
  )
  const [expanded, setExpanded] = React.useState(true)
  const [confirm, setConfirm] = React.useState<string | null>(null)

  const options: SegOption<'auto' | 'ask' | 'deny'>[] = [
    { value: 'auto', label: '免卡', icon: Check },
    { value: 'ask', label: '弹卡', icon: Hand },
    { value: 'deny', label: '不给', icon: Ban }
  ]

  return (
    <>
      <StateBar>
        <span className="text-meta text-ink-fg-2">
          每行可切三档。把 library_delete 切到「免卡」会先弹红色确认（danger_auto）。
        </span>
      </StateBar>

      <div className="mk-stage-body">
        <SceneHead
          id="F2"
          title="主 agent 的工具审批档：7 个 library 工具"
          design="§5.1 §5.3"
          note="真实的这一面在 /connectors 配置台的「内置工具」域（数据来自 GET /api/agent/tool-prefs，前端不手抄工具名）。这里复用了它的 SegIconSelect 与 ToolCategoryGroup 两个原语。"
        />

        <div className="max-w-[760px] rounded-[var(--r-card)] border border-ink-border bg-ink-1 p-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-lead font-medium text-ink-fg">{S.agent.toolPrefTitle}</h2>
              <p className="mt-1 text-aux leading-relaxed text-ink-fg-2">
                主 agent 的矩阵直通：能力矩阵全开 = 出厂档，owner 在这里逐个调。
              </p>
            </div>
          </div>

          <div className="mt-3">
            <ToolCategoryGroup
              id="library-tools"
              expanded={expanded}
              onToggle={() => setExpanded((v) => !v)}
              labelPill={
                <span className="rounded-full bg-ink-4 px-2 py-0.5 text-micro font-medium text-ink-fg-2">
                  library
                </span>
              }
              count={LIBRARY_TOOLS.length}
            >
              <div className="pt-1">
                {LIBRARY_TOOLS.map((row) => (
                  <div key={row.name} className="flex items-start gap-3 py-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="break-all font-mono text-micro text-ink-fg">
                          {row.name}
                        </span>
                        <Pill tone="ink">{row.tier}</Pill>
                        <Pill tone={row.cls === 'read' ? 'info' : 'accent'}>{row.cls}</Pill>
                        {row.danger ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-warn/15 px-1.5 py-0.5 text-micro font-medium text-warn">
                            <AlertTriangle className="size-2.5" aria-hidden />
                            danger
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-micro leading-relaxed text-ink-fg-3">
                        {row.note}
                      </div>
                    </div>
                    <div className="shrink-0">
                      <SegIconSelect
                        value={prefs[row.name] ?? row.factory}
                        options={options}
                        disabled={false}
                        ariaLabel={`${row.name} 审批档`}
                        onChange={(next) => {
                          if (next === 'auto' && row.danger) {
                            setConfirm(row.name)
                            return
                          }
                          setPrefs((p) => ({ ...p, [row.name]: next }))
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </ToolCategoryGroup>
          </div>

          {confirm ? (
            <div className="mt-3 rounded-[var(--r-ctl)] border border-[rgb(var(--c-fail)/0.35)] bg-[rgb(var(--c-fail)/0.08)] px-3 py-2">
              <div className="flex items-center gap-1.5 text-meta font-medium text-[rgb(var(--c-fail))]">
                <AlertTriangle className="size-3.5 shrink-0" aria-hidden />把{' '}
                <code className="font-mono">{confirm}</code> 设为免卡？
              </div>
              <p className="mt-1 text-micro leading-relaxed text-ink-fg-2">
                之后 agent 删文件不再问你。删除是软删（进 .trash，30 天可恢复），所以这个档
                允许调，但默认永远是「弹卡」。
              </p>
              <div className="mt-2 flex justify-end gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                  {S.act.cancel}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    setPrefs((p) => ({ ...p, [confirm]: 'auto' }))
                    setConfirm(null)
                  }}
                >
                  确认设为免卡
                </Button>
              </div>
            </div>
          ) : null}

          <div className="mt-3 rounded-[var(--r-ctl)] border border-ink-border-soft bg-ink-2 px-3 py-2">
            <div className="flex items-center gap-1.5 text-aux font-medium text-ink-fg">
              <Lock size={13} strokeWidth={2} aria-hidden className="text-ink-fg-2" />
              无人值守（cron / 不可信触发源）的地板
            </div>
            <ul className="mt-1 space-y-0.5 text-meta leading-relaxed text-ink-fg-2">
              <li>
                只有目标路径以 <code className="font-mono">agent-docs/</code> 开头、且大小在上限内的{' '}
                <code className="font-mono">library_append / library_write</code>{' '}
                免卡（policyEvaluate 规则）。
              </li>
              <li>
                <code className="font-mono">my-docs/</code>{' '}
                与所有挂载根**恒弹卡**；投影区服务端直接拒写。
              </li>
              <li>
                <code className="font-mono">library_move / library_delete</code> 不在免卡通道里。
              </li>
            </ul>
          </div>
        </div>
      </div>
    </>
  )
}

/* ── F3 对话里的工具卡 ─────────────────────────────────────────── */

type CardPhase = 'pending' | 'approved' | 'done' | 'rejected' | 'conflict'

function CardFrame({
  icon,
  title,
  phase,
  children
}: {
  icon: React.ReactNode
  title: string
  phase: CardPhase
  children: React.ReactNode
}): React.ReactElement {
  // 逐属性照 assistant/tools/_cardShell.tsx 的 CardFrame（原件用 useTranslation +
  // assistant-ui 的 respondToApproval，拖不进 mockup；壳的类名一字不改）。
  const pill: Record<CardPhase, { label: string; klass: string }> = {
    pending: { label: '待确认', klass: 'bg-coral/15 text-coral' },
    approved: { label: '已授权', klass: 'bg-info/15 text-info' },
    done: { label: '已完成', klass: 'bg-ok/15 text-ok' },
    rejected: { label: '已拒绝', klass: 'bg-ink-3 text-ink-fg-2' },
    conflict: { label: '版本冲突', klass: 'bg-warn/15 text-warn' }
  }
  return (
    <div className="my-1.5 min-w-0 overflow-hidden rounded-[var(--r-card)] border border-ink-border-soft bg-ink-1">
      <div className="flex items-center gap-2 border-b border-ink-border-soft px-3 py-2">
        <span className="grid size-5 shrink-0 place-items-center rounded-md bg-ink-3 text-coral">
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-aux font-medium text-ink-fg">{title}</span>
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-meta font-medium',
            pill[phase].klass
          )}
        >
          {pill[phase].label}
        </span>
      </div>
      <div className="px-3 py-2.5">{children}</div>
    </div>
  )
}

function CardParams({ rows }: { rows: Array<[string, React.ReactNode]> }): React.ReactElement {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-meta">
      {rows.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt className="text-ink-fg-3">{k}</dt>
          <dd className="min-w-0 break-words text-ink-fg-1">{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  )
}

function ApprovalActions({
  onApprove,
  onReject,
  danger = false
}: {
  onApprove(): void
  onReject(): void
  danger?: boolean
}): React.ReactElement {
  return (
    <div className="mt-2.5 flex items-center gap-1.5">
      <Button size="sm" variant={danger ? 'destructive' : 'default'} onClick={onApprove}>
        <Check size={13} aria-hidden />
        {S.agent.approve}
      </Button>
      <Button size="sm" variant="ghost" onClick={onReject}>
        <X size={13} aria-hidden />
        {S.agent.reject}
      </Button>
    </div>
  )
}

const F3_CARDS = [
  { value: 'search', label: 'library_search 结果卡' },
  { value: 'read', label: 'library_read 折叠卡' },
  { value: 'write', label: 'library_write 审批卡' },
  { value: 'delete', label: 'library_delete（danger）' },
  { value: 'move', label: 'library_move 审批卡' },
  { value: 'conflict', label: '409 后的重试' }
]

export function F3(): React.ReactElement {
  const [which, setWhich] = React.useState('search')
  const [phase, setPhase] = React.useState<CardPhase>('pending')
  const [readOpen, setReadOpen] = React.useState(false)
  const [path, setPath] = React.useState('agent-docs/notes/2026-Q3 渠道复盘要点.md')
  const [content, setContent] = React.useState(
    '## 需要人确认的地方\n\n- 「客单价下滑」是否含一次性折扣？原表里没有拆分口径。\n'
  )

  return (
    <>
      <StateBar>
        <StateSwitch label="卡片" value={which} options={F3_CARDS} onChange={setWhich} />
        {which !== 'search' && which !== 'read' && which !== 'conflict' ? (
          <StateSwitch
            label="阶段"
            value={phase}
            options={[
              { value: 'pending', label: '待确认' },
              { value: 'approved', label: '已授权' },
              { value: 'done', label: '已完成' },
              { value: 'rejected', label: '已拒绝' }
            ]}
            onChange={(v) => setPhase(v as CardPhase)}
          />
        ) : null}
      </StateBar>

      <div className="mk-stage-body">
        <SceneHead
          id="F3"
          title="对话里的 library 工具卡"
          design="§5.1 §4"
          note="读工具是 silent（不出卡，最多一条折叠的结果条）；写工具走既有的审批卡外壳（_cardShell 的 CardFrame + CardParams + ApprovalActions）。write 是 edit-tier：审批时可以改 path 与 content，卡上显示 expected_hash。"
        />

        <div className="max-w-[620px] rounded-[var(--r-card)] border border-ink-border bg-ink-0 p-3">
          <div className="mb-2 flex items-center gap-2 text-meta text-ink-fg-3">
            <Bot size={13} strokeWidth={1.9} aria-hidden />主 Agent · 对话流里的一段
          </div>

          {which === 'search' ? (
            <div className="rounded-[var(--r-card)] border border-ink-border-soft bg-ink-1 px-3 py-2">
              <div className="flex items-center gap-1.5 text-meta text-ink-fg-2">
                <Search size={12} strokeWidth={2} aria-hidden />
                <code className="font-mono text-micro">library_search</code>
                <span className="text-ink-fg-3">「客单价」→ 5 个结果</span>
                <span className="ml-auto font-mono text-micro text-ink-fg-3">0.09s</span>
              </div>
              <div className="mt-1.5 space-y-px">
                {HITS.slice(0, 3).map((h) => {
                  const f = fileById(h.fileId)
                  if (!f) return null
                  return <HitRow key={h.fileId} hit={h} file={f} compact />
                })}
              </div>
              <div className="mt-1.5 text-micro text-ink-fg-3">
                silent 档：不出审批卡，只在流里留一条可折叠的结果条。
              </div>
            </div>
          ) : null}

          {which === 'read' ? (
            <div className="rounded-[var(--r-card)] border border-ink-border-soft bg-ink-1">
              <button
                type="button"
                onClick={() => setReadOpen((v) => !v)}
                className="flex w-full items-center gap-1.5 px-3 py-2 text-left"
              >
                <CollapseChevron expanded={readOpen} size={12} className="text-ink-fg-3" />
                <FileText size={12} strokeWidth={2} aria-hidden className="text-ink-fg-2" />
                <code className="font-mono text-micro text-ink-fg-1">library_read</code>
                <span className="min-w-0 flex-1 truncate text-meta text-ink-fg-3">
                  my-docs/合同/服务协议-2026.pdf
                </span>
                <Pill tone="ink">pypdf</Pill>
              </button>
              <CollapsibleRegion expanded={readOpen} bodyClassName="px-3 pb-2.5">
                <div className="rounded-[var(--r-ctl)] border border-ink-border-soft bg-ink-2 px-2.5 py-2">
                  <div className="mb-1 font-mono text-micro text-ink-fg-3">
                    ~~~LIBRARY_FILE（不可信内容围栏）
                  </div>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-micro leading-5 text-ink-fg-2 scrollbar-thin">
                    {fileById(402)?.body}
                  </pre>
                  <div className="mt-1 font-mono text-micro text-ink-fg-3">
                    ~~~ · 12000 chars / 2 MB 上限 · content_hash ee11dd22
                  </div>
                </div>
              </CollapsibleRegion>
            </div>
          ) : null}

          {which === 'write' ? (
            <CardFrame
              icon={<FileText size={12} strokeWidth={2} aria-hidden />}
              title="写入资料库文件"
              phase={phase}
            >
              <CardParams
                rows={[
                  [
                    '工具',
                    <code key="t" className="font-mono text-micro">
                      library_write
                    </code>
                  ],
                  ['模式', 'overwrite'],
                  [
                    S.agent.expectedHash,
                    <code key="h" className="font-mono text-micro">
                      5f3c81ea
                    </code>
                  ]
                ]}
              />
              <div className="mt-2 space-y-1.5">
                <label className="block">
                  <span className="mb-1 block text-micro text-ink-fg-3">path（可改）</span>
                  <input
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    disabled={phase !== 'pending'}
                    className="h-7 w-full rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2 font-mono text-micro text-ink-fg outline-none focus-visible:border-coral/60 disabled:opacity-60"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-micro text-ink-fg-3">content（可改）</span>
                  <textarea
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    disabled={phase !== 'pending'}
                    className="h-24 w-full resize-y rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2 py-1.5 font-mono text-micro leading-5 text-ink-fg outline-none focus-visible:border-coral/60 disabled:opacity-60"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-micro text-ink-fg-3">{S.changeNote}</span>
                  <input
                    defaultValue="补一条待确认"
                    disabled={phase !== 'pending'}
                    className="h-7 w-full rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2 text-micro text-ink-fg outline-none focus-visible:border-coral/60 disabled:opacity-60"
                  />
                </label>
              </div>
              {phase === 'pending' ? (
                <ApprovalActions
                  onApprove={() => setPhase('done')}
                  onReject={() => setPhase('rejected')}
                />
              ) : null}
            </CardFrame>
          ) : null}

          {which === 'move' ? (
            <CardFrame
              icon={<FileText size={12} strokeWidth={2} aria-hidden />}
              title="移动资料库文件"
              phase={phase}
            >
              <CardParams
                rows={[
                  [
                    '工具',
                    <code key="t" className="font-mono text-micro">
                      library_move
                    </code>
                  ],
                  [
                    '从',
                    <code key="f" className="font-mono text-micro">
                      agent-docs/notes/log.md
                    </code>
                  ],
                  [
                    '到',
                    <code key="d" className="font-mono text-micro">
                      agent-docs/reports/log.md
                    </code>
                  ]
                ]}
              />
              <p className="mt-2 text-meta leading-relaxed text-ink-fg-2">
                id 不变，事项 / 会话里的引用不会断；但别的 agent 手里记着的**路径字符串**会失效。
                出厂 ask 就是为这个。
              </p>
              {phase === 'pending' ? (
                <ApprovalActions
                  onApprove={() => setPhase('done')}
                  onReject={() => setPhase('rejected')}
                />
              ) : null}
            </CardFrame>
          ) : null}

          {which === 'delete' ? (
            <CardFrame
              icon={<AlertTriangle size={12} strokeWidth={2} aria-hidden />}
              title="删除资料库文件"
              phase={phase}
            >
              <CardParams
                rows={[
                  [
                    '工具',
                    <code key="t" className="font-mono text-micro">
                      library_delete
                    </code>
                  ],
                  [
                    '文件',
                    <code key="f" className="font-mono text-micro">
                      agent-docs/notes/废弃草稿.md
                    </code>
                  ],
                  ['去向', '.trash（30 天内可恢复）']
                ]}
              />
              <div className="mt-2 rounded-[var(--r-ctl)] border border-[rgb(var(--c-fail)/0.35)] bg-[rgb(var(--c-fail)/0.08)] px-2.5 py-1.5 text-meta leading-relaxed text-ink-fg-1">
                <span className="font-medium text-fail">danger</span> —— 这一档即使 owner 把它调成
                「免卡」也会先弹一次红色确认。
              </div>
              {phase === 'pending' ? (
                <ApprovalActions
                  danger
                  onApprove={() => setPhase('done')}
                  onReject={() => setPhase('rejected')}
                />
              ) : null}
            </CardFrame>
          ) : null}

          {which === 'conflict' ? (
            <>
              <CardFrame
                icon={<FileText size={12} strokeWidth={2} aria-hidden />}
                title="写入资料库文件"
                phase="conflict"
              >
                <CardParams
                  rows={[
                    [
                      '工具',
                      <code key="t" className="font-mono text-micro">
                        library_write
                      </code>
                    ],
                    [
                      '文件',
                      <code key="f" className="font-mono text-micro">
                        agent-docs/notes/log.md
                      </code>
                    ],
                    [
                      '结果',
                      <span key="r" className="text-warn">
                        409 E_VERSION_CONFLICT
                      </span>
                    ],
                    [
                      'hash',
                      <span key="h" className="font-mono text-micro">
                        期望 77de01c9 · 当前 8a1c02fe
                      </span>
                    ]
                  ]}
                />
                <p className="mt-2 text-meta leading-relaxed text-ink-fg-2">
                  {S.agent.conflictRetry}
                </p>
              </CardFrame>
              <div className="rounded-[var(--r-card)] border border-ink-border-soft bg-ink-1 px-3 py-2 text-meta text-ink-fg-2">
                <div className="flex items-center gap-1.5">
                  <FileText size={12} strokeWidth={2} aria-hidden className="text-ink-fg-3" />
                  <code className="font-mono text-micro">library_read</code>
                  <span className="text-ink-fg-3">读回当前版本…</span>
                </div>
                <div className="mt-1 flex items-center gap-1.5">
                  <Check size={12} strokeWidth={2} aria-hidden className="text-ok" />
                  <code className="font-mono text-micro">library_write</code>
                  <span className="text-ink-fg-3">合并后重试成功（expected_hash 8a1c02fe）</span>
                </div>
                <div className="mt-1.5 text-micro text-ink-fg-3">
                  409 只自动重试一次；再冲突就交给人（design §4）。
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </>
  )
}

/* ── F4 data-library chip 与 composer 提示 ─────────────────────── */

export function F4(): React.ReactElement {
  const [archived, setArchived] = React.useState(true)
  const [noticeSeen, setNoticeSeen] = React.useState(false)
  const f = fileById(201)!

  return (
    <>
      <StateBar>
        <StateSwitch
          label="入库结果"
          value={archived ? 'ok' : 'fail'}
          options={[
            { value: 'ok', label: '已归档' },
            { value: 'fail', label: '入库失败（回落）' }
          ]}
          onChange={(v) => setArchived(v === 'ok')}
        />
        <StateSwitch
          label="一次性提示"
          value={noticeSeen ? 'seen' : 'new'}
          options={[
            { value: 'new', label: '第一次（显示）' },
            { value: 'seen', label: '看过了（不显示）' }
          ]}
          onChange={(v) => setNoticeSeen(v === 'seen')}
        />
      </StateBar>

      <div className="mk-stage-body">
        <SceneHead
          id="F4"
          title="消息气泡上的 data-library chip + composer 一次性提示"
          design="§1.4（L3）"
          note="发送即入库：非图片附件先 POST /library/files 落到 chat-attachments/{年-月}/，消息追加一个 data-library part（AI SDK DataUIPart，仓里 data-compact 是先例），零 CHAT_DB 迁移。模型看到的内容不变（仍是抽取文本预置）。入库失败就回落现状，chip 标「未归档」。隐私语义变了，所以 composer 附件区要有一次性提示。"
        />

        <div className="max-w-[640px] space-y-4">
          <Demo title="用户消息气泡" hint="chip 可点，点了跳到资料库并选中该文件">
            <div className="ml-auto max-w-[92%] rounded-[var(--r-card)] bg-ink-4 px-3 py-2.5">
              <p className="text-body leading-relaxed text-ink-fg">
                帮我把这份定价草案和上个季度的渠道数据对一下，重点看客单价。
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-micro transition-colors duration-fast',
                    archived
                      ? 'border-ink-border bg-ink-2 text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg'
                      : 'border-warn/30 bg-warn/10 text-warn'
                  )}
                  title={archived ? '打开资料库并选中这个文件' : S.chip.notArchivedHint}
                >
                  <Paperclip size={11} strokeWidth={2} aria-hidden />
                  <span className="max-w-[220px] truncate">{f.filename}</span>
                  <span className={archived ? 'text-ink-fg-3' : 'text-warn'}>
                    {archived ? S.chip.archived : S.chip.notArchived}
                  </span>
                </button>
              </div>
              {!archived ? (
                <p className="mt-1.5 text-micro leading-relaxed text-ink-fg-3">
                  {S.chip.notArchivedHint}
                </p>
              ) : null}
            </div>
          </Demo>

          <Demo title="composer 附件区" hint="第一次带附件发送时的一次性提示">
            <div className="rounded-[var(--r-card)] border border-ink-border bg-ink-1 p-2.5">
              {!noticeSeen ? (
                <div className="mb-2 flex items-start gap-2 rounded-[var(--r-ctl)] border border-info/25 bg-info/[0.07] px-2.5 py-1.5">
                  <Sparkles
                    size={12}
                    strokeWidth={2}
                    aria-hidden
                    className="mt-0.5 shrink-0 text-info"
                  />
                  <div className="min-w-0 flex-1 text-meta leading-relaxed text-ink-fg-1">
                    {S.chip.composerNotice}
                    <span className="ml-1 text-ink-fg-3">
                      落到 chat-attachments/2026-09/；删会话不会删这些文件。
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setNoticeSeen(true)}
                    aria-label="知道了"
                    className="shrink-0 rounded p-0.5 text-ink-fg-3 hover:bg-ink-3 hover:text-ink-fg"
                  >
                    <X size={12} aria-hidden />
                  </button>
                </div>
              ) : null}
              <div className="mb-2 flex flex-wrap gap-1.5">
                {[fileById(201)!, fileById(202)!].map((a) => {
                  const tone = toneOf(a)
                  const I = tone.Icon
                  return (
                    <span
                      key={a.id}
                      className="inline-flex items-center gap-1.5 rounded-full border border-ink-border bg-ink-2 px-2 py-1 text-micro text-ink-fg-1"
                    >
                      <I size={11} strokeWidth={2} className={tone.text} />
                      <span className="max-w-[180px] truncate">{a.filename}</span>
                      <X size={11} aria-hidden className="text-ink-fg-3" />
                    </span>
                  )
                })}
              </div>
              <div className="flex items-end gap-2">
                <div className="min-h-[56px] flex-1 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2.5 py-2 text-body text-ink-fg-3">
                  说点什么…
                </div>
                <Button size="icon" aria-label="发送">
                  <Send size={14} aria-hidden />
                </Button>
              </div>
            </div>
          </Demo>

          <Notice tone="warn">
            🔴 P2 第一件事实测：AI SDK 的{' '}
            <code className="mx-1 font-mono">convertToModelMessages</code> 默认丢弃 data part ——
            这是「模型看到的内容不变」成立的前提。实测一次再当事实； 若进了模型消息，gateway 侧要在
            prependInjectedContext 之前 strip。
          </Notice>
        </div>
      </div>
    </>
  )
}

/* ── F5 @ 提及 ─────────────────────────────────────────────────── */

export function F5(): React.ReactElement {
  const [surface, setSurface] = React.useState<'agent' | 'group'>('agent')
  const [open, setOpen] = React.useState(true)
  const [q, setQ] = React.useState('')
  const [picked, setPicked] = React.useState<number[]>([302])

  const recents = RECENT_FILE_IDS.map((id) => fileById(id)!).filter(Boolean)
  const list =
    q.trim() === ''
      ? recents
      : recents.filter((f) => displayName(f).toLowerCase().includes(q.trim().toLowerCase()))

  return (
    <>
      <StateBar>
        <StateSwitch
          label="场地"
          value={surface}
          options={[
            { value: 'agent', label: 'AgentComposer（dock / 会话 / 事项）' },
            { value: 'group', label: 'GroupComposer（群聊）' }
          ]}
          onChange={(v) => setSurface(v as typeof surface)}
        />
        <StateSwitch
          label="弹层"
          value={open ? 'open' : 'closed'}
          options={[
            { value: 'open', label: '打开' },
            { value: 'closed', label: '关闭' }
          ]}
          onChange={(v) => setOpen(v === 'open')}
        />
      </StateBar>

      <div className="mk-stage-body">
        <SceneHead
          id="F5"
          title="@ 提及资料库"
          design="§9.3（L14）"
          note="@ 有三套互不相通的实现。AgentComposer（Lexical directive）加第四组「资料库」是 P2 主入口，逐字抄 useMatterMentionAdapter 的四步范式。GroupComposer 是自写的裸文本弹层，加一组「资料」，消息 metadata.library_refs 记引用，装配时以一行「附带资料（用 library_read 读）：路径」前置。🔴 两处都**只发标识**（file_id / path / name / size），不发正文 —— 库里有邮件附件正文，把它当可信元数据注入等于绕过 ~~~email-excerpt 围栏。"
        />

        {/* 弹层是向上展开的，composer 压到容器底部才看得全（真 app 里 composer 本来就在底部）。 */}
        <div className="flex min-h-[420px] max-w-[620px] flex-col justify-end">
          <div className="relative rounded-[var(--r-card)] border border-ink-border bg-ink-1 p-2.5">
            {picked.length > 0 ? (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {picked.map((id) => {
                  const f = fileById(id)!
                  const tone = toneOf(f)
                  const I = tone.Icon
                  return (
                    <span
                      key={id}
                      className="inline-flex items-center gap-1.5 rounded-full border border-coral/35 bg-coral/10 px-2 py-1 text-micro text-ink-fg"
                    >
                      <I size={11} strokeWidth={2} className={tone.text} />
                      <span className="max-w-[200px] truncate">{displayName(f)}</span>
                      <button
                        type="button"
                        aria-label={`移除 ${displayName(f)}`}
                        onClick={() => setPicked((p) => p.filter((x) => x !== id))}
                        className="text-ink-fg-3 hover:text-ink-fg"
                      >
                        <X size={11} aria-hidden />
                      </button>
                    </span>
                  )
                })}
              </div>
            ) : null}

            <div className="min-h-[56px] rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2.5 py-2 text-body text-ink-fg">
              {surface === 'group' ? (
                <>
                  <span className="rounded bg-coral/15 px-1 text-coral">@法官</span> 看一下这份材料
                  <span className="text-ink-fg-3">|</span>
                </>
              ) : (
                <>
                  对比一下{' '}
                  <span className="rounded bg-coral/15 px-1 text-coral">@渠道复盘要点</span>{' '}
                  和这季度的数
                  <span className="text-ink-fg-3">|</span>
                </>
              )}
            </div>

            {open ? (
              <div className="absolute bottom-[calc(100%+6px)] left-2.5 z-30 w-[420px] overflow-hidden rounded-[var(--r-card)] border border-ink-border bg-ink-1 shadow-2xl">
                <div className="border-b border-ink-border px-2.5 py-1.5">
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="搜索资料库…"
                    className="w-full bg-transparent text-aux text-ink-fg outline-none placeholder:text-ink-fg-3"
                  />
                </div>
                <div className="max-h-[300px] overflow-y-auto p-1 scrollbar-thin">
                  {surface === 'agent' ? (
                    <>
                      <MentionGroup title="邮件" />
                      <MentionGroup title="Agent" />
                      <MentionGroup title="事项" />
                    </>
                  ) : (
                    <MentionGroup title="成员" />
                  )}
                  <div className="flex items-center gap-2 px-2 pb-1 pt-3 text-micro font-mono uppercase tracking-widest">
                    <span className="text-coral">
                      {surface === 'agent' ? S.mention.group : S.mention.groupShort}
                    </span>
                    <span className="text-ink-fg-3">
                      · {q.trim() === '' ? S.mention.recent : `${list.length} 个结果`}
                    </span>
                    <span className="ml-auto normal-case tracking-normal text-ink-fg-3">
                      新增的组
                    </span>
                  </div>
                  {list.map((f) => {
                    const tone = toneOf(f)
                    const I = tone.Icon
                    return (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => {
                          setPicked((p) => (p.includes(f.id) ? p : [...p, f.id]))
                          setOpen(false)
                        }}
                        className="flex w-full items-center gap-2 rounded-[var(--r-ctl)] px-2 py-1.5 text-left transition-colors duration-fast hover:bg-ink-3"
                      >
                        <span
                          className={cn('grid size-5 shrink-0 place-items-center rounded', tone.bg)}
                        >
                          <I size={11} strokeWidth={2} className={tone.text} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-aux text-ink-fg">
                            {displayName(f)}
                          </span>
                          <span className="block truncate font-mono text-micro text-ink-fg-3">
                            {f.rel_path}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            ) : null}
          </div>

          {surface === 'group' ? (
            <Demo title="群消息里的「附带资料」行" hint="装配时前置进 user 行，不塞正文">
              <div className="rounded-[var(--r-card)] border border-ink-border-soft bg-ink-1 px-3 py-2">
                <div className="text-body text-ink-fg">@法官 看一下这份材料</div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-[var(--r-ctl)] border border-ink-border-soft bg-ink-2 px-2 py-1 text-micro text-ink-fg-2">
                  <Paperclip size={11} strokeWidth={2} aria-hidden className="text-ink-fg-3" />
                  <span className="text-ink-fg-3">{S.chip.attachedRefs}：</span>
                  <code className="font-mono">agent-docs/notes/2026-Q3 渠道复盘要点.md</code>
                </div>
                <div className="mt-1 text-micro text-ink-fg-3">
                  成员 run 拿到 library_read / library_search 两个读工具（class read，与
                  group_history / group_members 同档；法官同样给），自己去读。
                </div>
              </div>
            </Demo>
          ) : (
            <div className="mt-3">
              <Notice tone="warn">
                🔴 落地时**必须**同时进 AgentComposer 那条「chip 被删就摘掉 mention」的对账 effect
                —— 漏了 = 用户删了 chip 模型照收（隐私回归）。另：审批 resume 会剥掉 injectedContext
                （approvalResume.ts），HITL 续跑后模型看不到 @ 的 envelope；正文本来靠工具读，写进
                工具描述即可。
              </Notice>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function MentionGroup({ title }: { title: string }): React.ReactElement {
  return (
    <>
      <div className="px-2 pb-1 pt-3 text-micro font-mono uppercase tracking-widest text-ink-fg-3">
        {title}
      </div>
      <div className="px-2 py-1 text-meta text-ink-fg-3">（既有的组，形态不变）</div>
    </>
  )
}

/* ── F6 通知 ───────────────────────────────────────────────────── */

export function F6(): React.ReactElement {
  return (
    <div className="mk-stage-body">
      <SceneHead
        id="F6"
        title="通知中心里的 library 型通知"
        design="§9.4"
        note="NotificationLink 是 8 型判别 union + 白名单，未知型静默 null（点了只标已读不跳转）。加 {type:'library', fileId} 的同时，后端信源必须同批真的发它 —— agent 无人值守写完 agent-docs/ 发一条，否则「写了没人知道」。白名单纪律：加信源时同步加档，不预留空位。"
      />
      <div className="max-w-[420px] overflow-hidden rounded-[var(--r-card)] border border-ink-border bg-ink-1 shadow-2xl">
        <div className="flex h-[41px] items-center gap-2 border-b border-ink-border px-3">
          <span className="flex-1 text-body font-medium text-ink-fg">通知</span>
          <span className="rounded-full bg-fail px-1.5 py-0.5 font-mono text-micro font-semibold text-white">
            3
          </span>
        </div>
        <div className="divide-y divide-ink-border-soft">
          <NotifyRow
            icon={<FolderTree size={13} strokeWidth={1.9} aria-hidden />}
            tone="ai"
            title={S.notify.libraryTitle}
            body="跟进 Agent 写了 agent-docs/notes/2026-Q3 渠道复盘要点.md"
            meta="8 分钟前 · 无人值守 · 免卡（agent-docs 通道）"
            unread
          />
          <NotifyRow
            icon={<FolderTree size={13} strokeWidth={1.9} aria-hidden />}
            tone="ai"
            title={S.notify.libraryTitle}
            body="报告 Agent 追加了 agent-docs/notes/log.md"
            meta="昨天 19:12 · 定时"
          />
          <NotifyRow
            icon={<Bot size={13} strokeWidth={1.9} aria-hidden />}
            tone="ink"
            title="Agent 执行完成"
            body="Q3 渠道复盘会 · 跟进 run 结束"
            meta="昨天 19:10"
          />
        </div>
      </div>
      <div className="mt-3 max-w-[560px]">
        <Notice tone="info">
          点通知 = 深链 <code className="mx-1 font-mono">/library?file=&#123;id&#125;</code>：进域 +
          展开所在文件夹 + 选中文件（落地形态见场景 G4）。文件 missing / trashed 时进域并 toast。
        </Notice>
      </div>
    </div>
  )
}

function NotifyRow({
  icon,
  tone,
  title,
  body,
  meta,
  unread = false
}: {
  icon: React.ReactNode
  tone: 'ai' | 'ink'
  title: string
  body: string
  meta: string
  unread?: boolean
}): React.ReactElement {
  return (
    <button
      type="button"
      className={cn(
        'flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors duration-fast hover:bg-ink-3',
        unread && 'bg-coral/[0.04]'
      )}
    >
      <span
        className={cn(
          'mt-0.5 grid size-6 shrink-0 place-items-center rounded-lg border',
          tone === 'ai'
            ? 'border-ai/25 bg-ai/10 text-ai'
            : 'border-ink-border bg-ink-2 text-ink-fg-2'
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-aux font-medium text-ink-fg">{title}</span>
          {unread ? <span className="size-1.5 shrink-0 rounded-full bg-coral" /> : null}
        </span>
        <span className="mt-0.5 block break-all font-mono text-micro text-ink-fg-2">{body}</span>
        <span className="mt-0.5 block text-micro text-ink-fg-3">{meta}</span>
      </span>
    </button>
  )
}

/* ── F7 custom_agent_call 带 library 引用 ──────────────────────── */

export function F7(): React.ReactElement {
  const [open, setOpen] = React.useState(true)
  const files = [302, 403].map((id) => fileById(id)!)

  return (
    <div className="mk-stage-body">
      <SceneHead
        id="F7"
        title="custom_agent_call 卡里带 library 引用"
        design="§5.1 §9.5"
        note="AgentCallReference.type 加 'library'、参数加 library_file_ids（≤50）。🔴 该类型在 ai-gateway/tools/agent_call.ts 与 assistant/tools/generic/CustomAgentCallCard.tsx 有**两份手抄且无闸** —— 加值前先把它下沉成零依赖叶子单源，否则只改一处前端卡片静默不渲染。"
      />
      <div className="max-w-[620px]">
        <CardFrame
          icon={<Bot size={12} strokeWidth={2} aria-hidden />}
          title="调用 Custom Agent「竞品分析」"
          phase="pending"
        >
          <CardParams
            rows={[
              ['agent', '竞品分析'],
              ['任务', '按这两份资料写一段定价对比，指出口径不一致的地方'],
              ['引用', `${files.length} 个资料库文件`]
            ]}
          />
          <div className="mt-2 overflow-hidden rounded-[var(--r-ctl)] border border-ink-border-soft">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="flex w-full items-center gap-1.5 bg-ink-2 px-2.5 py-1.5 text-left"
            >
              <CollapseChevron expanded={open} size={11} className="text-ink-fg-3" />
              <span className="text-micro font-mono uppercase tracking-widest text-ink-fg-3">
                library_file_ids
              </span>
              <ChevronDown size={0} className="hidden" aria-hidden />
            </button>
            <CollapsibleRegion expanded={open}>
              <div className="divide-y divide-ink-border-soft">
                {files.map((f) => {
                  const tone = toneOf(f)
                  const I = tone.Icon
                  return (
                    <div key={f.id} className="flex items-center gap-2 px-2.5 py-1.5">
                      <span
                        className={cn('grid size-5 shrink-0 place-items-center rounded', tone.bg)}
                      >
                        <I size={11} strokeWidth={2} className={tone.text} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-meta text-ink-fg">
                          {displayName(f)}
                        </span>
                        <span className="block truncate font-mono text-micro text-ink-fg-3">
                          library:{f.id} · {f.rel_path}
                        </span>
                      </span>
                    </div>
                  )
                })}
              </div>
            </CollapsibleRegion>
          </div>
          <p className="mt-2 text-meta leading-relaxed text-ink-fg-2">
            传的是 id 不是正文 —— 子 agent 自己 <code className="font-mono">library_read</code>。
            它得有 read 档才读得到（能力卡 off = 收到 id 也读不了，这是有意的）。
          </p>
          <ApprovalActions onApprove={() => undefined} onReject={() => undefined} />
        </CardFrame>
      </div>
    </div>
  )
}
