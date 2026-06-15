# Sprint 10 Handoff — Sprint 9 review carry-forwards 全闭 + Island L2 端到端联调 + 真 .dmg release + V1.5 polish

> Sprint 10 主开发 handoff. Sprint 10 ship 完成 — 4 commits / 一晚跑通 V1.5
> ship-ready 全闭环。Sprint 11 候选: 用户验收发现的 bug 优先 / V2 远程访问
> (FastAPI + Cloudflare Tunnel) / Island Sprint 5 (distribution + 月度
> rebase upstream) / 后端 Island 评估指标看板。
>
> **启动前最少读完**: §0 TL;DR + §6 用户验收 checklist + §9 启动 checklist

---

## 0. TL;DR

| 项 | 值 |
|---|---|
| Sprint 范围 | (a) Sprint 9 review carry-forwards 全闭(3 MEDIUM + 7 LOW + 3 Nit + 2 missing tests) + (b) ISLAND-PLUGIN §2.5.4-D 方案 A 落地 + smoke 验证(Phase 1 attentionNotification 展开 + 5 option intervention 渲染) + (c) 真 .dmg release v0.0.1 draft + (d) V1.5 polish(QuickActions LLM prompt i18n + IslandSection 安装提示 link + barrel re-export 修) |
| 提交 | `dd455c3` docs / `844fef2` (a) Day 1 review carry-forwards / `a557514` (b) §2.5.4-D 方案 A / `1453246` (d) V1.5 polish |
| 阀门 | **543 tests passed / 1 skipped** (+8 vs Sprint 9 535), pnpm lint 0, pnpm typecheck 0, pnpm a11y:contrast --strict 12 组合 clean, electron-vite build OK, pnpm build:mac OK (dmg+zip × arm64+x64 + blockmap 全产出), 后端 pytest tests/notify/ 49 passed |
| 工作模式 | Claude Opus 4.7 max-effort 单线 + 后台 build/test 并发 |
| 阻塞 | 无 — 全 gate 绿,等用户实机 .dmg 验收测试(§6) |
| **Sprint 11 候选** | (a) 用户验收 bug 修复(若有); (b) Sprint 10 opus 4.7 code-reviewer 跑(强制); (c) V2 远程访问启动(L3 V2-Sprint 1-2 FastAPI 骨架,详 PROJECT-PLAN.md §4); (d) Island Sprint 5 distribution + 月度 rebase upstream 流程; (e) V1.6 polish(mail metadata 进 island envelope 含 EnrichedEmailMeta / Notion workspace prefix UI / 1h cache TTL prefix-stable 测试) |

---

## 1. 已 ship deliverables

### 1.1 (a) Sprint 9 review carry-forwards 全闭 — `844fef2`

Sprint 9 末 opus 4.7 max-effort code-reviewer 跑出 **APPROVE-with-follow-ups** verdict (0 CRITICAL / 0 HIGH / 3 MEDIUM / 6 LOW / 3 Nit + 2 missing tests)。Sprint 10 Day 1 全 13 项 + 2 测试 gap 一次性闭。

#### 3 MEDIUM — Island bridge state-machine 修

| ID | File:line | 问题 → 修复 |
|---|---|---|
| M1 | `src/electron/main/island/sender.ts:172` | `'close'` 默认 resolve `{ok:true, response:null}` 掩盖"peer accept 后 RST / kernel reject"失败 → 加 `connectFired` flag,无 `'connect'` 前置 settle 为 `{ok:false, reason:'unknown', detail:'closed before connect'}` |
| M2 | `src/electron/main/island/probe.ts:140` | `_intervalMs` 在 `devDisabled` 早返前未 capture → 后续 `setIslandEnabled(true)` 调用 `startProbeLoop({intervalMs: _intervalMs})` 拾起 caller-supplied interval 丢失 → 把 capture 移到早返前 |
| M3 | `src/electron/main/island/probe.ts:160` | `setIslandEnabled(true)` 在 dev session 绕开 dev-disabled latch 启 probe loop,违反"dev 模式不自动 probe"语义 → 加 `_devDisabled` sticky latch,latched 状态下 `setIslandEnabled(true)` 保持 `dev-disabled` state |

#### 7 LOW + L6 顺手 — useEmailChat / sender / handler / appearance polish

