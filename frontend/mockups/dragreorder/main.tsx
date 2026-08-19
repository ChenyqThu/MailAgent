// DragReorderList「落下时序」诊断 harness —— 挂**真实**组件（不复刻），
// 用法与 FolderPicker 一致：受控 items（useMemo 派生自 string[] order）+ 同步 setOrder。
//
// 页面自带逐帧探针：pointerdown 时抓每行的静止 top 作基线，之后每个 rAF 采样
// 每行的 `getBoundingClientRect().top` 与实际写进 DOM 的 translateY，pointerup
// 后再录 700ms。落下瞬间行是否「先回到原位」在轨迹里是可读的数字，不靠肉眼。
//
// 读法：dropped 那一帧之后，被拖行的 top 若等于它**拖拽前**的 rest top，就是回弹。

import { StrictMode, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

import '../../src/electron/renderer/index.css'
import { DragReorderList, type ReorderItem } from '@shared/components/ui/DragReorderList'
import { LegacyDragReorderList } from './legacy'

const FOLDERS = ['收件箱', '已发送', '存档', '草稿箱', '项目 · Omada']

interface Sample {
  t: number
  phase: string
  tops: Record<string, number>
  ty: Record<string, number>
}

function translateY(el: Element): number {
  const m = new DOMMatrixReadOnly(getComputedStyle(el).transform)
  return Math.round(m.m42 * 100) / 100
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-reorder-item]')]
}

function snapshot(phase: string, t0: number): Sample {
  const tops: Record<string, number> = {}
  const ty: Record<string, number> = {}
  for (const row of rows()) {
    const id = row.dataset.id!
    tops[id] = Math.round(row.getBoundingClientRect().top * 100) / 100
    ty[id] = translateY(row)
  }
  return { t: Math.round(performance.now() - t0), phase, tops, ty }
}

function App(): React.ReactElement {
  const [order, setOrder] = useState<readonly string[]>(FOLDERS)
  const [trace, setTrace] = useState<Sample[]>([])
  const [buggy, setBuggy] = useState(false)
  const runningRef = useRef(false)

  const items = useMemo<ReorderItem[]>(() => order.map((n) => ({ id: n, label: n })), [order])

  // FolderPicker.handleReorder 逐字同款：同步 setState，无异步。
  const onReorder = (list: ReorderItem[]): void => setOrder(list.map((i) => i.id))

  function record(): void {
    if (runningRef.current) return
    runningRef.current = true
    const t0 = performance.now()
    const out: Sample[] = [snapshot('rest(before drag)', t0)]
    let upAt: number | null = null
    const onUp = (): void => {
      upAt = performance.now()
      out.push(snapshot('pointerup(sync)', t0))
    }
    window.addEventListener('pointerup', onUp, { once: true, capture: true })
    const tick = (): void => {
      out.push(snapshot(upAt === null ? 'drag' : 'after-drop', t0))
      if (upAt !== null && performance.now() - upAt > 700) {
        runningRef.current = false
        window.removeEventListener('pointerup', onUp, true)
        setTrace(out)
        ;(window as unknown as { __trace: Sample[] }).__trace = out
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  ;(window as unknown as { __record: () => void }).__record = record
  ;(window as unknown as { __order: () => readonly string[] }).__order = () => order

  return (
    <div className="min-h-screen bg-ink-1 px-8 py-7 text-ink-fg">
      <div className="mx-auto max-w-[720px] space-y-5">
        <header className="space-y-1">
          <h1 className="text-lg font-semibold">DragReorderList — 落下时序 harness</h1>
          <p className="text-meta text-ink-fg-3">
            真组件 + FolderPicker 同款受控用法。先点「开始录制」再拖，松手后 700ms 出轨迹。
          </p>
        </header>

        <div
          className={[
            'rounded-[var(--r-card)] border px-4 py-3',
            buggy ? 'border-fail/40 bg-fail/[0.07]' : 'border-ok/40 bg-ok/[0.07]'
          ].join(' ')}
        >
          <div className="flex items-center gap-2.5">
            <span className={buggy ? 'text-body font-semibold text-fail' : 'text-body font-semibold text-ok'}>
              {buggy ? '当前：复现现状缺陷（修复前的冻结副本）' : '当前：已修版（src/shared 里的真组件）'}
            </span>
          </div>
          <label className="mt-2 flex items-center gap-2 text-meta text-ink-fg-2">
            <input type="checkbox" checked={buggy} onChange={(e) => setBuggy(e.target.checked)} />
            <span>勾上 = 复现现状缺陷（落下先回原位，再突然换位）；不勾 = 修复后（落下即落位）</span>
          </label>
        </div>

        <div className="flex items-center gap-2.5 text-meta">
          <button
            type="button"
            onClick={record}
            className="rounded-[var(--r-ctl)] border border-ink-border px-2.5 py-1 hover:bg-ink-3"
          >
            开始录制
          </button>
          <button
            type="button"
            onClick={() => {
              setOrder(FOLDERS)
              setTrace([])
            }}
            className="rounded-[var(--r-ctl)] border border-ink-border px-2.5 py-1 hover:bg-ink-3"
          >
            重置
          </button>
          <span className="text-ink-fg-3">当前顺序：{order.join(' → ')}</span>
        </div>

        <div className="rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-4">
          {buggy ? (
            <LegacyDragReorderList items={items} onReorder={onReorder} />
          ) : (
            <DragReorderList items={items} onReorder={onReorder} />
          )}
        </div>

        <pre className="max-h-[420px] overflow-auto rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-3 text-[11px] leading-4 text-ink-fg-2">
          {trace.length === 0 ? '（无轨迹）' : trace.map((s) => JSON.stringify(s)).join('\n')}
        </pre>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
