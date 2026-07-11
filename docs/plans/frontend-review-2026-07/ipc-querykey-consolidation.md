# P2-7 + P2-8 — IPC 错误归一 + queryKey 类型收编设计（2026-07-10 拍板）

> 台账项 P2-7 / P2-8。全量盘点（132 IPC 调用点 / 173 query-client 调用，file:line 证据）见 task `07-10-frontend-review-batch3-structural-closeout` 的 `research/ipc-querykey-map.md`；本 doc 只记拍板结论。
> **勘误台账**：P2-7 原建议"抽 ipcCall wrapper"不成立——~59 个调用点已被 React Query queryFn/mutationFn 兜底，`chat.*` 走 loopback fetch 根本不是 IPC。真实的债是**错误归一化惯用法四套并存、复制粘贴**。

## P2-7 拍板：共享错误归一 helper，不做大一统 wrapper

新建 `frontend/src/shared/lib/ipcErrors.ts`（命名跟 `emailInvalidation.ts` 惯例）：

1. `WriteErrorShape` + `asWriteError()` —— 收编 EmailDetail.tsx / ComposePanel.tsx 两份逐字节拷贝（单源化）。
2. `errorMessage(e: unknown): string` —— 收编 29 处 `e instanceof Error ? e.message : String(e)` 三元 + 4 处不安全 `(e as Error).message` 强转 + AIFieldsBlock.tsx 的变体。
3. **不包 wrapper**：queryFn/mutationFn（~59 处）维持 React Query 边界；订阅点（9 处，disposer 模式已收敛）不动；单向 `sender()`（6 处）不动。

**静默 `.catch()` 分诊（~10 处）**：逐处判定"有意 fire-and-forget"还是"误吞"。政策保守：用户主动触发的写操作失败必须可见（toastError）；后台/预取类保持静默但补一行注释声明有意。不确定的一律保持现状 + 注释。

**记录不做（新台账项）**：EmailRow.tsx 与 useInboxActionShortcuts.ts 各自实现同款"乐观 flag + 回滚"（注释自认重复）——属写路径去重，超出 P2-7 错误处理范畴，热路径风险不值当下动，进台账记录。

## P2-8 拍板：typed queryKey factory 全量收编

新建 `frontend/src/shared/lib/queryKeys.ts`：

1. 按族导出 factory（`as const`），**返回值与现有字面量逐字节一致**——行为零改动，收编是纯替换。20+ 族全覆盖（email/emails/chat/folder/calendar/agent-runs/admin/settings/skills/…）。
2. 与既有单源协调：`emailInvalidation.ts`（'emails' SSE 路由族）与 `useCalendarEvents.ts` 的 `CALENDAR_EVENTS_KEY` 先例——factory 是唯一 key 字面量源，前两者改为从 factory 消费（或 re-export），禁止双定义。
3. ~150 处手拼字面量全量替换；typecheck + vitest 全量守护。

**顺手修一个真 bug（显式行为改动，单独 commit）**：`['email','thread',threadId]`（ThreadSidebar/ThreadBundle 同款）不在 `emailInvalidation.ts` SSE 路由表——flag/read 写事件从不主动 invalidate 线程侧栏，靠 30s staleTime 裸奔。修法：把该族纳入路由表的 supplement 门控段（沿 P1-2 的分层语义，不回退到全前缀扇出）。

## 排期约束

Lane C 必须在 Lane A（EmailList 拆分 A-1/A-2）合入后启动——错误 helper 与 key factory 的收编面覆盖 EmailList 拆分后的新文件，先动会互相冲突。

## 验收

- typecheck 0 error；vitest ≥ 基线（key factory 替换零行为改动；thread SSE 修复可加针对性 case）。
- 收编覆盖率对照 research 盘点：29+4+2 处归一化全收（grep 复核 `instanceof Error ?` 与 `(e as Error)` 在 renderer 侧余量应≈0）；~150 处 key 字面量余量≈0（豁免清单显式列出）。
- 静默 catch 分诊表落在 PR/commit message 里（哪些转可见、哪些声明有意）。

## 状态

- [x] ipcErrors.ts + 收编 `a0b7035f`（~34 三元 + ~20 强转 + asWriteError 双拷贝；余 7 处自定义 fallback 豁免；3 处误吞转 toast）
- [x] queryKeys.ts + 收编 `a0b7035f`（~30 族 / ~90+ 点 / 48 文件；守护测试锚定字节一致；豁免 1 处 calendar spread）
- [x] thread-members SSE 路由修复 `d8c2bbe7`（+6 case，check 核实守住 P1-2 分层）
- [x] 台账 P2-7/P2-8 状态更新 + 新记录项（乐观回滚去重进"明确不做"，2026-07-11）
