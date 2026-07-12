# 007 — AgentThreadList 会话侧栏收合：时长收编三档 + reduce 门控

- **Status**: DONE
- **Commit**: f4084f96
- **Severity**: MEDIUM
- **Category**: Performance + Accessibility（AUDIT §5 + §6）
- **Estimated scope**: 1 文件，1 行

## Problem

agents 会话侧栏 rail 收合（`w-12` ↔ `w-[260px]`）用 `transition-[width] duration-200`：

```tsx
// frontend/src/shared/components/agents/AgentThreadList.tsx:127-132 — current
        fluid
          ? 'w-full'
          : cn(
              'border-r border-ink-border transition-[width] duration-200',
              isRail ? 'w-12' : 'w-[260px]'
            )
```

三个问题：① `duration-200` 不在 120/220/380 三档（违反「不发明第四档」红线）；② 这是容器 width 动画（内容逐帧 reflow），且没有任何 reduce 覆盖——index.css 的 reduce 块全是选择器级、覆盖不到这个 Tailwind 任意值 transition，reduce 下侧栏照样滑动（AUDIT §6 位移必须可关）；③ 未显式曲线（Tailwind 默认恰为 standard，但仓库口径是显式 `ease-standard`）。

width 动画本身此处**保留**：收合语义就是宽度挤压（同 AIChatPanel/ChatSidebar 的既有 width tween 家族），本 plan 只做收档 + a11y 门控。

## Target

```tsx
// target — 仅改 cn() 内第一个字符串
              'border-r border-ink-border transition-[width] duration-base ease-standard motion-reduce:transition-none',
```

`duration-base` = 220ms（`frontend/tailwind.config.ts:126-130`），`ease-standard` = `cubic-bezier(0.4, 0, 0.2, 1)`（同文件 :123-125），`motion-reduce:transition-none` 让 reduce 下瞬时切换。

## Repo conventions to follow

- `motion-reduce:` 变体在仓内已是通行做法（如 `ChatModalFab.tsx:41` 的 `motion-reduce:transition-none`、`LoadingSkeleton` 家族的 `motion-reduce:animate-none`）。
- 220ms（base 档）匹配同类收合动画：`.app-nav` 收合 `width 220ms`（index.css:1195）。

## Steps

1. `frontend/src/shared/components/agents/AgentThreadList.tsx:130`：按 Target 替换该行字符串。

## Boundaries

- 不动 `fluid` 分支、不动 `isRail` 宽度值、不动玻璃材质 class（:126）。
- 不把 width 动画改成 transform 方案（收合挤压语义需要真实宽度变化让右侧内容回流，属既有设计）。
- 若与摘录不一致（commit 漂移），停下报告。

## Verification

- **Mechanical**：`cd frontend && pnpm typecheck && pnpm lint` 全绿。
- **Feel check**（`cd frontend && pnpm dev`）：
  - agents 视图点收合钮：侧栏 220ms 平滑收到 rail、再展开；与 `.app-nav`（主导航收合）的节奏感一致。
  - 收合中途再点（快速连点）：从当前宽度折返，无跳变（CSS transition 天然可重定向）。
  - DevTools Rendering 开 `prefers-reduced-motion: reduce`：收合/展开瞬时完成，无滑动。
- **Done when**：时长在三档、reduce 下零动画、交互无回退。
