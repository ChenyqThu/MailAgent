# MailAgent · 自动更新 (auto-update) 实现 Handoff

> 目标 UX（用户原话）：**检测在线更新 → 后台下载 → 前端提示"新版本就绪" → 点击重新加载即完成更新。**
>
> ⚠️ 本功能**大部分骨架在 Sprint 8 已实现**（electron-updater 全套 IPC + 状态机 + Settings Tab + GitHub publish + CI）。这是一份**「补缺口 + 激活」**的 handoff，**不是从零新建**。新 session 第一步必须**先审计现有实现**，只补真正缺的三块，别重造。
>
> 适配方式：新 session 用 **workflow** 实现。Claude design **不强制**（见 §6，复用既有 Banner/Toast/RestartBanner 即可）。

---

## 0. TL;DR + 头号阻断项

**已有（Sprint 8，勿重造）**：`autoUpdater` 桥接、`updater:status/check/download/quitAndInstall` IPC + `updater:event` 广播、8 态状态机、Settings 里的 `IslandUpdatesTab`、`electron-updater ^6.8.3`、`electron-builder.yml` publish（GitHub `chenyqthu/MailAgent`）、CI `--publish` 到 GitHub Releases。

**要补的三块缺口**（§2）：① 后台自动下载（当前 `autoDownload=false`）；② 主界面**主动"就绪"提示**（当前只埋在 Settings）+ 一键重载；③ 定时复查（当前只在启动后 10s 查一次）。

**🔴 头号阻断项（必须最先决策）**：**macOS 自动更新要求 Developer ID 签名 + 公证（notarization）**。当前 build 是 **ad-hoc 签名**，electron-updater 在 mac 上 `quitAndInstall` 会因下载包的签名无法匹配运行中 app 的 Developer ID 而**拒绝安装** → 更新装不上。**没有 Apple Developer ID（P6），这个功能写得再全也无法真正交付一次成功的更新。** 见 §3。

---

## 1. 现有实现清单（第一步：审计，别重造）

新 session 先读这些文件，搞清楚契约后再动手：

| 文件 | 作用 | 现状 |
|---|---|---|
| `frontend/src/electron/main/handlers/updater.ts` | autoUpdater 桥：绑事件→广播 `updater:event`、IPC handler、启动后 10s 自动 check | ✅ 完整。`autoDownload=false` / `autoInstallOnAppQuit=true` / dev 态 `dev-disabled` |
| `frontend/src/electron/main/index.ts`（~345-360） | `registerUpdaterHandlers({updater})`：打包态懒加载真 `autoUpdater`，dev 跳过 | ✅ |
| `frontend/src/shared/api/types.ts`（~1437-1445, 1682） | `UpdaterApi` 接口：`status()/check()/download()/quitAndInstall()/onEvent()` | ✅ |
| `frontend/src/shared/api/ElectronApi.ts`（~667） | renderer→IPC 桥（`updater:*`） | ✅ |
| `frontend/src/shared/state/updater.ts` | `useUpdaterStore` zustand，镜像 `UpdaterStatus` | ✅ |
| `frontend/src/shared/components/settings/tabs/IslandUpdatesTab.tsx` | Settings 里的手动 检查/下载/安装 UI + i18n | ✅（但只在 Settings 内） |
| `frontend/electron-builder.yml`（~100-106） | `publish: github / chenyqthu / MailAgent` | ✅ |
| `.github/workflows/build-mac.yml`（~88-91） | tag `v*` → `electron-builder --mac --<arch> --publish` + `GH_TOKEN` | ✅ |

**IPC 契约（已存在，复用，勿改名）**：
```
updater:status         () => UpdaterStatus
updater:check          () => UpdaterStatus   // autoUpdater.checkForUpdates()
updater:download       () => UpdaterStatus   // autoUpdater.downloadUpdate()（仅 state==='available'|'error' 有效）
updater:quitAndInstall () => void            // autoUpdater.quitAndInstall(false, true)
updater:event (push)   => UpdaterStatus      // 每次 setStatus 广播给所有窗口
```
`UpdaterState = 'idle'|'checking'|'available'|'not-available'|'downloading'|'downloaded'|'error'|'dev-disabled'`
`UpdaterStatus = { state, currentVersion, latestVersion, downloadPercent, message, updatedAt }`

---

## 2. 要补的缺口（本次实现范围）

### 缺口 A — 后台自动下载
现状：`handlers/updater.ts:103 autoDownload=false`（Sprint 8 故意：避免未经同意下 ~100MB；CRS 带宽语境）。
用户要后台下载。**实现选项（实现侧定，建议默认开 + 可关）**：
- 方案 1（简单）：`autoDownload=true` —— `update-available` 后 electron-updater 自动后台下载，到 `downloaded` 再提示。
- 方案 2（可控）：保持 `autoDownload=false`，在 `update-available` 事件里**自动调一次 `download()`**（等价后台下载，但留一个"仅 Wi-Fi/可关闭"的开关位）。
- 建议：方案 1 + 在 Settings 暴露一个「自动下载更新」开关（默认开），写进既有 `.env`/settings（沿用 settings 体系）。**保留** `autoInstallOnAppQuit=true`（退出即静默装好，下次启动就是新版）。

