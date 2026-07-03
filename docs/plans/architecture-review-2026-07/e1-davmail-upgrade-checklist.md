# E1 — davmail 升级回归清单

> 所属：[架构 Review 2026-07 · E1 Backend 契约收口](./e1-backend-contract.md) §3.1 Step 4 派生文档。
> **触发条件：2026-08 起 watch davmail release；出新版走本清单。**
> 性质：运维 runbook，零功能改动；配合 `mailagent admin health` 输出的静态 watch note（`src/cli/commands/admin.py::HEALTH_WATCH_NOTES`）一起使用——健康检查提醒"该关注了"，本文档回答"关注到新版后具体怎么升、怎么验证不回归"。

## 1. 背景

EWS 2026-10-01 关停；应对 = 跟随 davmail 官方 repo 切换 O365 标准接口，项目侧零工程；2026-08 起关注 davmail release，出新版及时升级并按回归清单验证。

当前部署现状：

- pm2 进程 `davmail-poc`（JVM 桥），本机暴露 IMAP `127.0.0.1:1143` / SMTP `127.0.0.1:1025` / CalDAV `127.0.0.1:1080`。
- `davmail-poc/` 目录存在于仓库内但整体 gitignored：`jar/`（davmail JAR）、`config/`（配置）、`token/token.dat`（OAuth token，davmail 配置项 `davmail.oauth.tokenFilePath` 指向此处）。
- `MAILAGENT_BACKEND=davmail` 是当前生产默认（`src/config.py` 的 `mailagent_backend` 字段），AppleScript 是 emergency fallback，任何时候都可用。

更多运维背景（端口全貌、切换/回切命令、DavMailWatchdog 遥测字段）见 [`architecture-internals.md` Sprint 16 章节](../../reference/architecture/architecture-internals.md) 与 [`roadmap-post-cutover.md`](../../reference/architecture/roadmap-post-cutover.md)（只读参考；本清单的 EWS 应对口径以上方为准）。

## 2. 升级步骤

1. **备份 token.dat**（davmail 进程退出时可能把内存态 token 刷盘覆盖磁盘文件，必须先备份再动进程）：
   ```bash
   cp davmail-poc/token/token.dat davmail-poc/token/token.dat.bak-$(date +%Y%m%d%H%M%S)
   ```
2. **停止 davmail 进程**：
   ```bash
   pm2 stop davmail-poc
   ```
3. **核对 token.dat 未被覆盖**（停止前后 md5 对比，若被覆盖则从上一步备份恢复）：
   ```bash
   md5 davmail-poc/token/token.dat davmail-poc/token/token.dat.bak-<ts>
   ```
4. **替换 davmail JAR**：把新版本 JAR 放入 `davmail-poc/jar/`（覆盖旧文件，文件名/路径以现有 pm2 启动脚本引用的路径为准）。
5. **确认 token.dat 复用**：新版 davmail 通常兼容旧 token 文件格式，`davmail.oauth.tokenFilePath` 配置项若未变化则无需迁移，直接复用同一份 token.dat。若该版本 release note 提示 token 格式或 OAuth 流程有 breaking change，需重新走交互式 OAuth 认证（davmail O365Manual 模式，前台手动粘贴 callback URL）。
6. **重启进程**：
   ```bash
   pm2 start davmail-poc
   ```
7. **确认 OAuth 续期**：重启后 token.dat 的 mtime 应更新，代表 davmail 刷新写回、refresh token 在服务端仍然有效：
   ```bash
   ls -la davmail-poc/token/token.dat   # 观察 mtime 是否新于本次重启时间
   ```
8. 完成第 6-7 步后，逐项走下方「§3 回归清单」。

## 3. 回归清单

升级完成后逐项验证，全部打勾才算升级完成；任一项持续失败 → 参考 §4 回滚。

- [ ] **IMAP 收信**：新邮件能正常同步进 `email_metadata`。
  验证：观察 `logs/sync.log` 出现新邮件同步日志，或
  ```bash
  sqlite3 data/sync_store.db "SELECT COUNT(*) FROM email_metadata WHERE backend_origin='davmail' AND date_received > datetime('now', '-10 minutes');"
  ```

- [ ] **SMTP 发信**：能通过 davmail SMTP 正常发出邮件。
  验证：走真实 compose/reply 发送一封测试邮件，确认收件方收到；或用 `mailagent email draft <internal_id> --dry-run` 先确认草稿构造正常，再实际发送一封验证链路通畅。

- [ ] **CalDAV 日历同步**：`CalendarSyncWorker` 能正常拉取日历事件。
  验证：
  ```bash
  mailagent calendar sync-status -o json
  mailagent calendar today -o json
  ```
  期待 `sync-status` 无异常且 `calendar_event` 表有新鲜 `last_synced_at`。

- [ ] **OAuth token 续期**：重启后 token 刷新正常，无需人工干预即可持续工作。
  验证：`davmail-poc/token/token.dat` mtime 随刷新周期性更新；本机开发态可选调用 `GET /api/admin/davmail-health`（`src/api/routers/admin.py`，无 CLI 等价物，需带鉴权）确认 `last_oauth_error` 为空、`token_age_days` 从新值开始计（阈值：80 天 warning / 87 天 critical）。

- [ ] **`mailagent admin health` 全绿**：
  ```bash
  mailagent admin health -o json | jq .data.healthy
  ```
  期待 `true`；同时 `data.notes` 里的 davmail watch 提醒字样仍在（该字段是静态提示，不影响 `healthy` 判定，不代表异常）。

- [ ] **草稿箱同步**：Exchange Drafts 全量 UID 对账正常进 `email_metadata`（`mailbox='草稿箱'`）。
  验证：
  ```bash
  mailagent -o json email list --mailbox 草稿箱 --limit 5
  ```
  确认能正常列出且无报错；与 Outlook/OWA 草稿箱数量做人工核对。

- [ ] **IMAP/SMTP/CalDAV 端口连通性三件套**（最基础的桥连通性，前面几项失败时优先排查这层）：
  ```bash
  # IMAP
  python3 -c "import imaplib; imaplib.IMAP4('127.0.0.1', 1143)"
  # SMTP
  python3 -c "import smtplib; smtplib.SMTP('127.0.0.1', 1025)"
  # CalDAV（期待 HTTP 207 Multi-Status）
  curl -s -o /dev/null -w '%{http_code}\n' -X PROPFIND http://127.0.0.1:1080/
  ```

## 4. 回滚

若升级后回归清单任一项持续失败且短时间内无法定位为 davmail 侧已知问题：

1. 用旧版 JAR 覆盖回 `davmail-poc/jar/` + 用 §2 步骤 3 的备份覆盖回 token.dat + `pm2 restart davmail-poc`。
2. 若 davmail 桥短期内无法恢复、且需要保证邮件收发不中断，可临时切回 AppleScript emergency fallback（切换/回切命令 + marker reset 步骤见 [`architecture-internals.md`](../../reference/architecture/architecture-internals.md)，务必按文档步骤做，遗漏 marker reset 会导致数据丢失）。
3. 记录本次升级失败的现象（davmail 版本号、报错日志摘要），登记进本文档或对应 issue，供下次重试参考。
