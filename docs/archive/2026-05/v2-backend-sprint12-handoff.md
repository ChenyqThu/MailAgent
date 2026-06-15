# V2 远程访问 — 本地 FastAPI (mailagent-api) Sprint 1+2 交接

> Workflow ① 产出 (`src/api/` ~4500 行 + tests/api 51 passed)。本 doc = Sprint 1B 补全施工图 +
> Spec 13 gotchas 持久记录。设计依据 `frontend/REMOTE-ACCESS.md` §3/§6/§9 + `BACKEND-INTERFACES.md` §2.4。

## 0. 现状

- `src/api/`: app.py(286) / auth.py(77) / cli_runner.py(417, 通用 `async run_cli(args, *, api_key, timeout)`) / deps.py(62) / routers/{email,attachment,llm,admin}.py / schemas/{email,attachment,llm,admin,calendar,folder,ai,envelope}.py
- **已实现 14 端点**：email list/get/body/search/resync/update-flag · attachment list/download/inline · llm stats/run · admin health/stats/dead-letter
- pytest: `tests/api/` 51 passed (TestClient + 临时 SQLite fixture + dependency_overrides)
- 改动: `pyproject.toml`(加 fastapi/uvicorn[standard]/pyjwt[crypto]) + `src/cli/main.py`(serve-api 子命令, 硬编码 host=127.0.0.1)
- 依赖已装入 main venv: fastapi 0.115 / uvicorn 0.34 / pyjwt 2.13

## 1. Sprint 1B 必修 (blocker + major)

| # | 级别 | 文件 | 问题 | 修法 |
|---|---|---|---|---|
| F1 | **blocker** | app.py | loopback assertion 死代码：读 `os.environ['UVICORN_HOST']`(uvicorn 从不设此 env)→ 永远通过, 即使 bind 0.0.0.0。当前 serve_api 硬编码 127.0.0.1 实际安全, 但宣称的防御层失效 | serve_api() 在 uvicorn.run 前 `os.environ['MAILAGENT_API_HOST']=host`; app.py 改读该自有变量并断言 `in ('127.0.0.1','localhost')` |
| F2 | major | email.py | list query camelCase 漂移：只有 from→alias='from', 其余 is_read/is_flagged/has_notion/since/until 用 snake_case, 但前端契约是 isRead/isFlagged/hasNotion/sinceDate/untilDate → FastAPI 静默丢弃 → 过滤被无声忽略 | 补 camelCase alias: `Query(None, alias='isRead')` 等; fromAddr 对齐 |

## 2. Sprint 1B 端点补全矩阵 (28 端点)

> 状态 backfill=本 sprint 补; defer=记录后延。实现：repo=EmailRepository 直读; cli=cli_runner.run_cli; sqlite=直查表。

