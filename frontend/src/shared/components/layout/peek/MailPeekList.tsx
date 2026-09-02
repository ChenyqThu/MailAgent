// 邮件域 peek —— **邮箱列表**（0902 dogfood 轮 1：owner 要的是「折叠态也能切邮箱」，
// 不是把邮件行再画一遍；邮件行在右边的主列表里本来就有）。
//
// 两段与列表头的文件夹选择器（`email/FolderMenu.tsx`）同一份数据链、同一套点行语义：
//   · MAILBOXES = registry 的五个内建视图行（`navDomainPanelEntries(NAV_ENTRIES,'mail')`），
//     行尾计数走 `qk.mailboxes()` + `mailboxViewCount`；
//   · FOLDERS   = `useSyncedFolderTree()` 的已同步自定义文件夹（🔴 数组序 = 用户自定义
//     显示顺序，不排序；whitelist 空 ⇒ 整段不渲染，隔离不变量）。
// 点行 = `useSelectMailbox()`（与列表头共用的 hook，不复制一份）：内建视图自带
// `?view=` 导航；自定义文件夹只写过滤 key，故这里补 `navigateToDomain('mail')` 切回邮件域。
//
// 不做 pin —— peek 是「看一眼再切」，钉不钉是列表头那一档的事。

import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { FolderGlyph } from '@shared/components/icons'
import { NavRow } from '@shared/components/layout/DomainPanel'
import { useFolderPrefMap } from '@shared/hooks/useFolderPrefs'
import { useMailApi } from '@shared/hooks/useMailApi'
import { MAIL_VIEW_ENTRIES, useSelectMailbox } from '@shared/hooks/useSelectMailbox'
import { useSyncedFolderTree } from '@shared/hooks/useSyncedFolderTree'
import { flattenFolderTree } from '@shared/lib/folderTree'
import { folderUnreadCount, mailboxViewCount } from '@shared/lib/mailboxCounts'
import { qk } from '@shared/lib/queryKeys'
import { navigateToDomain } from '@shared/navigation/domain-location'
import { navLabel } from '@shared/navigation/registry'
import { useEmailFilter } from '@shared/state/email-filter'

import { PeekHeader, type PeekListProps } from './PeekChrome'

/** 行尾计数 —— 与 FolderMenu 同一枚。null / 0 不画。 */
function RowCount({ count }: { count: number | null }): React.ReactElement | null {
  if (count === null || count <= 0) return null
  return (
    <span className="text-meta font-mono text-ink-fg-2 tabular-nums">
      {count.toLocaleString('en-US')}
    </span>
  )
}

export default function MailPeekList({ onNavigate }: PeekListProps): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const mailApi = useMailApi()
  const view = useEmailFilter((s) => s.view)
  const customMailbox = useEmailFilter((s) => s.customMailbox)
  const { selectView, selectFolder } = useSelectMailbox()
  const { tree, hasWhitelist } = useSyncedFolderTree()
  const prefMap = useFolderPrefMap()

  // 计数与 rail 徽标 / 列表头下拉同 key（SSE 失效 + Sidebar 兜底轮询已在喂它，这里只是
  // 又一个 observer：缓存有值时开浮层即时有数）。口径换算在 lib/mailboxCounts。
  const { data: mailboxData } = useQuery({
    queryKey: qk.mailboxes(),
    queryFn: () => mailApi.email.listMailboxes(),
    staleTime: 30_000
  })
  const mailboxes = mailboxData ?? []
  const folderRows = flattenFolderTree(tree)

  return (
    <>
      <PeekHeader title={t('nav.domain.mail')} />
      <div
        className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-1.5 pb-2"
        data-nav-peek-list="mail"
      >
        <h2 className="nav-panel-sechdr text-micro font-mono uppercase">
          {t('nav.section.mailboxes')}
        </h2>
        <div className="space-y-px">
          {MAIL_VIEW_ENTRIES.map((entry) => {
            const entryView = entry.view
            if (entryView === undefined) return null
            return (
              <NavRow
                key={entry.id}
                icon={entry.icon()}
                label={navLabel(entry, t)}
                selected={customMailbox === null && view === entryView}
                right={<RowCount count={mailboxViewCount(mailboxes, entryView)} />}
                onClick={() => {
                  // selectView 自带 navigateToNavEntry（`/?view=`）—— 切域也在其中。
                  selectView(entryView)
                  onNavigate()
                }}
              />
            )
          })}
        </div>
        {hasWhitelist && folderRows.length > 0 && (
          <>
            <h2 className="nav-panel-sechdr text-micro font-mono uppercase">
              {t('nav.section.folders')}
            </h2>
            <div className="space-y-px">
              {folderRows.map(({ node, depth }) => (
                <div
                  key={node.imapName}
                  style={depth > 0 ? { paddingLeft: `${depth * 14}px` } : undefined}
                >
                  <NavRow
                    icon={
                      <FolderGlyph
                        iconKey={prefMap.get(node.imapName)?.icon}
                        size={15}
                        strokeWidth={1.75}
                        className="shrink-0"
                      />
                    }
                    label={node.displayName}
                    selected={customMailbox === node.fullDisplayName}
                    right={<RowCount count={folderUnreadCount(mailboxes, node.fullDisplayName)} />}
                    onClick={() => {
                      // selectFolder 只写过滤 key（列表头本就在邮件域）；peek 可能从别的域
                      // 浮出，所以这里补切域。
                      selectFolder(node)
                      navigateToDomain(navigate, 'mail')
                      onNavigate()
                    }}
                  />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  )
}
