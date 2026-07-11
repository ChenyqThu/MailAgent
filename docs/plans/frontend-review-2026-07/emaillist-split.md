# P1-4 — EmailList.tsx 拆分设计（2026-07-10 拍板）

> 台账项 P1-4。现状坐实图（file:line 全证据）见 task `07-10-frontend-review-batch3-structural-closeout` 的 `research/emaillist-map.md`；本 doc 只记拍板结论。
> **勘误**：台账原文"1900 行 + 键盘 + 拖拽"有漂移——实测 1705 行；键盘导航早已是外部 hook（`useEmailKeyboardNav` / `useInboxActionShortcuts`，document 级监听，不读组件 state）；**无拖拽、无右键菜单**（grep 零命中）。

## 现状一句话

1705 行 = 12 个模块级纯函数（~500 行，零 state 依赖）+ 数据管线（5 useQuery → 过滤/分组/分页 → `rows`/`rowHeights`，~560 行耦合密集区）+ Header UI（~210 行 JSX + GSAP tab 指示器）+ 容器 JSX。行级渲染（EmailRow）与批量条（BatchActionBar）历史上已拆出。**零专属单测**，纯函数全靠 e2e 截图间接兜底。

## 拍板：seam 顺序 A → C → B，两次实现派发

`rows`/`rowHeights` 是滚动锚定、snippet 懒取、react-window 三方共读的汇合点，无法完全解耦——策略是把耦合面收窄成 hook 返回值契约，而不是追求零耦合。

### 阶段 A-1（一次派发：纯函数 + 单测 + Header）

| 动作 | 产物 | 约束 |
|---|---|---|
| 12 个纯函数搬出（`computeRowHeight`/`rowTopOfId`/`applyChipFilter`/`applyTab`/`categoryOf`/`applyMultiFilter`/`startOfDay`/`groupByThread`/`groupBySentAnchor`/`partitionByDate`/`flattenGroups`） | `emailListRows.ts`（命名跟 `emailInvalidation.ts` 惯例） | 纯搬移零行为改动；类型一并迁移 |
| `VirtualRow` 搬出（真组件，用 useTranslation） | `EmailListVirtualRow.tsx` | 同上 |
| **补单测**（拆分等价性安全网，A-2 的前置） | `frontend/tests/shared/emailListRows.test.ts` | 覆盖：线程分组去重/head 选择、发件箱锚定语义、日期分桶边界、pinned 桶提升、手风琴拍平 + bundleSelected、三个 filter、行高 28/44/60/78/84/100 六态（snippet 文本口径）、rowTopOfId 前缀和 |
| Header 抽离（tabs + GSAP 胶囊指示器 + 筛选 popover + 批量开关 + meta 计数行） | `EmailListHeader.tsx` | props 只收 `counts`/`categoryCounts`/`priorityCounts` 等管线下游产物；`useEmailFilter`/`useBatch` store 在内部直接读写不经父转发；`tabListRef`/`tabIndicatorRef`/`filterOpen` 随迁 |

### 阶段 A-2（单独派发，A-1 验收合入后启动）

数据管线（5 useQuery + `enrichedById`→`threadSupplement`→`filtered`→`threadGroups`→`orderedIds`→`buckets`→`rows`→`rowHeights` 全链）抽成 `frontend/src/shared/hooks/useEmailListRows.ts`。

- 返回契约（≈）：`{ rows, rowHeights, orderedIds, counts, categoryCounts, priorityCounts, selectedAllFlagged, showLoader, fetchSnippetsUpTo, handleRowsRendered, listRef, captureScrollAnchor, … }`——以实现时的最小充分集为准，禁止为"未来可能"多导出。
- **风险点**：5 个 query 隐式依赖顺序、useMemo/useCallback 依赖数组逐一重核（stale closure 是头号风险）；`isAnchoringRef`（滚动锚定 ↔ 分页屏蔽共享 ref）必须与 `handleRowsRendered` 留在同一模块。
- 滚动锚定两个 `useLayoutEffect` 与 hook 的归属：锚定读 `rows`/`rowHeights`/`listRef`，随 hook 走（保持共享闭包），组件体只留 JSX 组装。

### 目标形态

```
EmailList.tsx            容器 + JSX 组装（目标 ≤ ~400 行）
EmailListHeader.tsx      ~250 行
EmailListVirtualRow.tsx  ~150 行
emailListRows.ts         ~400 行（纯函数）
hooks/useEmailListRows.ts ~500 行（数据管线）
```

## 不变式（每阶段验收）

1. ARCHITECTURE.md §7.1 四条铁律落点逐一保持：listEnriched 不读 blob / snippet 按可见行懒取 / `listByThreads` 批量 / staleTime 5min + SSE 兜新鲜 / `rowHeights` useMemo 预算 O(1) 查表。
2. `pnpm typecheck` 0 error；`pnpm test` ≥ 基线 2165 passed（A-1 后应新增 ~30+ 纯函数 case）。
3. pnpm dev 实渲染验证：虚拟化滚动、线程手风琴展开/折叠 + 滚动锚定、j/k + s/u/e 快捷键、bundle 选中 wash、筛选 popover、GSAP tab 指示器（含语言切换重测量）、批量模式、静默分页升级（100→800）、snippet 懒取行高单向增高、搜索跳转滚入视口。
4. 对外契约不变：仍只导出 `EmailList`，唯一消费方 `InboxLayout.tsx` 零改动（新增文件的内部导出除外）。

## 状态

- [x] A-1 落地 `8c856c14`（1705→825，46 case 单测安全网，check 零缺陷）
- [x] A-2 落地 `27c26305`（825→133 + hooks/useEmailListRows.ts 801 行；双重机械字节级比对零差异）
- [x] Phase V 实渲染验证（2026-07-11，`--dir` 打包 + Playwright e2e：EmailList/inbox 面 12 用例全绿——boot/listEnriched/inbox 默认/详情/旗标筛选/深色/双语言截图；另 6 个失败为先存陈旧期望[Settings rail 化击穿 openSettings helper ×5 + ⌘L S3 退役残留 ×1]，与本拆分无因果，已开独立修复任务。⚠️ e2e 前必须退出生产 App——requestSingleInstanceLock 会让测试实例秒退造成 18 全挂假象）
- [x] 台账 P1-4 状态更新（README 台账 ✅，2026-07-11）
