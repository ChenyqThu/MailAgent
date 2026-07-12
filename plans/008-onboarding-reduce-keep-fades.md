# 008 — onboarding reduce 块：只删位移，保留颜色/透明度淡入

- **Status**: DONE
- **Commit**: f4084f96
- **Severity**: LOW
- **Category**: Accessibility（AUDIT §6）
- **Estimated scope**: 1 文件，1 个 media 块重写

## Problem

onboarding 的 reduced-motion 块用 `.ob * { transition-duration: 0.01ms !important; }` 一刀切，把**所有** transition 打成瞬时——包括帮助理解的 background/color/opacity 淡入（按钮 hover、输入框 focus 边框等）。AUDIT §6：reduce 的语义是「删位移、保留 opacity/color 类理解性反馈」，不是清零一切：

```css
/* frontend/src/electron/renderer/onboarding/onboarding.css:694-709 — current
   （行号基準：plan 003 落地后；审计 commit f4084f96 时为 694-707） */
@media (prefers-reduced-motion: reduce) {
  .ob .step-enter,
  .ob .spin,
  .ob .pbar-fill.indeterminate {
    animation: none !important;
  }
  .ob * {
    transition-duration: 0.01ms !important;
  }
  .ob .btn-primary:active,
  .ob .chip-sel:active,
  .ob .opt-card:active {
    transform: none;
  }
}
```

> 修订（2026-07-12，plan 作者）：初版摘录漏掉了块尾的 `:active { transform: none }` 规则（按压位移抑制，与本 plan 意图一致）——**该规则必须保留**，Target 已含。

全文件含**位移（transform）**的 transition 仅 4 处（已逐行核实）：

| 选择器 | 行号 | 原 transition 属性 |
|---|---|---|
| `.ob .chip-sel` | 348-349 | background-color, border-color, color, **transform** |
| `.ob .opt-card` | 381-384 | border-color, background-color, box-shadow, **transform** |
| `.ob .sw::after`（开关旋钮） | 472 | **transform**（仅此一项） |
| `.ob .btn-primary` | 597-599 | background-color, color, **transform** |

其余全部是 background/color/border-color/box-shadow/opacity（理解性反馈，应保留）；`.ob .pbar-fill` 的 `width 0.4s`（565）是数据进度语义，同样保留。

## Target

删掉 `.ob *` 一刀切，改为对上表 4 个选择器**只摘除 transform**（用 `transition-property` 覆写，颜色淡入继续存活）：

```css
/* target — 整个 media 块 */
@media (prefers-reduced-motion: reduce) {
  .ob .step-enter,
  .ob .spin,
  .ob .pbar-fill.indeterminate {
    animation: none !important;
  }
  /* 只删位移，保留颜色/透明度反馈（AUDIT §6）。下列 4 处的 transition 含 transform，
     用 transition-property 覆写摘除它；.sw::after 只有 transform → 直接 none。 */
  .ob .chip-sel {
    transition-property: background-color, border-color, color !important;
  }
  .ob .opt-card {
    transition-property: border-color, background-color, box-shadow !important;
  }
  .ob .btn-primary {
    transition-property: background-color, color !important;
  }
  .ob .sw::after {
    transition: none !important;
  }
  /* 按压位移抑制（既有规则，保留原样） */
  .ob .btn-primary:active,
  .ob .chip-sel:active,
  .ob .opt-card:active {
    transform: none;
  }
}
```

## Repo conventions to follow

- 主 app 的 reduce 块就是这么做的（选择器级、按类别精准杀，不用全局 `*`）：`frontend/src/electron/renderer/index.css:5179-5187`（animation 类）与 :5194 起（按压 scale 类）。
- 主战场 index.css 同样保留 reduce 下的颜色/透明度 transition，onboarding 与之对齐。

## Steps

1. `frontend/src/electron/renderer/onboarding/onboarding.css:694-709`：按 Target 重写整个 `@media (prefers-reduced-motion: reduce)` 块——删除 `.ob *` 一刀切、新增 4 条 transition 覆写、**原样保留**块尾的 `:active { transform: none }` 规则与块级收尾 `}`。
2. 复查：`grep -n "transform" frontend/src/electron/renderer/onboarding/onboarding.css` 确认除上表 4 处外没有新增含 transform 的 transition（若有 commit 漂移新增，停下报告）。

## Boundaries

- 不动 4 个选择器的**正常态**规则（348/381/472/597 行的原 transition 声明保持原样，只在 media 块内覆写）。
- 不动 `.ob .pbar-fill`（width 过渡，数据语义保留）。
- 不动 index.css 的任何 reduce 块（`email-flash` 等主 app 侧的同类微调不在本 plan 范围）。
- 若与摘录不一致（commit 漂移），停下报告。

## Verification

- **Mechanical**：`cd frontend && pnpm lint` 绿；`grep -n "\.ob \* {" frontend/src/electron/renderer/onboarding/onboarding.css` 零命中。
- **Feel check**：onboarding 需 fresh userData 才能走到；若不便，可在 `pnpm dev` DevTools 里对着 `.ob` 容器内元素直接验证 computed style。开启 Rendering → `prefers-reduced-motion: reduce` 后确认：
  - 按钮/chip hover：背景与文字色**仍有**淡入（不再瞬跳）。
  - 选项卡片（opt-card）hover：边框/底色淡入保留，但 transform 位移瞬时。
  - 开关（.sw）拨动：旋钮瞬时到位、无滑动。
  - step 切换：无 stepIn 位移动画（原有行为不变）。
- **Done when**：reduce 下位移全部瞬时、颜色/透明度反馈全部保留。
