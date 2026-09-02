// A 域外壳与文件夹树（design §2.1 / §2.2 / §2.3 / §8.2）

import * as React from 'react'
import { FolderPlus, Lock } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { Button } from '@shared/components/ui/button'
import { Popmenu } from '@shared/components/ui/Popmenu'

import { FILES, MOUNTS, filesIn, type LibMount } from '../fixtures'
import { S } from '../strings'
import { Demo, Notice, SceneHead, StateBar, StateSwitch, SystemDialogCard } from '../parts/kit'
import { AppWindow, ContentHeader, DockPlaceholder } from '../parts/shell'
import { LibraryTree, buildTree, nodeMenuItems, type TreeNode } from '../parts/tree'
import { FolderBody, FolderToolbar, type SortKey, type ViewMode } from '../parts/folderView'
import { toneOf } from '../parts/fileMeta'

const DEFAULT_EXPANDED = new Set(['mail-attachments', 'agent-docs', '__mounts__', '@工作区'])

/* ── A1 一级域整体 ───────────────────────────────────────────────── */

export function A1(): React.ReactElement {
  const [collapsed, setCollapsed] = React.useState(false)
  const [width, setWidth] = React.useState(336)
  const [selected, setSelected] = React.useState('agent-docs/notes')
  const [expanded, setExpanded] = React.useState(new Set(DEFAULT_EXPANDED))
  const [view, setView] = React.useState<ViewMode>('list')
  const [sort, setSort] = React.useState<SortKey>('date')
  const [filter, setFilter] = React.useState('')

  const toggle = (p: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })

  const files = filesIn(selected)
  const crumbs = [S.domain, ...selected.split('/')]

  return (
    <>
      <StateBar>
        <StateSwitch
          label="二级栏"
          value={collapsed ? 'collapsed' : 'open'}
          options={[
            { value: 'open', label: '展开' },
            { value: 'collapsed', label: '折叠' }
          ]}
          onChange={(v) => setCollapsed(v === 'collapsed')}
        />
        <StateSwitch
          label="宽度"
          value={String(width)}
          options={[
            { value: '280', label: '280（下限）' },
            { value: '336', label: '336（默认）' },
            { value: '420', label: '420（上限）' }
          ]}
          onChange={(v) => setWidth(Number(v))}
        />
      </StateBar>

      <div className="mk-stage-body">
        <SceneHead
          id="A1"
          title="资料库一级域整体"
          design="§2.1"
          note="导轨第 9 格（快照下唯一空位）+ 二级栏文件夹树（宽 336，可拖 280–420、可折叠）+ 内容区（PageFrame + 面包屑）+ 右侧 dock 的「对话」入口。每域一份 {collapsed,width} 记忆是 nav-shell 白拿的，加域零改动。"
        />
        <AppWindow
          collapsed={collapsed}
          secondWidth={width}
          onToggleCollapsed={() => setCollapsed((v) => !v)}
          dock={<DockPlaceholder />}
          peek={<PeekList selected={selected} onSelect={setSelected} />}
          second={
            <LibraryTree
              selected={selected}
              onSelect={setSelected}
              expanded={expanded}
              onToggle={toggle}
            />
          }
        >
          <div className="flex h-full flex-col">
            <ContentHeader crumbs={crumbs} />
            <FolderToolbar
              view={view}
              onView={setView}
              sort={sort}
              onSort={setSort}
              filter={filter}
              onFilter={setFilter}
            />
            <FolderBody
              files={files}
              view={view}
              state={files.length === 0 ? 'empty' : 'normal'}
              folderName={crumbs[crumbs.length - 1] ?? ''}
              onOpen={() => undefined}
              fileMenuItems={() => [
                { kind: 'action', id: 'open', label: '打开', onSelect: () => undefined }
              ]}
            />
          </div>
        </AppWindow>
      </div>
    </>
  )
}

/* ── A2 多根树 ───────────────────────────────────────────────────── */