| ID | File | 修复 |
|---|---|---|
| L1 | `src/shared/hooks/useEmailChat.ts:304` | done event 前补 trailing AIDraftStream(streamedCharsRef.current) → island pill 字符数收尾真实 |
| L2 | `src/shared/hooks/useEmailChat.ts:266` | 加 `sessionMetaRef` Map<sessionId,{emailId,senderName,subject}> — chunk envelope 的 emailId 从 session-meta 取,结构性消除跨邮件 stream chunk 泄漏可能 |
| L3 | `src/shared/hooks/useEmailChat.ts:307` + `AIChatPanel.tsx` | `SendChatInput` 加 senderName/subject 入参 + AIChatPanel caller 从 `detailQ` 拉真实值 → ping-island card 显 "AI 起草中 / John Smith" 而非 "... / —" |
| L4 | `src/electron/main/island/sender.ts:67` | `ISLAND_SOCKET_TIMEOUT_MS` env 优先 + 仍接旧 `ISLAND_SOCKET_TIMEOUT` 解释成 ms(原解释成秒,3000 期望 3s 会得 3000s) |
| L5 | `src/electron/main/handlers/island.ts:82-104` | 4 个 envelope send `.then(reportSendOutcome)` → 单 envelope 失败立即翻 `IslandStatus`,不等 5 min probe interval |
| L6 | `src/electron/main/island/probe.ts:140` | `_warmupTimer` handle + `stopProbeLoop()` clearTimeout 取消 100ms warm-up — `setIslandEnabled(false)` 100ms 内调用不再 stray fire probeOnce |
| L7 | `src/shared/state/appearance.ts:82` | `scheduleIslandAppearance()` rAF coalescer — theme + accent 同帧变化 → 单 envelope(原 2),节省 socket connect |

#### 3 Nit

- Nit-1 `probe.ts:27` 删 `PROBE_INTERVAL_MS_DEV` dead export + docstring 修正
- Nit-2 `sender.ts:229` `__wire` 注释从 "for Settings page hint" 改 "for tests"(Settings 实际走 useIslandStore.socketPath)
- Nit-3 `sender.ts:80` 加 `SocketLike` per-event listener overloads — `on('data', (chunk: Buffer) => ...)` 直接窄类型,删 `as Buffer` cast

#### 2 missing tests 补 (+8 total)

- `useEmailChat.test.tsx` +3: L1 throttle / L1 trailing flush / L2 session-meta contract — `vi.useFakeTimers({toFake:['Date']})` 控 Date.now() 保留 React waitFor 真行为
- `island_handler.test.ts` +4: M2 / M3 / probe lifecycle disabled→idle→connected / L6 warm-up cancel
- `island_sender.test.ts` +1: M1 close without connect → reason=unknown

### 1.2 (b) ISLAND-PLUGIN §2.5.4-D 方案 A 落地 — `a557514`

#### 触发判据(Sprint 10 §9-6 smoke 实测)

pre-Plan-A `MailReceived` envelope 经 `nc -U /tmp/island.sock` 发出 → ping-island fork log 停在 `Received bridge envelope provider=mail event=MailReceived` debug line → **不走 dispatch / 灵动岛不展开**。原因: `MailReceived` 不在 ping-island fork 现有 hook event dispatcher 识别表里(仅认 `UserPromptSubmit` / `PreToolUse` / `Notification` / `Stop` / `SessionStart`)。

#### 方案 A 实现

**后端 `src/notify/island_envelope.py`** (+44 / -2):
- 加 `_WIRE_EVENT_MAP` 10 项(MailReceived/Urgent + LLMReviewed/Urgent + MailCompleted + SyncFailed + DeadLetterAccum + AIDraftStart/Stream/Ready) 全 → `"Notification"`
- `_resolve_wire_event_type()` 未列入 map 的 event_type 原样返回保留客户端语义
- `to_wire_dict()` body["eventType"] 走映射 + body["metadata"]["mailagent.eventType"] = self.event_type 双写

**前端 `frontend/src/electron/main/island/envelope.ts`** (+29 / -7):
- 加 `_WIRE_EVENT_MAP` 5 项(AppearanceChange + AIDraftStart/Stream/Ready + Ping) 全 → `"Notification"`
- `BridgeEnvelope.eventType` 类型从 `IslandEventType` 改窄为新 `IslandWireEventType = 'Notification'`(wire 层窄)
- `commonShell()` 构造 envelope 时 eventType 走映射 + metadata 加 `'mailagent.eventType': eventType`(builder API 入参语义保留)

**Python `BridgeEnvelope.event_type` dataclass 字段保持 mail 名** — `island_dispatch` SQLite 表 / 47 后端单测断言 / 评估指标查询全部不破。

#### Post-Plan-A smoke 验证(同日)

```
MailReceived  → wire=Notification + metadata.mailagent.eventType=MailReceived → fork 接受 0 bytes 返回(non-blocking notification path) ✓
LLMReviewedUrgent → wire=Notification + waitingForInput + 5 options → fork block 等用户点 option,客户端 3s timeout(符合预期) ✓
  → 证明 fork 走 attentionNotification phase + 5 option intervention 渲染 — Phase 1 Arrive 展开真实生效
```

### 1.3 (c) 真 .dmg release v0.0.1 draft

`pnpm build:mac` 产出 9 个 artifact 已上传到 https://github.com/ChenyqThu/MailAgent/releases (draft 状态):

| 文件 | 大小 | 用途 |
|---|---|---|
| `mailagent-frontend-0.0.1-arm64.dmg` | ~115 MB | Apple Silicon (M1/M2/M3) 安装包 |
| `mailagent-frontend-0.0.1-x64.dmg` | ~120 MB | Intel Mac 安装包 |
| `MailAgent-0.0.1-arm64-mac.zip` | ~111 MB | arm64 zip(auto-updater 增量识别用) |
| `MailAgent-0.0.1-mac.zip` | ~116 MB | x64 zip |
| `latest-mac.yml` | <1 KB | electron-updater 元数据 |
| `.blockmap` × 4 | ~120 KB each | 给 electron-updater 算增量包 |

