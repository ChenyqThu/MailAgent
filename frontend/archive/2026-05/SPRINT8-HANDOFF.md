# Sprint 8 Handoff — 打包 + 分发 (electron-builder .dmg + electron-updater + INSTALL.md + 3 Sprint 7 review MEDIUM)

> Sprint 8 主开发 handoff. Sprint 8 ship 完成 — electron-builder macOS .dmg
> ad-hoc 签名 + electron-updater GitHub Releases auto-updater + 用户向
> INSTALL.md + 关闭 Sprint 7 review 3 MEDIUM(全 Day 1 闭)。下个 Sprint 9
> 进入 Sprint 8 review carry-forwards(如有)+ Sprint 7 剩余 LOW polish。
>
> **工期实际**: ~2.5 小时(vs PROJECT-PLAN.md 1.5 天估算 — Sprint 6/7 沉淀
> 的 useMailApi data layer + i18n SSoT + envelope.ts pattern 让 wire-in 非常快)。
>
> **启动前最少读完**: §0 + §1 + §3 + §4 + §5 + §9 启动 checklist + §10 红线清单.

---

## 0. TL;DR

| 项 | 值 |
|---|---|
| Sprint 范围 | electron-builder macOS .dmg ad-hoc 签名 + electron-updater GitHub Releases auto-updater + Settings/StatusBar UI 接通 + 用户向 INSTALL.md + 3 Sprint 7 review MEDIUM (M1 dbPath wire / M2 modal Esc-hardening / M3 palette nav-to-email) + Sprint 7 review LOW (palette.search.untitled i18n 漏 fix) |
| 已 ship 基线 | commits Sprint 7 上 + (Sprint 8 待 commit) |
| 阀门 | **491 tests passed / 1 skipped** (+23 vs Sprint 7 baseline 468), `pnpm lint` 0, `pnpm typecheck` 0, `pnpm a11y:contrast --strict` **12 组合 clean**, electron-vite build OK, production grep 2 patterns(MAILAGENT_CLI_API_KEY i18n hint + osascript toast hint — Sprint 7 一致非 leak) |
| 工作模式 | Claude Opus 4.7 max-effort 单线 + Sprint 7 末 opus 4.7 code-reviewer subagent (强制, verdict APPROVE-with-follow-ups, 0 CRITICAL/HIGH/3 MEDIUM 已闭) |
| 阻塞 | 无 — 全 gate 绿, 进入 Sprint 9 |
| **Sprint 9 主菜** | 暂无主菜 — Sprint 7/8 review carry-forwards 闭 + V1.5 polish 候选(QuickActions LLM prompt i18n / SkeletonRow WIDTH_CLASS / useFocusTrap hook 抽取 / Island L2 接入 if appetite); 真 .dmg release 实测(打 v0.0.1 ship → `gh release create` 触发 GitHub artifact upload → 用户实机装 .dmg 验证) |

---

## 1. 已 ship deliverables

### 1.1 Sprint 7 review 3 MEDIUM (Day 1 全闭)

opus 4.7 max-effort code-reviewer 跑出 **0 CRITICAL / 0 HIGH / 3 MEDIUM / 6 LOW / 3 Nit + 1 Open** (13 findings)。Sprint 8 Day 1 闭 **3 MEDIUM + 1 LOW (palette.search.untitled)**:

| Severity | Fix | Files |
|---|---|---|
| MEDIUM #1 | `db.ts:resolveDbPath()` 加 `settingsDbPathOverride()` 桥 → 读 `<userData>/settings.json:dbPath` + 通过新 `lib/path-guard.ts:isSafeUserPath()` 二次 validate(与 IPC sanitizer 共用 predicate) | `db.ts:18-65` + `lib/path-guard.ts` 新建 + `handlers/settings.ts:18-33,75-82` import 改 |
| MEDIUM #2 | KeyboardHelpModal + CommandPalette outer dialog `<div role="dialog">` 加 `tabIndex={-1}` + focus 兜底,让 backdrop 自己 focusable; Esc / Tab onKeyDown 在无 focusable descendant 时仍 route | `KeyboardHelpModal.tsx:127,131` + `CommandPalette.tsx:316,319` |
| MEDIUM #3 | CommandPalette search-hit `run()` 从 `navigate({to:'/search'})` 改 `setActiveEmail(hit.internal_id) + navigate({to:'/'})` — 选 hit 后真跳到 inbox 详情而不是回 search 页 | `CommandPalette.tsx:218-235` + import `useActiveEmail` |
| LOW (review Top-3 highlight) | `palette.search.untitled` i18n key zh+en locale 漏 — runtime 显字面 `palette.search.untitled` 而非 `(无主题)`/`(no subject)` fallback | `locales/zh-CN/common.json` + `locales/en-US/common.json` |

