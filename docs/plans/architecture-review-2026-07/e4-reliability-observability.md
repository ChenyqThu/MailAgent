# E4 — 可靠性与可观测性（worker 监督 / 阻塞 IO / 告警 / 用户诊断 / 瘦身 / 前端结构债)

> 所属：[架构 Review 2026-07](./README.md) 路线图 **Later** 阶段（3-6 月，按痛感排期，条目间无强依赖，可拆散机会主义地做）。

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
