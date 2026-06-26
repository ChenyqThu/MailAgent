# PRD — 实时刷新修复：进程内 SSE 总线(Y) + 邮件同步按钮(X)

> 承接 `06-26-handoff-4b-sent-optimistic.md`。深挖后发现原 #4b「发件箱乐观回显」
> 只是症状，根因是**一体化 app 无 Redis 时整条 SSE 推送桥是死的**。本 PRD 覆盖根因修复。
> worktree `fix/dogfood-ux-feedback`（未合 main）。task：#10 epic / #11 Y / #12 X。

## 1. 根因（已用代码确认）

一体化桌面 app 由 BackendLifecycleManager spawn 两个独立 Python 进程，无 IPC，共享 SQLite：
- `serve`（src/service.py）：NewWatcher 主循环（`radar_poll_interval=5s`）+ `sse_server`（9200）
- `serve-api`（FastAPI :8200）：前端读写；自己**不能 ingest**（读走 EmailRepository，写走 subprocess 调 CLI）

发送一封邮件后的真实时间线：
```
t=0     serve-api SMTP 真发 → Exchange 服务端自动归档到 Sent
t≤5s    serve 进程 watcher tick 拉 Sent → 真实完整行(正文/FTS)已写进 SQLite ✅
        ↓ watcher safe_publish('email.synced')
        ↓ redis_url 空 → publisher.py 整个 noop ❌ 事件消失
        ↓ 前端 SSE(9200) 无 Redis → sse_server 返回 503 → sseState≠connected
t≤60s   前端 usePollingFallback 默认 60s 轮询到点 → invalidate ['emails'] → 才看到
```

**关键结论**：数据 ≤5s 就进了 SQLite，慢的唯一原因是**没有信号通知前端 refetch**。
这不是发件箱特有问题——**新收邮件 / LLM 结果 / 所有 watcher 侧异步更新**在一体化 app 里
都不会自动刷新，全靠 60s 兜底。memory #4 旗标能过 dogfood 是因为它走**前端乐观更新**，
没真正依赖 SSE 回推。

handoff 的 in-process ingest 方向（变体 A/B/C）被证伪：无需在 serve-api 复刻 watcher、
碰真实 Sent 数据、处理 `sent_folder_uid`（默认 None，因 `davmail_archive_sent=False`）。

## 2. Redis 用途审计（全仓）

| 真实用途 | 代码 | 一体化 app | 远程 web / webhook-server |
|---|---|---|---|
| SSE 实时推送 | `publisher.py`→Redis chan；`sse_server.py` 订阅 | ❌ 可进程内化(=Y) | ✅ CF tunnel 9200 |
| Notion webhook 反向 | `redis_consumer.py` BLPOP `mailagent:{db}:events` | ❌ 默认关(REDIS_EVENTS_ENABLED=false)+B1退役 | ✅ webhook-server |
| 其余 5 文件 | email_repository/sync_store/kos 是搜索示例文本"redis timeout"；alert 是断连告警文案；settings 是配置项暴露 | — 全是误匹配 | — |

**结论**：Redis 对一体化 app 核心功能（收发/同步/SQLite SSoT/搜索/LLM）完全不必需。
- 不物理删除（远程 web + webhook-server 仍用）
- 不嵌入 app（做了 Y 就不需要；redis-server 嵌入增重+签名复杂）
- 降级为**可选增强**：`redis_url` 空→进程内总线；非空→维持 Redis（旧用户/远程零影响）

## 3. 目标（可验证）

- **Y**：无 Redis 下，watcher ingest 完成后前端 ≤(5s tick + Exchange 归档延迟) 自动刷新。
  验证：①send 后发件箱自动出现 ②外部发一封新邮件，收件箱自动出现（都不点任何按钮、不等 60s）。
- **Y 兼容**：`redis_url` 在场时行为与现状**字节级一致**（远程 web SSE 不回退）。
- **X**：工具栏「收发/同步」按钮点击 → 触发一次同步 + 列表刷新；send 成功后自动调一次。

## 4. 方案 Z = Y（修根因）+ X（同步按钮）

### Y — 进程内 SSE 事件总线（task #11）
`publisher.py` + `sse_server.py` 增加非 Redis 的进程内 pub/sub 分支。`safe_publish` 在
`redis_url` 空时投递进程内总线 → `sse_server` fanout 到本地 SSE 客户端。
- 进程内总线只连通**同进程**(serve) 的 publisher→sse_server。watcher 也在 serve 进程，
  其异步更新（发件箱/新邮件/LLM/会议）全覆盖 = 用户感知最强的被动刷新。
- serve-api 进程的 safe_publish 进程内到不了 serve（接受不覆盖，有前端乐观 + X 兜底）。

**技术设计（architect 复核确认，2026-06-26）**：

- **同 loop 验证**：`run_service()` 是单个 `asyncio.run`，watcher（`create_task(watcher.start())`,
  service.py:401）+ `start_sse_server`（await,:518）跑在**同一 event loop** → watcher 的
  `safe_publish` 与 SSE handler 同 loop（命门设计的地基）。
