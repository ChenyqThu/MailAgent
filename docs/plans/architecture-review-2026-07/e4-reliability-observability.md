# E4 — 可靠性与可观测性（worker 监督 / 阻塞 IO / 告警 / 用户诊断 / 瘦身 / 前端结构债)

> 所属：[架构 Review 2026-07](./README.md) 路线图 **Later** 阶段（3-6 月，按痛感排期，条目间无强依赖，可拆散机会主义地做）。

## 落地状态（2026-07-11 第一批：§1+§2+§3 ✅）

task `07-11-e4-batch1-reliability-supervise-alerts-blocking-io`，commits `26b79707`（§1+§3）/ `6a3cc8d0`(§2) / `36ecc067`(顺带收口 E3 遗留 NOTION_READ 观察窗口)。全量 pytest 4161 passed 零排除（基线 4093+）。落地前现状核查对本方案的**勘误**：

- **§1**：写方案时 ~15 worker 已涨到 **17 个**（S4/S5 加 agent_trigger/agent_run）；且 15/17 已有 tick 级 try/except 自愈——supervise 真正的价值是防「**进入 while 循环之前**的启动态未捕获异常」（实证 3 处窗口：NewWatcher pre-loop / meeting_expansion last-run gate / calendar `_sync_window`）与「正常返回式自我放弃」（NewWatcher consecutive_errors≥5 路径）。落地 = `src/utils/supervise.py` + 17 task 全收编（uid_backfill one_shot）+ 心跳走 sync_state `worker.<name>.*`（跨进程唯一可行 pattern）→ `admin health` CLI/API 双面 `workers`+`davmail` 摘要。
- **§2**：`new_watcher.py` 阻塞 fetch 实为 **4 处**（:706/:1404/:1436/:1449，`self.arm` 已改名 `self.backend`）；且 `mailapp_fanout.py` 既有 to_thread 用默认多线程池 + concurrency=3 = 并发打无锁 backend，「单线程保序」此前只靠 loop 单线程的隐式副作用维持。落地 = `serial_executor.py`（max_workers=1 "backend-io"）统一收编 4 fetch + 2 fanout 写；uid_mapper 3 处裸 sqlite 包普通 to_thread；慢 fetch 注入测试（全仓首例）。
- **§3**：五项里**三项写方案时已落地**（davmail 进程死亡 / EWS throttling burst / token 老化——全在 `davmail_watchdog.py`，方案的"至今 ❌"过期）。真缺口只有两项，已补：outbox 积压（`get_stats()` age_buckets 行龄≥5min pending > `ALERT_OUTBOX_BACKLOG_THRESHOLD`=100，`_alert_check_loop` 检查）+ 重启频次（sync_state `service.start_history` 裁 48h，24h>5 告警 + stats `restarts` collector）。token 老化补了"未进 admin health"的暴露缺口。**顺带修真 bug**：`service.py:894` `send_alert(message=)` 签名不符，TypeError 被自身 except 吞掉 → davmail fetch 突增告警自 Sprint 16 起从未发出过。
- **登记不做**（本批明确豁免）：NewWatcher 内嵌第 18 个 `_flush_v4_rollout_stats_loop` 不收编（非关键路径、生命周期绑 watcher，factory 已显式 cancel 残留防僵尸双跑）；`davmail_watchdog` 50KB 日志读/stat 不 to_thread（量级可忽略）；sync_state worker 键无 TTL（flag 关掉的 worker 留 last-known 快照——§4 第二批前端呈现时结合 `last_started_at` 判 staleness）；watcher factory 复位逻辑无独立单测（start() 内闭包，supervise 本体已全测）；`alert.py` 两处预存 ruff（E741/F841，非本批 diff）。

**剩余**：§4 诊断通道（崩溃日志已部分修复：07-03 起 `.prev` 轮转一份，方案描述过期；剩滚动扩份数 + 诊断包导出）、§5 venv 瘦身 a+c、§6 前端结构债（types.ts 已 2665 行 / chat_db.ts 1760 行，继续长胖中）。

## 1. worker 级监督（serve 进程）

**现状**：`src/service.py:402-588` 单 asyncio loop 拉起 ~15 个 env-gated worker task；某 worker 在 tick 外抛未捕获异常 → task 静默死、该功能停摆，但进程不退 → PM2/BackendLifecycle 都不会重启（它们只看进程级存活）。

**方案**：统一 `supervise(coro_factory, name, *, backoff, max_crashloop)` 包装器——worker 挂 → 记日志 + （开启时）飞书告警 + 指数退避重启；连续 N 次进入 crash-loop 则停该 worker 并保持醒目告警（不拖垮进程）。给 `mailagent admin health` 加各 worker 心跳时间戳（`sync_state` 或内存注册表），health 能看出「进程活着但某 worker 死了」。

**验收**：单测——worker 抛异常后自动重启且 health 可见；kill 单个 worker 不影响其余。量级 ~2 天。

## 2. 事件循环阻塞 IO

**现状**：`src/mail/new_watcher.py:696` `_sync_single_email_v3`（async 方法）直调同步阻塞的 `self.arm.fetch_email_content_by_id`——davmail 模式是网络 IMAP fetch，一封慢邮件卡整个 loop（fanout / reverse / island 全在同 loop）。