export function A2(): React.ReactElement {
  const [selected, setSelected] = React.useState('mail-attachments/2026-08')
  const [expanded, setExpanded] = React.useState(
    new Set([
      'mail-attachments',
      'agent-docs',
      'my-docs',
      '__mounts__',
      '@工作区'
    ])
  )
  const [mountState, setMountState] = React.useState<'normal' | 'unavailable'>('normal')
  const [dropTarget, setDropTarget] = React.useState<string | null>(null)

  const mounts: LibMount[] = React.useMemo(
    () =>
      MOUNTS.map((m) =>
        mountState === 'unavailable' && m.id === 1 ? { ...m, status: 'unavailable' as const } : m
      ),
    [mountState]
  )

  const toggle = (p: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })

  const missing = FILES.filter((f) => f.status === 'missing')
  const placeholder = FILES.filter((f) => f.kind === 'placeholder')

  return (
    <>
      <StateBar>
        <StateSwitch
          label="挂载状态"
          value={mountState}
          options={[
            { value: 'normal', label: '全部正常' },
            { value: 'unavailable', label: '@工作区 不可用' }
          ]}
          onChange={setMountState}
        />
        <StateSwitch
          label="拖入中"
          value={dropTarget ? 'yes' : 'no'}
          options={[
            { value: 'no', label: '否' },
            { value: 'yes', label: '悬停 my-docs/产品' }
          ]}
          onChange={(v) => setDropTarget(v === 'yes' ? 'my-docs/产品' : null)}
        />
      </StateBar>

      <div className="mk-stage-body">
        <SceneHead
          id="A2"
          title="多根树"
          design="§1.1 §2.2 §8.2"
          note="内置四根 + 「挂载的文件夹」分组 + 废纸篓 + 「添加文件夹」。挂载根用 @label + 外链图标，ro 带锁、unavailable 灰显且不可点（行不删，引用不悬空）。投影根按 {YYYY-MM} 分组。"
        />
        <div className="grid grid-cols-[360px_minmax(0,1fr)] gap-4">
          <div className="h-[720px] overflow-hidden rounded-[var(--r-card)] border border-ink-border bg-ink-1">
            <LibraryTree
              selected={selected}
              onSelect={setSelected}
              expanded={expanded}
              onToggle={toggle}
              mounts={mounts}
              dropTarget={dropTarget}
            />
          </div>
          <div className="space-y-3">
            <Demo title="根的读写语义" hint="design §0 一页定义的「谁能写什么」">
              <ul className="space-y-1.5 text-aux leading-relaxed text-ink-fg-1">
                <li>
                  <span className="font-medium text-ink-fg">{S.roots.mail}</span> ——
                  索引投影，不在磁盘上； 只读；随邮件删除消失；「另存到资料库」才真复制。
                </li>
                <li>
                  <span className="font-medium text-ink-fg">{S.roots.chat}</span> —— 发送即入库 （
                  <code className="font-mono text-micro">chat-attachments/&#123;年-月&#125;/</code>
                  ）；删会话不删文件。
                </li>
                <li>
                  <span className="font-medium text-ink-fg">{S.roots.agentDocs}</span> —— agent
                  可读写；无人值守唯一免卡区。
                </li>
                <li>
                  <span className="font-medium text-ink-fg">{S.roots.myDocs}</span> —— agent
                  默认只读； 主 agent 可写、custom agent 的 write 档**不含**它。
                </li>
                <li>
                  <span className="font-medium text-ink-fg">@挂载根</span> —— mode 是用户侧总闸；
                  headless 恒只读。
                </li>
              </ul>
            </Demo>

            <Demo title="树里的两种「文件级」行" hint="A2 要求：missing 灰显 + iCloud 占位">
              <div className="space-y-1.5">
                {[...missing, ...placeholder].map((f) => {
                  const tone = toneOf(f)
                  const I = tone.Icon
                  return (
                    <div
                      key={f.id}
                      className="flex h-[30px] items-center gap-2 rounded-[var(--r-ctl)] px-2 text-body text-ink-fg-1 opacity-55"
                    >
                      <span className={cn('grid size-5 place-items-center rounded', tone.bg)}>
                        <I size={11} strokeWidth={2} className={tone.text} />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{f.filename}</span>
                      <span className="shrink-0 text-micro text-ink-fg-3">
                        {f.status === 'missing' ? '磁盘上已不在' : 'iCloud 未下载'}
                      </span>
                    </div>
                  )
                })}
              </div>
              <Notice tone="info">
                占位文件（<code className="font-mono">.icloud</code>）标{' '}
                <code className="font-mono">kind=&#39;placeholder&#39;</code>，不抽取、不进 FTS；
                missing 行保留 id 与引用。
              </Notice>
            </Demo>
          </div>
        </div>
      </div>
    </>
  )
}

/* ── A3 节点菜单 ─────────────────────────────────────────────────── */

const MENU_CASES: Array<{ key: string; label: string; node: () => TreeNode }> = [
  {
    key: 'folder',
    label: '普通文件夹',
    node: () => buildTree(new Set(['my-docs']), MOUNTS).find((n) => n.path === 'my-docs/产品')!
  },
  {
    key: 'mount-ro',
    label: '挂载根（只读）',
    node: () => buildTree(new Set(['__mounts__']), MOUNTS).find((n) => n.path === '@Design 素材')!
  },
  {
    key: 'mount-rw',
    label: '挂载根（可写）',
    node: () => buildTree(new Set(['__mounts__']), MOUNTS).find((n) => n.path === '@工作区')!
  },
  {
    key: 'projection',
    label: '投影根（只读）',
    node: () => buildTree(new Set(), MOUNTS).find((n) => n.path === 'mail-attachments')!
  },
  {
    key: 'trash',
    label: '废纸篓',
    node: () => buildTree(new Set(), MOUNTS).find((n) => n.path === '.trash')!
  }
]

