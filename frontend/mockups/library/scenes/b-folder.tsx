// B 内容区：文件夹视图（design §2.3 / §8.2）

import * as React from 'react'
import { Search } from 'lucide-react'

import { Button } from '@shared/components/ui/button'
import type { PopmenuItem } from '@shared/components/ui/Popmenu'

import { filesIn, HITS, fileById } from '../fixtures'
import { S } from '../strings'
import { Demo, Notice, SceneHead, StateBar, StateSwitch } from '../parts/kit'
import { AppWindow, ContentHeader, DockPlaceholder } from '../parts/shell'
import { LibraryTree } from '../parts/tree'
import {
  FolderBody,
  FolderToolbar,
  sortFiles,
  type SortKey,
  type ViewMode
} from '../parts/folderView'
import { displayName } from '../parts/fileMeta'
import { HitRow } from './e-search'

const FOLDER_OPTIONS = [
  { value: 'mail-attachments/2026-08', label: '投影区 2026-08' },
  { value: 'my-docs/产品', label: 'my-docs/产品' },
  { value: 'agent-docs/notes', label: 'agent-docs/notes' },
  { value: '@工作区/2026-Q3', label: '@工作区/2026-Q3' }
]

function menuFor(): readonly PopmenuItem[] {
  return [
    { kind: 'action', id: 'open', label: '打开', onSelect: () => undefined },
    { kind: 'action', id: 'system', label: S.act.openSystem, onSelect: () => undefined },
    { kind: 'action', id: 'reveal', label: S.act.reveal, onSelect: () => undefined },
    { kind: 'separator', id: 's1' },
    { kind: 'action', id: 'keep', label: S.act.keepToLibrary, onSelect: () => undefined },
    { kind: 'action', id: 'move', label: S.act.moveTo, onSelect: () => undefined },
    { kind: 'action', id: 'del', label: S.act.delete, tone: 'danger', onSelect: () => undefined }
  ]
}

/* ── B1 网格 / 列表 ─────────────────────────────────────────────── */

export function B1(): React.ReactElement {
  const [folder, setFolder] = React.useState('mail-attachments/2026-08')
  const [view, setView] = React.useState<ViewMode>('list')
  const [sort, setSort] = React.useState<SortKey>('date')
  const [filter, setFilter] = React.useState('')

  const projection = folder.startsWith('mail-attachments')
  const files = sortFiles(
    filesIn(folder).filter((f) =>
      filter.trim() === ''
        ? true
        : displayName(f).toLowerCase().includes(filter.trim().toLowerCase())
    ),
    sort
  )

  return (
    <>
      <StateBar>
        <StateSwitch label="文件夹" value={folder} options={FOLDER_OPTIONS} onChange={setFolder} />
        <StateSwitch
          label="视图"
          value={view}
          options={[
            { value: 'grid', label: S.view.grid },
            { value: 'list', label: S.view.list }
          ]}
          onChange={(v) => setView(v as ViewMode)}
        />
        <StateSwitch
          label="排序"
          value={sort}
          options={[
            { value: 'name', label: '名称' },
            { value: 'size', label: '大小' },
            { value: 'type', label: '类型' },
            { value: 'date', label: '时间' }
          ]}
          onChange={(v) => setSort(v as SortKey)}
        />
      </StateBar>

      <div className="mk-stage-body">
        <SceneHead
          id="B1"
          title="网格 / 列表双视图"
          design="§2.3"
          note="列 = 图标（lane 色调走 pickIconTone）/ 名称（md 取 frontmatter.title，副行给真文件名）/ 大小 / 修改时间 / 类型 / 来源 / 创建者。投影区顶部常驻一行说明，来源列换成「邮件主题 + 发件人」。"
        />
        <AppWindow
          dock={<DockPlaceholder />}
          second={
            <LibraryTree
              selected={folder}
              onSelect={setFolder}
              expanded={
                new Set(['mail-attachments', 'my-docs', 'agent-docs', '__mounts__', '@工作区'])
              }
              onToggle={() => undefined}
            />
          }
        >
          <div className="flex h-full flex-col">
            <ContentHeader crumbs={[S.domain, ...folder.split('/')]} />
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
              projection={projection}
              onOpen={() => undefined}
              fileMenuItems={menuFor}
            />
          </div>
        </AppWindow>
      </div>
    </>
  )
}

/* ── B2 空 / 拖入 / 扫描中 ──────────────────────────────────────── */