签名: ad-hoc(identity=null + hardenedRuntime + 8 entitlements)。公证(Apple Notarize)留 V1.5(需 $99/y Apple Developer 账号)。

### 1.4 (d) V1.5 polish — `1453246`

- **QuickActions LLM prompt i18n**: `QuickActions.tsx` 5 个 chip prompt 字段从硬编码中文改 i18n key(`ActionDef.promptKey` + `t(a.promptKey)`)。zh-CN + en-US 加 5 keys × 2 locale = 10 个新条目(`summarizePrompt` / `draftPrompt` / `translatePrompt` / `extractPrompt` / `linkNotionPrompt`)。en 用户切英文 locale 后 prompt body 也变英文 → LLM 回复语言与 UI locale 一致。
- **IslandSection 安装提示 link**: `SettingsPage.tsx:IslandSection` 加 `showInstallHint = status.state === 'disconnected'`,disconnected 时(socket 文件缺) 在 toggle row 下方显一行提示 + GitHub fork link(`https://github.com/ChenyqThu/ping-island/tree/feat/mail-brand`)。zh + en locales 加 `settings.island.installHint` + `settings.island.installLinkLabel`。
- **Barrel re-export 修**: `electron/main/island/index.ts` 加 `reportSendOutcome` re-export — Sprint 10 (a) commit 后 `pnpm build:mac` rollup 报 `not exported by ../island` 错(电子-vite dev 走源码无碍,生产 rollup pack 走 barrel 才暴露)。

---

## 2. Sprint 11 工作清单(按交付顺序候选)

### 2.0 Sprint 10 ship 实测踩坑 — packaged-only bug 2 个(已修)

**Sprint 10 ship draft v0.0.1 后用户实机装 .dmg,瞬间踩 2 个 packaged-only bug**。dev 模式 / `pnpm build:mac` build 成功的 ✓ 输出 / vitest happy-dom 全过 — 这三个 gate **没一个能 catch 这 2 个 bug**。教训写进 §2.1 Tier 1 任务。

| Bug | Root cause | 修复 commit | 文件 |
|---|---|---|---|
| 装 .dmg 后打开显空白 "not found" | TanStack Router 默认 `createBrowserHistory` 读 `window.location.pathname`。packaged Electron 走 `file:///.../app.asar/out/renderer/index.html`,pathname 是整段文件系统路径,**不匹配任何注册的 route** → 落默认 NotFoundRoute。dev 模式走 vite dev server `http://localhost:5173/` 所以从未暴露,vitest happy-dom 默认 `http://localhost/` 也走 browser history 所以 router test 全过 | `e34b83c` | `src/shared/router-instance.tsx` — file:// 协议下切 `createMemoryHistory({initialEntries: ['/']})` |
| email.listEnriched IPC 报 NODE_MODULE_VERSION 141 vs 140 | better-sqlite3 native binding ABI 双轨: Node 25 (ABI 141,vitest 跑) vs Electron 39 (ABI 140,app 跑)。一份 `.node` 不能同时给两边用。Sprint 8 ship 前最后一次操作是 vitest → `node_modules/.../better-sqlite3.node` 留 ABI 141。`build:mac` 没 chain `rebuild:electron` → electron-builder 把 ABI 141 binding 打进 ASAR.unpacked → 装机起来必报 mismatch。NOTES.md 2026-05-17 已记过这个 dev-time bug,Sprint 8 ship 时漏 chain | 未 commit (sprint10 branch) | `package.json` — `build:mac` 加 `pnpm rebuild:electron &&` prefix,防 ABI 漂回 |

### 2.1 Sprint 11 Day 1 必做 — 3 件并行

#### (1) Tier 1 Playwright Electron E2E smoke (堵死 packaged-only bug class)

这次 Sprint 10 ship 踩的 2 个 bug **都是 build 成功 ≠ 可发布的**典型样本。Tier 1 Playwright Electron 一次堵死整条 bug class — `_electron.launch()` 直接起 packaged `.app`,把 BrowserWindow 当 page driver。**预期 1-2 天投入**,5-10 个 smoke test 覆盖 80% packaged-only 风险。

**Setup**:
```bash
cd frontend
pnpm add -D @playwright/test
# tests/e2e/playwright.config.ts — 单 darwin/electron project
# tests/e2e/smoke.spec.ts — 见下方 covers
# package.json scripts: "test:e2e": "playwright test"
```

**核心 covers (最少 5 个,优先级排序)**:
1. **boot → Inbox not NotFound** (e34b83c bug 防再来):
   ```typescript
   const app = await electron.launch({ executablePath: 'dist/mac-arm64/MailAgent.app/Contents/MacOS/MailAgent' })
   const win = await app.firstWindow()
   await expect(win.locator('[data-testid="email-list"]')).toBeVisible({ timeout: 10_000 })
   await expect(win.getByText('Not Found')).toHaveCount(0)
   await app.close()
   ```
