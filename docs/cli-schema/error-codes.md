# MailAgent CLI Error Codes (RFC v2 §5.2 / §7.0)

每条 CLI 错误的 `error.code` 必须落在下列 enum 中。新增 code 时同步更新本表
+ `src/cli/exceptions.py`。

| code | exit_code | 含义 | 触发场景 |
|---|---|---|---|
| `E_NOT_FOUND` | 1 | 资源不存在 | `email get <missing-id>` / `email body <no-body-id>` / `notion archive <missing-page>` |
| `E_INVALID_ARG` | 2 | 参数非法 / 互斥 / 范围超出 / PR-4 batch flag 在 PR-2 出现 | `--include foo` / `--limit -1` / `--source mail` (PR-3 才接) / `email resync --range ...` (PR-4 才接) |
| `E_AUTH_FAILED` | 4 | 写命令缺 API key 或 token 不匹配 | 非 dry-run 的 resync / delete / cleanup 且 `MAILAGENT_CLI_API_KEY` 未配 + `MAILAGENT_CLI_ALLOW_UNAUTH_WRITES` 未设 |
| `E_SCHEMA_MISMATCH` | 5 | DB schema 不一致 / `db_version != expected` | `admin db-version` 检到旧版本 / EmailRepository 读到不兼容 schema |
| `E_PARTIAL_FAILURE` | 6 | batch 命令部分成功部分失败 | `email resync --range A-B` succeeded + failed 同时非空 |
| `E_ABORTED` | 7 | SIGINT / SIGTERM 主动退出 | 用户 Ctrl-C 长任务 (第一次), 跑完 current unit 后退 |
| `E_MAX_FAILURES` | 8 | 长任务连续失败超 ``--max-failures`` 熔断 | batch resync / backfill 连续 N 次失败 |
| `E_PM2_RUNNING` | 9 | PM2 ``mail-sync`` 在跑, 写命令拒绝 | `email resync 53675` 时 pm2 jlist 返回 status=online |
| `E_INTERNAL` | 1 | 意外异常 — 未匹配上述任何 code 的内部错误 | 兜底, 出现 stacktrace 时落到此 code |
| `E_LLM_FAILED` | 1 | LLM gateway 调用失败 / 模型链耗尽 / Notion 写失败 | `llm run` runner 返回 ok=False (非 not-found 类) / 网关 5xx |
| `E_NOT_IMPLEMENTED` | 2 | 命令存在但当前 PR 仅 stub, 完整实现在后续 PR | 保留给后续尚未接通的 stub 命令 |

**PR-4 长任务 SIGINT 二次强退**: 进程退出码 130 (没对应 `E_*` code, 直接 `sys.exit(130)`)。

**约定**：

1. `code` 一律 `E_*` 前缀, 全大写 + 下划线
2. `exit_code` 0 / 1 / 2 / 4 / 5 / 6 / 7 / 8 / 9 / 130 共 10 种 (含 PR-4 范围的 8 = max-failures, 9 = pm2 conflict, 130 = SIGINT 二次)
3. 错误 wrapper schema 见 `_common.schema.json#/$defs/wrapper_error`
4. PR-3 / PR-4 新加 code 时本表追加 + bump 相应 schema 文件
