// 通讯录列表的显示偏好（排序 / 分组 / 密度）持久化（task 08-20 P3-10）。
//
// 为什么要记住：`sort` 直接进列表的 queryKey（`qk.contacts.listPaged(view,q,sort)`）——
// 改过排序、切走再切回时组件重挂、state 复位成默认档，那就是**另一个 key** ⇒ 必定冷取 +
// 骨架屏，即便刚才那份数据还在缓存里。视图（known/all）早已随 `contactLastVisit` 记住，
// 这三个档位是同一件事剩下的部分；分组与密度不进 key，记住它们只是不让界面每次回来跳一次版。
//
// 形状与理由照 `contactLastVisit.ts`：独立小模块才能在测试里 `vi.mock` 掉整层
// —— 本仓 vitest + happy-dom + Node 组合下，happy-dom 环境里裸 `localStorage` 取不到。
//
// 🔴 读出来的野值（手写 / 半旧记录 / 从带新档位的版本回退）一律回落默认，不让一条坏记录把
// 列表钉在一个不存在的排序上。档位清单来自 `contactListModel` 的单份运行时清单（不再抄）。

import type { ContactSort } from '@shared/api/types/contact'

import {
  CONTACT_DENSITIES,
  CONTACT_GROUP_BYS,
  CONTACT_SORTS,
  type ContactDensity,
  type ContactGroupBy
} from './contactListModel'

const CONTACT_LIST_PREFS_STORAGE_KEY = 'contacts:listPrefs'

export interface ContactListPrefs {
  sort: ContactSort
  groupBy: ContactGroupBy
  density: ContactDensity
}

/** 出厂档位（与本模块出现之前 `ContactsWorkspace` 的三个 useState 初值逐字相同）。 */
export const DEFAULT_CONTACT_LIST_PREFS: ContactListPrefs = {
  sort: 'density',
  groupBy: 'none',
  density: 'compact'
}

function pick<T extends string>(candidates: readonly T[], value: unknown, fallback: T): T {
  return candidates.includes(value as T) ? (value as T) : fallback
}

export function readContactListPrefs(): ContactListPrefs {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_CONTACT_LIST_PREFS
    const raw = localStorage.getItem(CONTACT_LIST_PREFS_STORAGE_KEY)
    if (raw === null) return DEFAULT_CONTACT_LIST_PREFS
    const parsed = JSON.parse(raw) as Partial<Record<keyof ContactListPrefs, unknown>>
    return {
      sort: pick(CONTACT_SORTS, parsed.sort, DEFAULT_CONTACT_LIST_PREFS.sort),
      groupBy: pick(CONTACT_GROUP_BYS, parsed.groupBy, DEFAULT_CONTACT_LIST_PREFS.groupBy),
      density: pick(CONTACT_DENSITIES, parsed.density, DEFAULT_CONTACT_LIST_PREFS.density)
    }
  } catch {
    return DEFAULT_CONTACT_LIST_PREFS
  }
}

export function writeContactListPrefs(prefs: ContactListPrefs): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(CONTACT_LIST_PREFS_STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // localStorage 不可用 —— 本 session 内切档照常工作。
  }
}
