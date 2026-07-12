# 006 — agents 自制 Switch：`left` 位移改 `translateX` + reduce 门控

- **Status**: DONE
- **Commit**: f4084f96
- **Severity**: MEDIUM
- **Category**: Performance + Accessibility（AUDIT §5 + §6）
- **Estimated scope**: 1 文件，1 个组件（~15 行）

## Problem

`src/shared/components/agents/primitives.tsx` 的自制 `Switch` 旋钮用 `left` 定位切换 + `transition: left`——布局属性动画（off-GPU，AUDIT §5）；时长 180ms 不在三档；且 transition 写在 **inline style** 里，`index.css` 的任何 `@media (prefers-reduced-motion)` 块都覆盖不到，组件也没有 JS 门控 → reduce 下旋钮照样滑动（AUDIT §6）。轨道的 `background 180ms` 还漏了曲线：

```tsx
// frontend/src/shared/components/agents/primitives.tsx:209-254 — current（Switch 全文）
export function Switch({
  on,
  onChange,
  size = 'md'
}: {
  on: boolean
  onChange: (v: boolean) => void
  size?: 'sm' | 'md'
}): React.ReactElement {
  const w = size === 'sm' ? 34 : 40
  const h = size === 'sm' ? 20 : 23
  const k = h - 6
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      style={{
        width: w,
        height: h,
        borderRadius: h,
        padding: 0,
        border: 0,
        cursor: 'pointer',
        position: 'relative',
        flexShrink: 0,
        background: on ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-5))',
        transition: 'background 180ms'
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 3,
          left: on ? w - k - 3 : 3,
          width: k,
          height: k,
          borderRadius: '50%',
          background: 'rgb(var(--c-accent-fg))',
          boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
          transition: 'left 180ms cubic-bezier(0.4,0,0.2,1)'
        }}
      />
    </button>
  )
}
```

## Target

旋钮固定 `left: 3`，位移全部走 `transform: translateX()`（on 态位移量 = `w - k - 6`，与原 `w - k - 3` 减去基準 `3` 等价，像素级一致）；时长收编 120ms fast 档；组件内用仓库 hook `useReducedMotion` 门控，reduce 时 transition 置 `'none'`（颜色与位置瞬时切换）：

```tsx
// target（整个 Switch 函数体替换）
export function Switch({
  on,
  onChange,
  size = 'md'
}: {
  on: boolean
  onChange: (v: boolean) => void
  size?: 'sm' | 'md'
}): React.ReactElement {
  const w = size === 'sm' ? 34 : 40
  const h = size === 'sm' ? 20 : 23
  const k = h - 6
  const reduce = useReducedMotion()
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      style={{
        width: w,
        height: h,
        borderRadius: h,
        padding: 0,
        border: 0,
        cursor: 'pointer',
        position: 'relative',
        flexShrink: 0,
        background: on ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-5))',
        transition: reduce ? 'none' : 'background 120ms cubic-bezier(0.4,0,0.2,1)'
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 3,
          left: 3,
          width: k,
          height: k,
          borderRadius: '50%',
          background: 'rgb(var(--c-accent-fg))',
          boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
          transform: on ? `translateX(${w - k - 6}px)` : 'translateX(0)',
          transition: reduce ? 'none' : 'transform 120ms cubic-bezier(0.4,0,0.2,1)'
        }}
      />
    </button>
  )
}
```

新增 import（文件顶部，与现有 import 并列）：

```ts
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
```

## Repo conventions to follow

- import 路径范例：`frontend/src/shared/components/Toast.tsx:31` `import { useReducedMotion } from '@shared/hooks/useReducedMotion'`。
- 「旋钮走 transform」的仓内正确范本：`ui/switch.tsx`（Radix 版，`transition-transform`）与 onboarding 的 `.ob .sw::after`（`transition: transform var(--dur-base)`，onboarding.css:472）。
- 曲线字面量 `cubic-bezier(0.4,0,0.2,1)` 保持该文件原有写法（无空格样式，与 :250 原行一致）。

## Boundaries

- 只动 `Switch` 一个导出，不动同文件其他组件（badge/chip 等）。
- **不**换成 `ui/switch.tsx`（视觉规格不同：本 Switch 有 sm/md 双尺寸与自有配色，替换属重设计，超范围）。
- 不改尺寸/颜色/圆角/阴影常量。
- 若与摘录不一致（commit 漂移），停下报告。

## Verification

- **Mechanical**：`cd frontend && pnpm typecheck && pnpm lint` 全绿（注意本仓 formatter hook：import 与使用点必须同一次编辑落盘，否则未使用 import 会被 autoflake 清除）。
- **Feel check**（`cd frontend && pnpm dev`）：
  - 打开 AI 设置/agents 面板任意开关：拨动手感与改前一致（旋钮平滑滑到对侧），off↔on 终点位置与改前逐像素相同（sm 与 md 各验一次）。
  - 快速连点开关：旋钮从当前位置折返（CSS transition 天然可重定向），无跳变。
  - DevTools Rendering 开 `prefers-reduced-motion: reduce`：拨动立即到位、无滑动，颜色也瞬时切换。
  - DevTools Performance 录制拨动：不再出现由该元素引发的 Layout 记录。
- **Done when**：视觉/终点位置零回退，reduce 下零动画，位移不再触发 layout。
