// per-folder 图标候选表 (v62 `folder_pref.icon`) 的闸。
//
// 覆盖两件会静默出错的事：
//   1. 兜底 —— DB 里存着的 key 是**不透明串**（后端不做枚举校验）。lucide 改名、手改
//      DB、老版本写进去的 key，读回来都可能不认识；`folderIcon()` 必须落到默认图标而
//      不是返回 undefined（渲染 <undefined /> 会当场把整棵侧边栏炸掉）。
//   2. 文案 —— 每个候选在选择器里要显示一句动效说明，文案在 i18n。新增一个图标而忘了
//      补两份 locale，界面上会显示原始 key 路径（i18next 找不到就回显 key），本身不报错。

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

import {
  DEFAULT_FOLDER_ICON,
  FOLDER_ICON_KEYS,
  folderIcon
} from '../../src/shared/components/icons/folderIcons'

const LOCALES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/shared/i18n/locales'
)

function motionTable(locale: string): Record<string, unknown> {
  const raw = JSON.parse(
    readFileSync(resolve(LOCALES_DIR, locale, 'common.json'), 'utf-8')
  ) as Record<string, never>
  const table = raw.settings?.folder?.picker?.icon?.motion as Record<string, unknown> | undefined
  // canary：路径写错 / 文案表被挪走时，下面的断言会因为空表而恒真 —— 这里先拦下。
  expect(table, `${locale}: settings.folder.picker.icon.motion 不存在`).toBeTruthy()
  return table as Record<string, unknown>
}

describe('folderIcons — 候选表', () => {
  test('24 个候选，key 不重复', () => {
    expect(FOLDER_ICON_KEYS).toHaveLength(24)
    expect(new Set(FOLDER_ICON_KEYS).size).toBe(24)
  })

  test('每个 key 都映到一个组件，且互不相同（防 24 行 registry 里复制粘贴撞车）', () => {
    const components = FOLDER_ICON_KEYS.map((k) => folderIcon(k))
    for (const [i, c] of components.entries()) {
      expect(c, `${FOLDER_ICON_KEYS[i]} 没映到组件`).toBeTypeOf('function')
      // 24 个候选都是自己的图标，不该退化成兜底。
      expect(c, `${FOLDER_ICON_KEYS[i]} 落到了兜底图标`).not.toBe(DEFAULT_FOLDER_ICON)
    }
    expect(new Set(components).size).toBe(24)
  })

  test('null / 空串 / 不认识的 key → 兜底图标（DB 存的是不透明串，认不出不许炸）', () => {
    expect(folderIcon(null)).toBe(DEFAULT_FOLDER_ICON)
    expect(folderIcon(undefined)).toBe(DEFAULT_FOLDER_ICON)
    expect(folderIcon('')).toBe(DEFAULT_FOLDER_ICON)
    expect(folderIcon('folder-does-not-exist')).toBe(DEFAULT_FOLDER_ICON)
    // 原型链上的名字也不能漏进来（Record 查表的经典坑）。
    expect(folderIcon('toString')).toBe(DEFAULT_FOLDER_ICON)
  })
})

describe('folderIcons — 动效说明文案与候选表逐个对齐', () => {
  test.each(['zh-CN', 'en-US'])('%s: 每个候选都有一句非空说明，且没有多余条目', (locale) => {
    const table = motionTable(locale)
    const missing = FOLDER_ICON_KEYS.filter(
      (k) => typeof table[k] !== 'string' || (table[k] as string).trim() === ''
    )
    expect(missing, `${locale} 缺动效说明的候选`).toEqual([])
    const extra = Object.keys(table).filter(
      (k) => !(FOLDER_ICON_KEYS as readonly string[]).includes(k)
    )
    expect(extra, `${locale} 有候选表里不存在的多余条目`).toEqual([])
  })
})