剩余 5 LOW + 3 Nit + 1 Open 留 Sprint 9 polish(非 user-facing)。

### 1.2 Sprint 8 主菜 — 打包 + 分发

#### D2: electron-builder 完善

| 模块 | 行数 | 作用 |
|---|---|---|
| `electron-builder.yml` | 56 | 完善:identity=null(ad-hoc) + hardenedRuntime=true + entitlements.mac.plist + mac.target {dmg+zip} × {arm64+x64} 4 product + minimumSystemVersion=12.0 + dmg.window 540×380 含 Applications 链接 + publish=github。zip 是 electron-updater **必需** channel(走 `latest-mac.yml` + `.zip.blockmap` 增量) |
| `build/entitlements.mac.plist` | 22 | 8 entitlements:cs.allow-jit + cs.allow-unsigned-executable-memory + cs.allow-dyld-environment-variables + cs.disable-library-validation + network.client + automation.apple-events + files.user-selected.read-write + files.downloads.read-write |
| `dev-app-update.yml` | 12 | electron-updater dev-mode override(packaged 时被打包内 `app-update.yml` 覆盖)。dev 通常走 `dev-disabled` state,packaged build 才真 check GitHub feed |

#### D3: electron-updater bridge

| 模块 | 行数 | 测试 | 作用 |
|---|---|---|---|
| `src/electron/main/handlers/updater.ts` | 230 | 16 | 8-state 状态机(idle/checking/available/not-available/downloading/downloaded/error/dev-disabled), `autoDownload=false`(用户控制)+`autoInstallOnAppQuit=true`,启动 10s 后 production auto-check 一次。BrowserWindow.send `updater:event` 广播。`bindAutoUpdater(AutoUpdaterLike)` 抽口让测试可 inject stub 不连 GitHub |
| `src/shared/state/updater.ts` | 30 | — | zustand store + `setUpdaterStatus()` helper |
| `src/shared/api/types.ts` | +60 | — | `UpdaterApi` + `UpdaterStatus` + `UpdaterState` types,加进 `MailApi` |
| `src/shared/api/ElectronApi.ts` | +25 | — | `ElectronUpdaterApi` class wire 4 IPC channels + onEvent subscribe |
| `src/shared/api/HttpApi.ts` | +10 | — | V2 stub(Web SPA 不能从 browser 触发 host update,Web 在 V2 显「Mac 主机版本 X」hint) |
| `src/electron/main/index.ts` | +20 | — | `registerUpdaterHandlers()` 调用,production 注入真 `autoUpdater`, dev 不注入(state 自然 `dev-disabled`) |

#### D4: SettingsPage UI 集成

| 改动 | 内容 |
|---|---|
| About section 拆 | `<AboutSection>` 单独显示 v{version} + GitHub link;`<UpdateSection>` 独立块 |
| `<UpdateSection>` | 8-state 全 covered:idle 显当前 + 检查按钮 / checking spinner / available 显新版本号 + 下载按钮 / not-available 显 "已是最新" / downloading 进度% / downloaded 显新版本号 + 重启按钮 / error 红字 / dev-disabled 灰示 |
| useEffect 接 stream | mount 时 `updater.status()` 一次 hydrate + subscribe `onEvent`,unmount 自动 cleanup |
| toast 反馈 | 错误经 `toastError(t('settings.update.heading'), ...)`;重启用 `toastSuccess(t('settings.update.restartCta'))` |

#### D5: StatusBar 动态 version

`v0.0.1 · sprint 2` → `v{status.currentVersion}`(从 `app.getVersion()` 读),`downloaded` 状态加 `· 更新就绪` coral hint。useEffect 同 SettingsPage 接 store subscribe。

