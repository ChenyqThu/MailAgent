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

## 7. 自动更新闸（为什么现在手动升级）

- 真·自动更新（electron-updater / Squirrel.Mac）要求 **Developer ID 签名 + 公证**；当前 ad-hoc 签名 `quitAndInstall` 会因签名不匹配**装不上更新**。
- 故 `AUTO_UPDATE_ENABLED` **默认关**，升级走 §6 手动替换。
- 启用路径（P6）：Apple Developer Program（$99/年）→ Developer ID Application 证书 → 改 `electron-builder.yml`（`identity` + `notarize:true` + CSC/APPLE_* 凭据）→ 翻 `AUTO_UPDATE_ENABLED` → `pnpm build:mac` 出 feed → 发 GitHub Release（`publish: github chenyqthu/MailAgent`）。两个**已签名**版本之间才自动更新（首签名版仍手动装）。
- 详见 [`docs/packaging/05-auto-update-handoff.md`](../packaging/05-auto-update-handoff.md) §3。

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

---

**一句话流程**：`main` 上 bump `frontend/package.json` version → 确认 `resources/python` 在 → `pnpm run build && npx electron-builder --dir --arm64` → 验签 + 验版本 → `ditto` 装 `/Applications` → `git tag vX.Y.Z`。
