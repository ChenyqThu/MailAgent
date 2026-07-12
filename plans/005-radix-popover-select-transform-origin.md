# 005 — Radix Popover/Select 缩放锚定到 trigger（transform-origin）

- **Status**: DONE
- **Commit**: f4084f96
- **Severity**: MEDIUM（popover/select）+ LOW（tooltip，可选步骤）
- **Category**: Physicality & origin（AUDIT §3）
- **Estimated scope**: 2 文件（+1 可选），每处 1 行新增 class

## Problem

三个 Radix 浮层原语用 tailwindcss-animate 的 `zoom-in-95/zoom-out-95` 做缩放出入场，但没设置 `transform-origin`——默认从**几何中心**缩放。Radix 在 content 元素上注入了 `--radix-*-content-transform-origin`（指向 trigger 侧），当前无人消费。AUDIT §3：popover/dropdown/tooltip 必须从 trigger 生长，模态框才允许 center（`ui/dialog.tsx` 豁免，勿动）。

```tsx
// frontend/src/shared/components/ui/popover.tsx:30-34 — current（PopoverContent className 内）
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        'data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2',
        'data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1',
```

```tsx
// frontend/src/shared/components/ui/select.tsx:98-101 — current（SelectContent className 内）
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        'data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2',
```

```tsx
// frontend/src/shared/components/ui/tooltip.tsx:32-36 — current（可选，LOW）
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
```

## Target

在每个 content 的 class 列表中（`zoom` 行之后即可）各加一个 origin class，值消费对应组件的 Radix 变量：

```tsx
// popover.tsx — 新增一行 class
        'origin-[var(--radix-popover-content-transform-origin)]',
```

```tsx
// select.tsx — 新增一行 class
        'origin-[var(--radix-select-content-transform-origin)]',
```

```tsx
// tooltip.tsx — 可选新增一行 class
        'origin-[var(--radix-tooltip-content-transform-origin)]',
```

Tailwind 的 `origin-[...]` 任意值直接编译为 `transform-origin: var(...)`，无需改 CSS 文件。

## Repo conventions to follow

- 这三个原语按 `frontend/docs/motion-gsap.md` §1 属于「Radix 托管、tailwindcss-animate 负责动画」区——**不要**引入 GSAP 或改用 useExitAnimation；设置 transform-origin 不是叠加动画，属合规修正。
- 变量名规律：`--radix-<组件名>-content-transform-origin`（Radix 官方注入，AUDIT §3 亦引用同款写法）。
- 仓库手写 popover（useExitAnimation 系）已全部正确锚定 origin（如 `EmailListHeader.tsx:117` 的 `'top right'`），本 plan 让 Radix 系与之对齐。

## Steps

1. `frontend/src/shared/components/ui/popover.tsx`：在 `zoom-out-95/zoom-in-95` 那一行 class 后新增 `'origin-[var(--radix-popover-content-transform-origin)]',`。
2. `frontend/src/shared/components/ui/select.tsx`：同法新增 `'origin-[var(--radix-select-content-transform-origin)]',`。
3. （可选）`frontend/src/shared/components/ui/tooltip.tsx`：同法新增 `'origin-[var(--radix-tooltip-content-transform-origin)]',`。

## Boundaries

- **不动 `ui/dialog.tsx`**——模态框 center 缩放是正确的（AUDIT §3 明文豁免）。
- 不改 zoom/fade/slide 的任何现有 class，不改 duration。
- 不动 `dropdown-menu.tsx` 等本 plan 未列出的文件（如 grep 发现同款问题，报告而非顺手改）。
- 若 class 列表与摘录不一致（commit 漂移），停下报告。

## Verification

- **Mechanical**：`cd frontend && pnpm typecheck && pnpm lint` 全绿；build 后检查产物 CSS 含 `transform-origin:var(--radix-popover-content-transform-origin)`（或 dev 模式 DevTools Elements 面板确认 content 元素的 computed `transform-origin` 不再是几何中心）。
- **Feel check**（`cd frontend && pnpm dev`）：
  - 打开一个 Select（设置页任意下拉）：DevTools → More tools → Animations 面板把播放速率降到 10%，重开下拉，确认菜单从 **trigger 一侧**生长（向下弹出时 origin 在顶部），不再从中心均匀放大。
  - 打开一个 Popover 消费点（`ComposeEditor.tsx` / `AiTab.tsx` / `AgentThreadList.tsx` 均有）同样确认。
  - 向上弹出的场景（空间不足时 Radix 翻转 side）：origin 应自动跟随变为底部——这正是消费变量优于写死 `origin-top` 的原因。
- **Done when**：popover/select（+tooltip 若做）在上下两个弹出方向都从 trigger 侧生长。
