// V3-11 —— 「记住上次选中」（设计 HANDOFF-列表与资料-v3.md §1）的持久化层，独立成模块
// 而不是留在 `MattersWorkspace.tsx` 里（那份文件其余的 localStorage 读写都是私有函数）：
// 拆出来是唯一能在测试里替换掉真实 `localStorage` 的办法——本仓当前的 vitest + happy-dom +
// Node 组合下，happy-dom 环境里裸 `localStorage`/`window.localStorage` 本身就取不到
// （`tests/components/CommandPalette.test.tsx` 的 `localStorage.clear()` 也包了一层
// try/catch 才没红），`MattersWorkspaceSelection.test.tsx` 靠 `vi.mock` 这个模块本身来测
// 「记住上次选中」的编排逻辑，绕开这个环境限制，不依赖真实 Storage 可用。

const MATTER_LAST_SELECTED_STORAGE_KEY = 'matters:lastSelId'

export function readLastSelectedMatterId(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage.getItem(MATTER_LAST_SELECTED_STORAGE_KEY)
  } catch {
    return null
  }
}

export function writeLastSelectedMatterId(publicId: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(MATTER_LAST_SELECTED_STORAGE_KEY, publicId)
  } catch {
    // localStorage unavailable — selection still works for this session.
  }
}
