# 003 — onboarding 不定态进度条 `margin-left` 循环改 `transform`

- **Status**: DONE
- **Commit**: f4084f96
- **Severity**: MEDIUM
- **Category**: Performance（AUDIT §5）
- **Estimated scope**: 1 文件，1 个 keyframes + 1 行

## Problem

onboarding 的不定态进度条用 `margin-left` 做无限循环动画——margin 是布局属性，挂载期间**每一帧都触发 reflow**（AUDIT §5：只允许动 transform/opacity）。初始同步等待屏会长时间停留在这个状态，持续布局开销：

```css
/* frontend/src/electron/renderer/onboarding/onboarding.css:567-577 — current */
.ob .pbar-fill.indeterminate {
  width: 35% !important;
  animation: indet 1.3s ease-in-out infinite;
}
@keyframes indet {
  0% {
    margin-left: -35%;
  }
  100% {
    margin-left: 100%;
  }
}
```

轨道容器已有 `overflow: hidden`（onboarding.css:555-560 `.ob .pbar`），滑出部分会被裁剪，可安全换 transform。

## Target

`margin-left` 的百分比相对**父级**宽度；`translateX` 的百分比相对**元素自身**宽度（自身 = 父级的 35%）。换算：`-35% ÷ 0.35 = -100%`，`100% ÷ 0.35 ≈ 285.72%`。视觉轨迹逐帧等价：

```css
/* target */
.ob .pbar-fill.indeterminate {
  width: 35% !important;
  animation: indet 1.3s ease-in-out infinite;
  will-change: transform;
}
@keyframes indet {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(285.72%);
  }
}
```

时长（1.3s，无限循环类豁免三档）、缓动、`width: 35% !important` 全部不动。

## Repo conventions to follow

- 「循环动画走 transform」已是仓库现状：`frontend/src/electron/renderer/index.css:4724-4725` 的 `shimmer-win`/`shimmer-hi` 就是 translateX 循环（并有 4713-4756 的长注释解释为何弃用 background-position）。
- `will-change` 用于**持续循环**的动画元素是合理的；本元素只在 indeterminate 态存在，类名移除即销毁，无 dangling 风险。

## Steps

1. `frontend/src/electron/renderer/onboarding/onboarding.css:567-577`：按 Target 整块替换 `.ob .pbar-fill.indeterminate` 与 `@keyframes indet`。

## Boundaries

- 不动 `.ob .pbar`（555）与 `.ob .pbar-fill`（561，determinate 态的 `transition: width 0.4s`——那是数据进度语义，另行不修）。
- 不动 reduce 块（onboarding.css:694-698 已把 `.ob .pbar-fill.indeterminate` 的 animation 杀掉，选择器不变所以继续生效）。
- 不改时长/缓动/颜色/尺寸。
- 若与摘录不一致（commit 漂移），停下报告。

## Verification

- **Mechanical**：`cd frontend && pnpm lint` 绿；`grep -n "margin-left" frontend/src/electron/renderer/onboarding/onboarding.css` 在 keyframes 内应为零命中。
- **Feel check**：onboarding 只在 fresh userData 首启出现，dev 下不易进入。两种验法任选：
  - 打包/删 userData 走一遍 onboarding 到同步等待屏：滑条视觉轨迹与改前一致（从左侧滑入 → 滑出右侧循环），无卡顿。
  - 或在 `pnpm dev` 的 DevTools 里手工造一个最小 DOM：`<div class="ob"><div class="pbar"><div class="pbar-fill indeterminate"></div></div></div>`，Performance 面板录 3 秒，确认无每帧紫色 Layout 条（改前应能看到连续 reflow）。
  - DevTools Rendering 面板开 `prefers-reduced-motion: reduce`：滑条静止（animation: none 兜底仍生效）。
- **Done when**：动画视觉等价 + Performance 录制中该动画不再产生逐帧 Layout。
