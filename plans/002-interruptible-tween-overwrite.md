# 002 — 可中断 tween 补齐 `overwrite:'auto'` / `fromTo` idiom

- **Status**: DONE
- **Commit**: f4084f96
- **Severity**: MEDIUM（markdown-text）+ LOW（Toast）
- **Category**: Interruptibility（AUDIT §4）
- **Estimated scope**: 2 文件，3 处单行级 diff

## Problem

仓库对「可被快速重入打断的 GSAP tween」有成文 idiom：用 `fromTo`（终点显式）+ `overwrite:'auto'`（打断时从当前值重定向，而不是 revert 跳变）。范例与事故记录见 `frontend/src/shared/components/email/EmailDetail.tsx:450-465`（注释详述了 `gsap.from` 会把「调用时的中途 opacity」快照成终点导致单调下降锁死的真机 bug）。以下两个组件漏掉了这个 idiom：

**① 思考块折叠（可逆 toggle，MEDIUM）** — 思考完成会自动收起（`shown` 由 `active` 派生），用户随时可点 chevron 手动展开；两者相撞时旧 tween 不会被重定向：

```ts
// frontend/src/shared/assistant/components/markdown-text.tsx:57 — current
      gsap.to(el, { height: shown ? 'auto' : 0, opacity: shown ? 1 : 0, duration: DUR.base })
```

**② Toast 进/退场（mid-enter 关闭会微跳，LOW）** — 进场用 `gsap.from`，若在 220ms 进场中途点 X / 被 demote，useGSAP context revert 会先把卡片瞬间打回 opacity:1/x:0 再播退场：

```ts
// frontend/src/shared/components/Toast.tsx:80 — current（exit 分支）
        gsap.to(el, { autoAlpha: 0, x: 16, duration: DUR.fast, onComplete: onExited })
```

```ts
// frontend/src/shared/components/Toast.tsx:86 — current（enter 分支）
        gsap.from(el, { autoAlpha: 0, x: 16, duration: DUR.base, clearProps: 'transform' })
```

## Target

```ts
// markdown-text.tsx:57 — target
      gsap.to(el, {
        height: shown ? 'auto' : 0,
        opacity: shown ? 1 : 0,
        duration: DUR.base,
        overwrite: 'auto'
      })
```

```ts
// Toast.tsx:80 — target（exit）
        gsap.to(el, { autoAlpha: 0, x: 16, duration: DUR.fast, overwrite: 'auto', onComplete: onExited })
```

```ts
// Toast.tsx:86 — target（enter：from → fromTo，终点显式，防中途打断快照）
        gsap.fromTo(
          el,
          { autoAlpha: 0, x: 16 },
          { autoAlpha: 1, x: 0, duration: DUR.base, clearProps: 'transform', overwrite: 'auto' }
        )
```

## Repo conventions to follow

- 模仿范例：`frontend/src/shared/components/email/EmailDetail.tsx:462`——`gsap.fromTo(el, { autoAlpha: 0 }, { autoAlpha: 1, duration: DUR.fast, overwrite: 'auto' })`。
- 全仓其余可中断路径均已带 `overwrite:'auto'`（CalendarLayout.tsx:121、CalendarToolbar.tsx:110、EmailListHeader.tsx:84、SettingsShell.tsx:78、useEmailListRows.ts:640/689），本 plan 是补齐最后的漏网。
- 曲线/时长不动：`DUR.base`/`DUR.fast` + gsap 默认 standard 曲线即合规。

## Steps

1. `frontend/src/shared/assistant/components/markdown-text.tsx:57`：给 `gsap.to` vars 追加 `overwrite: 'auto'`。
2. `frontend/src/shared/components/Toast.tsx:80`：exit `gsap.to` vars 追加 `overwrite: 'auto'`（保持 `onComplete: onExited` 不变）。
3. `frontend/src/shared/components/Toast.tsx:86`：enter `gsap.from(...)` 改写为 Target 中的 `gsap.fromTo(...)`。

## Boundaries

- 不动两文件里的 reduce 分支（`gsap.set` 短路逻辑）。
- 不动 `AssistantChatModal.tsx` 的 dock 进场（非快速重入路径，审计判 LOW 不修）。
- 不改 duration / 曲线 / 依赖数组 / scope。
- 若行内容与摘录不一致（commit 漂移），停下报告。

## Verification

- **Mechanical**：`cd frontend && pnpm typecheck && pnpm lint` 全绿。相关单测：`cd frontend && pnpm test -- tests`（测试环境全局强制 reduce，GSAP no-op，不应有行为变化——结果以退出码为准，勿用 `| tail` 截断判断）。
- **Feel check**（`cd frontend && pnpm dev`）：
  - Chat 里发起一个会出现「思考中」块的提问：思考进行中反复快速点 chevron 展开/收起，折叠动画应从**当前高度**平滑反向，无「先跳到端点再动」的闪跳；等思考自然完成触发自动收起时立刻手动展开，同样无跳变。
  - 触发一个 toast（如归档邮件），在滑入进行到一半时点 X 关闭：卡片应从**当前位置/透明度**直接滑出，不应先闪到完全不透明再退场。
  - macOS 系统设置开「减弱动态效果」后重复上两步：全部瞬时切换，无残留动画。
- **Done when**：上述两个打断场景肉眼无跳变，typecheck/lint/test 全绿。