### 缺口 B — 主界面主动「更新就绪」提示 + 一键重载（核心诉求）
现状：状态只在 Settings 的 `IslandUpdatesTab` 可见，主界面无感知。
要做：监听 `updater:event`，当 `state==='downloaded'` 时，在**主界面**弹一个非侵入提示（banner/toast），文案如「新版本 v{latestVersion} 已就绪 · 点击重启更新」，点击 → `api.updater.quitAndInstall()`（app 退出并重启到新版）。
- **强制复用既有组件**（见 §6）：`frontend/src/shared/components/settings/RestartBanner.tsx` 就是现成的"重启以应用"模式；或 `Toast.tsx`。挂载点建议 App 根（全局可见，不限 Settings）。
- 状态驱动：读 `useUpdaterStore`（已 mirror `updater:event`），`state==='downloaded'` → 显示；用户可「稍后」忽略（dismiss，下次启动或退出时 `autoInstallOnAppQuit` 兜底）。
- 可选：接入灵动岛（Ping Island）作为通知载体（见 [`project_mailagent_ping_island_prd`]）——**可选增强，非 MVP**。

### 缺口 C — 定时复查
现状：仅启动后 10s 查一次（`AUTO_CHECK_DELAY_MS`）。
要做：加一个周期性 `check()`（如每 4-6h 一次 `setInterval`），main 进程里挂，注意 dev 态跳过（沿用现有 `is.dev` guard）+ 进程退出清理。

---

## 3. 🔴 头号前置：macOS 代码签名 + 公证（决定能否真正交付更新）

**为什么 ad-hoc 不行**：Squirrel.Mac（electron-updater 在 mac 的底层）在 `quitAndInstall` 前会校验下载的新版 app 签名与当前运行 app 的 **Developer ID 身份一致**。ad-hoc 签名没有稳定 Developer ID → 校验失败 → 更新**装不上**（或被 Gatekeeper 拦）。

**需要**（= 打包 epic 的 P6）：
1. Apple Developer 账号（$99/年）→ Developer ID Application 证书。
2. `electron-builder` 用该证书签名（`CSC_LINK`/`CSC_KEY_PASSWORD`），**hardenedRuntime + 公证（notarytool）**。
3. CI 注入证书 + 公证凭据（`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`），见 `build-mac.yml` 里已留的 TODO env 占位。
4. 产物里 `latest-mac.yml` + `.zip`（electron-updater mac 用 zip 增量）+ blockmap 都需正确签名。

**决策点（handoff 给用户/实现侧）**：
- **选项 A（推荐）**：先拿 Apple 账号 → 把签名+公证打通（P6）→ 再激活自动更新。否则功能无法验收"一次成功更新"。
- **选项 B**：先把缺口 A/B/C 的**代码 + UI 全实现并跑通 dev/mock**（用 `dev-app-update.yml` 模拟 feed），**功能 flag 默认关**，等 P6 签名就绪一翻开关即生效。适合并行推进、不阻塞。
- 两者都要在文档/Settings 注明：未签名版本的"检查更新"可用，但"应用更新"会失败——避免用户困惑。

**仓库可见性坑**：`publish` 指向 `chenyqthu/MailAgent`。若该 repo 是 **private**，electron-updater 从 GitHub Releases 拉更新需要 token（嵌进 app 有泄漏风险）或自建代理/改 public release。**实现侧先确认 repo 是 public 还是 private**，private 的话这是另一个必须解的子问题（建议：要么 release 资产走 public，要么用 generic provider + 自己的静态托管）。

---

## 4. 更新 feed + CI（已配置，验证即可）

- Feed = GitHub Releases（electron-updater `github` provider）。CI 在 tag `v*` 时 `--publish always` 上传 `latest-mac.yml`/`.zip`/`.dmg`/`.blockmap`。
- 验证：本地 `pnpm exec electron-builder --mac --arm64 --publish never` 看是否生成 `latest-mac.yml` + zip；tag 一次预发布看 CI 是否把资产推到 Release。
- **arch**：当前只 arm64（x64 lane 在 CI 里注释着）。electron-updater 按 arch 拉对应包；若要支持 Intel 用户需启用 x64 lane + 两份资产。MVP 可只 arm64。

---

## 5. 更新 ↔ 数据/onboarding 的关系（实现护栏 + 验收点）