- **新建 `src/events/inprocess_bus.py`**（~80 行）：模块单例 `InProcessEventBus`，
  per-subscriber `asyncio.Queue(maxsize=1000)` fanout。`bind_loop(loop)` 启动时捕获 serve loop；
  `subscribe()/unsubscribe()`；`publish(frame)` 同步，走 `loop.call_soon_threadsafe(_fanout, frame)`；
  `_fanout` 在 loop 上 `put_nowait`，QueueFull→drop+warn（事件是 invalidation hint，丢了下次/60s poll 补）。
- **命门（sync→async 安全投递）**：`publish` 统一走 `call_soon_threadsafe`（**不裸 put_nowait**，
  因 `asyncio.Queue` 非线程安全；同 loop 近 noop、跨线程/无 loop 也安全）。4 边界全处理：
  loop 未 bind→drop；非 loop 线程→OK；serve-api 进程→`bus._loop=None`→no-op（X 兜底）；loop closed→swallow。
- **either/or（非 dual-fanout）**：`redis_url` 非空→Redis only（今天的码，**字节级不变**）；
  空→进程内 only。在 `safe_publish` 处分支（已验证 14 个 call sites 全走 safe_publish）。
  抽 `_build_payload` 单源化 JSON schema。**绝不双投递**（dual-fanout 会让 Redis 部署收到双份事件）。
- **sse_server**：`start_sse_server` 在 `runner.setup()` 后 `bind_loop`；`_stream_events` 把
  `redis_url 空→503` 分支换成 `bus.subscribe()` + `await asyncio.wait_for(q.get(), HEARTBEAT)` 循环
  （复用现有 heartbeat/cleanup 骨架），`finally: unsubscribe`。
- **events_bridge.ts 零改（亮点）**：它 Redis-agnostic，今天无 Redis 拿 503→永久重连→落 polling；
  改造后同一 endpoint 返 200+frames→自动 `connected`。前端 TS 一行不动。
- **无新 flag**：`redis_url` 空/非空即开关；`mailagent_sse_enabled` 仍是应急 kill switch（回切落 polling）。
- **改动文件**：新建 `inprocess_bus.py`；改 `publisher.py`（`_build_payload` + `safe_publish` 分支）；
  改 `sse_server.py`（`bind_loop` + `_stream_events` 分支）；`service.py` 无功能改动；测试 3 文件。
- **TDD checklist**：bus 跨线程投递(load-bearing)/同loop/未bind/QueueFull/loop closed；
  `safe_publish` redis 空→bus、非空→Redis(**回归 guard**)；SSE 无 redis 返 **200**(曾 503)+收 frame+
  heartbeat+多客户端+断连清理+auth 先于 transport。全用 `wait_for` 不用 sleep，零 flaky。

### X — 邮件同步按钮 + sync-now（task #12）
- 前端工具栏「收发/同步」按钮（对齐 Outlook/Foxmail 心智）
- → serve-api `POST /api/email/sync-now`（对齐 `calendar sync-now` + serve-api 写操作
  subprocess 调 CLI 先例：新增 `mailagent email sync-now`，进程内跑一轮 ingest，完成才返回）
- → 前端 invalidate `['emails']` refetch
- send 成功后自动调一次（用户无感）
- 互补 Y：补 serve-api 进程主动触发 + 用户手动控制 + SSE 万一断的兜底

## 5. 不做 / 边界
- 不碰 watcher 的真实 Sent ingest 逻辑（已正确）。
- 不动 `redis_url` 在场时的远程 web 路径（字节级不变）。
- 不把 redis-server 嵌入 app。
- Y 不覆盖 serve-api 进程自身写事件的 SSE（前端乐观 + X 兜底）。

## 6. 风险与纪律
- **Y 动 SSE 核心**：远程 web（有 Redis）路径必须字节级不变 → 进程内总线仅 redis 缺席时启用。
- **loop 边界**：`safe_publish` 是同步函数，SSE handler 是 async 协程；跨边界投递的正确性是命门
  （architect 复核）。
- **X 并发**：sync-now CLI 与 serve watcher 并发写 SQLite（WAL 单 writer + merge guard 去重）
  + subprocess 冷启动 1-3s（主动行为可接受）。
- **TDD**（碰实时链路，先写测）：
  - Y：进程内 sync publish→async subscriber 收到；sse_server 多源订阅；redis 在场字节级回退。
  - X：sync-now CLI 测 + 接口测 + 前端按钮。
- 跑 `venv/bin/python -m pytest tests/agent_eval -q` 不受影响（非 chat agent 改）。
- worktree 跑 Python 测试：main venv + `PYTHONPATH=<worktree>` + cwd=worktree。

## 7. 做完后
codex gpt-5.5 xhigh review（`collaborating-with-codex`）→ 合整个 `fix/dogfood-ux-feedback` 入 main。
