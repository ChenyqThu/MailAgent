# Windows Outlook COM backend（`outlook_com`）

> **状态：代码完备待真机 PoC 验证**（task `08-12-win-mailagentwin-backend-eval`；go/no-go 闸门 = `scripts/poc_win/`，不过则按 prd §5 风险 1 止损）。
> 方案权威 = 该任务 prd；本文写「现在是什么」。COM 管线借鉴同事仓 MailAgentWin（owner 2026-08-13 确认授权无障碍），但按本仓协议 + 三态异常契约重写并补测。

## 1. backend 三值语义与平台矩阵

`MAILAGENT_BACKEND` 值域三值（`src/mail/backend/factory.py` 单点分支；`frontend/src/shared/lib/mailBackend.ts` 为前端单源镜像，有一致性闸）：

| 值 | 平台 | 邮件源 | 说明 |
|---|---|---|---|
| `applescript` | mac-only | Mail.app（AppleScript + Envelope Index） | emergency fallback |
| `davmail` | mac + win | DavMail IMAP/SMTP 桥 EWS | mac 生产主路径 |
| `outlook_com` | **win-only** | 本机 classic Outlook COM（pywin32） | factory 有 `sys.platform=='win32'` 闸（import 前拦，mac 上给清晰错误而非 ImportError 噪音）；零外部依赖（无 JVM/无桥进程/发信不需 SMTP 凭证） |

前端按平台过滤可选项：mac 不显示 `outlook_com`，win 不显示 `applescript`（onboarding 双卡 + AccountsTab SegmentedControl）。win + outlook_com 下**日历入口隐藏**（owner 拍板日历整体出范围）。

## 2. 架构（`src/mail/backend/` 四文件）

```
OutlookComBackend (outlook_com_backend.py)  — IMailBackend 17 方法 + backend_origin='outlook_com'
  └─ StaComExecutor / OutlookSession (com_client.py) — 单线程 STA 宿主
       所有 COM 调用一进门转发到专属工作线程 (per-thread CoInitialize)，对调用方透明；
       HRESULT 忙态白名单 (BUSY_HRESULTS) + 退避；死对象识别 → _reconnect 自愈；
       跨线程 COM 对象经 CoMarshalInterThreadInterfaceInStream 封送
  └─ ItemSnapshot → rebuild_rfc822 (outlook_mime.py) — MIME 重组（纯函数零 COM，mac 可单测）
  └─ FolderComReader (com_folder_reader.py) — 协议外写面等价物
```

- **marker = 收件箱 ReceivedTime 水位**（epoch 秒 int，单调）。🔴 三态契约：取不到 raise `MarkerUnavailableError`（绝不回 0——task 07-14 L3：0 会被持久化成 baseline 触发全量重刷）；枚举/快照/internal_id 分配失败 raise `FolderFetchError`（绝不 `return []` 吞错——2026-08-11 丢邮件事故契约，游标不得推进）；OK+空结果才返 `[]`。watcher 保 poll 形状零改动（案 A；`OnNewMailEx` 事件推送留 v2）。
- **internal_id 照抄 davmail 模式**：`sync_store.allocate_davmail_internal_id()` KV 原子自增（≥10^9，与 Mail.app ROWID 空间隔离），两 backend 共用同一序列。
- **EntryID 只当缓存不当锚**（v53 `email_metadata.entry_id` 列）：EntryID 在邮件移动后会变（MAPI 语义），稳定锚是 `message_id UNIQUE`；entry_id miss/失效时 Table API 按 `PR_INTERNET_MESSAGE_ID`（DASL 0x1035001F）反查 + 回写自愈——与 davmail imap_uid 双路设计同构（imap_uid 实测 32% 漂移，该模式已验证）。
- **MIME 重组**（P0 风险核心）：COM 没有可靠的「给我原始 MIME」API，而整条解析链（`EmailReader.parse_email_source` → 附件/.ics/线程/v4 SSoT）吃 RFC822 原文 → 本地重组。头策略 = 优先 `PR_TRANSPORT_MESSAGE_HEADERS` 原文（References/In-Reply-To 链全保留，thread_id 推导靠它）、剥结构性头、transport 头缺失（草稿/已发送常见）时从 item 属性合成；结构策略 = alternative/related(内联图 cid)/mixed 镜像常见 MUA 产物，.ics 附件恒 `text/calendar`（会议解析链依赖）。保真度由 mock 单测（`tests/mail/backend/test_outlook_mime.py`）+ 真机 PoC 双层闸。
- **写面**：协议 5 写方法（mark_read/set_flag ×2、append_draft、send_email）单行 COM 属性操作；`send_email` 走 `MailItem.Send()`（Outlook 自己的账户，reply 线程头自动接对）。协议外写面（归档/移动/删改草稿/文件夹 CRUD）= `FolderComReader`；`mail_write.py` 的 reader 获取已从 `isinstance(DavMailBackend)` 硬闸改为能力判定（davmail → `FolderImapReader`，outlook_com → `FolderComReader`）。
- `sent_folder` / `drafts_folder` 属性在 probe 时从默认文件夹探出（镜像 davmail，`mail_write` 的 `getattr` 消费点兼容）。

