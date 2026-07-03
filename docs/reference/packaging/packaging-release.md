# 桌面 App 打包 / 发布流程（固化 runbook）

> 一体化 Electron 前端 + 内嵌 CPython 后端打成单个 macOS `.app`。
> **全部在 `main` 上做**：前端不是独立 repo/submodule，就是主 repo 的 `frontend/` 子目录；
> 打包/onboarding/auto-update 代码已全部合入 `main`（`feat/packaging-onboarding` 已合并并删除）。
> **以后发布不用再切 worktree 或别的分支** —— 在 `main` 上 bump → build → install。

---

## 0. 架构速记

- 前端：`frontend/`（electron-vite + electron-builder v26，Electron 39）。
- 后端：仓库根的 Python（`src/`），通过 `scripts/build-python-venv.sh` 装进**可重定位嵌入式 CPython**（python-build-standalone 3.11.15），由 `BackendLifecycleManager` 托管（取代 PM2）。
- 数据：打包态 `DATA_ROOT = ~/Library/Application Support/mailagent-frontend/`（注意是 package.json `name`=`mailagent-frontend`，**不是** `MailAgent`）。userData 跨重装保留。

## 1. 版本号机制

- **SSoT = `frontend/package.json` 的 `version` 字段。** electron-builder 读它 →
  - `.app` 的 `Info.plist` `CFBundleShortVersionString`
  - 产物名 `artifactName`（`${name}-${version}-${arch}.${ext}`）
  - auto-update feed `latest-mac.yml`（electron-updater 比对此版本）
- **bump 流程**：改 `frontend/package.json` `version` → build → 装机验证 → `git tag -a vX.Y.Z -m "..."`（annotated）。
- **语义**：`0.1.0` = 第一个 beta；bug 修复走 patch（`0.1.1` / `0.1.2` …）。已发 tag：`v0.1.0` / `v0.1.1` / `v0.1.2`（**本地，未推送**；当前走本地路线不发 GitHub Release）。
- **🔴 死硬约束**：不要随意改 package.json 的 `name`（`mailagent-frontend`）—— 它决定 userData 目录名，改了会让已装用户的 `~/Library/Application Support/mailagent-frontend/` 易主（数据 + .env 看起来"丢了"）。

## 2. 前置：build 环境（一次性）

构建需要两样东西在 `frontend/` 下就位（都是 gitignored 的本地产物，不随 git 走）：

1. **`node_modules`**：`cd frontend && pnpm install`。
2. **`resources/python`**（嵌入式后端运行时，~200M）：`bash scripts/build-python-venv.sh [arm64|x64]`（默认 arm64）。
   - 它下载 python-build-standalone（带缓存 `frontend/.cache/pbs`）+ `pip install` 后端 `src/` 进它的 site-packages，产出 `resources/python/{bin/python3.11, bin/mailagent, lib/.../site-packages/src}`。
   - electron-builder 经 `extraResources` 把它注入 `.app/Contents/Resources/python/`。

> **当前这台机器已 provision 过 `resources/python`**（主 repo 目录），可直接 build。换机器 / 全新 clone 时必须先跑 `build-python-venv.sh`。

## 3. 构建命令

```bash
cd /Users/chenyuanquan/Documents/MailAgent/frontend

# 推荐（本地装用）：只出 .app，跳过会 flaky 的 dmg
pnpm run build && npx electron-builder --dir --arm64
#   pnpm run build = typecheck(node+web) + electron-vite build(编译 TS→out/)
#   electron-builder --dir = 打 .app + 跑 afterPack 签名（不打 dmg/zip）

# 完整发布产物（dmg + zip + blockmap + latest-mac.yml，auto-update feed 用）
pnpm build:mac
#   = rebuild:electron(better-sqlite3 对 electron ABI) + electron-vite build + electron-builder --mac
```

产物：`frontend/dist/mac-arm64/MailAgent.app`（+ `dist/*.dmg` / `*.zip` 若走 build:mac）。

## 4. afterPack 签名（`scripts/afterPack.cjs`）—— 含头号 gotcha

封签前对嵌入式 python 的 121 个 Mach-O（.so/.dylib）做 ad-hoc 预签 + 对整个 `.app` 做 `--deep` ad-hoc 签（`identity: null`，无 Developer ID）。

> **🔴 头号 gotcha（本 session 踩过）**：若 `resources/python` **不存在**，afterPack 打印「未发现嵌入式 python, 跳过」并**跳过整个签名** → 产出的 `.app` 既无后端、签名又残缺 → `codesign --verify` FAIL。
> **务必先确认 `resources/python` 在**（见 §2），再 build。