- **userData 跨更新保留**：更新只替换 `.app` 包体；`~/Library/Application Support/MailAgent`（`.env` + `data/sync_store.db` + attachments）在 .app 之外，**不被更新触碰**。→ 更新后 `detectUserState()` 读 `<userData>/.env` 仍 `configured` → **直接进主界面、不走 onboarding**。
- **DB 自动迁移**：新版后端 `mailagent serve` 启动时 `_init_database()` 幂等迁移到最新 `DB_VERSION`（加列/建表式、向前兼容）。→ schema 变了也是后台自动升级，用户无感。
- **验收护栏**：① 更新器**绝不**写/删 userData（electron-updater 默认如此，但要在验收里显式确认）；② 强烈建议更新**应用前对 `sync_store.db` 做一次轻量备份**（forward-only 迁移的后悔药）——可作为 P2 增强，非 MVP 必须，但要在 handoff 里记一笔。

---

## 6. UI 设计：是否需要 Claude design？

**结论：MVP 不需要 Claude design。** 缺口 B 的"就绪提示"是一个**小而明确**的表面，**强制复用**既有设计语言：
- `frontend/src/shared/components/settings/RestartBanner.tsx`（已是"重启以应用"banner 范式）
- `frontend/src/shared/components/Toast.tsx`
- 既有 design tokens（`index.css` 的 `--ink-*`/`--c-accent`，参 [`frontend/DESIGN.md`]）

**何时升级到 Claude design**（写给用户判断）：若想要的不止一个 banner，而是**富更新中心**（"What's New" changelog 弹窗 / 下载进度可视化 / 版本历史），那属于新功能 UI → 走 `PRD + design system → Claude design 出设计 → handoff 实现`（见 [`03b-onboarding-design-handoff.md`] §6 协作协议）。MVP 先别上这个范围。

---

## 7. 测试策略（auto-update 难测，提前规划）

- **dev/mock**：electron-updater 支持 `dev-app-update.yml`（指向一个测试 feed）让 `pnpm dev` 下也能跑 check/download 流；或用 handler 现有的 `forceEnable` + stub `AutoUpdaterLike`（`handlers/updater.ts` 已为单测留了 stub 注入口 + `__testing`/`__resetForTesting`）。
- **真机端到端**：需要**两个已签名 + 公证**的版本（vX、vX+1）发到 feed，装 vX → 触发 → 验证下到 vX+1 → quitAndInstall → 重启后版本号变 vX+1 + userData 保留 + DB 迁移成功。**这一步依赖 §3 的签名前置。**
- 单测：扩 `handlers/updater.ts` 现有测试（事件→状态机迁移、`download()` 仅在 available/error 生效、`quitAndInstall` 仅在 downloaded 生效、缺口 B 的"downloaded→提示"渲染）。

---

## 8. 建议 workflow 阶段（新 session 用）

1. **审计**（并行只读）：盘点 §1 现有实现 + 确认 repo 可见性（§3 坑）+ 确认 `autoDownload`/auto-check 现状 + 找出主界面有无 update 消费点（应无）。产出缺口确认清单。
2. **签名前置决策**（问用户 / 按选项 B 默认）：是先 P6 还是先 flag-off 实现。
3. **实现缺口 A/B/C**（按契约，复用既有 IPC/store/组件）：main 侧 autoDownload + 定时复查；renderer 侧全局"就绪"banner + 一键 quitAndInstall + Settings 自动下载开关。
4. **交叉验证**：typecheck(node+web) + eslint(改动文件) + vitest（扩 updater 测试）+ build:unpack。
5. **对抗 review**（多轮，必要时 codex）：重点 = 签名/feed 配置正确性、更新器不碰 userData、quitAndInstall 时序、private-repo token 处理、dev 态不误触。
6.（P6 就绪后）真机两版端到端 dogfood。

---

## 9. 验收标准

- [ ] 启动后 + 周期性自动 `check`；有新版时（按设置）后台 `download`。
- [ ] 下载完成 → 主界面（非仅 Settings）出现"新版本就绪"提示，一键 `quitAndInstall` 重启到新版。
- [ ] Settings 的 `IslandUpdatesTab` 仍可手动 检查/下载/安装（不回归）。
- [ ] 更新后：不走 onboarding（`configured`）+ userData 完整保留 + 后端自动迁移 DB。
- [ ] dev 态 `dev-disabled`，不误触网络。
- [ ] 未签名版本：UI 明示"应用更新需正式签名版本"（或功能 flag-off），不静默失败误导用户。
- [ ] （P6 就绪）两个签名版本真机端到端更新成功。
- [ ] typecheck/lint(改动文件)/updater 单测全绿；build:unpack 出包 codesign 通过。

---

## 关联文档
- 打包 epic：`docs/packaging/01-architecture-analysis.md`（§ 签名/公证）、`02-landing-plan.md`（P6）、`docs/roadmap-post-cutover.md` §5.6
- 设计协作协议：`docs/packaging/03b-onboarding-design-handoff.md` §6
- 设计系统：`frontend/DESIGN.md`
- Ping Island（可选通知载体）：记忆 `project_mailagent_ping_island_prd`