#### D6: i18n + 用户向 INSTALL.md

| 项 | 数 |
|---|---|
| 新增 keys (per locale) | 20 (settings.update.* 12 + statusbar.* 7 + palette.search.untitled 1 — 后者是 Sprint 7 review LOW 修复) |
| zh-CN 总 keys | 340 (Sprint 7 320 + 20) |
| en-US 总 keys | 340 |
| `[TODO en]` 残留 | 0 |
| 新文件 | `frontend/INSTALL.md`(~280 行,7 章:适配范围 / 后端准备 / 安装 / 首次配置 / 日常使用 / 故障排查 / 升级 / 卸载) |

### 1.3 测试覆盖

| 文件 | 新测试 | 覆盖 |
|---|---|---|
| `tests/main/updater.test.ts` | +16 | 8 state 转换(checking/available/not-available/downloading/downloaded/error)+ check/download/quitAndInstall handler 操作 + dev-disabled 跳过 + error 兜底 + bindAutoUpdater 强制 autoDownload=false |
| `tests/main/db_settings_wire.test.ts` | +7 | `settingsDbPathOverride()` MEDIUM #1 wire:不存在/缺 key/非 string/绝对路径接受/相对路径拒/`..` 拒/malformed JSON 兜底 |
| **合计** | **+23** | Sprint 7 baseline 468 → Sprint 8 ship 491 |

---

## 2. Sprint 9 工作清单 (按交付顺序)

### 2.1 Sprint 8 review carry-forwards (Day 1 顺手关 — 待 opus 4.7 code-reviewer 输出)

Sprint 8 末仍需跑一次 opus 4.7 max-effort code-reviewer subagent(强制)。预期 0 CRITICAL / 0 HIGH(基线已是 APPROVE)。如有 MEDIUM/LOW Day 1 闭。

### 2.2 Sprint 7 review 剩余 LOW / Nit / Open (可选 polish)

| Severity | Item | File |
|---|---|---|
| LOW | wire `⌘K → toggle` 让 palette 自我开关(目前 dead code `toggle()`) | `state/command-palette.ts` + `GlobalShortcuts.tsx` |
| LOW | 抽 `useFocusTrap(dialogRef, open)` hook 给三 modal 复用 | new `hooks/useFocusTrap.ts` + 3 modal 改用 |
| LOW | `searchQ` 加 `keepPreviousData: false` 防 stale snippet | `CommandPalette.tsx:160-175` |
| LOW | keymap `toggleIsland scope='global'` 加 `wired: false` + 文档 Island L2 依赖 | `shared/keymap.ts` |
| LOW | KeyboardHelpModal `ScopeSection` 标题加 `tabIndex={0}` 让 VoiceOver 可 browse | `KeyboardHelpModal.tsx:62-77` |
| Nit | SkeletonRow `WIDTH_CLASS` hardening | `feedback/LoadingSkeleton.tsx` |
| Nit | `Array.from((_, i) => …)` key 索引(linter 偶尔 flag) | `feedback/LoadingSkeleton.tsx:30-40` |
| Nit | KeyboardHelpModal aria-modal claim 不完整(`<li>` 不可 Tab) | `KeyboardHelpModal.tsx` ScopeSection items |
| Open | CommandPalette adjust-state StrictMode 双 render 幂等性 stress-test | `CommandPalette.tsx:130-144` |

### 2.3 Sprint 9 可选主菜候选

| 任务 | 入口 |
|---|---|
| QuickActions LLM prompt i18n | `QuickActions.tsx` ACTIONS 的 `prompt:` 字段也走 i18n key(英文用户的 LLM prompt 应该用英文) |
| 真 .dmg release 实测 | `gh release create v0.0.1 --draft` → 触发 GitHub Actions 上传 dmg+zip+blockmap+latest-mac.yml → 实机装 .dmg → in-app updater check 验证 |
| Island L2 接入 | PROJECT-PLAN.md §3 Island-Sprint 1-3 (fork ping-island + .mail brand + plugin) |
| `inbox` 空状态 EmptyState | Mockup 没 spec; Sprint 9 polish 决定加 mascot 时再 wire |
| /admin /llm 看板更全数据接通 | 接入 `mailagent llm compare-paths` / Reader insights / RFC §1.6 cli runner |