## 3. fail-soft 面清单（有意不实现，缺方法即自动不激活）

new_watcher 的 hasattr 门（既有纪律：「没判据就不许猜」）对缺失方法静默不激活，无需任何配置：

| 能力 | 缺席方法 | 为什么 v1 不做 | v2 路径 |
|---|---|---|---|
| 入向已读回收（issue #58，`MAILAGENT_INBOUND_READ_RECONCILE_ENABLED`） | `search_inbox_unseen` / `fetch_inbox_seen_flags` | 灰度功能默认关；COM 下实现反而更容易，不急 | `UnRead` 属性直读 / Table API 按 UnRead 列过滤 |
| 收件箱对账兜底（`MAILAGENT_INBOX_RECONCILE_ENABLED`） | `reconcile_inbox` | 同上 | `PR_INTERNET_MESSAGE_ID` 枚举 |
| 草稿箱同步（`DRAFTS_SYNC_ENABLED`） | `reconcile_drafts` | AppleScript 有 noop 先例；COM 首版聚焦主链路 | Drafts 文件夹 Table 对账 |
| 多文件夹同步（`SYNC_FOLDERS`）+ folder discovery | （imap_client 直连面） | v1 收件箱 + Sent 起步 | `Namespace.Folders` 递归枚举 |
| 日历 | — | **owner 拍板整体出范围**（win 前端隐藏日历入口） | 技术路径留档 task prd §2.2-7（`GlobalAppointmentID` + RecurrencePattern→RRULE 翻译） |
| davmail_watchdog / davmail_properties | — | 按 `backend_origin` 分支天然不跑 | 可选 COM 健康探针（Outlook.exe 存活 / RTT） |

`llm_agent/runner.py` 的 backend 注入防御判据已从 `== "davmail"` 修为「非 applescript」。

## 4. Windows 打包链要点（实验轨，artifact-only）

- **`frontend/scripts/build-python-venv.ps1`**：与 mac 的 `.sh` 并列（同 PBS_TAG/PYVER）；差异 = Windows PBS 布局（`python.exe` 顶层无 bin/）+ `python._pth` 控 sys.path + **pywin32 落位**（dll 拷贝 + 构建末尾 `import pythoncom` 自检）。
- **`requirements.lock.win.txt`**（仓根）：mac lock 含 uvloop（win 无 wheel）/pyobjc（mac-only）装不上 → 平台分叉 lock。**只能在 win 真机/CI 生成**：`ps1 -GenerateLock` 全新解析 + pip freeze 覆写 → 人工 review 后提交（CI 不回推 commit）。
- **`.github/workflows/build-win.yml`**：镜像 build-mac 结构；同一道 ci-test 测试闸（跑在 macos-14——闸代码质量不闸平台行为）；x64 NSIS 无 Authenticode 签名；`win.publish=null` 结构性关 feed → **产物只 artifact upload 不进 GitHub Release**，win 失败不阻塞 mac 发布。`workflow_dispatch` 的 `generate_lock=true` 模式只产 lock artifact 跳过打包。
- launcher 直 spawn `python.exe`（无 sh wrapper）；icon 暂用 `icons/512.png`（无 .ico）。

## 5. PoC 闸门与真机 checklist

- 闸门 harness = **`scripts/poc_win/`**（README 有运行顺序 + go/no-go 判据表 + 合并 17 项真机 checklist：MIME 7 + 打包 6 + 前端 4）。三脚本：环境探测 → **MIME 保真度（核心，crash==0 / parse≥99% / 常规字段保真≥98%）** → STA executor 冒烟。直接调用正式模块，非 win32 退出码 2；mac 侧 import 冒烟测试 `tests/scripts/test_poc_win_imports.py`。
- mock 覆盖不到的 7 个点原文 = `tests/mail/backend/test_outlook_mime.py` 尾部 `POC_CHECKLIST`。

## 6. 已知边界

- **classic Outlook 硬前提**：必须已安装、已登录、运行中（Dispatch 会拉起 Outlook.exe，但 MFA 交互登录后无人值守断链——锁屏/未登录场景不保证实时）。
- **New Outlook（olk.exe）无 COM 对象模型**：不可用，onboarding 硬检测。战略风险 = classic 退场时间表（微软推 New Outlook，经典版支持线 ~2029）——与 davmail/EWS 同构的「架在被退役技术上的桥」；**届时唯一替代 = Graph API 第四 backend**（协议缝保证是换 backend 不是重写）。
- **Programmatic Access 安全弹窗**：首次 COM 访问可能弹「有程序正尝试访问...」，无代码级绕过（用户点允许/企业 GPO 调档）；杀软状态异常会加剧弹窗。poc_3 读出当前档位。
- **EntryID 漂移语义**：移动文件夹即变——所以它是缓存不是锚（§2）；`Send()` 后草稿 EntryID 也会变（移入已发送）。
- 位数：out-of-process COM 跨位数可通（64 位 Python + 32 位 Outlook），poc_3 报告留档；大邮箱性能（OST 本地缓存 vs 在线模式）无实测数据，PoC/dogfood 观察项。