## 5. 验证产物（每次 build 后必做）

```bash
APP=dist/mac-arm64/MailAgent.app
/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$APP/Contents/Info.plist"   # = 期望版本
codesign --verify --deep --strict "$APP" && echo OK                                          # 必须 OK
ls "$APP/Contents/Resources/python/bin/python3.11"                                            # 后端在
# 改动是否进包（app.asar 是归档，用 grep -a 文本搜）:
grep -ac '<改动里的唯一串>' "$APP/Contents/Resources/app.asar"
```

## 6. 安装 / 升级（本地，Developer ID 就绪前）

```bash
osascript -e 'quit app "MailAgent"'        # 退出运行中的旧版（内嵌后端随之停）
sleep 4
rm -rf /Applications/MailAgent.app
ditto "<repo>/frontend/dist/mac-arm64/MailAgent.app" /Applications/MailAgent.app   # ditto 保符号链接/权限
open /Applications/MailAgent.app
```

- **升级（已有用户）**：userData 保留 → detect `'configured'` → **跳过 onboarding** 直接进 → 后端启动自动跑 DB 迁移。版本不同也无需重配。
- **双写防护**：用 `.app` 时 pm2 的 `mail-sync` 必须停/删（`.app` 跑自己的内嵌后端）；davmail 用户的 `davmail-poc` 继续留 pm2（是 EWS 桥，不打进 app）。

## 7. 自动更新（v1.0.0 起已激活）

- **已上线**（P6，v1.0.0）：electron-updater / Squirrel.Mac 自动更新打通 —— Developer ID Application 签名 + notarytool 公证就位，`quitAndInstall` 可装。检测 → 后台下载 → 主界面「就绪」banner → 一键重启更新。
- **flag**：`AUTO_UPDATE_ENABLED` **packaged 默认开、dev 默认关**（`frontend/src/electron/main/handlers/updater.ts` `readMasterFlag()` = `!is.dev`）；gate 的只有「自动后台下载 + 自动安装」，检测/提醒（启动 10s check + 48h 周期复查）无条件跑。emergency 回滚：userData `.env` 设 `AUTO_UPDATE_ENABLED=0`（仍保留检测提醒）。运行时 `enabled` 不校验真实签名态——安全靠「翻 flag 与签名同次提交」纪律。
- **签名/公证机制**（CI `.github/workflows/build-mac.yml`）：`electron-builder.yml` mac 段 `identity` 省略（自动发现 CSC_LINK 导入临时 keychain 的 Developer ID Application 证书）+ `notarize:true`（notarytool 读 `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`）；electron-builder 经 @electron/osx-sign 递归 deepest-first 签整个 `Contents/`（含嵌入式 python 148 个散装 .so，带安全 timestamp）。`afterPack.cjs` 见 `CSC_LINK` 切换：有=跳过（交 electron-builder 全签，避免 ad-hoc `--timestamp=none` 害公证 reject）；无=本地 ad-hoc 回退。CI 需 **5 个 secret**（`CSC_LINK` base64 .p12 含私钥 / `CSC_KEY_PASSWORD` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` appleid.apple.com 生成 / `APPLE_TEAM_ID`），preflight step fail-fast 校验（缺则空串 secret 会让 electron-builder 晦涩失败）。
- **entitlements**（`build/entitlements.mac.plist`）：嵌入式 CPython 需 `allow-jit` / `allow-unsigned-executable-memory` / `disable-library-validation`（加载非 Apple 签名的 .so）+ `allow-dyld-environment-variables`（捆绑子进程前提，比前三项更敏感）。都是 hardened-runtime exception，Apple 接受、能过公证，但放宽了部分约束 —— 有意接受的 blast radius。
- 🔴 **首签名版仍手动装一次**：ad-hoc 旧版 → Developer ID 新版的跨签名身份升级 Squirrel.Mac 会拒绝。**v1.0.0 是「自动更新起点」，需手动装**（你 + 现有 ad-hoc 用户）；之后 v1.0.1+ 之间才全自动。
- 发布流程仍走 §3（CI tag → 签名+公证 → draft → 手动转正式）。详见 [`05-auto-update-handoff.md`](05-auto-update-handoff.md)。

## 8. 改了 **Python 后端**代码时

`resources/python` 里装的是后端 `src/` 的快照（gitignored，不随 git）。改了 `src/` 后必须**重新 provision** 才会进包：

```bash
bash frontend/scripts/build-python-venv.sh arm64   # 重装 src/ 进嵌入式 python
# 然后再 build（§3）
```

只改前端 TS / CSS 则不用，直接 build。

## 9. 故障排查

| 症状 | 根因 / 处置 |
|---|---|
| `codesign --verify` FAIL + `.app` 无 python | `resources/python` 缺失 → afterPack 跳过签名（§4）。provision 后重 build。 |
| dmg 步骤 `hdiutil couldn't unmount ... 资源忙` | dmg flaky（Finder/残留挂载占用）。本地装不需要 dmg → 改用 `electron-builder --dir`（§3）。或 `hdiutil detach` 残留盘后重试。 |
| `pnpm build:mac` 报 `BUILD_EXIT=0` 但其实失败 | `$?` 取的是管道末端 `tail` 的退出码，不是 pnpm。看日志里有无 `ELIFECYCLE Command failed`。 |
| 启动后主界面卡进 onboarding 小窗 | 旧 bug，0.1.1 已修（`reloadToMain` 恢复窗口尺寸）。 |
| Gatekeeper 拦"已损坏/无法验证" | 本地编译的 .app 无 quarantine；若被拦 `xattr -dr com.apple.quarantine /Applications/MailAgent.app`。 |
| 启动弹「数据库校验失败」/ serve 日志 `数据库完整性校验失败` | SQLite 损坏被启动安全网拦下（有意 fail-fast，防坏库继续写）。按 §10 从 backups/ 恢复。 |