export function A3(): React.ReactElement {
  const [which, setWhich] = React.useState('folder')
  const [open, setOpen] = React.useState(false)
  const [log, setLog] = React.useState<string[]>([])
  const triggerRef = React.useRef<HTMLButtonElement | null>(null)
  const node = MENU_CASES.find((c) => c.key === which)!.node()

  return (
    <>
      <StateBar>
        <StateSwitch
          label="节点类型"
          value={which}
          options={MENU_CASES.map((c) => ({ value: c.key, label: c.label }))}
          onChange={(v) => {
            setWhich(v)
            setOpen(false)
          }}
        />
      </StateBar>

      <div className="mk-stage-body">
        <SceneHead
          id="A3"
          title="节点菜单（右键 + 「…」）"
          design="§2.3 §8.2"
          note="五种节点的菜单不一样：文件夹给新建 / 导入 / 重命名 / 移到 / 删除；挂载根给重命名标签 / 切模式 / 访达 / 卸载（卸载只删索引不动磁盘）；投影根与废纸篓只给说明。树里任意行右键也能开同一份菜单。"
        />
        <div className="grid grid-cols-[380px_minmax(0,1fr)] gap-4">
          <Demo title="点开菜单" hint="也可以在 A2 的树里直接右键">
            <div className="relative">
              <button
                ref={triggerRef}
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="row relative flex h-[30px] w-full items-center gap-2 rounded-[var(--r-ctl)] px-2 text-left text-body text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg"
              >
                <span className="shrink-0 text-ink-fg-2">{node.icon}</span>
                <span className="min-w-0 flex-1 truncate">{node.name}</span>
                {node.readonly ? (
                  <Lock size={10} strokeWidth={2} className="shrink-0 text-ink-fg-3" aria-hidden />
                ) : null}
              </button>
              <Popmenu
                open={open}
                onClose={() => setOpen(false)}
                ariaLabel="节点菜单"
                title={node.name}
                triggerRef={triggerRef}
                width={272}
                items={nodeMenuItems(node, (what) =>
                  setLog((prev) =>
                    [
                      `${new Date().toLocaleTimeString('zh-CN')} · ${node.name} → ${what}`,
                      ...prev
                    ].slice(0, 8)
                  )
                )}
              />
            </div>
          </Demo>
          <Demo title="点了什么（mockup 只打日志）">
            {log.length === 0 ? (
              <div className="text-meta text-ink-fg-3">还没点。</div>
            ) : (
              <ul className="space-y-1 font-mono text-micro text-ink-fg-2">
                {log.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            )}
          </Demo>
        </div>

        <Demo title="「添加文件夹」的触发点" hint="design §8.2：主进程 dialog.showOpenDialog">
          <SystemDialogCard
            action="dialog.showOpenDialog({ properties: ['openDirectory'] })"
            detail="点树底部的「添加文件夹」会走这一步。完整流程见场景 D1。"
          />
        </Demo>
      </div>
    </>
  )
}

/* ── A4 折叠态 peek ─────────────────────────────────────────────── */

export function PeekList({
  selected,
  onSelect
}: {
  selected: string
  onSelect(p: string): void
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState(new Set(['agent-docs', '__mounts__']))
  return (
    <LibraryTree
      selected={selected}
      onSelect={onSelect}
      expanded={expanded}
      onToggle={(p) =>
        setExpanded((prev) => {
          const next = new Set(prev)
          if (next.has(p)) next.delete(p)
          else next.add(p)
          return next
        })
      }
    />
  )
}

export function A4(): React.ReactElement {
  const [selected, setSelected] = React.useState('agent-docs/notes')
  return (
    <>
      <StateBar>
        <span className="text-meta text-ink-fg-2">
          二级栏已折叠 —— 把鼠标移到导轨的「资料库」格上，peek 浮层出现。
        </span>
      </StateBar>
      <div className="mk-stage-body">
        <SceneHead
          id="A4"
          title="折叠态下的 peek 列表"
          design="§2.1"
          note="🔴 NavPeek.PAGE_LISTS 是 Partial<Record>，漏加不会红、静默回落成空 DomainPanel（page 域没有 panel 行）。所以加域时必须同时加 peek/LibraryPeekList。"
        />
        <AppWindow
          collapsed
          onToggleCollapsed={() => undefined}
          dock={<DockPlaceholder />}
          peek={<PeekList selected={selected} onSelect={setSelected} />}
          second={<PeekList selected={selected} onSelect={setSelected} />}
        >
          <div className="flex h-full flex-col">
            <ContentHeader crumbs={[S.domain, ...selected.split('/')]} />
            <div className="grid flex-1 place-items-center px-6 text-center">
              <div className="max-w-md">
                <div className="text-aux text-ink-fg-1">
                  折叠态下内容区吃满宽度；peek 是浮层，不挤压正文。
                </div>
                <div className="mt-1 text-meta text-ink-fg-3">
                  三条恢复入口：导轨底部开合钮 / 二级栏头钮 / <kbd className="kbd">]</kbd>。
                </div>
                <Button size="sm" variant="secondary" className="mt-3">
                  <FolderPlus size={13} aria-hidden />
                  {S.addFolder}
                </Button>
              </div>
            </div>
          </div>
        </AppWindow>
      </div>
    </>
  )
}
