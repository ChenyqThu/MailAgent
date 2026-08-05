// @vitest-environment happy-dom
//
// 0804 dogfood 流式动效重写 — 核心不变量的判别式测试：
//
//   🔴 任意时刻「正在动」的元素数 ≤ 1。
//
// 病根（调研 gap-beui-agent-components.md §Ⅰ-2 定量实测）：旧实现给每个新 chunk 起一个
// 独立的 380ms wipe 动画，而 chunk 到达间隔由模型出字速度决定（40-80 tok/s 下句间隔
// 162-259ms，突发投递 11ms）→ 并发动画数 ≈ ceil(380/gap) = 2+，与 owner 报的
// 「2 句话同时渲染淡出」逐字吻合。修法（方案 B）= 单一单调前进的揭示游标。
//
// 本文件刻意做到 **对新旧两版实现都能运行**：
// - 静态 import 只有 TranslatedBody（两版都存在）；
// - 帧调度 seam（setStreamRevealFrameSchedulerForTests）动态 import、可选安装 ——
//   旧实现没有这个导出（CSS keyframes 在 span 落 DOM 时自启，无需推帧），跳过即可；
// - 「正在动」的判据是两代机制的并集：
//     .stream-wipe-a / .stream-wipe-b —— 已退役的 per-chunk keyframe 机制。本测试的
//       时间线整个落在单个动画时长(380ms)之内，凡在 DOM 里的这类 span 必然仍在动画中；
//       保留在判据里，防止将来回退成「每 chunk 一个 keyframe」时闸失守。
//     .stream-reveal-head —— 单游标实现的推进头标记（mask 随 --sw-p 逐帧移动的
//       唯一元素）。
//
// 🔴 红线证据（写进回报）：改动前（b0101142..d2bbb731 间的 HEAD）此文件必须红 ——
// 突发场景下旧实现在 DOM 里同时挂着 2-3 个 .stream-wipe-* span。

import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'

import { TranslatedBody } from '@shared/components/email/TranslatedBody'

// 全局 setup（tests/setup.ts）强制 prefers-reduced-motion: reduce；本文件要测的是
// 真实动画路径（新实现在 JS 层就短路 reduce），按 useExitAnimation.test.tsx 先例
// 用 stubGlobal 覆盖成「不 reduce」。旧实现不读 matchMedia，stub 对它无影响。
beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false
      }) as unknown as MediaQueryList
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** 两代机制的「正在动」判据并集（见文件头）。 */
const KINETIC_SELECTOR = '.stream-wipe-a, .stream-wipe-b, .stream-reveal-head'
const kineticCount = (c: HTMLElement): number => c.querySelectorAll(KINETIC_SELECTOR).length

interface ManualScheduler {
  scheduler: { request(cb: (ts: number) => void): number; cancel(id: number): void }
  pump(ms: number): void
}

function makeManualScheduler(): ManualScheduler {
  let nextId = 1
  let now = 0
  const pending = new Map<number, (ts: number) => void>()
  return {
    scheduler: {
      request(cb) {
        const id = nextId++
        pending.set(id, cb)
        return id
      },
      cancel(id) {
        pending.delete(id)
      }
    },
    pump(ms) {
      now += ms
      const cbs = [...pending.values()]
      pending.clear()
      for (const cb of cbs) cb(now)
    }
  }
}

test('高速率突发投递（gap 11ms）下，任意时刻正在动的元素 ≤ 1', async () => {
  // 帧调度 seam：仅新实现导出。旧实现（keyframe 自启）无需推帧即可暴露并发。
  const pluginModule = (await import('@shared/components/email/streamWipePlugin')) as Record<
    string,
    unknown
  >
  const setScheduler = pluginModule.setStreamRevealFrameSchedulerForTests as
    | ((s: ManualScheduler['scheduler'] | null) => void)
    | undefined
  const manual = makeManualScheduler()
  setScheduler?.(manual.scheduler)

  try {
    // 场景 = 生长中的列表（单 markdown block）：Streamdown 的 li 子组件按
    // 「className+position」memo（比较器不看 children），旧行的 span 在后续 render
    // 不被解包 —— 这正是旧实现在真实 DOM 里同时挂多个动画 span 的路径（调研 §Ⅰ-2
    // 的另一条独立路径是跨段落 block）。三步投递间隔 11ms = smoothStream 排空循环
    // 的实测突发间隔。
    const t1 = '- 第一项内容到了。'
    const t2 = '- 第一项内容到了。\n- 第二项内容紧随其后。'
    const t3 = '- 第一项内容到了。\n- 第二项内容紧随其后。\n- 第三项内容也几乎同时。'

    const { container, rerender } = render(<TranslatedBody text={t1} streaming />)
    await waitFor(() => {
      expect(container.textContent).toContain('第一项')
    })
    expect(kineticCount(container)).toBeLessThanOrEqual(1)

    manual.pump(11)
    rerender(<TranslatedBody text={t2} streaming />)
    await waitFor(() => {
      expect(container.textContent).toContain('第二项')
    })
    // 🔴 旧实现在此红：li1 的 wipe span（memo 惰性留存、动画开始仅 11ms）+ li2 的新
    // wipe span 同时在 DOM —— 2 个并发动画。
    expect(kineticCount(container)).toBeLessThanOrEqual(1)

    manual.pump(11)
    rerender(<TranslatedBody text={t3} streaming />)
    await waitFor(() => {
      expect(container.textContent).toContain('第三项')
    })
    expect(kineticCount(container)).toBeLessThanOrEqual(1)

    // 沿整条揭示时间线逐帧采样：任何一帧都不得出现第二个在动元素；且揭示只前进不回退。
    let doneSoFar = 0
    for (let i = 0; i < 150; i++) {
      expect(kineticCount(container)).toBeLessThanOrEqual(1)
      const done = container.querySelectorAll('.stream-reveal-done').length
      expect(done).toBeGreaterThanOrEqual(doneSoFar)
      doneSoFar = done
      manual.pump(16)
    }
    expect(kineticCount(container)).toBeLessThanOrEqual(1)

    if (setScheduler) {
      // 新实现：推完 150 帧（虚拟 2.4s）后 backlog 必须清空 —— 没有 pending 段残留，
      // 推进头也已退场（全部揭示完毕）。
      expect(container.querySelectorAll('.stream-reveal-head')).toHaveLength(0)
      for (const el of container.querySelectorAll('.stream-reveal')) {
        expect(el.classList.contains('stream-reveal-done')).toBe(true)
      }
    }

    // 不丢字（对两代实现同样成立）：settle 后 DOM 文本与同文本的静态渲染逐字相等。
    rerender(<TranslatedBody text={t3} streaming={false} />)
    await waitFor(() => {
      expect(container.querySelectorAll('.stream-wipe, .stream-reveal')).toHaveLength(0)
    })
    const ground = render(<TranslatedBody text={t3} streaming={false} />)
    expect(container.textContent).toBe(ground.container.textContent)
  } finally {
    setScheduler?.(null)
  }
})
