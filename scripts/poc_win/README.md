# P0 PoC harness — Windows Outlook COM backend go/no-go 闸门

> task `08-12-win-mailagentwin-backend-eval` Phase 0（prd §3 P0 行 + §5 风险 1 + §6）。
> **PoC 直接调用 worktree 里的正式模块**（`src.mail.backend.outlook_mime` / `com_client` /
> `outlook_com_backend`），不做独立拷贝——验的就是要上线的代码。
> 三脚本非 win32 直接退出（exit 2），mac 侧有 import 冒烟测试
> `tests/scripts/test_poc_win_imports.py` 兜住「改了正式模块把 PoC 弄坏」。

## 三脚本与运行顺序

| 顺序 | 脚本 | 干什么 | 硬判定 |
|---|---|---|---|
| ① | `poc_3_environment.py` | 纯注册表/进程探测：classic Outlook 装没装（HKCR ProgID）、New Outlook（olk.exe）在不在跑、Programmatic Access 档位、Python/Outlook 位数、版本号。`--dispatch` 额外做一次真 COM Dispatch（可能触发弹窗——这本身是观察项） | 检出 classic ProgID = GO |
| ② | `poc_1_mime_fidelity.py` | **闸门核心**。取收件箱最近 N 封（`--count`，默认 50），逐封 `_snapshot_item` → `rebuild_rfc822` → `EmailReader.parse_email_source`，按封记录字段保真度 + 特殊类别计数 + loguru 兜底路径计数 | 见下方判据表 |
| ③ | `poc_2_sta_executor.py` | STA executor 冒烟：probe_readiness / 线程唯一性 / marker 水位合法性 / Restrict 窗口计数与延迟；`--reconnect` 交互演练手动重启 Outlook 后 `_reconnect` 自愈 | 步骤 1-4 全过 = GO（自愈是交互项只入报告） |

先跑 ③ 环境（没 classic Outlook 后面全免谈）→ ① 保真度（真闸门）→ ② executor。
每个脚本产 `scripts/poc_win/reports/<脚本名>_<时间戳>.json`；exit code：`0`=GO / `1`=NO-GO / `2`=非 win32 不适用。

## 前置

1. **classic Outlook** 已安装、已登录目标账户（New Outlook / olk.exe 无 COM 对象模型，不可用）。
2. worktree 的 Python 环境（win 侧二选一）：
   - 正式路径：`pwsh frontend/scripts/build-python-venv.ps1`（产 `frontend/resources/python`，含 pywin32 落位自检；lock 还是占位时先 `-GenerateLock`，见该脚本头注释）
   - 快速路径：任意 3.11 venv 里 `pip install -e ".[cli]" pywin32`
3. 首次 COM 访问可能弹「有程序正尝试访问...」——点允许并选最长时长；企业域可由 GPO 调整（poc_3 会把当前档位读出来）。

## go/no-go 判据表（poc_1，阈值同脚本头注释）

| 判据 | 阈值 | 不过的含义 |
|---|---|---|
| crash 数（重组/解析链未捕获异常） | == 0 | 管线有结构性 bug，先修再跑 |
| `parse_email_source` 成功率 | >= 99% | 重组产物过不了本仓解析链入口 |
| 常规邮件字段保真率（有 headers 且有 Message-ID 的封，subject/from/to/date/message_id/html/附件数/中文全过才算保真） | >= 98% | MIME 重组丢真，NO-GO |

**三条全过 = GO；任一不过 = NO-GO → 按 prd §5 风险 1 止损：评估 Redemption 或改判 Graph 路线。**
特殊类别（.ics / 内联图 cid 命中率 / 合成 Message-ID / 无 transport headers 占比 / Exchange DN
解析失败率 / OLE 附件跳过数 / compat32 兜底触发数）只入报告供人工评估，不进硬阈值——是 v1 已知降级面。

## 真机验证 checklist（合并三份，共 17 项）

### A. MIME 重组 7 项（`tests/mail/backend/test_outlook_mime.py` 尾部 `POC_CHECKLIST`，mock 覆盖不到）

| # | 项 | 自动化 |
|---|---|---|
| A1 | PR_TRANSPORT_MESSAGE_HEADERS 真实可达率（收件箱/草稿/已发送三类；草稿常缺 → 合成路径占比） | ✅ poc_1 `headers_missing` 计数 |
| A2 | HTMLBody 对非 UTF-8 原件（gb2312/big5）是否已归一 Unicode、无 mojibake | ✅ poc_1 CJK/U+FFFD 断言 |
| A3 | OLE 嵌入对象 SaveAsFile 行为与 PR_ATTACH_MIME_TAG 缺失率 | ✅ poc_1 raw vs extracted 附件差值 |
| A4 | 内联图 PR_ATTACH_CONTENT_ID 尖括号/大小写形态 → cid: 匹配命中率 | ✅ poc_1 cid 命中/未命中计数 |
| A5 | .ics 会议邀请成 AppointmentItem 时 MailItem 附件里是否还有 .ics（PR_ATTACH_METHOD 特判） | ❌ 人工（poc_1 结尾打印提示） |
| A6 | 真实 spam 超长头/坏头触发 compat32 兜底的频率 | ✅ poc_1 loguru 计数 |
| A7 | Exchange DN 发件人 GetExchangeUser 解析失败率（离职/外部联系人） | ✅ poc_1 `sender_unresolved` 计数 |

### B. 打包链 6 项（Wave1 打包 agent，`build-python-venv.ps1` / `build-win.yml` 首跑）

| # | 项 |
|---|---|
| B1 | `build-python-venv.ps1` 真机首跑全流程通过（PBS 下载/site-packages/pywin32 dll 落位 `import pythoncom` 自检）；通过后删脚本头「未经真机验证」警告行 |
| B2 | CI `build-win.yml` workflow_dispatch `generate_lock=true` 跑通，review artifact diff 后把 `requirements.lock.win.txt` 提交进仓 |
| B3 | `install-app-deps` 后 better-sqlite3/keytar 为 Electron ABI（win 侧等价 mac 的 dlopen 双向探针） |
| B4 | NSIS 安装包真机装/卸/升级三态正常（安装期进程占用等 NSIS 专属坑留意） |
| B5 | win.icon（`icons/512.png` 代 .ico）在任务栏/桌面/安装器渲染可接受，否则补 icon.ico |
| B6 | 退出 app 后无孤儿 `python.exe` / gateway 进程（Job Object / 父进程句柄语义） |

### C. 前端 4 项（Wave1 前端 agent，三值化产品面）

| # | 项 |
|---|---|
| C1 | win onboarding 双卡（outlook_com 主推 / davmail 进阶）渲染与流转正常，applescript 卡不出现 |
| C2 | `process.platform` 真值下平台过滤正确（mac 不见 outlook_com / win 不见 applescript），含 `mailBackend.ts` 单源判定 |
| C3 | 设置 → 账户 SegmentedControl 切 `MAILAGENT_BACKEND=outlook_com` 保存生效、重启后端后同步链路存活 |
| C4 | win + outlook_com 下日历入口不可见（拍板：日历整体出范围） |

## 判定后动作

- **GO** → 进 prd §6 Phase 1（BE1-BE3 已在分支，转入真机 dogfood + QA）；把本目录 reports/ 的 JSON 归档进任务目录。
- **NO-GO** → 1-2 天内止损：按 prd §5 风险 1 评估 Redemption（商业 license）或改判 Graph 第四 backend 路线。