---

## 3. 工作模式

| 角色 | Agent | 何时用 |
|---|---|---|
| **主线** | Claude Opus 4.7 单线 max-effort | 整 Sprint 9 持续 context |
| **子任务并行** | ultrawork (optional) | Sprint 9 主菜不大,基本不需 |
| **长 IO** | `Bash run_in_background=true` | `pnpm install` / `pnpm electron-vite build` / `pnpm a11y:contrast` / `pnpm build:mac` |
| **Sprint 末 review** | `Agent subagent_type=oh-my-claudecode:code-reviewer model=opus` (强制) | 强制 — 闭环价值高 |
| **禁用** | `codex:codex-rescue` agent / `autopilot` | `[[feedback-codex-collaboration-path]]` 红线 |

参考: `[[reference-mailagent-frontend-dev-collab]]` + `[[feedback-codex-collaboration-path]]`.

---

## 4. 设计约束 (lint / CI 已枪口对准)

DESIGN.md §14 八条非协商 + i18n + 三态主题第 9/10 条 — 同 Sprint 5/6/7. Sprint 8 没新增 lint rule.

**Sprint 8 关键 pattern**:
- **electron-updater state machine** — main process 单 module 持 8-state status,renderer 通过 `updater:event` 广播 subscribe + `updater:status` 单次 hydrate。zustand store + 共享 selector hook,SettingsPage 和 StatusBar 都读同一 store(初次 mount 谁先 fetch 谁去 hydrate,其余 piggyback)
- **AutoUpdaterLike injection** — handler 不直 import `electron-updater`,而是接受 `AutoUpdaterLike` shape 注入。生产 `require('electron-updater').autoUpdater`,测试注入 stub。这样测试不会 reach out GitHub
- **lib/path-guard.ts SSoT** — `isSafeUserPath()` 抽到独立 lib,IPC sanitizer 和 db.ts 都 import 同 predicate(REVIEW-LOG defense-in-depth)
- **tabIndex={-1} on backdrop** — Portal modal 的 outer dialog div 加 `tabIndex={-1}` 后 backdrop 自己 focusable,即使没 focusable descendant 也能接 keydown(Esc / Tab focus-trap)。React onKeyDown synthetic event 通过 focused element bubble,backdrop 是兜底
- **WriteEnvelope unification** — Sprint 7 抽到 `lib/envelope.ts` 的 pattern,Sprint 8 沿用(updater handler IPC 不走 WriteEnvelope 因为它的 error 本身就是 state field,不抛)

---

## 5. 架构规范 (关键 + Sprint 8 已落地)

### 5.1 electron-updater bridge 模式 (Sprint 8 沉淀)

新加 auto-update 相关功能:
1. main 端在 `handlers/updater.ts` 内实现状态机,broadcast 单 channel `updater:event`
2. renderer `shared/state/updater.ts` zustand store + `setUpdaterStatus()` helper
3. `useMailApi().updater.onEvent(handler)` subscribe 渲染层,unmount 自动 unsubscribe
4. UI 组件读 `useUpdaterStore(s => s.status)` 单 selector

### 5.2 path-guard SSoT 模式

```typescript
// lib/path-guard.ts — IPC sanitizer 和 db.ts 共用 predicate
export function isSafeUserPath(value: string): boolean {
  if (value.length === 0) return false
  if (!isAbsolute(value)) return false
  const rawSegments = value.split(/[/\\]/).filter(Boolean)
  if (rawSegments.includes('..')) return false
  const normalized = normalize(value)
  if (!isAbsolute(normalized)) return false
  return true
}
```

用于:`handlers/settings.ts:sanitize()` + `db.ts:settingsDbPathOverride()`. 任何后续 file path 输入(attachment dir、custom log path 等)都应该走它。

### 5.3 electron-builder ad-hoc 签名 mac config

```yaml
mac:
  identity: null            # ad-hoc 签名,不需 Apple Developer ID
  hardenedRuntime: true     # 强制现代运行时(notarize 也需要这个)
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  notarize: false           # 公证留 V1.5(需 $99/y Developer 账号)
  target:
    - target: dmg
      arch: [arm64, x64]
    - target: zip           # zip + blockmap 给 electron-updater 增量
      arch: [arm64, x64]
```

