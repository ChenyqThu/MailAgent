// 资料库域 peek —— 投影变体（体例同 GroupsPeekList：浮层只做「看 + 切」，`LibraryTreePanel`
// 的右键菜单 / 新建 / 导入 / 在访达中显示那一整套写动作在浮层里没有落点）。
// 行 = 树的摊平投影（按域内 `expanded` 记忆展开）+ 直属文件数角标。
// 数据 = `useLibraryTreeQuery`（与工作区同一个 query key，访问过就零请求）。
//
// 点行 = 展开到该文件夹并选中（写进 `library-tree` store）+ 进 `/library`。
// 🔴 有意不走 `navigateToDomain`：那会回放本域上次的 location，而深链进来过的话它带着
// `?file=`，回放 = 刚点的文件夹被那份深链重新盖成某个文件。这里要的是「去我点的那个
// 文件夹」，所以恒落 registry 给的干净路径。

import { useMemo } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Folder, FolderTree, Trash2 } from 'lucide-react'

import { useLibraryTreeQuery } from '@shared/components/library/hooks'
import { rootLabelKey } from '@shared/components/library/LibraryTreePanel'
import { buildLibraryTree, flattenLibraryTree } from '@shared/components/library/tree'
import { cn } from '@shared/lib/cn'
import { navEntry, navigateToNavEntry } from '@shared/navigation/registry'
import { useLibraryTree } from '@shared/state/library-tree'

import { PeekEmpty, PeekHeader, PeekSkeleton, type PeekListProps } from './PeekChrome'

const MAX_ROWS = 80
const ICON_SIZE = 15

export default function LibraryPeekList({ onNavigate }: PeekListProps): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const q = useLibraryTreeQuery()
  const expanded = useLibraryTree((s) => s.expanded)
  const selectedPath = useLibraryTree((s) => s.selectedPath)
  const revealPath = useLibraryTree((s) => s.revealPath)

  const rows = useMemo(
    () =>
      flattenLibraryTree(
        buildLibraryTree({ folders: q.data?.folders ?? [], mounts: q.data?.mounts ?? [] }),
        expanded
      )
        // 挂载分组头是合成节点（`__mounts__`），没挂载时它是一行永远点不动的空标题。
        .filter((row) => row.kind !== 'group' || row.fileCount > 0)
        .slice(0, MAX_ROWS),
    [q.data, expanded]
  )

  return (
    <>
      <PeekHeader
        title={t('nav.domain.library')}
        meta={q.data !== undefined ? String(q.data.file_count) : undefined}
      />
      <div
        className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-1.5 py-1.5 space-y-px"
        data-nav-peek-list="library"
      >
        {q.isPending ? (
          <PeekSkeleton />
        ) : rows.length === 0 ? (
          <PeekEmpty text={t('library.empty.folderTitle')} />
        ) : (
          rows.map((row) => {
            // 内置根 / 废纸篓 / 分组头的显示名按 slug 走 i18n（同 LibraryTreePanel）；
            // 挂载根与普通子目录用服务端给的末段名。
            const label =
              row.depth === 0 && row.kind !== 'folder' && !row.path.startsWith('@')
                ? t(rootLabelKey(row.path))
                : row.name
            const Icon = row.kind === 'trash' ? Trash2 : row.kind === 'group' ? FolderTree : Folder
            const indent = { paddingLeft: `${8 + row.depth * 12}px` }
            const body = (
              <>
                <Icon size={ICON_SIZE} strokeWidth={1.75} className="shrink-0 text-ink-fg-3" />
                <span className="flex-1 truncate">{label}</span>
                {row.fileCount > 0 && (
                  <span className="shrink-0 font-mono text-micro tabular-nums text-ink-fg-3">
                    {row.fileCount}
                  </span>
                )}
              </>
            )
            // 分组头不是真目录（服务端不认 `__mounts__` 这个 path），渲成静态标题行 ——
            // 画成按钮就得给它编一个点击语义。
            if (row.kind === 'group') {
              return (
                <div
                  key={row.path}
                  className="row flex h-[30px] w-full items-center gap-2 pr-2 text-body text-ink-fg-3"
                  style={indent}
                >
                  {body}
                </div>
              )
            }
            return (
              <button
                key={row.path}
                type="button"
                data-library-path={row.path}
                onClick={() => {
                  revealPath(row.path)
                  navigateToNavEntry(navigate, navEntry('library'))
                  onNavigate()
                }}
                className={cn(
                  'row flex h-[30px] w-full items-center gap-2 rounded-[var(--r-ctl)] pr-2 text-left text-body',
                  'text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg',
                  // 🔴 只加粗不套 `.row-selected`：那个类在 shell 里有「至多一个」的契约
                  // （tests/components/sidebar-contract），浮层再画一个就把它顶破了。
                  row.path === selectedPath && 'font-medium text-ink-fg',
                  row.unavailable && 'opacity-[0.55]'
                )}
                style={indent}
              >
                {body}
              </button>
            )
          })
        )}
      </div>
    </>
  )
}
