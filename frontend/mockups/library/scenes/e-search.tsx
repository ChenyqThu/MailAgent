// E 搜索（design §9.1）

import * as React from 'react'
import { CornerDownLeft, Search, Sparkles } from 'lucide-react'

import { cn } from '@shared/lib/cn'

import { fileById, HITS, type LibFile, type LibHit } from '../fixtures'
import { S } from '../strings'
import { Demo, Notice, Pill, SceneHead, StateBar, StateSwitch } from '../parts/kit'
import { AppWindow, ContentHeader, DockPlaceholder } from '../parts/shell'
import { LibraryTree } from '../parts/tree'
import { displayName, toneOf } from '../parts/fileMeta'

function matchPill(match: LibHit['match']): React.ReactElement {
  if (match === 'both') return <Pill tone="accent">{S.search.matchBoth}</Pill>
  if (match === 'vec') return <Pill tone="ai">{S.search.matchVec}</Pill>
  return <Pill tone="info">{S.search.matchFts}</Pill>
}

/** 结果行 —— ⌘K lane / /search 页 / 资料库页三处共用同一份形状。 */
export function HitRow({
  hit,
  file,
  compact = false,
  selected = false
}: {
  hit: LibHit
  file: LibFile
  compact?: boolean
  selected?: boolean
}): React.ReactElement {
  const tone = toneOf(file)
  const I = tone.Icon
  return (
    <button
      type="button"
      className={cn(
        'row relative flex w-full items-start gap-2.5 rounded-[var(--r-ctl)] px-2 py-1.5 text-left transition-colors duration-fast',
        selected ? 'row-selected acc-select text-ink-fg' : 'text-ink-fg-1 hover:bg-ink-3'
      )}
    >
      <span className={cn('mt-0.5 grid size-5 shrink-0 place-items-center rounded', tone.bg)}>
        <I size={11} strokeWidth={2} className={tone.text} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="min-w-0 truncate text-aux text-ink-fg">{displayName(file)}</span>
          {matchPill(hit.match)}
          {!compact ? (
            <span className="ml-auto shrink-0 font-mono text-micro tabular-nums text-ink-fg-3">
              {new Date(file.mtime).toLocaleDateString('zh-CN')}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block truncate font-mono text-micro text-ink-fg-3">
          {file.rel_path}
        </span>
        <span
          className="mt-0.5 block text-meta leading-5 text-ink-fg-2 [&_mark]:rounded-[2px] [&_mark]:bg-coral/25 [&_mark]:px-0.5 [&_mark]:text-ink-fg"
          // snippet 高亮：服务端出的 <mark>，与邮件搜索同款（那边也是 dangerouslySetInnerHTML）。
          dangerouslySetInnerHTML={{ __html: hit.snippet }}
        />
      </span>
    </button>
  )
}

type SearchState = 'results' | 'tooShort' | 'empty' | 'noSemantic'

/* ── E1 全库搜索面 ──────────────────────────────────────────────── */

export function E1(): React.ReactElement {
  const [state, setState] = React.useState<SearchState>('results')
  const [q, setQ] = React.useState('客单价')

  React.useEffect(() => {
    if (state === 'tooShort') setQ('价')
    else if (state === 'empty') setQ('不存在的关键词')
    else setQ('客单价')
  }, [state])

  const hits = state === 'results' || state === 'noSemantic' ? HITS : []
  const shown = state === 'noSemantic' ? hits.filter((h) => h.match !== 'vec') : hits

  return (
    <>
      <StateBar>
        <StateSwitch
          label="状态"
          value={state}
          options={[
            { value: 'results', label: '有结果（hybrid）' },
            { value: 'noSemantic', label: '语义模型未下载' },
            { value: 'tooShort', label: '1 字拦截' },
            { value: 'empty', label: '空结果' }
          ]}
          onChange={setState}
        />
      </StateBar>

      <div className="mk-stage-body">
        <SceneHead
          id="E1"
          title="资料库页顶部的全库搜索"
          design="§9.1"
          note="结果行 = 类型图标 / 名称 / 完整虚拟路径 / snippet 高亮 / match 标记 / 修改时间。中文 1 字拦截 + warning（抄邮件核的四条纪律）；≥3 字整串 MATCH 不拆 CJK；含 CJK 走 trigram 表。语义 lane 未就绪时明示「当前只按关键词匹配」。"
        />

        <AppWindow
          dock={<DockPlaceholder />}
          second={
            <LibraryTree
              selected=""
              onSelect={() => undefined}
              expanded={new Set(['agent-docs', '__mounts__'])}
              onToggle={() => undefined}
            />
          }
        >
          <div className="flex h-full flex-col">
            <ContentHeader
              crumbs={[S.domain, '搜索']}
              right={
                <span className="font-mono text-micro text-ink-fg-3">GET /library/search</span>
              }
            />
            <div className="border-b border-ink-border-soft px-4 py-2.5">
              <label className="flex h-9 items-center gap-2 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3">
                <Search size={14} strokeWidth={2} aria-hidden className="shrink-0 text-ink-fg-3" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={S.search.placeholder}
                  className="min-w-0 flex-1 bg-transparent text-body text-ink-fg outline-none placeholder:text-ink-fg-3"
                />
                <kbd className="kbd shrink-0">⏎</kbd>
              </label>
              {state === 'noSemantic' ? (
                <div className="mt-2">
                  <Notice tone="info">{S.search.noSemantic}</Notice>
                </div>
              ) : null}
              {state === 'tooShort' ? (
                <div className="mt-2">
                  <Notice tone="warn">{S.search.tooShort}</Notice>
                </div>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2 scrollbar-thin">
              {state === 'empty' ? (
                <div className="grid place-items-center gap-1 px-6 py-16 text-center">
                  <div className="text-aux text-ink-fg-1">{S.search.empty}</div>
                  <div className="text-meta text-ink-fg-3">{S.search.emptyHint}</div>
                </div>
              ) : state === 'tooShort' ? (
                <div className="px-2 py-4 text-meta text-ink-fg-3">
                  1 字 query 不发请求 —— trigram 最小单位是 3 字符，2 字走 LIKE（无 bm25）， 1
                  字会把全库都召回。
                </div>
              ) : (
                <>
                  <div className="px-2 pb-1 text-micro font-mono uppercase tracking-widest text-ink-fg-3">
                    {shown.length} 个结果
                    {state === 'results' ? ' · FTS ∪ 向量 → RRF(k=60)' : ' · 仅 FTS'}
                  </div>
                  {shown.map((h, i) => {
                    const f = fileById(h.fileId)
                    if (!f) return null
                    return <HitRow key={h.fileId} hit={h} file={f} selected={i === 0} />
                  })}
                </>
              )}
            </div>
          </div>
        </AppWindow>
      </div>
    </>
  )
}

/* ── E2 ⌘K 第五 lane ───────────────────────────────────────────── */

export function E2(): React.ReactElement {
  const [q] = React.useState('客单价')
  return (
    <div className="mk-stage-body">
      <SceneHead
        id="E2"
        title="⌘K 命令面板的第五 lane「资料库」"
        design="§9.1"
        note="纯加法：PaletteScope 加 'library'、paletteScopeVisibility 加字段、qk.library.paletteSearch、一枚 LibraryHitRow。🔴 SearchResultGroups 与 SearchTabPage 的组序靠注释互指，改一侧必改另一侧。"
      />
      <div className="mx-auto max-w-[640px] overflow-hidden rounded-[var(--r-card)] border border-ink-border bg-ink-1 shadow-2xl">
        <div className="flex h-11 items-center gap-2 border-b border-ink-border px-3">
          <Search size={15} strokeWidth={2} aria-hidden className="shrink-0 text-ink-fg-3" />
          <input
            defaultValue={q}
            className="min-w-0 flex-1 bg-transparent text-body text-ink-fg outline-none"
            aria-label="命令面板搜索"
          />
          <kbd className="kbd">esc</kbd>
        </div>
        <div className="max-h-[440px] overflow-y-auto p-1 scrollbar-thin">
          <PaletteGroup title="跳转" count={2}>
            <PaletteRow icon="→" label="资料库" hint="⌘9" />
            <PaletteRow icon="→" label="事项" hint="⌘2" />
          </PaletteGroup>

          <PaletteGroup title="邮件" count={12}>
            <PaletteRow icon="✉" label="Re: Q3 渠道数据对齐" hint="王磊 · 08-14" />
            <PaletteRow icon="✉" label="竞品价格整理" hint="李思远 · 08-19" />
          </PaletteGroup>

          <PaletteGroup title="事项" count={1}>
            <PaletteRow icon="◎" label="Q3 渠道复盘会" hint="3 个待办" />
          </PaletteGroup>

          {/* 第五组 —— 新增的这一组。 */}
          <PaletteGroup title={S.search.groupTitle} count={3} accent>
            {HITS.slice(0, 3).map((h) => {
              const f = fileById(h.fileId)
              if (!f) return null
              return <HitRow key={h.fileId} hit={h} file={f} compact />
            })}
          </PaletteGroup>
        </div>
        <div className="flex items-center gap-3 border-t border-ink-border px-3 py-1.5 text-micro text-ink-fg-3">
          <span className="flex items-center gap-1">
            <CornerDownLeft size={11} aria-hidden /> 打开
          </span>
          <span>↑↓ 选择</span>
          <span className="ml-auto flex items-center gap-1">
            <Sparkles size={11} aria-hidden className="text-coral" /> 问 AI
          </span>
        </div>
      </div>
    </div>
  )
}

function PaletteGroup({
  title,
  count,
  accent = false,
  children
}: {
  title: string
  count: number
  accent?: boolean
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className={accent ? 'rounded-[var(--r-card)] bg-coral/[0.04] pb-1' : undefined}>
      <h2 className="flex items-center gap-2 px-2 pb-1.5 pt-3 text-micro font-mono uppercase tracking-[0.08em] text-ink-fg-2">
        <span className={accent ? 'text-coral' : undefined}>{title}</span>
        <span className="text-ink-fg-3">·</span>
        <span className="tabular-nums text-ink-fg-3">{count}</span>
        {accent ? (
          <span className="ml-auto normal-case tracking-normal text-ink-fg-3">新增的组</span>
        ) : null}
      </h2>
      <div className="space-y-px">{children}</div>
    </div>
  )
}

function PaletteRow({
  icon,
  label,
  hint
}: {
  icon: string
  label: string
  hint: string
}): React.ReactElement {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2.5 rounded-[var(--r-ctl)] px-2 py-1.5 text-left text-aux text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3"
    >
      <span className="grid size-5 shrink-0 place-items-center rounded bg-ink-4 text-micro text-ink-fg-3">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-ink-fg">{label}</span>
      <span className="shrink-0 text-micro text-ink-fg-3">{hint}</span>
    </button>
  )
}

/* ── E3 /search 页 ─────────────────────────────────────────────── */

export function E3(): React.ReactElement {
  return (
    <div className="mk-stage-body">
      <SceneHead
        id="E3"
        title="/search 页里的资料库结果组"
        design="§9.1"
        note="与 ⌘K 是同一份组序（两侧注释互指）。这里空间大，结果行给完整路径 + 时间 + snippet 两行。"
      />
      <div className="overflow-hidden rounded-[var(--r-card)] border border-ink-border bg-ink-0">
        <div className="flex h-[41px] items-center gap-2 border-b border-ink-border px-4">
          <span className="text-body font-medium text-ink-fg">搜索</span>
          <span className="font-mono text-micro text-ink-fg-3">「客单价」</span>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-h-[420px] border-r border-ink-border p-2">
            <Demo title="" hint="">
              <div className="-m-3">
                <div className="px-2 pb-1.5 pt-2 text-micro font-mono uppercase tracking-[0.08em] text-ink-fg-2">
                  邮件 · 12
                </div>
                <PaletteRow icon="✉" label="Re: Q3 渠道数据对齐" hint="王磊 · 08-14" />
                <PaletteRow icon="✉" label="渠道复盘会议纪要" hint="陈可 · 08-15" />

                <div className="px-2 pb-1.5 pt-4 text-micro font-mono uppercase tracking-[0.08em] text-ink-fg-2">
                  事项 · 1
                </div>
                <PaletteRow icon="◎" label="Q3 渠道复盘会" hint="进行中" />

                <div className="flex items-center gap-2 px-2 pb-1.5 pt-4 text-micro font-mono uppercase tracking-[0.08em]">
                  <span className="text-coral">{S.search.groupTitle}</span>
                  <span className="text-ink-fg-3">· 6</span>
                  <span className="ml-auto normal-case tracking-normal text-ink-fg-3">
                    新增的组（组序与 ⌘K 一致）
                  </span>
                </div>
                {HITS.map((h) => {
                  const f = fileById(h.fileId)
                  if (!f) return null
                  return <HitRow key={h.fileId} hit={h} file={f} />
                })}
              </div>
            </Demo>
          </div>
          <aside className="p-3">
            <div className="text-micro font-mono uppercase tracking-widest text-ink-fg-3">
              检索内核
            </div>
            <ul className="mt-2 space-y-1.5 text-meta leading-relaxed text-ink-fg-2">
              <li>
                三个消费方（⌘K / /search / 事项关联弹窗）与 agent 的 library_search 同一内核。
              </li>
              <li>不接邮件 DSL parser —— 工具描述明说「纯关键词，无字段语法」。</li>
              <li>含 CJK 走 trigram 表；无 CJK 走 porter 表，bm25(text 1.0, filename 5.0)。</li>
              <li>P2 = FTS5；P3 = 语义 lane + RRF(k=60) 混合。</li>
            </ul>
          </aside>
        </div>
      </div>
    </div>
  )
}
