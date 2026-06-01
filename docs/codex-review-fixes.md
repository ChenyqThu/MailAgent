# V2 后端收尾修复单 (codex gpt-5.5 review + Workflow ①B findings)

> 来源: codex SESSION 019e8157-aeb6-7741-aa85-ac536f532cec (security-review + code-review skills) + ①B verify。
> 按文件施工, 每个修复配/更新 pytest。代号: C=codex, A=Claude①B。

## auth.py (lane auth-security)
- **[C1 major] L85**: JWT 接受**无 `email` claim** 的 token(设 user_email=None)→ CF Access policy drift / service-token 路径可能仍过 L2。**fix**: 强制 claims 含 `email`(缺则 403); 并与配置的**单一 allowed email** 比对(用 settings.user_email, 或新增 MAILAGENT_API_ALLOWED_EMAIL), 不匹配 403。这是纵深防御 L2 的核心, 不能只信 CF L1 白名单。
- **[C2 major] L66**: `MAILAGENT_API_AUTH_DISABLED=true` 跳过所有 JWT 校验。**fix**: 该 flag 只允许 dev(检测无明确 dev 上下文时, 启动期 RuntimeError 拒绝启动); 且 auth-disable **不应**控制 CORS(CORS 归 app.py 独立 flag)。

## app.py (lane app-core)
- **[C3 major] L213**: loopback 保护用 `assert` → `python -O` 下被 strip, 防御消失。**fix**: 改显式 `if host not in ('127.0.0.1','localhost'): raise RuntimeError(...)`。
- **[A4] unset fail-closed**: MAILAGENT_API_HOST 未设时**不默认 127.0.0.1 放行**, 视为不可信触发 raise(或确保 serve_api 总设它且直启 uvicorn 路径也被挡)。
- **[C2] CORS 解耦复核**: ①B 称已拆 MAILAGENT_API_DEV_CORS 独立控 localhost origin; codex 仍标 auth-disable widen CORS → **复核确保** auth-disable 与 CORS 完全解耦, dev CORS 只由 MAILAGENT_API_DEV_CORS 控。
- **[A2/A3 minor] ERROR_CODE_TO_HTTP**: 加 `E_UPSTREAM:502` + `E_GENERIC:500` + `E_PARTIAL:207`(与 cli_runner EXIT_CODE_MAP 命名对齐, 消除 E_PARTIAL vs E_PARTIAL_FAILURE 漂移)。
- **[A1 major] partial_envelope helper**: 加 `partial_envelope(data)` → status:'partial_failure' + HTTP 207(schemas/envelope.py 已定形状), 供 email/admin 写端点用。

## cli_runner.py (lane cli-runner)
- **[C4 major] L411**: 非结构化 CLI `stderr` 原样作 `error.message` 返回 → crash/config 失败泄漏绝对路径/env/argv。**fix**: 原始 stdout/stderr **仅 server-side log**; 未解析到结构化 CLI wrapper 时返回 **sanitized 通用 message**(不含路径/argv/env)。

## attachment.py (lane attachment)
- **[C5 major] L166**: download 整文件 read_bytes 进内存再吐 → 大附件阻塞 event loop + OOM(与 pm2 --max-memory-restart 500M 冲突)。**fix**: 路径 guard 后用 `FileResponse` 或 `open(path,'rb')` chunk iterator 流式(配合 Range), 不全量读。

## admin.py (lane admin)
- **[C6 major] L161**: `GET /api/admin/stats` 实例化 `SyncStore`(构造函数 init/migrate 表)→ **读端点 mutate SQLite** + 与 mail-sync 争锁。**fix**: 改直接 read-only SQL(或 SyncStore(skip_init=True)/只读连接), 读端点绝不触发 migration。
- **[C9 minor] L125/L118**: health 返回绝对 `db_path` + error 回显 path → 泄漏 host 文件布局。**fix**: redact/相对路径, 或只返 bool/version 诊断。
- **[A1] cleanup-dead-letter** partial_failure → 207(用 app.py partial_envelope)。

## calendar.py (lane calendar)
- **[C7 major] L129**: 响应形状不匹配 types.ts CalendarApi。eventsList 期望**数组**(却返 `{events,total,window,filters}`); eventGet 期望 detail/null(返 `{event}`); syncStatus 期望**数组**(返 `{calendars,...}`)。**fix**: router data 形状对齐 types.ts 的返回类型(让前端 HttpApi 按 types.ts 写即匹配, 不需 remap)。**注意**: ② 的 HttpApi 也按 types.ts 写, 两端都向 types.ts 收敛即一致。

## email.py (lane email)
- **[A1 major] flag_email** partial_failure → 207(用 app.py partial_envelope)。
- **[C8 major] L646/680**: batch flag 契约。types.ts 允许 `flag(null,{ids})`, 但 route 要 `{internal_id}`, `ids:[]` 静默 fallback path id。**fix**: 加 `POST /api/email/flag` batch route(无 path id, body 含 ids[] + is_read/is_flagged) + **拒绝空 ids(400)**; 保留单封 `POST /api/email/{id}/flag`。

## email_views.py (lane email — 同 email lane 或独立)
- **[C10 minor] L588**: batch 端点(threads/snippets/ai-fields/internalIds)从 body 构 unbounded `IN (...)` SQL → huge list 撑爆 SQLite 变量限制/阻塞。**fix**: cap batch size(如 ≤500), 超限 400/413。

## 仅文档化 (不改码)
- **[A5]** `/api/email/search` 故意返 SearchResult **对象**(非 cli-schema 数组), 因 types.ts EmailApi.search 返 SearchResult。在 router docstring + 本 handoff 注明, 防未来 schema-conformance 测试误报。
- **[A6]** email.flag 的 `allowConcurrent` client field 服务端**恒忽略**(永远 --allow-concurrent, gotcha #9 安全选择), docstring 注明避免未来误接。
