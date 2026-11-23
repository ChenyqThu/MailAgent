"""External credentials, connectors, and connector tool storage operations for AgentConfigStore."""

from __future__ import annotations

import json
import sqlite3
from typing import Any, Optional

from src.agent_config.store_common import (
    ConnectorRow,
    ConnectorToolRow,
    ExternalCredentialMeta,
    _UNSET,
    _json_object_or_none,
    _now,
    _row_to_connector,
    _row_to_connector_tool,
    _row_to_external_credential_meta,
)


def _connector_consts():
    from src.agent_config import store as m

    return m


class AgentConfigConnectorsMixin:
    def upsert_external_credential(
        self,
        namespace: str,
        credential_key: str,
        payload_ciphertext: bytes,
        *,
        expires_at: Optional[int] = None,
        metadata_json: Optional[str] = None,
    ) -> None:
        """写/替换一条外部凭证（``payload_ciphertext`` = Fernet ciphertext，本层不解密）。

        **整行替换语义**：``expires_at`` / ``metadata_json`` 不传即写 NULL（一次 token 刷新是
        payload 与到期时间**一起**换掉，留旧到期时间 = 谎报健康状态）。``created_at`` 是唯一例外
        —— 冲突时保留首次落库时间（镜像 ``install_skill`` 保 ``installed_at``）。
        键/形状合法性由调用方（``credentials.set_credential``）校验，本层只落盘。
        """
        now = _now()
        with self._connection() as conn:
            conn.execute(
                "INSERT INTO external_credential "
                "(namespace, credential_key, payload_ciphertext, expires_at, metadata_json, "
                " created_at, updated_at) VALUES (?,?,?,?,?,?,?) "
                "ON CONFLICT(namespace, credential_key) DO UPDATE SET "
                " payload_ciphertext=excluded.payload_ciphertext, expires_at=excluded.expires_at, "
                " metadata_json=excluded.metadata_json, updated_at=excluded.updated_at",
                (
                    namespace,
                    credential_key,
                    sqlite3.Binary(payload_ciphertext),
                    expires_at,
                    metadata_json,
                    now,
                    now,
                ),
            )
            conn.commit()

    def get_external_credential_ciphertext(
        self, namespace: str, credential_key: str
    ) -> Optional[bytes]:
        """取一条外部凭证的密文（无 → None）。解密归 ``credentials.get_credential``。"""
        with self._connection() as conn:
            row = conn.execute(
                "SELECT payload_ciphertext FROM external_credential "
                "WHERE namespace = ? AND credential_key = ?",
                (namespace, credential_key),
            ).fetchone()
        return bytes(row["payload_ciphertext"]) if row else None

    def get_external_credential_meta(
        self, namespace: str, credential_key: str
    ) -> Optional[ExternalCredentialMeta]:
        """取一条外部凭证的**明文元数据**（含 expires_at）—— 不读密文列、不解密。"""
        with self._connection() as conn:
            row = conn.execute(
                "SELECT namespace, credential_key, expires_at, metadata_json, created_at, "
                " updated_at FROM external_credential WHERE namespace = ? AND credential_key = ?",
                (namespace, credential_key),
            ).fetchone()
        return _row_to_external_credential_meta(row) if row else None

    def list_external_credential_meta(
        self, namespace: Optional[str] = None
    ) -> list[ExternalCredentialMeta]:
        """列外部凭证的明文元数据（``namespace`` 有值 = 严格等值过滤；None = 全部）。

        不读密文列、不解密（设置页「已连接的服务」清单用）。PK 前缀即 namespace，故等值过滤走
        主键索引，无需额外 index。
        """
        sql = (
            "SELECT namespace, credential_key, expires_at, metadata_json, created_at, updated_at "
            "FROM external_credential"
        )
        params: list[Any] = []
        if namespace is not None:
            sql += " WHERE namespace = ?"
            params.append(namespace)
        sql += " ORDER BY namespace, credential_key"
        with self._connection() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [_row_to_external_credential_meta(r) for r in rows]

    def delete_external_credential(self, namespace: str, credential_key: str) -> bool:
        """删一条外部凭证。幂等（无行 False）。"""
        with self._connection() as conn:
            cur = conn.execute(
                "DELETE FROM external_credential WHERE namespace = ? AND credential_key = ?",
                (namespace, credential_key),
            )
            conn.commit()
        return cur.rowcount > 0

    # ======================================================================
    # MCP connector 双表（08-01 阶段 1 PR1）
    # —— 凭证在 external_credential（credentials.py），这里只管连接元数据 + 工具清单
    # ======================================================================

    def upsert_connector(
        self,
        connector_id: str,
        *,
        server_url: str,
        display_name: Optional[str] = None,
        transport: str = "streamable_http",
        source: Optional[str] = None,
        composio_session_id: Any = _UNSET,
        runtime_config: Any = _UNSET,
    ) -> None:
        """建/刷 connector 行的**静态定义**字段。冲突时只更新 server_url/display_name/
        transport/updated_at（+ 显式传了的 source / composio_session_id / runtime_config）——
        status/enabled/scopes 等运行态一律不动（另走 ``update_connector_state``）。

        ``source``（08-05 WP-12）：``None`` = 不动（建行时吃 DDL 默认 ``custom_mcp``）。
        ``composio_session_id`` 与 ``runtime_config`` 用哨兵区分「不动」与「显式清空 None」。
        """
        if not connector_id or not isinstance(connector_id, str):
            raise ValueError("connector_id must be a non-empty string")
        if source is not None and source not in _connector_consts().CONNECTOR_SOURCES:
            raise ValueError(f"connector source {source!r} not in {_connector_consts().CONNECTOR_SOURCES}")
        if (
            runtime_config is not _UNSET
            and runtime_config is not None
            and not isinstance(runtime_config, dict)
        ):
            raise ValueError("connector runtime_config must be a dict or None")
        rc_json = (
            None
            if runtime_config is _UNSET or runtime_config is None
            else json.dumps(runtime_config, ensure_ascii=False)
        )
        now = _now()
        with self._connection() as conn:
            conn.execute(
                "INSERT INTO connector (connector_id, server_url, transport, display_name,"
                " source, composio_session_id, runtime_config_json, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(connector_id) DO UPDATE SET server_url=excluded.server_url,"
                " transport=excluded.transport, display_name=excluded.display_name,"
                " updated_at=excluded.updated_at",
                (
                    connector_id,
                    server_url,
                    transport,
                    display_name,
                    source or "custom_mcp",
                    None if composio_session_id is _UNSET else composio_session_id,
                    rc_json,
                    now,
                    now,
                ),
            )
            sets: list[str] = []
            params: list[Any] = []
            if source is not None:
                sets.append("source=?")
                params.append(source)
            if composio_session_id is not _UNSET:
                sets.append("composio_session_id=?")
                params.append(composio_session_id)
            if runtime_config is not _UNSET:
                sets.append("runtime_config_json=?")
                params.append(rc_json)
            if sets:
                params.append(connector_id)
                conn.execute(
                    f"UPDATE connector SET {', '.join(sets)} WHERE connector_id=?", params
                )
            conn.commit()

    def upsert_custom_connector(
        self,
        connector_id: str,
        *,
        display_name: str,
        transport: str = "streamable_http",
        server_url: str = "",
        custom_headers: Optional[dict[str, str]] = None,
        replace_headers: bool = False,
        stdio_command: Optional[dict[str, Any]] = None,
        stdio_env: Optional[dict[str, str]] = None,
        replace_env: bool = False,
    ) -> ConnectorRow:
        """创建或更新自定义 MCP connector（HTTP 静态 header 或本机 stdio 进程）。

        - 静态 headers 与 stdio env 用 ``secrets.encrypt_secret``（Fernet）加密存 BLOB；
          键名单独存明文 JSON 列，列表接口零解密开销、密文永不出 wire。
        - 更新模式（行已存在）且未传新 headers / env（replace=False）时保留既有密文。
        """
        if not connector_id or not isinstance(connector_id, str):
            raise ValueError("connector_id must be a non-empty string")
        if transport not in _connector_consts().CONNECTOR_TRANSPORTS:
            raise ValueError(f"transport must be one of {_connector_consts().CONNECTOR_TRANSPORTS}")
        from src.agent_config.secrets import encrypt_secret

        now = _now()
        with self._connection() as conn:
            existing = conn.execute(
                "SELECT * FROM connector WHERE connector_id = ?", (connector_id,)
            ).fetchone()

            if custom_headers is not None or replace_headers:
                clean_headers = {
                    str(k).strip(): str(v)
                    for k, v in (custom_headers or {}).items()
                    if str(k).strip()
                }
                header_names_json: Optional[str] = (
                    json.dumps(sorted(clean_headers.keys()), ensure_ascii=False)
                    if clean_headers
                    else None
                )
                headers_cipher: Optional[bytes] = (
                    encrypt_secret(json.dumps(clean_headers, ensure_ascii=False))
                    if clean_headers
                    else None
                )
            elif existing is not None:
                header_names_json = existing["custom_header_names_json"]
                headers_cipher = existing["custom_headers_cipher"]
            else:
                header_names_json = None
                headers_cipher = None

            if stdio_env is not None or replace_env:
                clean_env = {
                    str(k).strip(): str(v)
                    for k, v in (stdio_env or {}).items()
                    if str(k).strip()
                }
                env_keys = sorted(clean_env.keys())
                env_cipher: Optional[bytes] = (
                    encrypt_secret(json.dumps(clean_env, ensure_ascii=False))
                    if clean_env
                    else None
                )
            elif existing is not None:
                env_cipher = existing["stdio_env_cipher"]
                existing_cmd = (
                    _json_object_or_none(existing["stdio_command_json"]) or {}
                )
                raw_keys = existing_cmd.get("env_keys") or []
                env_keys = [str(k) for k in raw_keys if isinstance(k, str)]
            else:
                env_cipher = None
                env_keys = []

            if stdio_command is not None:
                cmd_payload: Optional[dict[str, Any]] = {
                    "command": str(stdio_command.get("command") or "").strip(),
                    "args": [str(a) for a in (stdio_command.get("args") or [])],
                    "cwd": (
                        str(stdio_command["cwd"]).strip()
                        if stdio_command.get("cwd")
                        else None
                    ),
                    "env_keys": env_keys,
                }
                cmd_json: Optional[str] = json.dumps(cmd_payload, ensure_ascii=False)
            elif existing is not None and transport == "stdio":
                existing_cmd = (
                    _json_object_or_none(existing["stdio_command_json"]) or {}
                )
                existing_cmd["env_keys"] = env_keys
                cmd_json = json.dumps(existing_cmd, ensure_ascii=False)
            elif transport in ("streamable_http", "sse"):
                cmd_json = None
                env_cipher = None
            else:
                cmd_json = None

            conn.execute(
                "INSERT INTO connector ("
                " connector_id, server_url, transport, display_name, status, enabled,"
                " source, custom_header_names_json, custom_headers_cipher,"
                " stdio_command_json, stdio_env_cipher, created_at, updated_at"
                ") VALUES (?,?,?,?, 'connected', 1, 'custom_mcp', ?,?,?,?,?,?) "
                "ON CONFLICT(connector_id) DO UPDATE SET "
                " server_url=excluded.server_url,"
                " transport=excluded.transport,"
                " display_name=excluded.display_name,"
                " status='connected',"
                " last_error=NULL,"
                " source='custom_mcp',"
                " custom_header_names_json=excluded.custom_header_names_json,"
                " custom_headers_cipher=excluded.custom_headers_cipher,"
                " stdio_command_json=excluded.stdio_command_json,"
                " stdio_env_cipher=excluded.stdio_env_cipher,"
                " updated_at=excluded.updated_at",
                (
                    connector_id,
                    server_url,
                    transport,
                    display_name,
                    header_names_json,
                    headers_cipher,
                    cmd_json,
                    env_cipher,
                    now,
                    now,
                ),
            )
            conn.commit()
        row = self.get_connector(connector_id)
        assert row is not None
        return row

    def get_connector_custom_secrets(
        self, connector_id: str
    ) -> tuple[dict[str, str], dict[str, str]]:
        """按需解密一个自定义 connector 的静态 headers 与 stdio env。"""
        from src.agent_config.secrets import decrypt_secret

        with self._connection() as conn:
            row = conn.execute(
                "SELECT custom_headers_cipher, stdio_env_cipher FROM connector "
                "WHERE connector_id = ?",
                (connector_id,),
            ).fetchone()
        if row is None:
            return {}, {}

        def _decode(cipher: Any) -> dict[str, str]:
            if not cipher:
                return {}
            try:
                raw = decrypt_secret(bytes(cipher))
                obj = json.loads(raw)
                if isinstance(obj, dict):
                    return {str(k): str(v) for k, v in obj.items() if str(k)}
            except Exception:  # noqa: BLE001 — 绝不泄露密文/异常细节
                pass
            return {}

        return _decode(row["custom_headers_cipher"]), _decode(row["stdio_env_cipher"])

    def delete_connector(self, connector_id: str) -> bool:
        """整行移除（08-05 WP-12「断开并清除配置」）：connector 行 + 它的全部工具行。

        🔴 与 ``disconnect``（只删凭证、保留配置）分工明确：这条是 owner **显式**要求的
        「当它没存在过」——预置目录切换（旧直连行退场）与彻底卸载都走它。凭证不在本表，
        由调用方（router）按 namespace 逐条删干净后再调本方法。幂等（无行 → False）。
        """
        with self._connection() as conn:
            conn.execute("DELETE FROM connector_tool WHERE connector_id=?", (connector_id,))
            cur = conn.execute("DELETE FROM connector WHERE connector_id=?", (connector_id,))
            conn.commit()
        return cur.rowcount > 0

    def update_connector_state(
        self,
        connector_id: str,
        *,
        status: Optional[str] = None,
        last_error: Any = _UNSET,
        scopes: Any = _UNSET,
        last_synced_at: Optional[int] = None,
        enabled: Optional[bool] = None,
    ) -> None:
        """部分更新运行态列。``last_error`` / ``scopes`` 用哨兵区分「不动」与「显式清空 None」。
        坏 status **入库时拒**（ValueError），不靠读侧宽容。"""
        sets: list[str] = []
        params: list[Any] = []
        if status is not None:
            if status not in _connector_consts().CONNECTOR_STATUSES:
                raise ValueError(
                    f"connector status {status!r} not in {_connector_consts().CONNECTOR_STATUSES}"
                )
            sets.append("status=?")
            params.append(status)
        if last_error is not _UNSET:
            sets.append("last_error=?")
            params.append(last_error)
        if scopes is not _UNSET:
            if scopes is not None and not (
                isinstance(scopes, list) and all(isinstance(s, str) for s in scopes)
            ):
                raise ValueError("connector scopes must be a list[str] or None")
            sets.append("scopes_json=?")
            params.append(json.dumps(scopes, ensure_ascii=False) if scopes is not None else None)
        if last_synced_at is not None:
            sets.append("last_synced_at=?")
            params.append(int(last_synced_at))
        if enabled is not None:
            sets.append("enabled=?")
            params.append(1 if enabled else 0)
        if not sets:
            return
        sets.append("updated_at=?")
        params.append(_now())
        params.append(connector_id)
        with self._connection() as conn:
            cur = conn.execute(
                f"UPDATE connector SET {', '.join(sets)} WHERE connector_id=?", params
            )
            conn.commit()
        if cur.rowcount == 0:
            raise KeyError(f"connector not found: {connector_id}")

    def update_connector_runtime_config(
        self,
        connector_id: str,
        runtime_config: Optional[dict[str, Any]],
    ) -> ConnectorRow:
        """更新受管连接器运行选项（``runtime_config_json``），返回最新行。"""
        if runtime_config is not None and not isinstance(runtime_config, dict):
            raise ValueError("connector runtime_config must be a dict or None")
        rc_json = (
            json.dumps(runtime_config, ensure_ascii=False)
            if runtime_config is not None
            else None
        )
        now = _now()
        with self._connection() as conn:
            cur = conn.execute(
                "UPDATE connector SET runtime_config_json=?, updated_at=? WHERE connector_id=?",
                (rc_json, now, connector_id),
            )
            conn.commit()
        if cur.rowcount == 0:
            raise KeyError(f"connector not found: {connector_id}")
        row = self.get_connector(connector_id)
        assert row is not None
        return row

    def get_connector(self, connector_id: str) -> Optional[ConnectorRow]:
        with self._connection() as conn:
            row = conn.execute(
                "SELECT * FROM connector WHERE connector_id=?", (connector_id,)
            ).fetchone()
        return _row_to_connector(row) if row else None

    def list_connectors(self) -> list[ConnectorRow]:
        with self._connection() as conn:
            rows = conn.execute("SELECT * FROM connector ORDER BY connector_id").fetchall()
        return [_row_to_connector(r) for r in rows]

    def sync_connector_tools(
        self, connector_id: str, tools: list[dict[str, Any]]
    ) -> dict[str, int]:
        """远端工具清单 → ``connector_tool`` 落库（refresh 纪律的唯一实现点）。

        - 🔴 只覆盖 manifest 派生字段（description / input_schema_json / output_schema_json /
          crud_type / destructive / last_seen_at / orphan=0），**永不**覆盖 ``mode``
          （用户配置；旧 ``enabled`` 死列同理）与 ``first_seen_at``。crud_type 属 manifest 派生 ⇒ 全量 upsert 重跑
          derive 即自愈存量误判行（裁决①：owner 点一次 sync 就把旧误判刷成新推导）。
        - 本轮清单里没有的既有行 → ``orphan=1``（保留用户配置，PR2 不注册 orphan）。
        - 坏 ``crud_type``（含已退役的 ``'delete'``）/ 空 name **入库时拒**。
        """
        now = _now()
        prepared: list[tuple] = []
        seen: set[str] = set()
        for t in tools:
            name = t.get("name")
            if not name or not isinstance(name, str):
                raise ValueError(f"connector tool name must be a non-empty string: {t!r}")
            crud = t.get("crud_type", "read")
            if crud not in _connector_consts().CONNECTOR_CRUD_TYPES:
                raise ValueError(
                    f"connector tool {name!r} crud_type {crud!r} not in {_connector_consts().CONNECTOR_CRUD_TYPES}"
                )
            if name in seen:
                raise ValueError(f"duplicate tool name in manifest: {name!r}")
            seen.add(name)
            input_schema = t.get("input_schema")
            output_schema = t.get("output_schema")
            prepared.append(
                (
                    connector_id,
                    name,
                    t.get("description") or "",
                    json.dumps(input_schema, ensure_ascii=False) if input_schema is not None else None,
                    json.dumps(output_schema, ensure_ascii=False) if output_schema is not None else None,
                    crud,
                    1 if t.get("destructive") is True else 0,
                    now,
                    now,
                    now,
                )
            )
        with self._connection() as conn:
            existing = {
                r["tool_name"]
                for r in conn.execute(
                    "SELECT tool_name FROM connector_tool WHERE connector_id=?",
                    (connector_id,),
                ).fetchall()
            }
            for row in prepared:
                conn.execute(
                    "INSERT INTO connector_tool (connector_id, tool_name, description,"
                    " input_schema_json, output_schema_json, crud_type, destructive,"
                    " first_seen_at, last_seen_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) "
                    "ON CONFLICT(connector_id, tool_name) DO UPDATE SET"
                    " description=excluded.description,"
                    " input_schema_json=excluded.input_schema_json,"
                    " output_schema_json=excluded.output_schema_json,"
                    " crud_type=excluded.crud_type,"
                    " destructive=excluded.destructive,"
                    " orphan=0,"
                    " last_seen_at=excluded.last_seen_at,"
                    " updated_at=excluded.updated_at",
                    row,
                )
            orphaned = 0
            for name in existing - seen:
                conn.execute(
                    "UPDATE connector_tool SET orphan=1, updated_at=? "
                    "WHERE connector_id=? AND tool_name=?",
                    (now, connector_id, name),
                )
                orphaned += 1
            conn.commit()
        return {
            "total": len(prepared),
            "inserted": len(seen - existing),
            "updated": len(seen & existing),
            "orphaned": orphaned,
        }

    def set_connector_preprocess_enabled(self, connector_id: str, enabled: bool) -> None:
        """分类侧独立授权开关（PR3 坑 3）。行不存在 → ``KeyError``（先连接再授权）。

        🔴 这里**只有布尔**，没有天花板参数 —— 分类侧的 read 天花板是结构性的（工厂只造
        read 类工具），不是一个可以配错的值。要给分类侧写权限得改代码，不是改配置。
        """
        with self._connection() as conn:
            cur = conn.execute(
                "UPDATE connector SET preprocess_enabled=?, updated_at=? WHERE connector_id=?",
                (1 if enabled else 0, _now(), connector_id),
            )
            conn.commit()
        if cur.rowcount == 0:
            raise KeyError(f"connector not found: {connector_id}")

    def list_connector_tools(self, connector_id: str) -> list[ConnectorToolRow]:
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT * FROM connector_tool WHERE connector_id=? ORDER BY tool_name",
                (connector_id,),
            ).fetchall()
        return [_row_to_connector_tool(r) for r in rows]

    def set_connector_tool_mode(
        self, connector_id: str, tool_name: str, mode: Optional[str]
    ) -> None:
        """用户 per-tool 档位覆盖（08-05 三档）：``'auto'|'ask'|'off'``；``None`` = 清除覆盖
        回默认档（auto）。

        🔴 08-03 起**任何在册工具都可配置**（owner 改判：「连接工具应该都全部可配置」）——
        没有恒灰的档位。危险性由 ``destructive`` 列承担（设置面把 destructive 设 auto 时
        弹一次性红色确认，审批卡红警告链在 ask 档原样保留）。值域外入库即拒（ValueError）；
        行不存在 → ``KeyError``（先 sync 再配）。
        """
        if mode is not None and mode not in _connector_consts().CONNECTOR_TOOL_MODES:
            raise ValueError(
                f"connector tool mode {mode!r} not in {_connector_consts().CONNECTOR_TOOL_MODES} (or None)"
            )
        with self._connection() as conn:
            row = conn.execute(
                "SELECT crud_type FROM connector_tool WHERE connector_id=? AND tool_name=?",
                (connector_id, tool_name),
            ).fetchone()
            if row is None:
                raise KeyError(f"connector tool not found: {connector_id}/{tool_name}")
            conn.execute(
                "UPDATE connector_tool SET mode=?, updated_at=? "
                "WHERE connector_id=? AND tool_name=?",
                (mode, _now(), connector_id, tool_name),
            )
            conn.commit()

    def bulk_set_connector_tool_mode(
        self, connector_id: str, mode: Optional[str], *, crud_type: Optional[str] = None
    ) -> int:
        """组级批量设档（差距表 #6 / Reset permissions #8 的后端）：把该 connector 的工具
        （可按 ``crud_type`` 收窄）统一置 ``mode``；``mode=None`` = 批量清覆盖回默认
        （= Reset permissions）。返回受影响行数。

        orphan 行**跳过**——它们恒不注册，批量动作把已失效行也改了只会在 re-sync 复活时
        带回一份用户从没看过的档位；orphan 行的覆盖仍可经 per-tool 端点显式改。
        """
        if mode is not None and mode not in _connector_consts().CONNECTOR_TOOL_MODES:
            raise ValueError(
                f"connector tool mode {mode!r} not in {_connector_consts().CONNECTOR_TOOL_MODES} (or None)"
            )
        if crud_type is not None and crud_type not in _connector_consts().CONNECTOR_CRUD_TYPES:
            raise ValueError(
                f"connector tool crud_type {crud_type!r} not in {_connector_consts().CONNECTOR_CRUD_TYPES}"
            )
        sql = (
            "UPDATE connector_tool SET mode=?, updated_at=? "
            "WHERE connector_id=? AND orphan=0"
        )
        params: list[Any] = [mode, _now(), connector_id]
        if crud_type is not None:
            sql += " AND crud_type=?"
            params.append(crud_type)
        with self._connection() as conn:
            cur = conn.execute(sql, params)
            conn.commit()
        return cur.rowcount

    def purge_orphan_connector_tools(self, connector_id: str) -> int:
        """删掉该 connector 的 orphan 工具行（PR5 清理出口），返回删除行数。

        orphan 行是 refresh 纪律 4 的**有意**保留物（远端清单里消失 → 标记不删，防服务器
        抖一下就把用户的 enabled 覆盖抹掉）。代价是攒久了会在设置面堆成噪音，故这里给
        owner 一个**显式**清理出口 —— 自动回收永远不做（那就把纪律 4 白写了）。

        🔴 ``WHERE orphan=1`` 是本方法的全部安全性：在册工具行（含用户 enabled 覆盖）一行
        不碰。删完若远端又有了，下次 sync 照常 INSERT（sync 是 upsert，不依赖旧行存在）。
        未连接 / 没有 orphan 行 → 返回 0（删空不是错）。
        """
        with self._connection() as conn:
            cur = conn.execute(
                "DELETE FROM connector_tool WHERE connector_id=? AND orphan=1",
                (connector_id,),
            )
            conn.commit()
        return cur.rowcount

    # ======================================================================