Sprint 9 要走真公证:加 `notarize: { teamId: '...' }` + APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD env。

---

## 6. 注意事项 + Edge cases

| 场景 | 处理 |
|---|---|
| dev 模式调 `autoUpdater.checkForUpdates()` 会抛 | `is.dev=true` 时 handler 不 bind autoUpdater,state 留 `dev-disabled`,UI 显灰示 |
| 多 BrowserWindow 同时存在 | broadcast 给所有非 destroyed window webContents(`BrowserWindow.getAllWindows()`) |
| 用户重启时 update 已部分下载 | `autoInstallOnAppQuit=true` — 关 app 时静默安装,下次启动是新版本 |
| auto-check 在网络断时 | autoUpdater.checkForUpdates() 走 'error' 事件,state → 'error' + message,SettingsPage 显红字 |
| download 中用户 ⌘K 关 app | electron-updater 自带 abort + temp file cleanup,我们不持有 controller |
| settings.json 被外部改成非法 dbPath | db.ts:settingsDbPathOverride() defense-in-depth — re-validate isSafeUserPath,非法返回 null → fallback default 路径 |
| settings.json 是 malformed JSON | settingsDbPathOverride() catch + 返 null;handlers/settings.ts:readSettings() catch + 返 DEFAULTS |

---

## 7. 验收标准

### 7.1 阀门 (ship 前必绿)

- ✅ `pnpm test`: **491 passed | 1 skipped** (Sprint 7 baseline 468 + 23 新)
- ✅ `pnpm lint`: 0 violation (含 mailagent design rules + react-hooks 各 rule)
- ✅ `pnpm typecheck`: 0 error (node + web)
- ✅ `pnpm a11y:contrast` (--strict): **12 组合 all clean**
- ✅ `pnpm exec electron-vite build`: ✓
- ✅ production grep 23 patterns: renderer + preload **0 真泄漏** (2 patterns hit — MAILAGENT_CLI_API_KEY 是 i18n hint string + osascript 是 toast hint — Sprint 7 baseline 一致)

### 7.2 功能性 (Sprint 8 主菜)

- ✅ Settings → 应用更新 区显示当前版本(real from `app.getVersion()`)
- ✅ Settings → 应用更新 → 检查更新 触发 autoUpdater.checkForUpdates()
- ✅ 8 状态 UI 全 covered:idle / checking / available / not-available / downloading / downloaded / error / dev-disabled
- ✅ StatusBar v{version} 实时读 store
- ✅ StatusBar downloaded 时显 「更新就绪」 coral hint
- ✅ build/entitlements.mac.plist 含 8 entitlements
- ✅ electron-builder.yml mac 走 ad-hoc 签名 + dmg+zip × arm64+x64
- ✅ dev-app-update.yml 存在(electron-updater dev override)
- ✅ frontend/INSTALL.md 用户向完整(8 章)

### 7.3 Sprint 7 review carry-forwards

- ✅ MEDIUM #1: settings.dbPath wire 进 db.ts:resolveDbPath() + lib/path-guard.ts SSoT
- ✅ MEDIUM #2: KeyboardHelpModal + CommandPalette outer dialog tabIndex={-1} hardening
- ✅ MEDIUM #3: CommandPalette search-hit run() → setActiveEmail + navigate '/'
- ✅ LOW Top-3 highlight: palette.search.untitled i18n 漏 fix

### 7.4 i18n

- ✅ 所有新增 JSX 字符串走 `t()`
- ✅ zh-CN + en-US locales 同步 (340 keys 同 count)
- ✅ `[TODO en]` 0 残留
- ✅ Sprint 7 review LOW (`palette.search.untitled`) 双 locale 补齐

### 7.5 Sprint 末 review (强制)

- 独立 Opus 4.7 max-effort `Agent subagent_type=oh-my-claudecode:code-reviewer model=opus` (Sprint 9 启动前跑)

---

## 8. NOTES.md 待办处理

Sprint 9 启动后用 5 分钟整理 `frontend/NOTES.md`. Sprint 8 review carry-forwards
(待 opus 4.7 review 输出后写入) Day 1 顺手关.