**方案**：抓取段 `await asyncio.to_thread(...)` 包裹。**注意串行约束**：AppleScript 与单条 IMAP 连接都不是并发安全的——用单线程 executor（`ThreadPoolExecutor(max_workers=1)`）保序，而非放任默认线程池并发。顺带 grep 主循环其余同步调用点（Notion API 调用已是 async？逐个确认）列清单同批处理。

**验收**：慢 fetch 注入测试（mock 延迟 30s）下 fanout worker tick 不受阻。量级 ~1-2 天（盘点为主）。

## 3. 告警落地（roadmap §4.2/§4.5 欠账）

`docs/reference/architecture/roadmap-post-cutover.md §4.2` 列的五项至今 ❌，全部有现成落点（`src/notify/alert.py` 飞书告警 + `src/stats_reporter.py` 看板上报）：

| 告警 | 触发 | 落点 |
|---|---|---|
| davmail 进程死亡 | 60s `probe_tcp(127.0.0.1, 1143)` 失败 ≥3 | service.py 新 watchdog worker（复用 §1 supervise） |
| OAuth token 老化 | token.dat mtime > 80 天 | `admin health` 指标 + 每日 check |
| outbox 积压 | pending > 100 持续 5min | FanoutWorker tick 内自检 |
| EWS throttling burst | davmail 日志匹配 EWSThrottlingException ≥3/5min | log tail sidecar（低优） |
| mail-sync 重启频次 | >5/day | stats_reporter 维度 |

注意：打包 app 用户大多没配飞书 → 告警的**前端呈现**（下 §4 诊断面）比飞书更重要，两者共用同一事件源。量级 ~2-3 天。

## 4. 用户侧诊断通道（非开发者场景）

**现状**：`backend_lifecycle.ts:593` 后端 stdout/stderr 日志 `flags:'w'` 每次 spawn 截断（`:583` 注释说明是防交错的有意设计）——但 crash-loop 时只剩最后一次输出，import 期崩溃不进 loguru `sync.log`，历史现场丢失；`ALERT_ENABLED`/`STATS` 默认关；用户出问题只能靠开发者远程扒日志。

**方案**：
1. 崩溃日志滚动：`backend-process.log` 改按 spawn 编号/大小滚动保留最近 5 份（保持每次独立 stream 的防交错设计）。
2. 设置页「导出诊断包」：打 zip——logs/ 最近 N 天 + `admin health -o json` + 版本号 + DB quick_check 结果 + flag 快照（**脱敏**：过滤 token/key/邮箱地址）。
3. 应用内健康页（可选，后做）：把 §1 worker 心跳 + §3 告警事件流呈现在 Settings 里。

量级：1+2 约 2 天；3 另计。

## 5. 嵌入式 venv 瘦身（评估项）

**现状**：~425MB，其中 mem0 记忆栈（onnxruntime ~68M + faiss ~16M + numpy ~22M ≈ 100M+）恒随包分发（`frontend/scripts/build-python-venv.sh`，pyproject memory extra），与是否启用无关。

**方案（按序评估，不急）**：
- a. 审计先行：build-python-venv.sh 产出 `venv-manifest.txt`（包 × 体积 top20），进 repo 供每版对比——防「无声长胖」；
- b. memory 栈按需：首启后台下载或独立可选组件——**打包/签名/公证复杂度显著上升**，只有用户体感（下载时长/磁盘）成为真实抱怨时才做；
- c. 顺手项：provision 脚本清 `__pycache__`/tests/`.dist-info` RECORD 外冗余、strip so 调试符号，通常可省 10-15% 且零风险。

**先做 a + c，b 挂起**。量级 a+c ~1 天。

## 6. 前端结构债

1. **typed IPC 契约层**：118 个 channel 靠字符串约定 + `preload/index.ts` 18 行泛型透传，编译器抓不住 channel 名/参数漂移。方案：单一 `IpcContract` 类型表（channel → req/res 类型），main 注册与 renderer 调用都从表派生（`invoke<K extends keyof IpcContract>`）；增量迁移，新 channel 必须走表。~2-3 天。
2. **`shared/api/types.ts` 拆分**（2415 行 / 184 export，高频改动热点）：按域拆 `types/email.ts` / `types/chat.ts` / `types/settings.ts`…，原文件保留纯 re-export 兼容层（一次机械移动，不改 import 方）。~1 天。
3. **`electron/main/chat_db.ts` 拆分**（1599 行独扛 `ai_chat.db` 全部读写）：按表/关注点（sessions / messages / tool_calls / migrations）拆模块。~1 天。
4. **SSE 跨进程盲区**（设计项，先记录后决策）：serve-api 进程内执行的写操作，其 `safe_publish` 落在本进程 InProcessEventBus，而 SSE 订阅端在 serve 进程 → 无 Redis 的打包态该类事件丢失（`src/events/inprocess_bus.py` 模块注释自述 lossy 边界；前端有 invalidate/轮询兜底）。候选方案：serve-api 写完向 serve 进程发一条 loopback 通知 / SSE server 迁 serve-api / 正式化「乐观回显 + invalidate」为契约。**先在 inprocess_bus 文档注明现状已核实，等 #36 类症状再驱动选型**。

## 7. 优先级建议

痛感排序（出问题的概率 × 排查成本）：**§1 worker 监督 > §4 诊断通道 > §2 阻塞 IO > §3 告警 > §6.1 typed IPC > 其余**。§5/§6.2/§6.3 纯机会主义，顺手做。