2. **email.listEnriched IPC works** (ABI bug 防再来):
   ```typescript
   await expect(win.locator('.email-row').first()).toBeVisible({ timeout: 15_000 })
   ```
3. **⌘K command palette opens** (Sprint 7 keymap regression)
4. **⌘L AI Chat panel opens** + composer 接受 input
5. **Settings → 灵动岛 testConnection** → status pill 颜色/文本(Sprint 10 (b) §2.5.4-D 防 fork-side regression)
6. (可选) **切 en locale** → QuickAction chip 文本变(Sprint 10 (d) 防 i18n drift)
7. (可选) **详情页 sandbox iframe** 加载(Sprint 2 sandbox 防 CSP regression)
8. (可选) **email body FTS5 search** 返回 hit(Sprint 3 search 防 schema drift)

**CI gate**: `build:mac` 之后必跑 `pnpm test:e2e` — Sprint 8 我标的"build 成功 ≠ 可发布"就这一刀堵死。

**进 ship pipeline** (Sprint 11 Day 1 写好后, 加进 package.json):
```json
"build:mac": "pnpm rebuild:electron && electron-vite build && electron-builder --mac && pnpm test:e2e"
```
最后一个 chain 确保不会再发"build 成功但装上空白 / IPC 崩"的 .dmg。

**Tier 2 (Visual Regression) / Tier 3 (axe-core + nut.js) 留 V1.5+** — Tier 1 已堵 80% 风险,Tier 2 等出第一次"主题变更回归"再考虑。

#### (2) Sprint 10 ship-review (强制)

Sprint 10 5 commit (dd455c3 + 844fef2 + a557514 + 1453246 + e34b83c) + 本地 ABI fix 跑一次独立 opus 4.7 max-effort `Agent subagent_type=oh-my-claudecode:code-reviewer model=opus`。预期 0 CRITICAL / 0 HIGH(本 Sprint 都是 review carry-forwards 修复 / wire 层映射 / V1.5 polish / packaged-only bug fix,改动面浅)。如有 MEDIUM/LOW Day 1 闭。

**Review 关注点**(Sprint 10 新加):
- `router-instance.tsx` file:// 检测是否健壮(SSR / iframe / popup / test runner 等边界)
- `build:mac` chain 是否能 cross-arch(当前 rebuild:electron 只切 arm64,x64 .dmg 仍 ABI 漂)
- §2.5.4-D 方案 A wire 映射是否破后续 evaluation 指标查询(`island_dispatch.event_type` 仍存 mail 名,应不破)

#### (3) 用户验收 bug fix (若有)

如 §6 验收 checklist 任一项失败 → **Sprint 11 Day 1 必修**(优先级高于 ship-review,但低于 Tier 1)。验收清单:
- [x] **实机 .dmg 安装(右键 → 打开 → 信任 ad-hoc)** — 已通过(用户 11:30 报告)
- [x] **email.listEnriched 列表加载** — 已通过(ABI fix 后)
- [ ] AI Chat panel ⌘L 打开 + ⌘↩ 发送
- [ ] Settings → 灵动岛集成 → 测试连接(ping-island 在跑→connected / 关掉→disconnected + 显安装提示 link)
- [ ] Settings → 应用更新 → 检查更新 → in-app updater 状态机
- [ ] 切 EN locale → QuickActions chip 触发英文 prompt
- [ ] **用户下个 session 提的 UI 问题** — 待 session start 时记入

### 2.2 V2 远程访问启动 (大头候选)

详 PROJECT-PLAN.md §4 V2-Sprint 1-5:
- V2-Sprint 1 (1.5 天): 本地 FastAPI 骨架 + middleware + Cloudflare Access JWT 校验
- V2-Sprint 2 (1 天): email/attachment/llm/admin 路由 + StreamingResponse 附件下载
- V2-Sprint 3 (1.5 天): `frontend/vite.web.config.ts` + Web build target + `HttpApi` 真实现
- V2-Sprint 4 (1 天): Cloudflare Tunnel + Access OAuth + PWA manifest + iOS Safari 实测
- V2-Sprint 5 (1 天): Cloudflare Pages 部署 + 安全 checklist

### 2.3 Island Sprint 5 distribution (可选)

详 ISLAND-PLUGIN.md(本仓内 §11 + 配套仓 `~/Documents/ping-island/`):
- `scripts/build.sh` 出 .dmg
- GitHub Actions release pipeline(fork 仓)
- Sparkle 自动更新接 fork appcast
- 月度 rebase upstream 流程文档

### 2.4 V1.6 polish (按 appetite 决定)