## 10. 数据恢复（E0-WP2 启动安全网 + backups/ 回滚）

**机制**（`src/mail/db_safety.py`，只在 `mailagent serve` 启动早期跑）：距上次备份 >24h 时对 `sync_store.db` / `agent_config.db` 各跑一次 `PRAGMA quick_check`；通过 → `VACUUM INTO` 滚动备份到 `<DATA_ROOT>/data/backups/`（每库保最近 3 份，文件名 `<stem>-YYYYMMDD-HHMMSS.db`；放 `data/` 下：dev 态 DATA_ROOT=仓库根，`data/` 已 gitignore）；失败 → 写 `data/db_integrity_failure.json` marker + serve 拒绝启动（Electron 读 marker 弹「数据库校验失败」框），**不做备份不轮转**（保住已有好备份）。实测 1.5 GB 库一轮 ~40s（quick_check ~24s + VACUUM ~13s），每天最多一次；3 份 sync_store 备份 ≈ 4.6 GB 磁盘（已知成本）。

**已知边界**：`ai_chat.db`（前端 owned，chat 历史）与 `data/attachments/` 首期不在备份范围。

**恢复步骤**（DATA_ROOT：打包 app = `~/Library/Application Support/mailagent-frontend/`；dev/PM2 = 仓库根）：

```bash
# 0) 先退出 MailAgent.app（或 pm2 stop mail-sync），确保没有进程持有 DB
# 1) 看备份（按时间戳选最近一份）
ls -lh "<DATA_ROOT>/data/backups/"
# 2) 现场留底（把损坏库挪走，不要直接删）
mv "<DATA_ROOT>/data/sync_store.db" "<DATA_ROOT>/data/sync_store.db.corrupt"
rm -f "<DATA_ROOT>/data/sync_store.db-wal" "<DATA_ROOT>/data/sync_store.db-shm"   # 旧 WAL/SHM 属于坏库，必须一起挪/删
# 3) 回滚备份（VACUUM INTO 产物是无 WAL 的完整单文件库）
cp "<DATA_ROOT>/data/backups/sync_store-<时间戳>.db" "<DATA_ROOT>/data/sync_store.db"
# 4) 验证恢复件完整
sqlite3 "<DATA_ROOT>/data/sync_store.db" "PRAGMA quick_check"   # 期望输出: ok
# 5) 清 marker（成功启动也会自动清，手动清可立即消除弹框）
rm -f "<DATA_ROOT>/data/db_integrity_failure.json"
# 6) 重启 App / pm2 start；备份时间点之后的邮件由 health_check / 增量同步自动补齐
```

`agent_config.db` 同理（stem 换成 `agent_config`）。备份是 24h 粒度快照：恢复后 Notion 侧/邮件侧多出的增量会被正常对账链路补回，AI 分类/报告等派生数据按需重跑。

---

**一句话流程**：`main` 上 bump `frontend/package.json` version → 确认 `resources/python` 在 → `pnpm run build && npx electron-builder --dir --arm64` → 验签 + 验版本 → `ditto` 装 `/Applications` → `git tag vX.Y.Z`。
