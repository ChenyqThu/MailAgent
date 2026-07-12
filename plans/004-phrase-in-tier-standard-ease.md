# 004 — 思考 phrase 轮播进场收编三档 + standard 曲线

- **Status**: DONE
- **Commit**: f4084f96
- **Severity**: LOW
- **Category**: Easing & duration（AUDIT §2）
- **Estimated scope**: 1 文件，1 行

## Problem

AI 思考态的多段 phrase 轮播（ThinkingPhrases.tsx 消费）进场动画用了 `0.34s` + 裸 `ease`——时长不在 120/220/380 三档内（违反 DESIGN.md §8「不发明第四档」红线），裸 `ease` 也不是仓库 standard 曲线；且这是一个 opacity+translateY **进场**，AUDIT §2 要求进场用 ease-out 族强曲线，仓库口径即 standard：

```css
/* frontend/src/electron/renderer/index.css:4778 — current */
.thinking-phrases-item { animation: phrase-in 0.34s ease both; }
```

（`@keyframes phrase-in` 本体在 4780 行：`opacity 0→1, translateY(5px)→0`，合成器属性，不动。）

## Target

```css
/* target */
.thinking-phrases-item { animation: phrase-in 0.22s cubic-bezier(0.4, 0, 0.2, 1) both; }
```

## Repo conventions to follow

- 三档时长 fast 120 / base 220 / slow 380（`frontend/docs/motion-gsap.md` §1）；内容进场取 base=220ms。
- CSS 内 standard 曲线的通行写法就是字面量 `cubic-bezier(0.4, 0, 0.2, 1)`（index.css 内 57 处同款，如 index.css:899）。

## Steps

1. `frontend/src/electron/renderer/index.css:4778`：`0.34s ease` → `0.22s cubic-bezier(0.4, 0, 0.2, 1)`，其余不动。

## Boundaries

- 不动 `@keyframes phrase-in`（4780）与 `chat-think-blink`（4781）。
- 不动 reduce 兜底（index.css:5183 已把 `.thinking-phrases-item` animation 杀掉，选择器不变继续生效）。
- 若与摘录不一致（commit 漂移），停下报告。

## Verification

- **Mechanical**：`cd frontend && pnpm lint` 绿。
- **Feel check**（`cd frontend && pnpm dev`）：Chat 里触发 AI 搜索/思考态，观察 phrase 文案轮换：进场略干脆于改前（220ms vs 340ms），仍是淡入+5px 上移，不显生硬；DevTools Rendering 开 reduce 后 phrase 直接切换无动画。
- **Done when**：该行值与 Target 一致，轮播视觉自然。
