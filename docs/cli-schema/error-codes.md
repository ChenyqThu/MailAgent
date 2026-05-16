# MailAgent CLI Error Codes (RFC v2 §5.2 / §7.0)

每条 CLI 错误的 `error.code` 必须落在下列 enum 中。新增 code 时同步更新本表
+ `src/cli/exceptions.py`。

| code | exit_code | 含义 | 触发场景 |
|---|---|---|---|
| `E_NOT_FOUND` | 1 | 资源不存在 | `email get <missing-id>` / `email body <no-body-id>` / `notion archive <missing-page>` |
| `E_INVALID_ARG` | 2 | 参数非法 / 互斥 / 范围超出 / PR-4 batch flag 在 PR-2 出现 | `--include foo` / `--limit -1` / `--source mail` (PR-3 才接) / `email resync --range ...` (PR-4 才接) |
| `E_AUTH_FAILED` | 4 | 写命令缺 API key 或 token 不匹配 | 非 dry-run 的 resync / delete / cleanup 且 `MAILAGENT_CLI_API_KEY` 未配 + `MAILAGENT_CLI_ALLOW_UNAUTH_WRITES` 未设 |
| `E_SCHEMA_MISMATCH` | 5 | DB schema 不一致 / `db_version != expected` | `admin db-version` 检到旧版本 / EmailRepository 读到不兼容 schema |
| `E_PARTIAL_FAILURE` | 6 | batch 命令部分成功部分失败 (PR-4 占位) | `email resync --range A-B` 实施后会用 |
| `E_ABORTED` | 7 | SIGINT / SIGTERM 主动退出 (PR-4 占位) | 用户 Ctrl-C 长任务 |
| `E_INTERNAL` | 1 | 意外异常 — 未匹配上述任何 code 的内部错误 | 兜底, 出现 stacktrace 时落到此 code |

**约定**：

1. `code` 一律 `E_*` 前缀, 全大写 + 下划线
2. `exit_code` 0 / 1 / 2 / 4 / 5 / 6 / 7 / 8 / 9 / 130 共 10 种 (含 PR-4 范围的 8 = max-failures, 9 = pm2 conflict, 130 = SIGINT 二次)
3. 错误 wrapper schema 见 `_common.schema.json#/$defs/wrapper_error`
4. PR-3 / PR-4 新加 code 时本表追加 + bump 相应 schema 文件