### email.py (lane email — 同文件所有改动归一个 lane)
| 方法 | HTTP | 实现 | 备注/gotcha |
|---|---|---|---|
| flag | POST /api/email/{id}/flag | cli `email flag {id} --is-read/--no-is-read --allow-concurrent`, batch `--ids` | **SSoT 主写**(outbox dual-target); slash 形, 区别 update-flag 的 tri-bool 字符串形 (#7); 永远 `--allow-concurrent` (#9) |
| archive | POST /api/email/{id}/archive | cli `email archive {id}` | davmail-only, 无 --allow-concurrent (#6 #9); 非 davmail → 400 |
| draft | POST /api/email/draft | cli `email draft … --body-html-file <tmp>` | bodyHtml 写 NamedTemporaryFile(.html) 传路径再清理 (#8) |
| send | POST /api/email/send | cli `email send … --body-html-file <tmp> --yes` | 同 #8; DraftPlanResult snake_case(reply_html/forward_intro_html) **勿 camelCase** (#8) |
| draftPlan | POST /api/email/{id}/draft-plan | cli | 返回 snake_case 原样 |
| pin | POST /api/email/{id}/pin | cli 或 repo | |
| listPinnedIds | GET /api/email/pinned-ids | repo `list_pinned_ids()` | |
| listEnriched | GET /api/email/list-enriched | repo join | enriched = email_metadata+email_body+llm_processing JOIN(snippet+AI chip)。移植 Electron handler SQL(grep frontend/src/electron/main/handlers 找 listEnriched/嵌 join) |
| listMailboxes | GET /api/email/mailboxes | sqlite `SELECT DISTINCT mailbox` | |
| listByThread | GET /api/email/thread/{thread_id} | repo `get_thread_members` | |
| listByThreads | POST /api/email/threads | repo 批量 | |
| listSnippets | POST /api/email/snippets | repo/sqlite 批量取 body snippet | 懒取, 输入 ids → {id: snippet} |
| aiFields | POST /api/email/ai-fields | sqlite join llm_processing | 输入 ids → {id: AILabels} |

### routers/calendar.py (lane cal-folder — 新建)
eventsList GET /api/calendar/events · eventGet GET /api/calendar/events/{event_id} · syncStatus GET /api/calendar/sync-status · calendarNames GET /api/calendar/names。实现 cli `mailagent calendar …` 或直查 calendar_event 表。READ only(写端点全 defer)。

### routers/folder.py (lane cal-folder — 新建)
list GET /api/folder/{folder}/list · get GET /api/folder/{folder}/{id} · search GET /api/folder/{folder}/search · syncStatus GET /api/folder/sync-status。**直查 folder_email/folder_email_fts 避开 davmail gate** (规格建议)。READ only(写端点全 defer)。

### routers/llm.py + admin.py + ai.py (lane backend-misc)
- llm.selftest GET /api/llm/selftest → cli `mailagent llm selftest` (read, 无 api_key); schema LlmSelfTestData 已备
- admin.deadLetterRetry POST /api/admin/dead-letter/{id}/retry (cli) · cleanupDeadLetter POST /api/admin/cleanup-dead-letter (cli) · davmailHealth GET /api/admin/davmail-health (sqlite 直读 `sync_state WHERE key LIKE 'davmail.%'`, meta.source=sqlite) · systemAlerts GET /api/admin/system-alerts (sqlite 直读)。schema DavMailHealthData/SystemAlertsData/DeadLetterRetryResult/CleanupDeadLetterResult 已备
- ai.getCached GET /api/ai/translation/{id} (repo translation cache 读) · deleteCached DELETE /api/ai/translation/{id} (cache 删)。schema ai.py 已备

## 3. defer (本 sprint 不做, 记录) — 前端 ② graceful degrade

- **ai.translateBatch**: 无 CLI, 是 Electron-main LLM 逻辑(html block 提取 + pLimit + LLM gateway)。服务端重写工作量大 → defer 到后续 V2 sprint。前端 HttpApi 保持 stub 或 graceful。
- **email.createDraft**(Mail.app AppleScript): web/davmail 用 email.draft 替代, 不实现。
- **enriched views 若 lane email 工作量超载**: listByThread(s)/listSnippets/aiFields 可降级为后续补; 但 listEnriched/listMailboxes **必须本 sprint**(收件箱主列表)。
- minor: search 缺 ai_priority/lang(repo 无 JOIN) · 大附件全量读内存(无 size 上限, §12 风险) · 这两个记录, 真机遇到再处理。

## 4. KEEP notImplemented stub (REMOTE-ACCESS §8 减法, 前端 ② 不接)
island/* · updater/* · notionAgent/* · services/* · env/* · prompts/* · settings 写(secretsStatus/setSecret/clear/set/pickFolder/testLlm/testCustomApi) · chat/*(SSE 延 V2.1) · calendar 写(eventCreate/Update/Delete/Rsvp/Replay/recurringDiscover/recurringReplay/expand) · folder 写(syncNow/deleteMsg/move/sendDraft/createDraft/editDraft)。settings.get 可选部分代理(非密: pollInterval/notionAgent binding/userEmail)。

## 5. Spec 13 GOTCHAS (实现时必看)

1. **local_path LEAK**: get_attachments() 返回 local_path(host 绝对路径), 从每个 wire response **剥离**, 永不暴露。
2. **无 single-attachment-meta-by-id**: get_attachment_bytes(att_id) 只给 bytes 不给 filename/content_type。download/inline 的 Content-Type+Disposition 要在 router 加小 SELECT(id,filename,content_type,internal_id), 勿猜 MIME。
3. **search total_indexed 无 helper**: 加 `SELECT count(*) FROM email_body_fts`; transformed_query/mode 经 smart_query_transform import 算。
4. **ENRICHED views 非 repo-backed**: listEnriched/listMailboxes/listByThread(s)/listSnippets/aiFields 是 Electron handler 的 SQL JOIN, 收件箱 UI 主力。FastAPI 要么 router 重实现 join(本 sprint 选这条), 要么前端降级。
5. **ai.translateBatch 无 CLI**: Electron-main-only LLM 逻辑, defer。getCached/deleteCached(表读)便宜可做。
6. **davmail-only writes**: email archive + 所有 folder 写 hard-require MAILAGENT_BACKEND=davmail(否则 E_INVALID_ARG)。prod 是 davmail OK, 但 400 干净 surface。
7. **email flag vs notion update-flag 不同 flag 约定**: flag 用 `--is-read/--no-is-read`(slash); update-flag 用 `--is-read true/false`(tri-bool 字符串)。cli_runner 映射按命令分支。灰度期都存在。
8. **body-html-file 模式**: compose draft/send 的 bodyHtml 走 **临时文件** `--body-html-file`, 非 inline。router 用 NamedTemporaryFile(.html) 写 TipTap HTML 传路径再清理。DraftPlanResult snake_case(reply_html/forward_intro_html) **勿 camelCase**(历史 bug)。
9. **--allow-concurrent**: email flag/resync 永远加(mail-sync 在线 → 否则 exit 9 E_PM2_RUNNING → 409)。email archive **无**此 flag(它不做 pm2 check)。
10. **MAILAGENT_CLI_API_KEY 仅后端**(§6.4 G3): subprocess --api-key 注入, 永不入 response/web bundle。
11. **Auth identity**: user_email 只从 verified JWT claims(verify_cf_access)取, 绝不信任 CF-Access-Authenticated-User-Email header(§6.3)。
12. **davmailHealth/systemAlerts 直读 sync_state davmail.\* 键**(无 CLI)。meta.source=sqlite(repo 读) / cli(subprocess)。
13. **WAL 并发**: EmailRepository 每调用开新连接(timeout=30)即关, 与 mail-sync writer 安全并存。API 进程**勿**持长写连接。

## 6. minor 修复 (lane framework 顺手做)
- app.py on_event('startup') 已 deprecate → 迁 lifespan(asynccontextmanager); 保留 `_assert_bind_loopback()` 协程不破测试。
- auth.py CF_AUDIENCE 无 fail-fast: AUTH_DISABLED=false 时启动 assert 非空, 缺失 RuntimeError 退出(避免漏配 → 全员静默 403)。
- schemas/envelope.py 死代码 ApiResponse(无 router 引用) vs app.py success_envelope/error_envelope(实际用)两套并行。决策：保留 app.py helper 为 SoT, 删 schemas/envelope.py 的 ApiResponse(或注释为纯类型文档)。
- app.py CORS dev-bypass 与 auth-disable 耦合在 MAILAGENT_API_AUTH_DISABLED: 拆 MAILAGENT_API_DEV_CORS(仅控 localhost origin) + flag 开启打显眼 WARNING。
