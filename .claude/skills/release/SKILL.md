---
name: release
description: MailAgent 桌面 App 对外发布全流程（dogfood → bump → tag → CI → draft 转正 → 验证），内置嵌入 Python / better-sqlite3 ABI / build:web / torn-bundle 检查点。不可逆，仅手动触发。
user_invocable: true
disable-model-invocation: true
---

# /release — 桌面 App 对外发布

⚠️ **不可逆对外发布**：push tag 会触发 CI 构建并产出公开 GitHub Release。只在用户明确要发布时执行，每步先确认再做。
**版本号 SSoT = `frontend/package.json` 的 `version`，全程读实际值、绝不硬编码**（CLAUDE.md 正文里的版本号已知过时）。
建议先跑 `packaging-preflight` subagent 做预检。

## 1. 预检（拦住已知坑）

- 嵌入式后端在：`ls frontend/resources/python/bin/python3.11`（缺 → `bash frontend/scripts/build-python-venv.sh arm64`，否则 afterPack 跳过整个签名）
- better-sqlite3 是 Electron ABI：`cd frontend && ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron -e "require('better-sqlite3')"`（报错 → `cd frontend && pnpm rebuild:electron`；注意 `pnpm test` 会把它切回 node ABI）
- DB_VERSION 两侧一致：`src/mail/sync_store.py` 的 `DB_VERSION` == `frontend/src/electron/main/backend_lifecycle.ts` 的 `EXPECTED_DB_VERSION`
- 改过 Python 后端 → 先 `bash frontend/scripts/build-python-venv.sh arm64` 重 provision 才进包

## 2. 本地 dogfood 构建 + 装机验证

- 完整 feed（含 web SPA）：`cd frontend && pnpm build:mac`
- 或只装 .app（**必须手动补 build:web，否则远程 /app 返 404**）：`cd frontend && pnpm build:web && pnpm run build && npx electron-builder --dir --arm64`
- 每次 build 后验证：
  ```bash
  APP=frontend/dist/mac-arm64/MailAgent.app
  /usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$APP/Contents/Info.plist"   # == 期望版本
  codesign --verify --deep --strict "$APP" && echo OK                                         # 必须 OK
  ls "$APP/Contents/Resources/python/bin/python3.11"                                           # 后端在
  ```
- 装机（**三步串行单线，防 torn bundle**）：
  ```bash
  osascript -e 'quit app "MailAgent"'; sleep 4; \
  rm -rf /Applications/MailAgent.app; \
  ditto frontend/dist/mac-arm64/MailAgent.app /Applications/MailAgent.app; \
  open /Applications/MailAgent.app
  ```

## 3. bump 版本 → 提交 → 打 tag（触发 CI）

- 编辑 `frontend/package.json` 的 `version`（semver：patch=修复 / minor=功能）
- `git add -A && git commit -m "release: vX.Y.Z ..." && git push origin main`
- `git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z`  ← **这一步触发 CI 对外发布**

## 4. 盯 CI → draft 转正

- `gh run watch <run-id> --exit-status`（~3-4min；产物上传到一个 **draft** release）
- **CI 不会自动转正**，手动转：
  `gh release edit vX.Y.Z --draft=false --latest --title "MailAgent vX.Y.Z" --notes-file <notes>`

## 5. 发布后验证

- `gh api repos/ChenyqThu/MailAgent/releases/latest --jq .tag_name`  须 == `vX.Y.Z`

## 红线

- **不要**手动 `gh release create` / 上传产物 —— push tag 已触发 CI 传 draft，手动会撞车。
- 装机三步必串行单线，勿并发多个 ditto（torn bundle → dyld `libffmpeg.dylib` missing → SIGABRT，易误判成「启动崩溃 / DB 版本 bug」；修复：`rm -rf` + 单次 ditto 重装）。
- **勿改** `frontend/package.json` 的 `name`（`mailagent-frontend`，决定 userData 目录 `~/Library/Application Support/mailagent-frontend/`，改了已装用户数据 / `.env` 易主）。
- 本地 `pnpm build:mac` 仅 dogfood；CI 会从 tagged commit 重新构建发布字节。
