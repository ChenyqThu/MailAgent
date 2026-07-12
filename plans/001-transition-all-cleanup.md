# 001 — 清零全部 5 处 `transition: all` / `transition-all`

- **Status**: DONE
- **Commit**: f4084f96
- **Severity**: MEDIUM
- **Category**: Performance（AUDIT §5）
- **Estimated scope**: 4 文件，5 处小 diff

## Problem

仓库自身红线明令禁止 `transition: all`（见 `frontend/src/shared/components/ui/button.tsx:21` 注释 "never transition-all"、`frontend/src/shared/components/agents/shared.ts:6`），因为 `all` 会把非预期属性也拉进过渡（off-GPU，且未来任何新样式属性变更都会意外产生动画）。当前有 5 处漏网：

```css
/* frontend/src/electron/renderer/index.css:4076 — current（.undo-btn 块内） */
.undo-btn {
  flex-shrink: 0;
  height: 30px;
  padding: 0 14px;
  border-radius: 7px;
  font-size: 13px;
  font-weight: 600;
  color: rgb(var(--c-accent));
  background: transparent;
  border: 1px solid rgb(var(--c-accent) / 0.55);
  cursor: pointer;
  transition: all 0.12s;
  font-family: inherit;
}
/* hover 实际只改 background 与 border-color（index.css:4079-4082）*/
```

```css
/* frontend/src/electron/renderer/index.css:4139 — current（.sb-info 块内） */
.sb-info {
  /* …省略布局属性… */
  color: rgb(var(--ink-fg-3));
  cursor: default;
  transition: all 0.12s;
  border: 0;
  background: transparent;
  padding: 0;
}
/* hover/focus 实际只改 background 与 color（index.css:4144-4148）*/
```

注意上面两处 `all 0.12s` 连缓动都没写（落到浏览器默认 `ease`），修复时一并对齐全文件通行的 standard 曲线写法。

```tsx
// frontend/src/shared/assistant/modal/ChatModalFab.tsx:39 — current（hover 展开文案 pill）
'text-meta text-ink-fg-1 opacity-0 transition-all duration-base ease-standard',
// 相邻行 40-41 表明 hover 实际过渡的属性是 max-width / padding / opacity / box-shadow / background：
// 'group-hover:max-w-[16rem] group-hover:bg-ink-2 group-hover:px-3 group-hover:py-1.5',
// 'group-hover:opacity-100 group-hover:shadow-md motion-reduce:transition-none'
```

```tsx
// frontend/src/shared/components/settings/tabs/IslandUpdatesTab.tsx:349 — current（下载进度条填充）
className="h-full bg-coral/100 transition-all"
// 相邻 style={{ width: `${…}%` }} —— 实际只有 width 在变，且未指定 duration（Tailwind 默认 150ms，非三档）
```

```tsx
// frontend/src/shared/components/llm/LlmDashboardPage.tsx:191 — current（准确率仪表条填充）
className={cn('h-full transition-all duration-fast', color)}
// 相邻 style={{ width: `${clamped}%` }} —— 实际变化的是 width 与（换档时的）background-color
```

## Target

逐处枚举真实过渡属性，时长/曲线全部落在三档（120/220/380ms）+ standard 曲线上：

```css
/* index.css .undo-btn — target（只改 transition 一行） */
  transition:
    background 0.12s cubic-bezier(0.4, 0, 0.2, 1),
    border-color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
```

```css
/* index.css .sb-info — target（只改 transition 一行） */
  transition:
    background 0.12s cubic-bezier(0.4, 0, 0.2, 1),
    color 0.12s cubic-bezier(0.4, 0, 0.2, 1);
```

```tsx
// ChatModalFab.tsx:39 — target（transition-all → 枚举；duration/ease/motion-reduce 原样保留）
'text-meta text-ink-fg-1 opacity-0 transition-[max-width,padding,opacity,box-shadow,background-color] duration-base ease-standard',
```

```tsx
// IslandUpdatesTab.tsx:349 — target（width 是进度语义本体，保留 width 过渡但显式化 + 上三档）
className="h-full bg-coral/100 transition-[width] duration-base ease-standard"
```

```tsx
// LlmDashboardPage.tsx:191 — target
className={cn('h-full transition-[width,background-color] duration-fast ease-standard', color)}
```

## Repo conventions to follow

- 枚举属性 + `0.12s cubic-bezier(0.4, 0, 0.2, 1)` 的写法是 index.css 全文件通行做法，范例：`frontend/src/electron/renderer/index.css:789-791`（background / border-color / transform 三属性逐项枚举）。
- Tailwind 侧 `ease-standard` / `duration-fast(120ms)` / `duration-base(220ms)` token 定义在 `frontend/tailwind.config.ts:123-130`。
- Tailwind 任意值多属性写法 `transition-[max-width,padding,opacity]`（逗号分隔、不能有空格）。

## Steps

1. `frontend/src/electron/renderer/index.css:4076`：把 `.undo-btn` 的 `transition: all 0.12s;` 替换为 Target 中的两属性枚举。
2. `frontend/src/electron/renderer/index.css:4139`：把 `.sb-info` 的 `transition: all 0.12s;` 替换为 Target 中的两属性枚举。
3. `frontend/src/shared/assistant/modal/ChatModalFab.tsx:39`：`transition-all` → `transition-[max-width,padding,opacity,box-shadow,background-color]`，其余 class 不动。
4. `frontend/src/shared/components/settings/tabs/IslandUpdatesTab.tsx:349`：`transition-all` → `transition-[width] duration-base ease-standard`。
5. `frontend/src/shared/components/llm/LlmDashboardPage.tsx:191`：`transition-all` → `transition-[width,background-color]`，追加 `ease-standard`，保留 `duration-fast`。
6. 全仓复查归零：`grep -rn "transition: all\|transition-all" frontend/src --include="*.tsx" --include="*.css"` 应只剩注释里的提及（button.tsx:21 / EmailSourcePanel.tsx:16 / ReportsTab.tsx:25 / shared.ts:6）。

## Boundaries

- 不动 `.undo-prog`（index.css:4084 起，GSAP scaleX 倒计时驱动，注释已说明）。
- 不改任何布局/颜色/圆角属性，只动 transition 声明。
- FAB pill 的 max-width/padding hover 展开是既有交互设计，本 plan 只做红线合规（枚举化），**不**改成 transform/clip 方案。
- 不加依赖、不动其他文件。
- 若某行与本 plan 摘录不一致（commit 漂移），停下报告，不要即兴发挥。

## Verification

- **Mechanical**：`cd frontend && pnpm typecheck && pnpm lint` 全绿；步骤 6 的 grep 结果符合预期。
- **Feel check**：`cd frontend && pnpm dev`：
  - 删除一封邮件触发 undo toast，hover「撤销」按钮：背景/边框仍有 120ms 淡入，无突兀变化。
  - hover 状态栏 ℹ️ 图标：背景/文字色淡入如旧。
  - hover 右下角 AI FAB：文案 pill 向左展开的动画与改前视觉一致（max-width/padding 仍在过渡列表内）。
  - LLM 仪表页（设置 → LLM 面板）准确率条：数值变化时条宽平滑生长。
  - DevTools Rendering 面板开启 `prefers-reduced-motion: reduce`：FAB pill 立即切换（`motion-reduce:transition-none` 仍生效）。
- **Done when**：全仓（注释外）`transition: all`/`transition-all` 为零，且上述 5 个交互视觉无回退。