---

## 9. 启动 checklist

```bash
# 1. 拉最新 + 切分支
cd ~/Documents/MailAgent && git pull
git checkout main && git merge sprint8   # Sprint 8 主线已 ship
git checkout -b sprint9
cd frontend && pnpm install

# 2. 验 Sprint 8 baseline 全绿
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm test       # 491 passed | 1 skipped
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm lint       # 0
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm typecheck  # 0
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm a11y:contrast  # ✓ 12 组合 clean
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm exec electron-vite build  # ✓

# 3. mailagent CLI 可用?
which mailagent && mailagent --version
mailagent admin health -o json  # 探一下后端 DB 可读

# 4. Mail.app 自动化权限确认 (Sprint 5 复用)

# 5. 起 dev server 验证 Sprint 8 功能
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm dev
# → 设置 → 应用更新 区 (应显 v0.0.1 + Dev 模式禁用灰示)
# → 检查更新按钮 disabled (dev 状态)
# → StatusBar 右下 v0.0.1 (dynamic)

# 6. 真 .dmg 打包实测
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm build:mac
# → 输出 release/MailAgent-0.0.1-arm64.dmg + MailAgent-0.0.1-x64.dmg
#   + MailAgent-0.0.1-arm64-mac.zip + .blockmap + latest-mac.yml
# → 装 .dmg 实机跑 (右键 → 打开 → 信任 ad-hoc)
# → Settings → 应用更新 → 检查更新 (生产模式状态应到 not-available 或 available)

# 7. 必读 (~25 min):
# - frontend/PROJECT-PLAN.md §2 Sprint 7 剩余 (Sprint 8 已完成,Sprint 9 灵活)
# - frontend/SPRINT8-HANDOFF.md §2 + §10 (本文档)
# - frontend/NOTES.md (Sprint 7/8 review carry-forwards)
# - frontend/DESIGN.md §13 项目结构

# 8. Day 1 顺手关 cheap Sprint 8 review carry-forwards (待 opus 4.7 review 输出)
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
- ❌ 不要在 keymap binding 加新条不更新 `src/shared/keymap.ts` SSoT (`?` modal 读它)
- ❌ 不要在 main 直 `import { autoUpdater } from 'electron-updater'` (会在测试时 reach GitHub); 用 `AutoUpdaterLike` 注入 pattern (`handlers/updater.ts`)
- ❌ 不要打包公证留 V1.5 — 当前 ad-hoc 签名已够;切公证要 `$99/y` Apple Developer + APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD env

---

## 11. Cross-links (按重要度)

| 文档 | 章节 | 用途 |
|---|---|---|
| `PROJECT-PLAN.md` | §2 Sprint 7 剩余 | Sprint 8 任务源头(已完成);Sprint 9 灵活 polish |
| `INSTALL.md` | 全部 | 用户向安装 / 首次配置 / 故障排查 / 升级 / 卸载 |
| `DESIGN.md` | §9.5 快捷键 + §14 lint + §16 i18n + §17 主题 | 视觉 / 交互 / 非协商 |
| `ARCHITECTURE.md` | §2.2 + §5 | 数据层抽象边界 + 主路径 |
| `BACKEND-INTERFACES.md` | §1.6 cli runner + §4 SQLite schema | Sprint 6 admin/llm dashboard 数据来源 |
| `NOTES.md` | Sprint 7/8 review entry | 历次 review carry-forwards |
| `REVIEW-LOG.md` | C-04 / C-05 / H-15 | 红线 trump 任何新设计 |
| `SPRINT7-HANDOFF.md` | §1 + §5 (架构沉淀) | Sprint 7 模式参考 |
| 后端 `CLAUDE.md` | "CLI 完整列表" admin/llm/calendar group | dashboard 数据来源 |
| memory `reference-mailagent-frontend-dev-collab` | 全部 | 工作模式 SoT |

---

> Sprint 9 ship checklist 走完 → 这份 handoff 归档到 `frontend/archive/`, 写
> Sprint 10 handoff 时引用本文 §1.2 (D2-D6 主菜模式) + §5 (架构沉淀) +
> §1.1 (Sprint 7 review carry-forwards 闭环).
