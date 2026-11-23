"""Policy rules, owner settings, and tool approval preference storage operations."""

from __future__ import annotations

from typing import Any, Iterable, Optional

from src.agent_config.store_common import (
    PolicyRuleRow,
    _now_iso,
    _row_to_policy_rule,
)


class AgentConfigPolicyMixin:
    def create_policy_rule(
        self,
        capability: str,
        matcher_json: str,
        *,
        context_mode: str = "manual_chat",
        note: Optional[str] = None,
        agent_id: Optional[str] = None,
    ) -> PolicyRuleRow:
        """落一条结构化白名单规则。``matcher_json`` 已是校验过的 typed matcher 序列化串
        （合法性由 policy.py 的 pydantic 模型在 API 层把关，store 不二次解析——只存原样）。

        ``agent_id``（S5 per-agent，ADR-004 §3.3）：store 层只拒**空串/空白**（``agent_id=''``
        既非 NULL 也匹配不到任何 run，纯脏数据，codex P1-5）；「agent 存在且 type='custom'」的
        归属校验在 API 层做 —— agent 行在 sync_store（另一库），store 保持单库零跨库依赖
        （镜像 api_keys 纪律）。
        """
        if agent_id is not None and (not isinstance(agent_id, str) or not agent_id.strip()):
            raise ValueError("policy rule agent_id must be a non-empty string or None")
        now = _now_iso()
        with self._connection() as conn:
            cur = conn.execute(
                "INSERT INTO policy_rules "
                "(capability, matcher_json, context_mode, agent_id, enabled, note, created_at, "
                " last_used_at, use_count) VALUES (?,?,?,?,?,?,?,?,?)",
                (capability, matcher_json, context_mode, agent_id, 1, note, now, None, 0),
            )
            conn.commit()
            rule_id = int(cur.lastrowid)
            row = conn.execute("SELECT * FROM policy_rules WHERE id = ?", (rule_id,)).fetchone()
        return _row_to_policy_rule(row)

    def list_policy_rules(
        self,
        *,
        capability: Optional[str] = None,
        context_mode: Optional[str] = None,
        agent_id: Optional[str] = None,
    ) -> list[PolicyRuleRow]:
        """列全部规则（可选按 capability / context_mode / agent_id 过滤），最新在前。
        ``agent_id=None`` = 不过滤（现状，含全局与 per-agent 全部行）；有值 = 严格等值。"""
        sql = "SELECT * FROM policy_rules"
        clauses: list[str] = []
        params: list[Any] = []
        if capability is not None:
            clauses.append("capability = ?")
            params.append(capability)
        if context_mode is not None:
            clauses.append("context_mode = ?")
            params.append(context_mode)
        if agent_id is not None:
            clauses.append("agent_id = ?")
            params.append(agent_id)
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY id DESC"
        with self._connection() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [_row_to_policy_rule(r) for r in rows]

    def get_policy_rule(self, rule_id: int) -> Optional[PolicyRuleRow]:
        with self._connection() as conn:
            row = conn.execute("SELECT * FROM policy_rules WHERE id = ?", (rule_id,)).fetchone()
        return _row_to_policy_rule(row) if row else None

    def set_policy_rule(
        self, rule_id: int, *, enabled: Optional[bool] = None, note: Optional[str] = None
    ) -> Optional[PolicyRuleRow]:
        """启用/停用 + 改备注（owner 管理页用）。不存在返回 None。matcher 不可 patch
        （放宽 = 删旧建新，防原地把窄规则悄悄改宽）。"""
        sets: list[str] = []
        params: list[Any] = []
        if enabled is not None:
            sets.append("enabled = ?")
            params.append(1 if enabled else 0)
        if note is not None:
            sets.append("note = ?")
            params.append(note)
        if not sets:
            return self.get_policy_rule(rule_id)
        params.append(rule_id)
        with self._connection() as conn:
            cur = conn.execute(
                f"UPDATE policy_rules SET {', '.join(sets)} WHERE id = ?", params
            )
            conn.commit()
            if cur.rowcount == 0:
                return None
            row = conn.execute("SELECT * FROM policy_rules WHERE id = ?", (rule_id,)).fetchone()
        return _row_to_policy_rule(row)

    def delete_policy_rule(self, rule_id: int) -> bool:
        with self._connection() as conn:
            cur = conn.execute("DELETE FROM policy_rules WHERE id = ?", (rule_id,))
            conn.commit()
            return cur.rowcount > 0

    def candidate_policy_rules(
        self, capability: str, context_mode: str, agent_id: Optional[str] = None
    ) -> list[PolicyRuleRow]:
        """评估候选规则（双键，ADR-004 §3.3）：

        - ``agent_id=None``（manual 消费方现状）→ ``AND agent_id IS NULL``，查询串与 S2
          **逐字节相同**（tests/agent_config 有源文本锚定断言，勿改动该字符串）；
        - ``agent_id='<id>'``（headless per-agent）→ ``AND agent_id = ?`` **严格等值** ——
          全局（NULL）规则永不进 headless 候选集，headless 规则永不进 manual 候选集
          （红线①双向物理隔离，绝无 ``IS NULL OR``）；
        - ``agent_id`` 空串/空白 → 空候选（脏实参拒绝，evaluate 兜底 ask，codex P1-5）。

        **context_mode 严格等值绑定**（红线①）：manual_chat 规则永不进 untrusted_trigger 查询的
        候选集，反之亦然。
        """
        if agent_id is None:
            sql = (
                "SELECT * FROM policy_rules WHERE enabled = 1 AND capability = ? "
                "AND context_mode = ? AND agent_id IS NULL ORDER BY id ASC"
            )
            params: tuple[Any, ...] = (capability, context_mode)
        else:
            if not isinstance(agent_id, str) or not agent_id.strip():
                return []
            sql = (
                "SELECT * FROM policy_rules WHERE enabled = 1 AND capability = ? "
                "AND context_mode = ? AND agent_id = ? ORDER BY id ASC"
            )
            params = (capability, context_mode, agent_id)
        with self._connection() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [_row_to_policy_rule(r) for r in rows]

    def delete_policy_rules_for_agent(self, agent_id: str) -> int:
        """agent 删除级联（ADR-004 §3.3 ④）：清该 agent 的全部 policy_rules —— 悬空规则虽匹配
        不到 run，但会在 Settings 留鬼行。返回删除行数。空/空白 agent_id → 0（**绝不**误删
        agent_id IS NULL 的全局规则）。reports 的 delete_agent 路径调用。"""
        if not isinstance(agent_id, str) or not agent_id.strip():
            return 0
        with self._connection() as conn:
            cur = conn.execute("DELETE FROM policy_rules WHERE agent_id = ?", (agent_id,))
            conn.commit()
            return cur.rowcount

    def bump_policy_rule_use(self, rule_id: int) -> None:
        """规则命中（auto_allow）→ last_used_at=now + use_count+1（审计 + 管理页展示）。"""
        with self._connection() as conn:
            conn.execute(
                "UPDATE policy_rules SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?",
                (_now_iso(), rule_id),
            )
            conn.commit()

    # ======================================================================
    # owner 级全局设置（owner_settings，07-16 approval-mode switcher）
    # ======================================================================

    def get_owner_setting(self, key: str) -> Optional[str]:
        """读一个 owner 设置值；无行 → None（调用方自带默认，如 approval mode 回落 manual）。"""
        with self._connection() as conn:
            row = conn.execute(
                "SELECT value FROM owner_settings WHERE key = ?", (key,)
            ).fetchone()
        return row["value"] if row else None

    def set_owner_setting(self, key: str, value: str) -> None:
        """写/覆盖一个 owner 设置值（upsert）。合法性（值域校验）由 API 层把关，本层只落盘。"""
        if not isinstance(key, str) or not key.strip():
            raise ValueError("owner setting key must be a non-empty string")
        if not isinstance(value, str):
            raise ValueError("owner setting value must be a string")
        with self._connection() as conn:
            conn.execute(
                "INSERT INTO owner_settings (key, value, updated_at) VALUES (?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, "
                " updated_at=excluded.updated_at",
                (key, value, _now_iso()),
            )
            conn.commit()

    # ======================================================================
    # built-in 写工具的 per-tool 审批档（tool_approval_pref，08-05 WP-11）
    # ======================================================================

    def get_tool_approval_prefs(self) -> dict[str, str]:
        """全部显式覆盖行 ``{tool_name: tier}``（无行 = 跟随出厂默认，折算在
        tool_prefs.effective_tool_tier）。值域外脏行原样返回——读侧折算 fail-closed
        成 ask，这里不做静默清洗（取证友好）。"""
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT tool_name, tier FROM tool_approval_pref"
            ).fetchall()
        return {r["tool_name"]: r["tier"] for r in rows}

    def set_tool_approval_pref(self, tool_name: str, tier: Optional[str]) -> None:
        """写/清一个工具的显式档位覆盖。``tier=None`` = 删行回出厂默认。

        值域校验（TOOL_APPROVAL_TIERS）在 store 层入库即拒；「工具在注册表 + 可配置」
        的业务校验在 API 层（agent.py）——store 保持单表零业务依赖（api_keys 纪律）。
        """
        from src.agent_config.tool_prefs import TOOL_APPROVAL_TIERS

        if tier is not None and tier not in TOOL_APPROVAL_TIERS:
            raise ValueError(
                f"tool approval tier {tier!r} not in {TOOL_APPROVAL_TIERS} (or None)"
            )
        if not isinstance(tool_name, str) or not tool_name.strip():
            raise ValueError("tool_name must be a non-empty string")
        with self._connection() as conn:
            if tier is None:
                conn.execute(
                    "DELETE FROM tool_approval_pref WHERE tool_name=?", (tool_name,)
                )
            else:
                conn.execute(
                    "INSERT INTO tool_approval_pref (tool_name, tier, updated_at) "
                    "VALUES (?,?,?) ON CONFLICT(tool_name) DO UPDATE SET "
                    "tier=excluded.tier, updated_at=excluded.updated_at",
                    (tool_name, tier, _now_iso()),
                )
            conn.commit()

    def bulk_set_tool_approval_prefs(
        self, tool_names: Iterable[str], tier: Optional[str]
    ) -> int:
        """批量设档 / 批量清覆盖（``tier=None`` = Reset 这些工具回默认）。返回处理行数。
        名单合法性（注册表 + configurable）由 API 层预先裁定——store 只落盘。"""
        from src.agent_config.tool_prefs import TOOL_APPROVAL_TIERS

        if tier is not None and tier not in TOOL_APPROVAL_TIERS:
            raise ValueError(
                f"tool approval tier {tier!r} not in {TOOL_APPROVAL_TIERS} (or None)"
            )
        names = [n for n in tool_names if isinstance(n, str) and n.strip()]
        now = _now_iso()
        with self._connection() as conn:
            for name in names:
                if tier is None:
                    conn.execute(
                        "DELETE FROM tool_approval_pref WHERE tool_name=?", (name,)
                    )
                else:
                    conn.execute(
                        "INSERT INTO tool_approval_pref (tool_name, tier, updated_at) "
                        "VALUES (?,?,?) ON CONFLICT(tool_name) DO UPDATE SET "
                        "tier=excluded.tier, updated_at=excluded.updated_at",
                        (name, tier, now),
                    )
            conn.commit()
        return len(names)

    def reset_tool_approval_prefs(self) -> int:
        """清空全部显式覆盖（Reset permissions —— 全部工具回出厂默认）。返回删除行数。"""
        with self._connection() as conn:
            cur = conn.execute("DELETE FROM tool_approval_pref")
            conn.commit()
        return cur.rowcount