| 任务 | 入口 |
|---|---|
| Mail metadata 进 island envelope | useEmailChat 当前 fire envelope 时 senderName/subject 走 detailQ(已 Sprint 10 L3 done),但 internalId 等更多字段可加进 metadata.mailagent.* |
| Notion workspace prefix UI | NOTES.md 2026-05-17 TODO — Settings 让用户设 `/omadanetworks/...` workspace 前缀给 page deep-link |
| 1h cache TTL prefix-stable 测试 | 验证 v4 LLM cache hit rate 在 prefix 不变时 1h 内稳定命中(后端 NOTES.md 涉及) |
| ResyncConfirmDialog `react-focus-lock` | Sprint 5 review opus Nit — focus-trap 当前 3-button boundary 处理,4-button 会破 |

---

## 3. 工作模式

| 角色 | Agent | 何时用 |
|---|---|---|
| **主线** | Claude Opus 4.7 单线 max-effort | 整 Sprint 11 持续 context |
| **子任务并行** | ultrawork (optional) | 多 lane 同步推进时 |
| **长 IO** | `Bash run_in_background=true` | `pnpm build:mac`(~2-3 min) / `pnpm test`(~10s) / `pytest tests/notify/`(~2s) / `gh release upload`(~3-5 min for 480MB) |
| **Sprint 末 review** | `Agent subagent_type=oh-my-claudecode:code-reviewer model=opus` (强制) | 强制 — 闭环价值高 |
| **禁用** | `codex:codex-rescue` agent / `autopilot` | `[[feedback-codex-collaboration-path]]` 红线 |

参考: `[[reference-mailagent-frontend-dev-collab]]` + `[[feedback-codex-collaboration-path]]` + `[[feedback-commit-directly]]`.

---

## 4. 设计约束 (lint / CI 已枪口对准)

DESIGN.md §14 八条非协商 + i18n + 三态主题第 9/10 条 — 同 Sprint 5/6/7/8/9/10. Sprint 10 没新增 lint rule.

**Sprint 10 关键 pattern**:

- **方案 A wire 映射模式** — 当上游枚举不识别我们的事件名时,本地端 wire 层映射到上游已识别名 + metadata 双写原值。语义层 enum 保持不变(API 入参 / SQLite 表 / 评估指标 / 测试断言不破),wire 层窄到上游能接的子集。Plan B(上游加专属 case)可以平滑切过去,只需在上游解码后读 metadata 走专属分支,本地代码不动。
- **sticky latch 模式** — `_devDisabled` 一旦 startProbeLoop({devDisabled:true}) 设置,后续 `setIslandEnabled(true)` 公共 API 不能清。dev 模式语义稳定到 next launch。
- **session-meta map + sessionId 路由** — useEmailChat L2: chunk envelope 的 emailId 不从 emailIdRef 取(可能时序漏) 而从 sessionMetaRef.get(envelope.sessionId).emailId 取。结构性消除跨邮件泄漏的可能,而非靠"小心"。
- **rAF coalescer** — appearance.ts L7: 同帧多次 setState 触发的 envelope 在 rAF 内合并成一个 send,sessionKey 不去重也能省 socket connect。
- **send outcome → status feedback loop** — handlers/island.ts L5: 不只 probe 改 IslandStatus,每次 envelope send 失败也喂回 setStatus,renderer pill 5 min 内不再透明。

---

## 5. 架构规范 (关键 + Sprint 10 已落地)

### 5.1 Island wire 层方案 A 协议固化

**Python 端** (`src/notify/island_envelope.py`):
```python
_WIRE_EVENT_MAP: Dict[str, str] = {
    "MailReceived": "Notification",
    "MailReceivedUrgent": "Notification",
    "LLMReviewed": "Notification",
    "LLMReviewedUrgent": "Notification",
    "MailCompleted": "Notification",
    "SyncFailed": "Notification",
    "DeadLetterAccum": "Notification",
    "AIDraftStart": "Notification",
    "AIDraftStream": "Notification",
    "AIDraftReady": "Notification",
}

def to_wire_dict(self) -> Dict[str, Any]:
    wire_event = _resolve_wire_event_type(self.event_type)
    meta_with_event = {**self.metadata, "mailagent.eventType": self.event_type}
    return {
        "provider": "mail",
        "eventType": wire_event,
        "metadata": meta_with_event,
        ...
    }
```

**Frontend 端** (`frontend/src/electron/main/island/envelope.ts`):
```typescript
const _WIRE_EVENT_MAP: Record<IslandEventType, IslandWireEventType> = {
  AppearanceChange: 'Notification',
  AIDraftStart: 'Notification',
  AIDraftStream: 'Notification',
  AIDraftReady: 'Notification',
  Ping: 'Notification'
}

function commonShell(eventType, ...): BridgeEnvelope {
  return {
    eventType: _WIRE_EVENT_MAP[eventType],
    metadata: { ...metadata, 'mailagent.eventType': eventType },
    ...
  }
}
```

ping-island fork 端 dispatcher 接 `eventType="Notification"` 走 attentionNotification / hoverDashboard / sessionList phase。读 `metadata.mailagent.eventType` 区分原 mail 事件类型给 generic `HoverSessionCard` 渲染或 future Plan B Swift 专属分支用。

### 5.2 session-meta + sessionId 路由模式

