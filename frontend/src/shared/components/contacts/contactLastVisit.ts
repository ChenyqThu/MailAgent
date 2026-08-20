// 「记住上次离开的位置」的持久化层（通讯录 agent 面 v2 任务 ③）。
//
// 逐字镜像 `matters/matterLastSelected.ts` 的形状与理由：独立成模块而不是留在
// `ContactsWorkspace.tsx` 里（那份文件其余的 localStorage 读写都是私有函数），是因为拆出来
// 才是唯一能在测试里替换掉真实 `localStorage` 的办法 —— 本仓当前的 vitest + happy-dom +
// Node 组合下，happy-dom 环境里裸 `localStorage` 本身就取不到（`CommandPalette.test.tsx` 的
// `localStorage.clear()` 也包了一层 try/catch 才没红），编排逻辑的测试靠 `vi.mock` 这个模块。
//
// 比 matters 那份多存一个 `view`：通讯录的「往来的人 / 全部」是两份不同的人群，只记 id 而
// 不记视图，恢复时那个人可能根本不在当前视图的列表里（然后被判成「失效」退化成第一条）。

import type { ContactView } from '@shared/api/types/contact'

const CONTACT_LAST_VISIT_STORAGE_KEY = 'contacts:lastVisit'

export interface ContactLastVisit {
  id: number
  view: ContactView
}

export function readLastContactVisit(): ContactLastVisit | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(CONTACT_LAST_VISIT_STORAGE_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as { id?: unknown; view?: unknown }
    // 手写/半旧的记录一律当没有 —— 这份记录只是个便利，读出个野值就退化成默认选中。
    if (typeof parsed.id !== 'number' || !Number.isInteger(parsed.id)) return null
    if (parsed.view !== 'known' && parsed.view !== 'all') return null
    return { id: parsed.id, view: parsed.view }
  } catch {
    return null
  }
}

export function writeLastContactVisit(visit: ContactLastVisit): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(CONTACT_LAST_VISIT_STORAGE_KEY, JSON.stringify(visit))
  } catch {
    // localStorage 不可用 —— 本 session 内选中照常工作。
  }
}
