# 动效改进 plans（improve-animations 审计产物）

- **审计 commit**: f4084f96（2026-07-12）
- **来源**: `/improve-animations` 全量审计（八类，4 路并行 + 逐条 file:line 复核）
- **执行方式**: 每份 plan 自包含（零上下文执行器可直接跑）。可交给任意 agent 执行：`improve-animations execute <plan>` 或直接按 plan 步骤实施。
- **审计结论备忘**: 仓库动效纪律整体极佳（无 ease-in / scale(0) / spring 违规，GSAP reduce 门控全覆盖）；本批 plans 全部是「违反自身红线的漏网」修复。未入选 plan 的裁决项（Cmd+K palette 动画、图标 hover 时长 0.4-0.6s）与 token 收口（v3 曲线 token 零消费 + 57 处字面量）记录在审计对话中，可后续再立项。

## Plan 一览

| # | Plan | 严重度 | 状态 |
|---|---|---|---|
| 001 | [清零 5 处 transition:all](001-transition-all-cleanup.md) | MEDIUM | DONE |
| 002 | [可中断 tween 补 overwrite/fromTo](002-interruptible-tween-overwrite.md) | MEDIUM | DONE |
| 003 | [onboarding 不定态进度条 margin-left→transform](003-onboarding-indeterminate-transform.md) | MEDIUM | DONE |
| 004 | [phrase-in 收编三档 + standard 曲线](004-phrase-in-tier-standard-ease.md) | LOW | DONE |
| 005 | [Radix Popover/Select 缩放锚定 trigger](005-radix-popover-select-transform-origin.md) | MEDIUM | DONE |
| 006 | [agents Switch left→translateX + reduce](006-agents-switch-translatex-reduce.md) | MEDIUM | DONE |
| 007 | [AgentThreadList rail 收合收档 + reduce](007-agent-threadlist-rail-tier-reduce.md) | MEDIUM | DONE |
| 008 | [onboarding reduce 只删位移保留淡入](008-onboarding-reduce-keep-fades.md) | LOW | DONE |

## 推荐执行顺序与依赖

1. **001 → 004**（都改 `index.css`，先后串行避免同文件冲突；互相无逻辑依赖）
2. **002**（独立，2 个 TSX 文件）
3. **005**（独立，ui 原语）
4. **006 → 007**（都在 `src/shared/components/agents/`，串行；互相独立）
5. **003 → 008**（都改 `onboarding.css`，串行；008 重写的 reduce 块引用 `.ob .pbar-fill.indeterminate` 选择器，003 不改选择器名，先后皆可但建议 003 先行）

无跨 plan 硬依赖；任意单个 plan 可独立落地与回滚。全部完成后建议跑一次 `cd frontend && pnpm typecheck && pnpm lint && pnpm test`，并按各 plan 的 feel check 逐项过一遍（reduce 模拟统一用 DevTools Rendering 面板）。
