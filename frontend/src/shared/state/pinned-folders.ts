// task 08-27 P1 Lane B —— 列表头「pin 的文件夹」。
//
// 常驻文件夹树退役后，切文件夹的入口收敛到列表头的下拉。pin 是它的补偿：把常用的几个
// 钉在第一行当图标，一步直达，不用先开下拉。**只是快捷方式**，不影响同步白名单，也不
// 影响任何查询语义。
//
// 上限 4（原型 TabAnatomy 定的第一行容量：文件夹选择器 + 4 枚图标 + 写邮件 CTA 在
// 336px 列里刚好排得下）。超出时不静默丢弃，由调用方出 toast。
//
// 两种可 pin 的东西：内建视图（收件箱/发件箱/草稿箱/已标旗/所有邮件，身份 = EmailView）
// 与自定义同步文件夹（身份 = 完整 display_name，即 `email_metadata.mailbox` 的值）。
// 🔴 存的是身份不是显示名快照：文件夹改了图标 / 被移出白名单时，渲染侧按当前树重解析，
// 解析不到就退回兜底图标（不做自动清理 —— 用户重新勾上同步就该原样回来）。

import { create } from 'zustand'

import type { EmailView } from '@shared/state/email-filter'

const KEY = 'mailagent.emailList.pinnedFolders.v1'

export const MAX_PINNED_FOLDERS = 4

export type PinnedFolder = { kind: 'view'; view: EmailView } | { kind: 'folder'; mailbox: string }

/** 同一性判据（去重 / 取消 pin 都走它）。 */
export function samePinnedFolder(a: PinnedFolder, b: PinnedFolder): boolean {
  if (a.kind === 'view') return b.kind === 'view' && a.view === b.view
  return b.kind === 'folder' && a.mailbox === b.mailbox
}

/** React key / DOM id 用的稳定串（**不**作为持久化格式 —— 文件夹名里可能有冒号）。 */
export function pinnedFolderKey(pin: PinnedFolder): string {
  return pin.kind === 'view' ? `view:${pin.view}` : `folder:${pin.mailbox}`
}

const VIEWS: ReadonlySet<string> = new Set<EmailView>([
  'inbox',
  'outbox',
  'drafts',
  'flagged',
  'all'
])

function parse(raw: string | null): PinnedFolder[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: PinnedFolder[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const rec = item as Record<string, unknown>
      if (rec.kind === 'view' && typeof rec.view === 'string' && VIEWS.has(rec.view)) {
        out.push({ kind: 'view', view: rec.view as EmailView })
      } else if (rec.kind === 'folder' && typeof rec.mailbox === 'string' && rec.mailbox !== '') {
        out.push({ kind: 'folder', mailbox: rec.mailbox })
      }
    }
    return out.slice(0, MAX_PINNED_FOLDERS)
  } catch {
    return []
  }
}

function read(): PinnedFolder[] {
  if (typeof window === 'undefined') return []
  try {
    return parse(window.localStorage.getItem(KEY))
  } catch {
    return []
  }
}

function write(next: readonly PinnedFolder[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* quota / private mode — 状态留在内存里 */
  }
}

interface Store {
  pinned: readonly PinnedFolder[]
  /** 翻转 pin。已 pin → 取消，恒成功；未 pin 且已满 → **不改动**并返回 false
   *  （调用方据此出 toast，别在这里 push toast：store 不该知道 i18n）。 */
  toggle(pin: PinnedFolder): boolean
}

export const usePinnedFolders = create<Store>((set, get) => ({
  pinned: read(),
  toggle(pin) {
    const cur = get().pinned
    if (cur.some((p) => samePinnedFolder(p, pin))) {
      const next = cur.filter((p) => !samePinnedFolder(p, pin))
      write(next)
      set({ pinned: next })
      return true
    }
    if (cur.length >= MAX_PINNED_FOLDERS) return false
    const next = [...cur, pin]
    write(next)
    set({ pinned: next })
    return true
  }
}))

// 跨窗口同步（弹出窗与主窗共用同一份偏好）——同 group-collapse / nav-shell 的范式。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return
    usePinnedFolders.setState({ pinned: parse(e.newValue) })
  })
}
