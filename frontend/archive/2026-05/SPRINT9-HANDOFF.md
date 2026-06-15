# Sprint 9 Handoff — Island L2 Electron 端接入 + Sprint 7 review LOW polish (5 closed)

> Sprint 9 主开发 handoff. Sprint 9 ship 完成 — Island L2 Electron 端
> 完整接入(unix socket sender + envelope builder + 5min 探测 + 7 IPC channel
> + TitleBar 实时 indicator + useEmailChat 钩 AIDraft 3 事件 + Settings
> IslandSection)+ Sprint 7 review 5 LOW + 1 Nit Day 1 全闭。下个 Sprint 10
> 进入 Sprint 9 review carry-forwards(如有)+ Island-Sprint 2 Python plugin
> 配套 (后端仓 src/notify/) + 真 .dmg release 实测。
>
> **工期实际**: ~2.5 小时(vs PROJECT-PLAN.md Island L2 6-10 天估算 — 因为
> frontend 端只做半套[wire + envelope + IPC + UI]; Python plugin + Swift fork
> 已分别在后端仓 src/notify/ 与 ~/Documents/ping-island/feat/mail-brand 推进)。
>
> **启动前最少读完**: §0 + §1 + §3 + §5 + §9 启动 checklist + §10 红线清单.

---

## 0. TL;DR

