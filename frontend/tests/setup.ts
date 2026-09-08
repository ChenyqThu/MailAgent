// Vitest 全局 setup（vitest.config.ts setupFiles 引用）。
//
// 强制 happy-dom 组件测试环境上报 `prefers-reduced-motion: reduce`，使所有
// GSAP 动画（useReducedMotion / useExitAnimation / 各组件进场）在测试里走
// reduced-motion 短路而 no-op —— 组件测试断言的是最终可见 DOM，而非动画中途
// 的 visibility:hidden 态（happy-dom 不会自动推进 GSAP 的 rAF timeline，元素
// 会停在进场起始的隐藏态，导致 testing-library 的 getByRole 找不到元素）。
//
// node 环境的测试（无 window）自动跳过。需要测真实动画路径的用例（见
// tests/shared/useExitAnimation.test.tsx）在 beforeEach 里用 vi.stubGlobal
// 自行覆盖 matchMedia，优先级高于本 setup。

// localStorage 补位（Node ≥22 起必要）：Node 自己在 globalThis 上定义了一个 `localStorage`
// own property，不带 `--localstorage-file` 时它的值是 **undefined**。vitest 建 happy-dom 环境时
// 不会覆盖 globalThis 上已存在的 key，于是 happy-dom 自带的那份被这个 undefined 挡掉，
// `window.localStorage` 变成 undefined —— 直接调它的测试当场 TypeError（不是断言失败，是
// beforeEach 就炸，看起来像功能坏了）。sessionStorage 没这问题：Node 那份是纯内存的，能用。
//
// 每个测试文件跑在独立 fork 里，所以这份内存实现天然按文件隔离；同一文件内跨 mount 保持，
// 正是「点掉之后重新挂载也不再出现」这类用例需要的语义。
if (typeof window !== 'undefined' && !window.localStorage) {
  const store = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      get length(): number {
        return store.size
      },
      key: (index: number): string | null => [...store.keys()][index] ?? null,
      getItem: (key: string): string | null => store.get(String(key)) ?? null,
      setItem: (key: string, value: string): void => void store.set(String(key), String(value)),
      removeItem: (key: string): void => void store.delete(String(key)),
      clear: (): void => store.clear()
    } satisfies Storage
  })
}

if (typeof window !== 'undefined') {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia
}
