"""Skill registry, secrets, drafts, and trust storage operations for AgentConfigStore."""

from __future__ import annotations

import json
import sqlite3
from typing import Any, Iterable, Optional

from src.agent_config.store_common import (
    INSTALLABLE_SOURCE_TYPES,
    SkillDraftRow,
    SkillRow,
    SkillTrustRow,
    _SKILL_NAME_RE,
    _UNSET,
    _now,
    _now_iso,
    _row_to_skill,
    _row_to_skill_draft,
    _row_to_skill_trust,
    _to_int_bool,
)


class AgentConfigSkillsMixin:
    def list_skills(self) -> list[SkillRow]:
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT * FROM agent_skills ORDER BY skill_name"
            ).fetchall()
        return [_row_to_skill(r) for r in rows]

    def get_skill(self, skill_name: str) -> Optional[SkillRow]:
        with self._connection() as conn:
            row = conn.execute(
                "SELECT * FROM agent_skills WHERE skill_name = ?", (skill_name,)
            ).fetchone()
        return _row_to_skill(row) if row else None

    def install_skill(
        self,
        skill_name: str,
        *,
        source_type: str,
        manifest: Optional[dict[str, Any]] = None,
        manifest_version: Optional[str] = None,
        version: Optional[str] = None,
        source_uri: Optional[str] = None,
        granted_scopes: Optional[Iterable[str]] = None,
        package_hash: Optional[str] = None,
        trusted: bool = False,
        enabled: Optional[bool] = None,
        files_json: Optional[str] = None,
        upstream_meta: Optional[dict[str, Any]] = None,
        preserve_enabled: bool = False,
        session_id: Optional[int] = None,
    ) -> SkillRow:
        """安装/更新一个用户来源 skill（source_type ∈ INSTALLABLE_SOURCE_TYPES）。

        ``granted_scopes`` 写时校验 ⊆ KNOWN_SCOPES（复用 api_keys.validate_scopes）—— 非法 scope
        ``ValueError``，不静默产出 manifest 里调不动的死工具。``files_json`` = S2 供应链的逐文件
        sha256（confirm 落库）。记一条 install 事件（detail 含 package_hash/manifest_version，
        **绝不含 secret 值**）。
        """
        if source_type not in INSTALLABLE_SOURCE_TYPES:
            raise ValueError(
                f"install_skill source_type must be one of {INSTALLABLE_SOURCE_TYPES}, got {source_type!r}"
            )
        skill_name = (skill_name or "").strip()
        if not skill_name:
            raise ValueError("skill_name is required")
        # R5 — strict slug + manifest.name agreement (so the registry projection,
        # @mention parsing, and enable/disable all key off the same canonical name).
        if not _SKILL_NAME_RE.match(skill_name):
            raise ValueError(
                f"skill_name must be a lowercase slug matching {_SKILL_NAME_RE.pattern!r}, "
                f"got {skill_name!r}"
            )
        if manifest is not None:
            mname = manifest.get("name")
            if mname is not None and mname != skill_name:
                raise ValueError(
                    f"manifest.name ({mname!r}) must be absent or equal skill_name ({skill_name!r})"
                )
        scopes = self._validate_scopes(granted_scopes)
        manifest_json = (
            json.dumps(manifest, ensure_ascii=False, sort_keys=True) if manifest is not None else None
        )
        upstream_meta_json = (
            json.dumps(upstream_meta, ensure_ascii=False, sort_keys=True)
            if upstream_meta is not None
            else None
        )
        enabled_update_sql = (
            "COALESCE(excluded.enabled, agent_skills.enabled)"
            if preserve_enabled
            else "excluded.enabled"
        )
        now = _now()
        with self._connection() as conn:
            existing = conn.execute(
                "SELECT installed_at FROM agent_skills WHERE skill_name = ?", (skill_name,)
            ).fetchone()
            installed_at = existing["installed_at"] if existing else now
            conn.execute(
                f"INSERT INTO agent_skills "
                "(skill_name, source_type, source_uri, version, manifest_version, manifest_json, "
                " enabled, granted_scopes_json, package_hash, trusted, last_error, installed_at, updated_at, "
                " files_json, upstream_meta_json) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(skill_name) DO UPDATE SET "
                " source_type=excluded.source_type, source_uri=excluded.source_uri, "
                " version=excluded.version, manifest_version=excluded.manifest_version, "
                f" manifest_json=excluded.manifest_json, enabled={enabled_update_sql}, "
                " granted_scopes_json=excluded.granted_scopes_json, package_hash=excluded.package_hash, "
                " trusted=excluded.trusted, last_error=NULL, updated_at=excluded.updated_at, "
                " files_json=excluded.files_json, upstream_meta_json=excluded.upstream_meta_json",
                (
                    skill_name,
                    source_type,
                    source_uri,
                    version,
                    manifest_version,
                    manifest_json,
                    _to_int_bool(enabled),
                    json.dumps(list(scopes), ensure_ascii=False),
                    package_hash,
                    1 if trusted else 0,
                    None,
                    installed_at,
                    now,
                    files_json,
                    upstream_meta_json,
                ),
            )
            # detail 记 source_type + package_hash + manifest_version（供应链溯源）；**绝不含 secret 值**。
            detail: dict[str, Any] = {"source_type": source_type}
            if package_hash is not None:
                detail["package_hash"] = package_hash
            if manifest_version is not None:
                detail["manifest_version"] = manifest_version
            self._record_event_conn(conn, skill_name, "install", detail, session_id, now)
            conn.commit()
        skill = self.get_skill(skill_name)
        assert skill is not None  # 刚插入
        return skill

    def set_enabled(
        self,
        skill_name: str,
        enabled: bool,
        *,
        source_type: str = "builtin",
        session_id: Optional[int] = None,
    ) -> None:
        """设置 skill 的启用覆盖。builtin 无行时懒建一行（只存 enable 覆盖，manifest 来自代码）。

        installed skill 已有行 → 仅更新 enabled。记 enable/disable 事件。
        """
        skill_name = (skill_name or "").strip()
        if not skill_name:
            raise ValueError("skill_name is required")
        now = _now()
        with self._connection() as conn:
            existing = conn.execute(
                "SELECT skill_name FROM agent_skills WHERE skill_name = ?", (skill_name,)
            ).fetchone()
            if existing is None:
                # 懒建 builtin 覆盖行：manifest_json=NULL（manifest 来自代码），只承载 enabled。
                conn.execute(
                    "INSERT INTO agent_skills "
                    "(skill_name, source_type, enabled, granted_scopes_json, trusted, installed_at, updated_at) "
                    "VALUES (?,?,?,?,?,?,?)",
                    (skill_name, source_type, _to_int_bool(enabled), "[]", 0, now, now),
                )
            else:
                conn.execute(
                    "UPDATE agent_skills SET enabled = ?, updated_at = ? WHERE skill_name = ?",
                    (_to_int_bool(enabled), now, skill_name),
                )
            self._record_event_conn(
                conn, skill_name, "enable" if enabled else "disable", None, session_id, now
            )
            conn.commit()

    def uninstall_skill(self, skill_name: str, *, session_id: Optional[int] = None) -> bool:
        """删一个 skill 行（installed → 卸载；builtin 懒行 → 回退代码默认）。幂等：无行返回 False。"""
        now = _now()
        with self._connection() as conn:
            cur = conn.execute("DELETE FROM agent_skills WHERE skill_name = ?", (skill_name,))
            removed = cur.rowcount > 0
            if removed:
                self._record_event_conn(conn, skill_name, "uninstall", None, session_id, now)
            conn.commit()
        return removed

    def set_skill_last_error(self, skill_name: str, error: Optional[str]) -> None:
        """落/清一个 skill 的 ``last_error``（W4 完整性闸：``tampered:<relpath>``）。无行 no-op。

        Settings 据此标红 + 提供「重新信任（re-hash）」入口；install_skill upsert 时自动清
        （``last_error=NULL``，见上）。
        """
        with self._connection() as conn:
            conn.execute(
                "UPDATE agent_skills SET last_error = ?, updated_at = ? WHERE skill_name = ?",
                (error, _now(), skill_name),
            )
            conn.commit()

    def merge_first_run_approved(self, skill_name: str, updates: dict[str, dict]) -> None:
        """把首跑记录 merge 进 ``first_run_approved`` JSON（W4 首跑闸，ADR-002 §5）。

        形状 ``{<entrypoint_realpath>: {version, entrypoint_hash, approved_at}}`` —— 绑
        version + entrypoint hash（非裸时间戳）：skill 升级 / 换脚本后旧记录自动失效、
        首跑闸重新触发。``approved_at`` 缺失时由本层补当前 epoch。无行 no-op（供应链外
        内容根本过不了完整性闸，不会走到这）。
        """
        if not updates:
            return
        now = _now()
        with self._connection() as conn:
            row = conn.execute(
                "SELECT first_run_approved FROM agent_skills WHERE skill_name = ?",
                (skill_name,),
            ).fetchone()
            if row is None:
                return
            try:
                existing = json.loads(row["first_run_approved"] or "{}")
                if not isinstance(existing, dict):
                    existing = {}
            except (ValueError, TypeError):
                existing = {}
            for entrypoint, rec in updates.items():
                merged = dict(rec)
                merged.setdefault("approved_at", now)
                existing[entrypoint] = merged
            conn.execute(
                "UPDATE agent_skills SET first_run_approved = ?, updated_at = ? WHERE skill_name = ?",
                (json.dumps(existing, ensure_ascii=False, sort_keys=True), now, skill_name),
            )
            conn.commit()

    def list_skill_secret_names(self, skill_name: str) -> list[str]:
        """一个 skill 已存储的密钥**名**列表（永不返回值 —— 值列是密文，W3 解密专属）。"""
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT secret_name FROM skill_secrets WHERE skill_name = ? ORDER BY secret_name",
                (skill_name,),
            ).fetchall()
        return [r["secret_name"] for r in rows]

    def delete_skill_secrets(self, skill_name: str) -> int:
        """删一个 skill 的全部 skill_secrets 行（uninstall 清理钩子）。返回删除行数。

        W2 只做结构清理（删行）；Keychain master key 不动（W3 拥有加解密 + master key 生命周期）。
        """
        with self._connection() as conn:
            cur = conn.execute("DELETE FROM skill_secrets WHERE skill_name = ?", (skill_name,))
            conn.commit()
            return cur.rowcount

    # -- skill secret 密文 CRUD（W3 —— 加解密在 src/agent_config/secrets.py，store 只存/取密文）──

    def upsert_skill_secret(
        self, skill_name: str, secret_name: str, value_ciphertext: bytes
    ) -> None:
        """写/替换一个 skill secret 的密文（``value_ciphertext`` = Fernet ciphertext，本层不解密）。

        值列**只存密文**（明文永不落库）；``updated_at`` = ISO 文本（与 policy_rules 同风格）。
        secret 名合法性由调用方（``secrets.set_secret`` + 端点）校验，本层只落盘。
        """
        now = _now_iso()
        with self._connection() as conn:
            conn.execute(
                "INSERT INTO skill_secrets (skill_name, secret_name, value_ciphertext, updated_at) "
                "VALUES (?,?,?,?) "
                "ON CONFLICT(skill_name, secret_name) DO UPDATE SET "
                " value_ciphertext=excluded.value_ciphertext, updated_at=excluded.updated_at",
                (skill_name, secret_name, sqlite3.Binary(value_ciphertext), now),
            )
            conn.commit()

    def get_skill_secret_ciphertext(
        self, skill_name: str, secret_name: str
    ) -> Optional[bytes]:
        """取一个 skill secret 的密文（无 → None）。解密归 ``secrets.get_secret``。"""
        with self._connection() as conn:
            row = conn.execute(
                "SELECT value_ciphertext FROM skill_secrets WHERE skill_name = ? AND secret_name = ?",
                (skill_name, secret_name),
            ).fetchone()
        return bytes(row["value_ciphertext"]) if row else None

    def list_skill_secret_ciphertexts(self, skill_name: str) -> list[tuple[str, bytes]]:
        """一个 skill 的全部 (secret_name, 密文) 对（按名排序）。供 ``secrets.get_secrets_for_skill``
        批量解密注入。返回密文，本层不解密。"""
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT secret_name, value_ciphertext FROM skill_secrets "
                "WHERE skill_name = ? ORDER BY secret_name",
                (skill_name,),
            ).fetchall()
        return [(r["secret_name"], bytes(r["value_ciphertext"])) for r in rows]

    def skill_secret_meta(self, skill_name: str) -> list[tuple[str, str]]:
        """一个 skill 已存储密钥的 (secret_name, updated_at) 对 —— **只名 + 时间戳，永不返回值**
        （owner Settings ``GET .../secrets`` 用）。"""
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT secret_name, updated_at FROM skill_secrets "
                "WHERE skill_name = ? ORDER BY secret_name",
                (skill_name,),
            ).fetchall()
        return [(r["secret_name"], r["updated_at"]) for r in rows]

    def delete_skill_secret(self, skill_name: str, secret_name: str) -> bool:
        """删一个 skill 的单个 secret 行（owner ``DELETE .../secrets/{name}``）。幂等（无行 False）。"""
        with self._connection() as conn:
            cur = conn.execute(
                "DELETE FROM skill_secrets WHERE skill_name = ? AND secret_name = ?",
                (skill_name, secret_name),
            )
            conn.commit()
        return cur.rowcount > 0


    def create_skill_draft(
        self,
        draft_id: str,
        name: str,
        root_path: str,
        *,
        manifest: Optional[dict[str, Any]] = None,
        source_session_id: Optional[int] = None,
    ) -> SkillDraftRow:
        now = _now()
        with self._connection() as conn:
            conn.execute(
                "INSERT INTO agent_skill_draft "
                "(id,name,status,root_path,manifest_json,validation_json,source_session_id,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    draft_id,
                    name,
                    "draft",
                    root_path,
                    json.dumps(manifest, ensure_ascii=False, sort_keys=True)
                    if manifest is not None else None,
                    None,
                    source_session_id,
                    now,
                    now,
                ),
            )
            conn.commit()
        row = self.get_skill_draft(draft_id)
        assert row is not None
        return row

    def get_skill_draft(self, draft_id: str) -> Optional[SkillDraftRow]:
        with self._connection() as conn:
            row = conn.execute(
                "SELECT * FROM agent_skill_draft WHERE id = ?", (draft_id,)
            ).fetchone()
        return _row_to_skill_draft(row) if row else None

    def list_skill_drafts(self, *, include_terminal: bool = True) -> list[SkillDraftRow]:
        sql = "SELECT * FROM agent_skill_draft"
        if not include_terminal:
            sql += " WHERE status NOT IN ('published','discarded')"
        sql += " ORDER BY updated_at DESC, id ASC"
        with self._connection() as conn:
            rows = conn.execute(sql).fetchall()
        return [_row_to_skill_draft(row) for row in rows]

    def update_skill_draft(
        self,
        draft_id: str,
        *,
        status: Optional[str] = None,
        manifest: Any = _UNSET,
        validation: Any = _UNSET,
    ) -> SkillDraftRow:
        if status is not None and status not in {
            "draft", "valid", "invalid", "published", "discarded"
        }:
            raise ValueError(f"invalid skill draft status: {status!r}")
        sets = ["updated_at = ?"]
        values: list[Any] = [_now()]
        if status is not None:
            sets.append("status = ?")
            values.append(status)
        if manifest is not _UNSET:
            sets.append("manifest_json = ?")
            values.append(
                json.dumps(manifest, ensure_ascii=False, sort_keys=True)
                if manifest is not None else None
            )
        if validation is not _UNSET:
            sets.append("validation_json = ?")
            values.append(
                json.dumps(validation, ensure_ascii=False, sort_keys=True)
                if validation is not None else None
            )
        values.append(draft_id)
        with self._connection() as conn:
            cur = conn.execute(
                f"UPDATE agent_skill_draft SET {', '.join(sets)} WHERE id = ?", values
            )
            conn.commit()
        if cur.rowcount == 0:
            raise KeyError(draft_id)
        row = self.get_skill_draft(draft_id)
        assert row is not None
        return row

    def mark_skill_draft_published(self, draft_id: str) -> SkillDraftRow:
        return self.update_skill_draft(draft_id, status="published")

    def mark_skill_draft_discarded(self, draft_id: str) -> SkillDraftRow:
        return self.update_skill_draft(draft_id, status="discarded")

    def grant_skill_trust(
        self,
        trust_id: str,
        skill_name: str,
        package_hash: str,
        entrypoint: str,
        policy: dict[str, Any],
    ) -> SkillTrustRow:
        now = _now()
        with self._connection() as conn:
            conn.execute(
                "INSERT INTO agent_skill_trust "
                "(id,skill_name,package_hash,entrypoint,policy_json,trusted_at,revoked_at) "
                "VALUES (?,?,?,?,?,?,NULL) "
                "ON CONFLICT(skill_name,package_hash,entrypoint) DO UPDATE SET "
                "id=excluded.id, policy_json=excluded.policy_json, trusted_at=excluded.trusted_at, "
                "revoked_at=NULL",
                (
                    trust_id,
                    skill_name,
                    package_hash,
                    entrypoint,
                    json.dumps(policy, ensure_ascii=False, sort_keys=True),
                    now,
                ),
            )
            conn.commit()
        row = self.find_active_skill_trust(skill_name, package_hash, entrypoint)
        assert row is not None
        return row

    def revoke_skill_trust(self, trust_id: str) -> bool:
        with self._connection() as conn:
            cur = conn.execute(
                "UPDATE agent_skill_trust SET revoked_at = ? "
                "WHERE id = ? AND revoked_at IS NULL",
                (_now(), trust_id),
            )
            conn.commit()
        return cur.rowcount > 0

    def list_skill_trust(self, skill_name: str) -> list[SkillTrustRow]:
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT * FROM agent_skill_trust WHERE skill_name = ? "
                "ORDER BY trusted_at DESC, id ASC",
                (skill_name,),
            ).fetchall()
        return [_row_to_skill_trust(row) for row in rows]

    def find_active_skill_trust(
        self, skill_name: str, package_hash: str, entrypoint: str
    ) -> Optional[SkillTrustRow]:
        with self._connection() as conn:
            row = conn.execute(
                "SELECT * FROM agent_skill_trust WHERE skill_name = ? AND package_hash = ? "
                "AND entrypoint = ? AND revoked_at IS NULL ORDER BY trusted_at DESC LIMIT 1",
                (skill_name, package_hash, entrypoint),
            ).fetchone()
        return _row_to_skill_trust(row) if row else None

    def installed_rows_fingerprint(self) -> str:
        """安装行的确定性指纹串（installed_skills_hash 的 store 半部）。

        canonical：``ORDER BY skill_name``，每行 ``name|source_type|version|manifest_version`` join。
        **不含** enabled（启用态属于 active_skills_hash，不进 installed_skills_hash —— 见 plan §F）。
        PR2 把它与代码 builtin 签名拼接后 sha256 成最终 installed_skills_hash。
        """
        parts: list[str] = []
        for r in self.list_skills():
            parts.append(
                f"{r.skill_name}|{r.source_type}|{r.version or ''}|{r.manifest_version or ''}"
            )
        return "\n".join(parts)