useEmailChat L2 重构: 不在 chunk handler 内读 emailIdRef.current(可能在用户切邮件后指 wrong email),改成 send() 时 sessionMetaRef.set(sessionId, {emailId, senderName, subject}),chunk 时 sessionMetaRef.get(envelope.sessionId).emailId 路由。 done/error 时 delete entry 防 map 长任务堆积。

适用场景: 任何"流式事件回填到错的 React state"风险 — sessionId 是 wire 协议本身就有的稳定 routing key,不依赖 hook 内部 ref 时序。

### 5.3 dev-disabled sticky latch 模式

probe.ts M3: `_devDisabled` module-scope flag 一次 set 不清,public API `setIslandEnabled(true)` 在 latch 下保持 dev-disabled state。clear 只能 `startProbeLoop({devDisabled: false})` 或 `__resetForTesting`。

适用场景: 任何"开发/生产差异化语义不应被 runtime UI toggle 绕过"。比 `is.dev` 检查更稳(避免每个 caller 重复判断),比"删 toggle UI"更友好(测试可走 testing helper 强 unblock)。

### 5.4 fail-open + 5 bucket + 'close' 状态机修(M1)

sender.ts: 'connect' 设 connectFired flag,'close' 不带 'connect' 前置 → `{ok:false, reason:'unknown', detail:'closed before connect'}`;'close' 带 'connect' 前置 → `{ok:true, response:null}`(one-shot peer)。

---

## 6. 用户验收 checklist (Sprint 11 启动前必跑)

### 6.1 环境前置

- [x] `/tmp/island.sock` 存在(ping-island.app Xcode Debug build 在 PID 70474 跑)
- [x] `.env` 已加 `PING_ISLAND_ENABLED=true` + `ISLAND_SOCKET_PATH=/tmp/island.sock`
- [x] `pm2 status` → `mail-sync online`
- [x] `pm2 logs mail-sync | grep '[island] enabled'` → 确认后端 plugin loaded

### 6.2 .dmg 实机安装

1. 等 GitHub release `v0.0.1` draft upload 完成(后台 ~3-5 min,upload ~480MB)
   - 当前状态: https://github.com/ChenyqThu/MailAgent/releases (draft, 等 upload 完)
2. 下载 `mailagent-frontend-0.0.1-arm64.dmg`(M1/M2/M3) 或 `-x64.dmg`(Intel)
3. 双击挂载 → 拖 `MailAgent.app` 到 `/Applications/`
4. **右键 → 打开**(不能双击,会卡 Gatekeeper) → 信任 ad-hoc 签名

### 6.3 功能验收

| 项 | 验证步骤 | 预期 |
|---|---|---|
| Inbox 三栏 | 启动 app | 显邮件列表 + 详情 + AI Chat panel |
| AI Chat ⌘L | 按 ⌘L | 命令面板打开 |
| QuickActions i18n (English) | Settings → 切 English locale | QuickAction chip 显 "Summarize" 等;点 "Summarize" 后 composer 填 "Summarize this email in 3-5 bullet points: ..."(英文 prompt 不是中文) |
| QuickActions i18n (中文) | 切回中文 locale | chip 显 "总结" 等;点 "总结" 后 composer 填 "请用 3-5 个要点总结..."(中文) |
| 灵动岛 connected 状态 | Settings → 灵动岛集成 → 测试连接 | dot 变绿 + label "已连接" |
| 灵动岛 disconnected 状态 | 关闭 ping-island.app(Cmd+Q) → 等 5 min 或手动 Settings 测试连接 | dot 灰 + label "未运行" + 显安装提示 link "/tmp/island.sock 不存在..." + "获取 fork (feat/mail-brand)" GitHub link |
| 灵动岛 dev-disabled | `pnpm dev` 起 app(不是装机版) | dot 灰 + label "Dev 模式 · 已禁用",测试连接按钮可点(手动一次性 probe) |
| AI Chat 触发 island envelope | AI Chat panel 发一条消息(任意 prompt) | ping-island 弹"AI 起草中 / {senderName}" Phase 2 dock icon(注: 当前 senderName/subject 已接通 detailQ,如 email 列表中选过具体邮件应显真名) |
| In-app updater | Settings → 应用更新 → 检查更新 | 状态从 idle → checking → not-available(因为 v0.0.1 是当前 release tag) |

### 6.4 已知非问题

- **Sprint 10 builder warning**: pnpm install 时 `electron-builder install-app-deps` rebuild `better-sqlite3` + `keytar` 是 normal(NODE_MODULE_VERSION 140/141 ABI 切换),无 ERR_DLOPEN_FAILED 即正常。
- **happy-dom AsyncTaskManager 偶发 stderr**: 测试运行时 `Error: Failed to execute 'startTask()' on 'AsyncTaskManager'`,是 happy-dom 已知 issue 与生产无关,vitest exit code 0 即可。
- **Notion 桌面版未装时 mail action `open_notion`**: Python `island_response.handle_response` 检测 `/Applications/Notion.app` 存在 → 选 deep-link 否则 fallback Web URL(M-13 已修)。

### 6.5 失败时回滚