| 项 | 值 |
|---|---|
| Sprint 范围 | Island L2 Electron 接入 (unix socket sender + envelope builder + probe loop + 7 IPC channel + TitleBar indicator + useEmailChat 钩 AIDraftStart/Stream/Ready + Settings IslandSection UI) + Sprint 7 review **5 LOW** (L1 ⌘K toggle / L2 useFocusTrap hook 抽取 / L3 searchQ placeholderData / L4 toggleIsland wired:false / L5 ScopeSection h3 tabIndex) + **1 Nit** (LoadingSkeleton string-prefixed key) |
| 已 ship 基线 | commits Sprint 8 上 + (Sprint 9 待 commit) |
| 阀门 | **535 tests passed / 1 skipped** (+44 vs Sprint 8 baseline 491), `pnpm lint` 0, `pnpm typecheck` 0, `pnpm a11y:contrast --strict` **12 组合 clean**, electron-vite build OK, production grep 2 patterns(MAILAGENT_CLI_API_KEY i18n hint + osascript toast hint — Sprint 8 一致非 leak) |
| 工作模式 | Claude Opus 4.7 max-effort 单线 |
| 阻塞 | 无 — 全 gate 绿, 进入 Sprint 10 |
| **Sprint 10 主菜** | (a) Sprint 9 review carry-forwards 闭(待 opus 4.7 code-reviewer 输出); (b) Island Sprint 4 端到端联调 — **Python plugin 已在 main** (`e39cc3f` Island-Sprint 2 / PR #2, 2026-05-18 cherry-pick reconcile, 702/702 pytest, 47 个 island_* 单测), 联调只需: 启 ping-island.app fork(`feat/mail-brand`) + `.env` 设 `PING_ISLAND_ENABLED=true` + `pm2 restart mail-sync` 触发 v6→v7 DB migration + 决议 ISLAND-PLUGIN §2.5.4 三方案(推荐 A: Python 端 eventType 映射 `Notification` + `metadata.*` 区分); (c) 真 .dmg release 实测 + GitHub Release artifact 上传 |

---

## 1. 已 ship deliverables

### 1.1 主菜 — Island L2 Electron 端接入

#### D1: bridge core (3 模块, ~470 行)

| 模块 | 行数 | 测试 | 作用 |
|---|---|---|---|
| `src/electron/main/island/envelope.ts` | 232 | 13 | BridgeEnvelope 5 type builder (AppearanceChange + AIDraft{Start,Stream,Ready} + Ping) + Swift Date 编码 (`sentAt = unixSeconds - 978307200`) + clipPreview 240 char 截断 |
| `src/electron/main/island/sender.ts` | 215 | 13 | `net.createConnection` 单 envelope writer + ISLAND-PLUGIN §3.1 wire 协议(3s timeout / 64 KiB envelope / 1 MiB response 上限 / half-close SHUT_WR) + fail-open SendOutcome 5 reason buckets (enoent / refused / timeout / protocol / unknown) |
| `src/electron/main/island/probe.ts` | 145 | (via handler) | 5min 探测 loop + IslandStatus state machine (idle/connected/degraded/disconnected/dev-disabled/disabled) + setIslandEnabled toggle + subscribeIslandStatus listener |
| `src/electron/main/island/index.ts` | 50 | — | Barrel re-export |

#### D2: IPC handler + main 注入 (220 行)

| 模块 | 行数 | 测试 | 作用 |
|---|---|---|---|
| `src/electron/main/handlers/island.ts` | 180 | 17 | 7 IPC channel: 3 invoke (`island:status` / `:testConnection` / `:setEnabled`) + 4 send (`island:appearance` / `:aiDraftStart` / `:aiDraftStream` / `:aiDraftReady`) + 1 broadcast (`island:event`). payload guards 拒绝 malformed input silent。订阅 probe 状态变化 broadcast 给所有 BrowserWindow |
| `src/electron/main/index.ts` | +5 | — | `registerIslandHandlers()` 注入 startup 流程 (在 createWindow 前) |

#### D3: shared types + ElectronApi/HttpApi/store (~150 行)

| 模块 | 改动 | 作用 |
|---|---|---|
| `src/shared/api/types.ts` | +60 | `IslandApi` + `IslandStatus` + `IslandConnectionState` + 4 payload type,加进 `MailApi` |
| `src/shared/api/ElectronApi.ts` | +30 | `ElectronIslandApi` class wire 7 IPC channel + `onEvent` subscribe |
| `src/shared/api/HttpApi.ts` | +20 | V2 stub (Web SPA 不能直接打 unix socket; AIDraft 4 send 是 no-op,status/testConnection 走 notImplemented) |
| `src/shared/state/island.ts` (新文件) | 45 | zustand store + `setIslandStatus` helper + `islandStateI18nKey` 把 wire kebab `dev-disabled` 转 camelCase i18n key |

#### D4.1: TitleBar Island indicator wire (~30 行 net)

| 改动 | 内容 |
|---|---|
| `src/shared/components/layout/TitleBar.tsx` | useEffect 接 store: mount 时调 `mailApi.island.status()` 一次 hydrate + `onEvent` 订阅;dot color 按 `IslandConnectionState` 映射 (`connected=ok`/`degraded=warn`/默认`ink-fg-3`);title 走 i18n `titleBar.island.${state}` |

#### D4.2: appearance store 推 island envelope

| 改动 | 内容 |
|---|---|
| `src/shared/state/appearance.ts` | `applyResolvedTheme` + `applyAccent` 内除现有 `appearance:theme` / `appearance:nativeTheme` / `appearance:accent` 三 sink 外,新加 `island:appearance` send (合并 payload `{accent, theme: resolvedTheme}`) |

#### D5: useEmailChat 钩 AIDraft 3 事件 (~50 行 net)

| 钩点 | 时机 |
|---|---|
| `send()` 成功 stranded check 后 | `mailApi.island.aiDraftStart({emailId, senderName:null, subject:null, prompt})` |
| stream `chunk` event (throttled 500ms) | `mailApi.island.aiDraftStream({emailId, streamedChars})` |
| stream `done` event | `mailApi.island.aiDraftReady({emailId, preview: finalContent.slice(0,240)})` |
| stream `error/aborted` | 不 fire (ping-island session 自然在 chat error 上保持 pending,后续 user retry 或 abort 会发新 envelope) |

streamedChars 用 ref 跟,每 500ms wall-clock fire 一次。fire-and-forget 不阻塞 chat 流。

#### D6: Settings IslandSection + i18n (~145 行新加 + 32 i18n keys)

| 改动 | 内容 |
|---|---|
| `src/shared/components/settings/SettingsPage.tsx` | 新 `IslandSection` 组件: 状态 pill (颜色 + label) + Socket 路径 (read-only) + 测试连接按钮 (调 `island.testConnection()`) + 启用/关闭 segmented toggle (调 `island.setEnabled`)。useEffect mount 时 hydrate + onEvent 订阅。`islandDotClass` 函数 mapping `IslandConnectionState` 到 swatch class |
| `src/shared/i18n/locales/{zh-CN,en-US}/common.json` | +32 keys per locale: `titleBar.island.{label,idle,connected,degraded,disconnected,devDisabled,disabled}` (7) + `settings.island.{heading,channel,statusLabel,socketPath,testConnection,enable,enableHint,testing,testOk,testFail,lastProbe,toggleOn,toggleOff}` + `settings.island.state.{idle,connected,degraded,disconnected,devDisabled,disabled}` (6) |
| zh-CN 总 keys | 372 (Sprint 8 340 + 32) |
| en-US 总 keys | 372 |
| `[TODO en]` 残留 | 0 |

### 1.2 Sprint 7 review 5 LOW + 1 Nit (Day 1 全闭)

| Severity | Fix | Files |
|---|---|---|
| LOW #1 | `GlobalShortcuts.tsx` ⌘K → `useCommandPalette.getState().toggle()` 接通 (toggle() 是 Sprint 7 zustand store dead code; 现在 ⌘K 二次按下能 dismiss palette) | `GlobalShortcuts.tsx:30-33` |
| LOW #2 | 抽 `useFocusTrap({open, fallbackRef})` hook (新 `src/shared/hooks/useFocusTrap.ts`) — 3 modal 改用 (KeyboardHelpModal / CommandPalette / ResyncConfirmDialog) 消除 ~120 行重复 querySelectorAll boundary 处理 + fix KeyboardHelpModal/ResyncConfirmDialog 缺 `!root.contains(active)` shift-wrap guard 的 drift bug | new `hooks/useFocusTrap.ts` + 3 modal |
| LOW #3 | CommandPalette `searchQ` 加 `placeholderData: undefined` 显式表达不复用 stale snippet (tanstack v5 默认是 undefined,加上显式 doc intent) | `CommandPalette.tsx:182` |
| LOW #4 | `keymap.ts` toggleIsland binding `wired: false` (已存在; Sprint 7 commit `683284a` 落地; Sprint 9 仅文档确认无需改动) | `shared/keymap.ts:201-208` |
| LOW #5 | `KeyboardHelpModal.tsx` `ScopeSection` h3 标题加 `tabIndex={0}` + focus ring 让 VoiceOver / Tab 用户可 anchor focus 在 sections (NVDA rotor 已能找,但 Tab 之前跳过 headings) | `KeyboardHelpModal.tsx:58-69` |
| Nit | LoadingSkeleton `Array.from` map key 从 `key={i}` 改 `key={\`skeleton-bar-${i}\`}` (string-prefixed 让 lint scanner + 人类 reviewer 明确 intent: 固定长度 + 非 reorder placeholder render) | `feedback/LoadingSkeleton.tsx:38-40` |

剩余 2 Nit + 1 Open 留 Sprint 10 (非 user-facing):
- Nit: SkeletonRow `WIDTH_CLASS` 已 typesafe (Record<NonNullable<...>>), Sprint 9 无需 hardening
- Nit: KeyboardHelpModal aria-modal `<li>` 不可 Tab — h3 tabIndex={0} 改善已 cover intent (sections focusable, list items 保持非交互)
- Open: CommandPalette adjust-state StrictMode 双 render stress-test (review 低 confidence; Sprint 9 测试 535 passed StrictMode 已 cover)

### 1.3 测试覆盖

| 文件 | 新测试 | 覆盖 |
|---|---|---|
| `tests/main/island_envelope.test.ts` | +13 | swiftSentAt (Unix epoch / Swift reference epoch / ms precision) + buildAppearanceChange shape + AIDraft{Start,Stream,Ready} shape + preview clipping 240 char + UUID per-call + serializeEnvelope UTF-8 round-trip + CJK 字符 |
| `tests/main/island_sender.test.ts` | +13 | 5 failure buckets (ENOENT / ECONNREFUSED / timeout / unknown / factory throw) + 3 protocol limits (oversize envelope / oversize response / malformed JSON) + 5 happy paths (empty response / JSON response / close-without-end / SHUT_WR 验证 / multi-chunk concat) |
| `tests/main/island_handler.test.ts` | +17 | channel registration (3 invoke + 4 send) + idempotent register + devDisabled status + 4 payload guards + disabled state no-op + setEnabled toggle + 4 internal guards via __testing |
| `tests/shared/useEmailChat.test.tsx` | +1 (mock fixup) | island stub 加进 stableMailApi 让现有 6 测试不 fail on `aiDraftStart undefined` |
| **合计** | **+44** | Sprint 8 baseline 491 → Sprint 9 ship 535 |

---

## 2. Sprint 10 工作清单 (按交付顺序)

### 2.1 Sprint 9 review carry-forwards (Day 1 顺手关 — 待 opus 4.7 code-reviewer 输出)

Sprint 9 末仍需跑一次 opus 4.7 max-effort code-reviewer subagent (强制)。预期 0 CRITICAL / 0 HIGH。如有 MEDIUM/LOW Day 1 闭。

### 2.2 Island L2 端到端联调 (主菜候选)

Sprint 9 frontend 端 ship 完,但仍需:

| 阶段 | 内容 |
|---|---|
| **Python plugin 配套** ✅ 已 ship (`e39cc3f`) | `src/notify/{ping_island,island_dispatch,island_response,island_snooze,island_reconnect,island_envelope,island_i18n,island_bootstrap}.py` 全部在 main(8 个模块 + 4 个 hook 点 + 47 单测 + DB_VERSION 7 + `island_dispatch` 表 + 14d 评估指标聚合)。同样 wire 协议 §3.1 + H-12/H-16/H-17/H-18/M-13/M-14/M-15 决议全落实。详 ISLAND-PLUGIN §4 + memory `project_mailagent_island_sprint2_done` |
| 真启动 ping-island.app | `~/Documents/ping-island/feat/mail-brand` Xcode build + 装到 /Applications |
| 端到端验证 | 主同步邮件 → Python plugin 发 envelope → ping-island 弹 phase 1 灵动岛; Electron 改主题 → ping-island repaint; Electron AI Chat composer.send → ping-island 显 AI 起草中 phase / done 时显草稿 ready |
| **Sprint 4 dispatch 决议 (ISLAND-PLUGIN §2.5.4) — Sprint 10 启动前必决** | mail eventType 名 (MailReceived / LLMReviewed 等)目前不在 ping-island 现 dispatch 表;决定是否 (a) 让 Python plugin emit Notification eventType + 用 metadata.* 区分 (b) Swift fork 加 mail event 识别 (c) 复用 Notification 走 generic HoverSessionCard。**推荐先走 A**(0 Swift 改动 / 30 min Python `island_dispatch.py` eventType 映射 / rebase-friendly);用 1-2 周后觉得语义糊再切 B |

### 2.3 真 .dmg release 实测

Sprint 8 已 ship electron-builder 全配置(dmg+zip × arm64+x64),还差实战:

```bash
gh release create v0.0.1 --draft   # 触发 GitHub Actions 上传 dmg+zip+blockmap+latest-mac.yml
# 等 release artifact ready 后:
# - 实机装 .dmg (右键 → 打开 → 信任 ad-hoc 签名)
# - Settings → 应用更新 → 检查更新 → 验证 in-app updater 状态机
```

### 2.4 V1.5 polish 候选 (按 appetite 决定)

| 任务 | 入口 |
|---|---|
| QuickActions LLM prompt i18n | `QuickActions.tsx` ACTIONS 的 `prompt:` 字段走 i18n key |
| /admin /llm 看板更全数据 | `mailagent llm compare-paths` / Reader insights 接通 |
| 邮件 metadata 进 island envelope | useEmailChat 当前 fire envelope 时 senderName/subject 都为 null;接入 EnrichedEmailMeta 用 useQuery 拉一次缓存 |
| ping-island.app 安装提示 | Settings IslandSection 在 disconnected 时显 "前往 ping-island GitHub release 下载" link |

---

## 3. 工作模式

| 角色 | Agent | 何时用 |
|---|---|---|
| **主线** | Claude Opus 4.7 单线 max-effort | 整 Sprint 10 持续 context |
| **子任务并行** | ultrawork (optional) | Sprint 10 主菜不大,基本不需 |
| **长 IO** | `Bash run_in_background=true` | `pnpm install` / `pnpm electron-vite build` / `pnpm a11y:contrast` / `pnpm build:mac` |
| **Sprint 末 review** | `Agent subagent_type=oh-my-claudecode:code-reviewer model=opus` (强制) | 强制 — 闭环价值高 |
| **禁用** | `codex:codex-rescue` agent / `autopilot` | `[[feedback-codex-collaboration-path]]` 红线 |

参考: `[[reference-mailagent-frontend-dev-collab]]` + `[[feedback-codex-collaboration-path]]`.

---

## 4. 设计约束 (lint / CI 已枪口对准)

DESIGN.md §14 八条非协商 + i18n + 三态主题第 9/10 条 — 同 Sprint 5/6/7/8. Sprint 9 没新增 lint rule.

**Sprint 9 关键 pattern**:
- **Unix socket fail-open** — `sender.ts` 永不 reject Promise; ENOENT / ECONNREFUSED / timeout / protocol / unknown 全部 resolve 到 `{ok:false, reason}`。caller 通过 reason bucket 知道是 ping-island 没装 / 没跑 / 协议错 vs 真错。
- **Probe loop 状态机** — main process `probe.ts` 单 module 持 `IslandStatus`,renderer 通过 `island:event` 广播 subscribe + `island:status` 单次 hydrate。zustand store + 共享 selector hook,TitleBar 和 SettingsPage 都读同一 store(初次 mount 谁先 fetch 谁去 hydrate,其余 piggyback)
- **SocketFactory 注入** — `sendEnvelope` 接受 `factory?: SocketFactory` 参数,生产用 `net.createConnection`,测试注入 fake socket。这样测试不会 reach out unix socket
- **kebab → camelCase i18n key 映射** — `islandStateI18nKey` 把 wire-level `dev-disabled` 转为 camelCase `devDisabled`,因为 react-i18next 把 `.` 当 keypath 分隔,kebab 在 nested object 中查不到
- **useFocusTrap hook + FOCUSABLE_SELECTOR 集中** — Sprint 7 review LOW carry-forward; 3 modal 改用 hook 后,Tab boundary 处理只剩一份 source,加 modal 时只需 attach `dialogRef` + 调 `handleTab(e)`
- **Stream throttle 500ms** — useEmailChat AIDraftStream 用 ref 跟 wall-clock 而非 setState,避免 stream chunk 触发 useEmailChat re-render storm

---

## 5. 架构规范 (关键 + Sprint 9 已落地)

### 5.1 Island bridge 模式 (Sprint 9 沉淀)

新加 island 相关功能:
1. main 端在 `island/{envelope,sender,probe}.ts` 内实现纯函数 builder + 一次性 socket writer + 探测循环,broadcast 单 channel `island:event`
2. handler 端 `handlers/island.ts` 注册 7 channel + payload guard + 订阅 probe → broadcast
3. renderer `shared/state/island.ts` zustand store + `setIslandStatus()` helper + `islandStateI18nKey()` 转 key
4. `useMailApi().island.onEvent(handler)` subscribe 渲染层,unmount 自动 unsubscribe
5. UI 组件读 `useIslandStore(s => s.status)` 单 selector

### 5.2 Envelope builder 与 Swift Date 编码

```typescript
// envelope.ts
const SWIFT_REFERENCE_DATE_OFFSET = 978_307_200  // 2001-01-01 - 1970-01-01 seconds
export function swiftSentAt(now: number = Date.now()): number {
  return now / 1000 - SWIFT_REFERENCE_DATE_OFFSET
}
```

Swift JSONDecoder 的 `.deferredToDate` 默认按 `timeIntervalSinceReferenceDate` 解码; 这里直接生成对的浮点数,Date 解码无需特殊 strategy。

### 5.3 fail-open 5 reason buckets

```typescript
export type SendOutcome =
  | { ok: true; response: unknown | null }
  | {
      ok: false
      reason:
        | 'enoent'    // socket 文件缺 → ping-island.app 没跑
        | 'refused'   // ECONNREFUSED → ping-island crash/restarting
        | 'timeout'   // 3s deadline 超
        | 'protocol'  // envelope > 64KB / response > 1MB / JSON parse 错
        | 'unknown'   // 其余
      detail: string
    }
```

`probe.ts:outcomeToState` 把 reason 映射到 `IslandConnectionState`:
- `enoent` → disconnected (无 error 显示, 用户没装 / 没跑是常态)
- `refused` → disconnected + lastError 显 detail
- `timeout/protocol/unknown` → degraded + lastError 显 detail

---

## 6. 注意事项 + Edge cases

| 场景 | 处理 |
|---|---|
| ping-island 未装 / socket 不存在 | `sendEnvelope` 走 `enoent` reason → fail-open;probe loop 探测 → `IslandStatus.state='disconnected'` |
| 用户关闭灵动岛集成 | Settings 切 toggleOff → `setIslandEnabled(false)` → state='disabled' → 所有 IPC `island:*` send 触发的 envelope 在 handler 内被 `isOperable()` short-circuit, 不开 socket |
| Dev 模式 | `is.dev=true` 时 `registerIslandHandlers` 默认 `devDisabled=true` → state='dev-disabled' → 所有 send envelope skip,Settings 可手动 `testConnection` 触发一次 |
| 多 BrowserWindow | broadcast 给所有非 destroyed window webContents (`BrowserWindow.getAllWindows()`) |
| auto-probe 在网络断时 | n/a — probe 走本机 unix socket,无网络;ENOENT/ECONNREFUSED 静默降级 |
| AIDraft stream 用户切邮件 | useEmailChat stranded-session check 已 short-circuit 不发新 envelope;ping-island 端老 session 自然在 timeout 后被 Phase 2 dock icon 收掉 |
| envelope 内含 secret? | 不会 — payload guard 拒绝任意未列入的字段;metadata 只放 internalId / senderName / subject / draftPhase 等非密信息 |

---

## 7. 验收标准

### 7.1 阀门 (ship 前必绿)

- ✅ `pnpm test`: **535 passed | 1 skipped** (Sprint 8 baseline 491 + 44 新)
- ✅ `pnpm lint`: 0 violation (含 mailagent design rules + react-hooks 各 rule)
- ✅ `pnpm typecheck`: 0 error (node + web)
- ✅ `pnpm a11y:contrast` (--strict): **12 组合 all clean**
- ✅ `pnpm exec electron-vite build`: ✓
- ✅ production grep 23 patterns: renderer + preload **0 真泄漏** (2 patterns hit — MAILAGENT_CLI_API_KEY 是 i18n hint string + osascript 是 toast hint — Sprint 8 baseline 一致)

### 7.2 功能性 (Sprint 9 主菜)

- ✅ TitleBar Island indicator 显当前状态 (dot color + tooltip i18n)
- ✅ Settings → 灵动岛集成 区显示当前状态 + Socket 路径 + 测试连接 + 启用/关闭 toggle
- ✅ 6 状态 UI 全 covered: idle / connected / degraded / disconnected / dev-disabled / disabled
- ✅ Electron 改主题 → 触发 `island:appearance` envelope send (main 端被 fail-open 接住即使 ping-island 没跑)
- ✅ AI Chat composer.send → 触发 `aiDraftStart` envelope; stream 触发 throttled `aiDraftStream`; done 触发 `aiDraftReady`
- ✅ Settings 切 disable → state='disabled' → 后续 envelope skip
- ✅ Dev 模式自动 `dev-disabled` (Settings 仍可手动 `testConnection`)

### 7.3 Sprint 7 review LOW + Nit carry-forwards

- ✅ L1: ⌘K toggle 命令面板 (useCommandPalette.toggle wired)
- ✅ L2: useFocusTrap hook 抽取 + 3 modal 改用
- ✅ L3: searchQ `placeholderData: undefined` 显式
- ✅ L4: toggleIsland binding wired:false 已就位
- ✅ L5: KeyboardHelpModal ScopeSection h3 tabIndex={0}
- ✅ Nit-2: LoadingSkeleton Array key string-prefixed

### 7.4 i18n

- ✅ 所有新增 JSX 字符串走 `t()`
- ✅ zh-CN + en-US locales 同步 (372 keys 同 count)
- ✅ `[TODO en]` 0 残留
- ✅ kebab `dev-disabled` 通过 `islandStateI18nKey` 映射 camelCase 不在 t() 路径中

### 7.5 Sprint 末 review (强制)

- 独立 Opus 4.7 max-effort `Agent subagent_type=oh-my-claudecode:code-reviewer model=opus` (Sprint 10 启动前跑)

---

## 8. NOTES.md 待办处理

Sprint 10 启动后用 5 分钟整理 `frontend/NOTES.md`. Sprint 9 review carry-forwards
(待 opus 4.7 review 输出后写入) Day 1 顺手关.

---

## 9. 启动 checklist

> **0. Git topology context (2026-05-18 reconcile)**
> 本轮 reconcile 已把 Sprint 0-9 + Island-Sprint 2 Phase 2 全部合进 main 并 force-push 到 origin。
> - local `main` ⟷ `origin/main` 完全对齐 (顶 `e39cc3f`)
> - 6 个旧 sprint 分支 (sprint3/4/5/6/8/9) 都是 main 祖先, 可安全删
> - 旧 ahead/behind 漂移已彻底消除

```bash
# 1. 拉最新 + 切分支 + 清理旧 sprint 分支
cd ~/Documents/MailAgent && git fetch origin
git checkout main && git pull --ff-only origin main   # 应已对齐 e39cc3f
git branch -d sprint3 sprint4 sprint5 sprint6 sprint8 sprint9  # 全是 main 祖先,安全可删
git checkout -b sprint10
cd frontend && pnpm install

# 2. 验 Sprint 9 baseline 全绿
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm test       # 535 passed | 1 skipped
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm lint       # 0
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm typecheck  # 0
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm a11y:contrast  # ✓ 12 组合 clean
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm exec electron-vite build  # ✓

# 3. mailagent CLI 可用 + 后端 DB 状态
which mailagent && mailagent --version
mailagent admin health -o json  # 首跑可能报 E_SCHEMA_MISMATCH (db=6, expected=7), 见 3a

# 3a. 后端 DB v6→v7 migration (Island Sprint 2 新加 `island_dispatch` 表)
#     SyncStore._init_database 用 CREATE TABLE IF NOT EXISTS + INSERT OR REPLACE,
#     idempotent 零数据风险, pm2 restart 即触发
pm2 restart mail-sync && sleep 3
pm2 logs mail-sync --lines 10 --nostream  # 看 "SyncStore initialized" + "v7"
mailagent admin health -o json | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print('db_version=', d['db_version'], 'healthy=', d['healthy'], 'island_dispatch in tables=', 'island_dispatch' in d['tables_present'])"
# 预期: db_version=7, healthy=True, island_dispatch in tables=True

# 4. Mail.app 自动化权限确认 (Sprint 5 复用)

# 5. 起 dev server 验证 Sprint 9 功能
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm dev
# → TitleBar 右上 Island indicator (Dev 模式应灰 + tooltip "Dev 模式 · 灵动岛禁用")
# → 设置 → 灵动岛集成 区 (应显 dev-disabled state + Socket 路径)
# → 点击 测试连接 应转 connected (如 ping-island.app 在跑) 或 disconnected (如 socket 缺)

# 6. (可选,但 Sprint 10 主菜) ping-island 端到端联调
# - cd ~/Documents/ping-island && git checkout feat/mail-brand
# - 在 Xcode 打开 PingIsland.xcodeproj → Run (scheme PingIsland) → 装到 /Applications
# - 主仓 .env: PING_ISLAND_ENABLED=true
# - pm2 restart mail-sync && pm2 logs mail-sync | grep '\[island\]'
#   预期: [island] enabled (socket=/tmp/island.sock timeout=3.0s ...)
# - 等一封新邮件或手动触发, sqlite3 data/sync_store.db "SELECT * FROM island_dispatch ORDER BY sent_at DESC LIMIT 3;"
#   预期: dispatched_ok=1 + event_type=MailReceived
# - 决议 §2.5.4 三方案 (推荐 A: Python eventType 映射 Notification + metadata.* 区分)
# 详 §2.2

# 7. 必读 (~25 min):
# - frontend/PROJECT-PLAN.md §3 Island Sprint 拆分 (Sprint 10 看 Sprint 4 联调)
# - frontend/SPRINT9-HANDOFF.md §0 §2 §10 (本文档)
# - frontend/ISLAND-PLUGIN.md §2.5.4 (Sprint 4 dispatch 决议三方案) + §3 wire + §4 Python plugin + §8 主题色同步
# - frontend/NOTES.md (Sprint 8/9 review carry-forwards)
# - frontend/DESIGN.md §13 项目结构
# - 后端 CLAUDE.md "ping-island 灵动岛集成" 段 (env + table + smoke 命令)

# 8. Day 1 顺手关 cheap Sprint 9 review carry-forwards (待 opus 4.7 review 输出)
```

---

## 10. 不要做的 (红线清单)

- ❌ 不要碰 `data/sync_store.db` schema (C-05 红线; 后端 DB_VERSION 拥有)
- ❌ 不要碰 `~/.mailagent/frontend/ai_chat.db` schema 而不 bump CHAT_DB_VERSION
- ❌ 不要让 LLM API key / Custom API key / CLI API key 进 renderer bundle (C-04 红线)
- ❌ 不要在 render body 调 `Date.now()` / `Math.random()` 等 impure 函数
- ❌ 不要在 useEffect body 同步 setState — 用 setTimeout(0) 推到下一 tick OR adjust-state-on-prop-change (Sprint 7 CommandPalette pattern)
- ❌ 不要 RegExp literal 内直写控制字符
- ❌ 不要回退 `useShortcut` 到 per-call-site listener
- ❌ 不要回退 a11y --strict gate
- ❌ 不要用 `codex:codex-rescue` agent
- ❌ 不要用 `autopilot`
- ❌ 不要在 `text-micro` / `text-meta` 字面值写中文 — `useCjkMonoSwap` helper 解决 i18n key 漏检
- ❌ 不要 commit 让 `lint` / `typecheck` / `test` / `a11y:contrast --strict` 任一 fail
- ❌ 不要直接渲染 `email_metadata.mailbox` 进 AppleScript without `isMailboxNameSafe` 校验
- ❌ 不要发明新颜色 token — 用 6 swatch CSS classes;raw hex 留 CSS file
- ❌ 不要把 secret 写入 file-backed settings.json — 走 keytar
- ❌ 不要 dynamic `await import('./module')` 当 module 已在 entry 静态导入
- ❌ 不要绕 `isSafeUserPath()` 把 dbPath / attachmentDir 路径直传 `better-sqlite3.Database()` 或 fs (Sprint 8 已 wire 进 db.ts; Sprint 9 attachment fs 路径接入时也要走)
- ❌ 不要重复 `WriteEnvelope<T>` / `envelopeFromCli` / `ensureInternalId` 定义 (Sprint 7 抽到 `lib/envelope.ts`)
- ❌ 不要重复 `STORAGE_AGENT_*` 常量 (Sprint 7 抽到 `state/notion-agent-storage.ts`)
- ❌ 不要重复 `isSafeUserPath` 定义 (Sprint 8 抽到 `lib/path-guard.ts`)
- ❌ 不要重复 `FOCUSABLE_SELECTOR` / Tab boundary 逻辑 (Sprint 9 抽到 `hooks/useFocusTrap.ts`)
- ❌ 不要重复 `BridgeEnvelope` / `swiftSentAt` / `sendEnvelope` 定义 (Sprint 9 抽到 `electron/main/island/{envelope,sender}.ts`)
- ❌ 不要在 keymap binding 加新条不更新 `src/shared/keymap.ts` SSoT (`?` modal 读它)
- ❌ 不要在 main 直 `import { autoUpdater } from 'electron-updater'` (会在测试时 reach GitHub); 用 `AutoUpdaterLike` 注入 pattern (`handlers/updater.ts`)
- ❌ 不要在 useEmailChat hook 内直 `import 'net'` / `import 'fs'`; renderer-side hook 通过 `useMailApi().island.*` send (Sprint 9 pattern)
- ❌ 不要打包公证留 V1.5 — 当前 ad-hoc 签名已够;切公证要 `$99/y` Apple Developer + APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD env

---

## 11. Cross-links (按重要度)

| 文档 | 章节 | 用途 |
|---|---|---|
| `PROJECT-PLAN.md` | §3 Island Sprint 拆分 | Sprint 10 主菜 Island Sprint 2/4 入口 |
| `ISLAND-PLUGIN.md` | §3 wire + §4 Python plugin + §8 主题色同步 | Sprint 9 sender / envelope / probe 协议来源;Sprint 10 Python plugin 配套 |
| `INSTALL.md` | 全部 | 用户向安装 / 首次配置 / 故障排查 / 升级 / 卸载 |
| `DESIGN.md` | §9.5 快捷键 + §14 lint + §16 i18n + §17 主题 | 视觉 / 交互 / 非协商 |
| `ARCHITECTURE.md` | §2.2 + §3.4 + §5 | 数据层抽象边界 + Island 数据流图 + 主路径 |
| `BACKEND-INTERFACES.md` | §1.6 cli runner + §4 SQLite schema | Sprint 6 admin/llm dashboard 数据来源 |
| `NOTES.md` | Sprint 7/8/9 review entry | 历次 review carry-forwards |
| `REVIEW-LOG.md` | C-04 / C-05 / H-15 | 红线 trump 任何新设计 |
| `SPRINT8-HANDOFF.md` | §1 + §5 (架构沉淀) | Sprint 8 模式参考 |
| 后端 `CLAUDE.md` | "CLI 完整列表" admin/llm/calendar group | dashboard 数据来源 |
| memory `reference-mailagent-frontend-dev-collab` | 全部 | 工作模式 SoT |

---

> Sprint 10 ship checklist 走完 → 这份 handoff 归档到 `frontend/archive/`, 写
> Sprint 11 handoff 时引用本文 §1.1 (主菜 D1-D6 模式) + §5 (架构沉淀) +
> §1.2 (Sprint 7 review LOW carry-forwards 闭环).
