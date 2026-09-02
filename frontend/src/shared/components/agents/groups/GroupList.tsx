// L4 群聊 UX 批 — 清单列（列头 + 分段 + 新建 + 行列表 + 空态）。
//
// 从 GroupChatWorkspace 抽出：那个文件现在是三栏壳，列表的选中 / 重命名 / 删除确认这些行级状态
// 住在这里。行本身见 GroupRow。
//
// 🔴 群聊是桌面-only（发言链路走本地 gateway）。建群本身走 serve-api，在 web 上会「建得出来但一句
// 话都发不了」——拿不到 gateway 时直接禁用入口并说明原因，不留这个洞。

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'
import { Button } from '@shared/components/ui/button'

import type { GroupMemberMeta } from './members'
import { GroupRow, type GroupRowItem } from './GroupRow'
import type { GroupLiveTriple } from './useGroupTurnEvents'

export function GroupList({
  headerSlot,
  items,
  memberMeta,
  activeId,
  liveBySession,
  sendingSessionId,
  canCreate,
  unreadOf,
  narrow,
  navHidden,
  onSelect,
  onNew,
  onRename,
  onDelete
}: {
  headerSlot: React.ReactNode
  /** 清单行（serve-api 的 origin='group' 列表；零消息群也在里面）。 */
  items: GroupRowItem[]
  memberMeta: Map<string, GroupMemberMeta>
  activeId: number | null
  /** 服务端事件推出来的在场态（每群一份三元组）；labs off 恒空 Map。 */
  liveBySession: Map<number, GroupLiveTriple>
  /** labs off 的 v1 发送期间由群视图上抛的「这个群正在跑」。 */
  sendingSessionId: number | null
  canCreate: boolean
  unreadOf: (item: GroupRowItem) => boolean
  narrow: boolean
  navHidden: boolean
  onSelect: (id: number) => void
  onNew: () => void
  onRename: (id: number, title: string) => void
  onDelete: (id: number) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [pendingDelete, setPendingDelete] = useState<GroupRowItem | null>(null)
  // 相对时间的「现在」：整列一份、挂载时冻结（render 期间调 Date.now() 会被 react-hooks/purity
  // 拒绝；与 MatterList / MatterDetail 同一模式）。行不各自读时钟，同一批行口径一致。
  const [now] = useState(() => Date.now())

  return (
    <aside
      data-nav-second
      className={cn(
        'glass-panel flex h-full shrink-0 flex-col overflow-hidden',
        // 09-01 侧栏批：清单列读对话域的记忆宽（默认 336），折叠时整列隐藏——与 AgentThreadList 同契约，
        // 否则 `[` 折叠后顶栏左段收到 56 而这一列纹丝不动，hairline 与列边界错开。
        narrow ? 'w-full' : 'w-[var(--app-second-w,336px)] border-r border-ink-border'
      )}
      style={
        navHidden && !narrow ? { width: 0, visibility: 'hidden', borderRightWidth: 0 } : undefined
      }
    >
      <div className="flex h-12 shrink-0 items-center px-3">
        <h2 className="min-w-0 flex-1 truncate text-body font-semibold text-ink-fg">
          {t('groupChat.listTitle')}
        </h2>
      </div>
      <div className="px-3 pb-2">{headerSlot}</div>
      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={onNew}
          disabled={!canCreate}
          className={cn(
            'flex h-8 w-full items-center gap-2 rounded-lg border border-ink-border-soft bg-ink-2 px-2.5',
            'text-body font-medium text-ink-fg transition-colors duration-fast hover:bg-ink-3',
            'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-ink-2'
          )}
        >
          <Plus size={15} strokeWidth={2} className="shrink-0 text-coral" />
          <span className="truncate">{t('groupChat.newGroup')}</span>
        </button>
        {!canCreate && (
          <p className="mt-1.5 text-micro leading-relaxed text-ink-fg-3">
            {t('groupChat.desktopOnly')}
          </p>
        )}
      </div>
      <div className="scrollbar-thin flex-1 overflow-y-auto px-2 pb-2">
        {items.length === 0 ? (
          <div className="px-2 py-6 text-center text-meta text-ink-fg-3">
            {t('groupChat.emptyList')}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {items.map((item) => {
              const live = liveBySession.get(item.id) ?? null
              return (
                <GroupRow
                  key={item.id}
                  item={item}
                  memberMeta={memberMeta}
                  selected={item.id === activeId}
                  unread={item.id !== activeId && unreadOf(item)}
                  speaking={live != null || sendingSessionId === item.id}
                  speakerId={live?.inFlight ?? null}
                  renaming={renamingId === item.id}
                  now={now}
                  onSelect={() => onSelect(item.id)}
                  onStartRename={() => setRenamingId(item.id)}
                  onSubmitRename={(next) => {
                    setRenamingId(null)
                    onRename(item.id, next)
                  }}
                  onCancelRename={() => setRenamingId(null)}
                  onDelete={() => setPendingDelete(item)}
                />
              )
            })}
          </div>
        )}
      </div>

      {/* 删除是不可逆的（一条 DELETE，消息随之消失）→ 二次确认，文案只写事实。 */}
      <Dialog open={pendingDelete != null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('groupChat.deleteConfirmTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-meta leading-relaxed text-ink-fg-1">
            {t('groupChat.deleteConfirmBody', {
              title: pendingDelete?.title ?? t('groupChat.defaultTitle')
            })}
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              {t('groupChat.cancel')}
            </Button>
            <Button
              data-confirm-action="delete"
              onClick={() => {
                const target = pendingDelete
                setPendingDelete(null)
                if (target != null) onDelete(target.id)
              }}
            >
              {t('groupChat.deleteConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  )
}