```bash
# 后端 .env 恢复关
sed -i '' 's/PING_ISLAND_ENABLED=true/PING_ISLAND_ENABLED=false/' /Users/chenyuanquan/Documents/MailAgent/.env
pm2 restart mail-sync

# git 回滚 Sprint 10(仅本地 sprint10 branch)
git checkout main
# (Sprint 10 未合 main, sprint10 远端分支可保留作 PR 候选)
```

---

## 7. 用户(明早)要做的事 — 优先级清单

按重要度排序,**前 3 项必做**,后 3 项可选:

### 7.1 高优 — 验收实际功能(20-40 min)

**① 等 GitHub release `v0.0.1` upload 完成**
- 当前 draft release: https://github.com/ChenyqThu/MailAgent/releases
- 后台 upload 9 个 artifact ~480MB,大约 3-10 min(看网速)
- 看到 9 个 asset 全部显示 → upload 完成

**② 跑 §6.3 验收 checklist 8 项**
- 至少跑前 5 项(Inbox / AI Chat / QuickActions i18n × 2 / 灵动岛 connected/disconnected)
- 灵动岛验收时 ping-island.app 已在跑(PID 70474), 直接装 .dmg 后 Settings → 测试连接应 connected

**③ 决定是否 publish release**
- 验收全通过 → `gh release edit v0.0.1 --draft=false` 公开发布
- 验收发现 bug → 留 draft,记录到 frontend/NOTES.md,Sprint 11 Day 1 修

### 7.2 中优 — review + 规划(15-30 min)

**④ 跑 Sprint 10 ship-review**
```
Sprint 11 启动时第一件事: Agent subagent_type=oh-my-claudecode:code-reviewer model=opus
review 范围: Sprint 10 4 个 commit (dd455c3 + 844fef2 + a557514 + 1453246)
预期: APPROVE 或 APPROVE-with-follow-ups, 0 CRITICAL / 0 HIGH
```

**⑤ 决定 Sprint 11 主菜**
按 §2 候选选: V2 远程访问(大头 4-6 天) / Island Sprint 5 distribution(中, 1-2 天) / V1.6 polish(小, 半天-1 天) / 用户验收 bug fix(优先级最高如有)。

### 7.3 低优 — 文档归档(5-10 min)

**⑥ 归档 SPRINT9-HANDOFF.md** 到 `frontend/archive/`(SPRINT10-HANDOFF.md 已就位作下个 sprint 的入口)

---

## 8. NOTES.md 待办处理

Sprint 11 启动后用 5 分钟整理 `frontend/NOTES.md`. Sprint 10 没新增 TODO 进 NOTES,但 Sprint 9 review carry-forwards 在 NOTES 里的清单都已 Day 1 close,可以归档。

---

## 9. 启动 checklist

> **0. Git topology context (2026-05-18 Sprint 10 ship 后)**
> - local `sprint10` 顶 `1453246`,push 到 `origin/sprint10` 完整 4 commits
> - `origin/main` 仍是 `e050f20`(Sprint 10 未 merge,作 PR 候选,Sprint 11 可决定合或继续在 sprint10 推)
> - 旧 sprint3/4/5/6/8/9 6 个分支 Sprint 10 §9-1 已删
> - claude/happy-brown-19c887 worktree 仍存在(不阻塞,需要时手动清)

```bash
# 1. 拉最新 + 看分支状态
cd ~/Documents/MailAgent && git fetch origin
git branch -vv | head -10
# 期: sprint10 顶 1453246, main 顶 e050f20

# 2. 验 Sprint 10 baseline 全绿(可跳过若已知绿)
cd frontend
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm test       # 543 passed | 1 skipped
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm lint       # 0
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm typecheck  # 0
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm a11y:contrast  # ✓ 12 组合 clean
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm exec electron-vite build  # ✓

# 3. 后端 baseline
cd ..
source venv/bin/activate
pytest tests/notify/ -q   # 49 passed
mailagent admin health -o json | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print('db_version=', d['db_version'], 'island_dispatch in tables=', 'island_dispatch' in d.get('tables_present', []))"
# 期: db_version=7 + island_dispatch in tables=True

# 4. ping-island 联调环境(若验收 §6 时需要)
ls -la /tmp/island.sock                       # 期: srwxrwxrwx
ps aux | grep "Ping Island" | grep -v grep    # 期: 进程在
pm2 logs mail-sync --lines 5 --nostream | grep '\[island\] enabled'  # 期: 后端 plugin loaded

# 5. 看 v0.0.1 release upload 进度
gh release view v0.0.1 --json assets --jq '.assets | length'
# 期: 最终 9 个 asset

# 6. Day 1 必跑: Sprint 10 ship-review (opus 4.7)
# Agent subagent_type=oh-my-claudecode:code-reviewer model=opus
# review 4 commits: dd455c3 + 844fef2 + a557514 + 1453246

# 7. 必读 (~15 min):
# - frontend/SPRINT10-HANDOFF.md §0 §6 §7 §10
# - frontend/PROJECT-PLAN.md §3 (Island Sprint 5) + §4 (V2)
# - frontend/ISLAND-PLUGIN.md §2.5.4-D (方案 A 决议归档)
# - frontend/NOTES.md (Sprint 10 entry)
```