export function B2(): React.ReactElement {
  const [state, setState] = React.useState<'empty' | 'dragging' | 'scanning'>('empty')
  const files = state === 'scanning' ? filesIn('@工作区/2026-Q3') : filesIn('my-docs/产品')

  return (
    <>
      <StateBar>
        <StateSwitch
          label="状态"
          value={state}
          options={[
            { value: 'empty', label: '空文件夹' },
            { value: 'dragging', label: '拖入中' },
            { value: 'scanning', label: '索引扫描中' }
          ]}
          onChange={setState}
        />
      </StateBar>

      <div className="mk-stage-body">
        <SceneHead
          id="B2"
          title="空 / 拖入中 / 索引扫描中"
          design="§2.3 §8.2"
          note="拖文件到某个文件夹 = 复制入库（source='user'）；树内拖拽移动本 epic 不做，用「移到…」菜单。挂载后的批量登记只走 stat 建行，文本抽取是后台低速队列。"
        />
        <AppWindow
          dock={<DockPlaceholder />}
          second={
            <LibraryTree
              selected={state === 'scanning' ? '@工作区/2026-Q3' : 'my-docs/产品'}
              onSelect={() => undefined}
              expanded={new Set(['my-docs', '__mounts__', '@工作区'])}
              onToggle={() => undefined}
              dropTarget={state === 'dragging' ? 'my-docs/产品' : null}
            />
          }
        >
          <div className="flex h-full flex-col">
            <ContentHeader
              crumbs={[
                S.domain,
                ...(state === 'scanning' ? ['@工作区', '2026-Q3'] : ['my-docs', '产品'])
              ]}
            />
            <FolderToolbar
              view="grid"
              onView={() => undefined}
              sort="date"
              onSort={() => undefined}
              filter=""
              onFilter={() => undefined}
            />
            <FolderBody
              files={state === 'empty' ? [] : files}
              view="grid"
              state={state}
              folderName={state === 'scanning' ? '2026-Q3' : '产品'}
              scanProgress={{ done: 412, total: 1284 }}
              onOpen={() => undefined}
              fileMenuItems={menuFor}
            />
          </div>
        </AppWindow>

        <div className="mt-4">
          <Notice tone="info">
            扫描进度条挂在文件夹视图顶部而不是全局：挂载是按根发生的，用户当下就在看那个根。
            全库层面的进度（重扫 / 语义索引）在设置页（场景 D2）。
          </Notice>
        </div>
      </div>
    </>
  )
}

/* ── B3 文件夹过滤 vs 全库搜索 ──────────────────────────────────── */

export function B3(): React.ReactElement {
  const [filter, setFilter] = React.useState('定价')
  const [query, setQuery] = React.useState('客单价')
  const files = filesIn('my-docs/产品/定价').filter((f) =>
    filter.trim() === '' ? true : displayName(f).includes(filter.trim())
  )

  return (
    <>
      <StateBar>
        <span className="text-meta text-ink-fg-2">
          两个输入框都能打字，看清它们的形态、位置与结果面完全不同。
        </span>
      </StateBar>

      <div className="mk-stage-body">
        <SceneHead
          id="B3"
          title="文件夹级过滤 与 全库搜索"
          design="§2.3 §9.1"
          note="过滤 = 在当前文件夹里筛已经列出来的行，窄输入框贴在工具条上，即时、无结果分组、不跨文件夹。全库搜索 = 走 GET /library/search（FTS 双表 + P3 语义 lane），宽输入框在页头，结果带路径 / snippet / match 标记。两者刻意不合成一个框。"
        />

        <div className="grid grid-cols-2 gap-4">
          <Demo title="文件夹级过滤" hint="工具条上的窄框">
            <div className="overflow-hidden rounded-[var(--r-card)] border border-ink-border bg-ink-1">
              <FolderToolbar
                view="list"
                onView={() => undefined}
                sort="name"
                onSort={() => undefined}
                filter={filter}
                onFilter={setFilter}
              />
              <FolderBody
                files={files}
                view="list"
                state={files.length === 0 ? 'empty' : 'normal'}
                onOpen={() => undefined}
                fileMenuItems={menuFor}
              />
            </div>
            <div className="mt-2 text-meta leading-relaxed text-ink-fg-3">
              只筛 <code className="font-mono">my-docs/产品/定价</code> 这一个文件夹的行；
              清空即恢复。不发请求。
            </div>
          </Demo>

          <Demo title="全库搜索" hint="页头的宽框 + 结果分组">
            <div className="overflow-hidden rounded-[var(--r-card)] border border-ink-border bg-ink-1">
              <div className="flex h-[41px] items-center gap-2 border-b border-ink-border px-3">
                <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2.5">
                  <Search
                    size={13}
                    strokeWidth={2}
                    aria-hidden
                    className="shrink-0 text-ink-fg-3"
                  />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={S.search.placeholder}
                    className="min-w-0 flex-1 bg-transparent text-aux text-ink-fg outline-none placeholder:text-ink-fg-3"
                  />
                </label>
                <Button size="sm" variant="ghost">
                  {S.librarySearch}
                </Button>
              </div>
              <div className="max-h-[360px] overflow-y-auto p-1 scrollbar-thin">
                {HITS.slice(0, 4).map((h) => {
                  const f = fileById(h.fileId)
                  if (!f) return null
                  return <HitRow key={h.fileId} hit={h} file={f} />
                })}
              </div>
            </div>
            <div className="mt-2 text-meta leading-relaxed text-ink-fg-3">
              跨所有根（含投影区与挂载根）；结果行带完整虚拟路径、snippet 高亮、
              <code className="mx-1 font-mono">match</code> 标记。
            </div>
          </Demo>
        </div>
      </div>
    </>
  )
}
