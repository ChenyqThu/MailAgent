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