---

## 10. 不要做的 (红线清单 — 同 Sprint 9 + Sprint 10 新加 2 条)

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
- ❌ 不要绕 `isSafeUserPath()` 把 dbPath / attachmentDir 路径直传 `better-sqlite3.Database()` 或 fs
- ❌ 不要重复 `WriteEnvelope<T>` / `envelopeFromCli` / `ensureInternalId` 定义
- ❌ 不要重复 `STORAGE_AGENT_*` 常量
- ❌ 不要重复 `isSafeUserPath` 定义
- ❌ 不要重复 `FOCUSABLE_SELECTOR` / Tab boundary 逻辑
- ❌ 不要重复 `BridgeEnvelope` / `swiftSentAt` / `sendEnvelope` 定义
- ❌ 不要在 keymap binding 加新条不更新 `src/shared/keymap.ts` SSoT
- ❌ 不要在 main 直 `import { autoUpdater } from 'electron-updater'`
- ❌ 不要在 useEmailChat hook 内直 `import 'net'` / `import 'fs'`
- ❌ 不要打包公证留 V1.5
- ❌ **(Sprint 10 新)** 不要让 `BridgeEnvelope.eventType` wire 出非 `Notification` — fork 现有 dispatcher 不识别(方案 A 协议)。如需切方案 B(Swift 加 mail 专属 case),在 fork 端 HookSocketServer 加 case 而非改 wire 层枚举。
- ❌ **(Sprint 10 新)** 不要从 `emailIdRef.current` 读 chunk envelope 的 emailId(可能跨邮件泄漏) — 走 `sessionMetaRef.get(sessionId).emailId`(L2 模式)。
- ❌ **(Sprint 10 (c) 实测踩坑新)** 不要用 `pnpm build:mac` 成功 = ship-ready 的判据 — Sprint 10 ship 踩了 2 个 packaged-only bug(router file:// + native ABI mismatch),`pnpm dev` / vitest happy-dom / build:mac ✓ 三个 gate 没一个能 catch。**Sprint 11 必做 Tier 1 Playwright Electron smoke 加进 ship gate**(详 §2.1)。
- ❌ **(Sprint 10 (c) 实测踩坑新)** 不要在 TanStack Router `createRouter()` 上保留默认 `createBrowserHistory` — packaged Electron 走 `file://` 协议时 pathname 是 fs 路径,落 NotFoundRoute。protocol 是 `file:` 一律切 `createMemoryHistory({initialEntries: ['/']})` (router-instance.tsx 已 wire)。
- ❌ **(Sprint 10 (c) 实测踩坑新)** 不要在 `build:mac` 跳过 `pnpm rebuild:electron` — vitest 会把 better-sqlite3 / keytar 的 .node binding 切到 Node ABI(141),packaged app 需 Electron ABI(140)。`package.json:build:mac` 已 chain `pnpm rebuild:electron && ...`。手动 invoke `electron-builder --mac` 时也要先跑 `pnpm rebuild:electron`。

---

## 11. Cross-links (按重要度)

| 文档 | 章节 | 用途 |
|---|---|---|
| `PROJECT-PLAN.md` | §3 Island + §4 V2 Sprint 拆分 | Sprint 11 主菜候选入口 |
| `ISLAND-PLUGIN.md` | §2.5.4-D 方案 A 决议归档 + §3 wire + §4 Python plugin + §8 主题色同步 | Sprint 10 方案 A 落地基准 |
| `INSTALL.md` | 全部 | 用户向安装 / 首次配置 / 故障排查 / 升级 / 卸载 |
| `DESIGN.md` | §9.5 快捷键 + §14 lint + §16 i18n + §17 主题 | 视觉 / 交互 / 非协商 |
| `ARCHITECTURE.md` | §2.2 + §3.4 + §5 | 数据层抽象边界 + Island 数据流图 + 主路径 |
| `BACKEND-INTERFACES.md` | §1.6 cli runner + §4 SQLite schema | dashboard 数据来源 |
| `NOTES.md` | Sprint 7/8/9/10 review entry | 历次 review carry-forwards |
| `REVIEW-LOG.md` | C-04 / C-05 / H-15 | 红线 trump 任何新设计 |
| `SPRINT9-HANDOFF.md` | §1 + §5 (架构沉淀) | Sprint 9 模式参考 |
| 后端 `CLAUDE.md` | "CLI 完整列表" admin/llm/calendar group + "ping-island 灵动岛集成" | dashboard 数据来源 + Island env / table / smoke |
| memory `reference-mailagent-frontend-dev-collab` | 全部 | 工作模式 SoT |

---

> Sprint 11 ship checklist 走完 → 这份 handoff 归档到 `frontend/archive/`, 写
> Sprint 12 handoff 时引用本文 §1.2 (方案 A 协议固化) + §5 (架构沉淀) +
> §6 (用户验收 checklist 模板)。
