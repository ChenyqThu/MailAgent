"""MEMORY/SKILLS 投影 + 配置快照 hash（Phase -1 / 0A · PR2）.

- ``MEMORY.md`` 是只读投影（M5b 后内容恒空；读侧改靠 mem0 M2 召回 + user.md M3 恒注入）。
  ``SKILLS.md`` 是 skill registry 的只读投影（避免双 SSoT 漂移，plan §D）。
- hash helpers 给 Phase 0 eval trace 提供**确定性**配置快照：``installed_skills_hash``
  （builtin name|version 签名 + store 安装行指纹，canonical 排序 → sha256）。
  ``agent_profile_hash`` 由 ``AgentConfigStore.profile_hash()`` 提供；``active_skills_hash``
  是客户端派生（含 @mention 叠加 + collision-exempt），不在后端（plan §F）。
"""

from __future__ import annotations

import hashlib
from typing import Any, Iterable, Optional

from src.agent_config.store import AgentConfigStore, resolve_enabled


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# 文档投影
# ---------------------------------------------------------------------------


def skills_doc_projection(manifest_skills: Iterable[Any]) -> str:
    """SKILLS.md 投影 —— 来自 manifest skills（PR3 后自动含 installed skills）。

    每个 skill 一行：title (name) — N tools · default on/off · available/unavailable。
    """
    skills = sorted(manifest_skills, key=lambda s: s.name)
    lines = ["# SKILLS", ""]
    if not skills:
        lines.append("(No skills available.)")
        return "\n".join(lines) + "\n"
    for s in skills:
        avail = (
            "available"
            if s.availability.available
            else f"unavailable: {s.availability.reason or 'unknown'}"
        )
        state = "on" if s.default_enabled else "off"
        lines.append(
            f"- **{s.title}** (`{s.name}`) — {len(s.tools)} tools · default {state} · {avail}"
        )
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# 配置快照 hash
# ---------------------------------------------------------------------------


def builtin_skills_signature(manifest_skills: Iterable[Any]) -> str:
    """manifest skills 的确定性签名串：``name|version`` 排序 join。"""
    return "\n".join(sorted(f"{s.name}|{s.version}" for s in manifest_skills))


def compute_installed_skills_hash(
    manifest_skills: Iterable[Any], store: AgentConfigStore
) -> str:
    """installed_skills_hash —— manifest skill 签名 + store 安装行指纹 → sha256。

    确定性：两半都 ORDER BY name。捕获「装了什么 / 什么版本 / 什么来源」的变化；**不含**
    enabled 启用态（启用态属 active_skills_hash —— toggle 不应改 installed_skills_hash）。
    """
    sig = builtin_skills_signature(manifest_skills)
    fp = store.installed_rows_fingerprint()
    return _sha256(f"{sig}\n##installed##\n{fp}")


# ---------------------------------------------------------------------------
# 启用态（PR5 —— enablement 迁后端）
# ---------------------------------------------------------------------------


def skill_overrides_map(store: AgentConfigStore) -> dict[str, bool]:
    """显式启用覆盖 map ``{skill_name: enabled}`` —— 只含用户 toggle 过的 skill（enabled 非 None）。

    供 /chat/config 下发给 runtime（取代 localStorage 的 readSkillOverrides）。无覆盖的 skill
    不在 map 里 → runtime 的 computeSkillEnablement 回退 manifest default_enabled（签名不变）。
    """
    return {r.skill_name: bool(r.enabled) for r in store.list_skills() if r.enabled is not None}


def _skill_install_dir(name: str) -> Optional[str]:
    """供应链 installed skill 的绝对安装目录（issue #62）；skills 根不可得（裸 worktree）→ None。
    lazy import 防 agent_config 层在无 skills 面的进程里拉起 pack_fetch（同 policy.py 纪律）。"""
    try:
        from src.skills.pack_fetch import skill_dir

        return skill_dir(name)
    except Exception:  # noqa: BLE001
        return None


def resolved_skills(manifest_skills: Iterable[Any], store: AgentConfigStore) -> list[dict[str, Any]]:
    """Settings 面用的解析后 skill 列表 —— manifest skill ⋈ store 启用覆盖 + source_type。

    enabled = ``resolve_enabled(store_override, manifest.default_enabled)``。builtin skill 无
    store 行 → source_type='builtin'、override=None；installed skill 携其 source_type。

    ``installDir``（issue #62）只对**供应链 installed** skill（``files_json`` 非空 = confirm 落库
    事实，判据同 ``/skills/entrypoints``）非 None —— builtin skill 没有可执行的落盘目录。给模型
    绝对路径是为了让它用 ``["python3", "<installDir>/main.py"]`` 而非 ``sh -lc "cd … && …"``：后者
    的完整性校验 / 首跑记录 / secret 注入全部 fail-open，且 exec 端点自 issue #62 起 409 硬拒。
    """
    rows = {r.skill_name: r for r in store.list_skills()}
    out: list[dict[str, Any]] = []
    for s in manifest_skills:
        row = rows.get(s.name)
        override = row.enabled if row else None
        out.append(
            {
                "name": s.name,
                "title": s.title,
                "description": s.description,
                "defaultEnabled": s.default_enabled,
                "enabled": resolve_enabled(override, s.default_enabled),
                "overridden": override is not None,
                "available": s.availability.available,
                "unavailableReason": s.availability.reason,
                "toolCount": len(s.tools),
                "scopes": sorted({sc for t in s.tools for sc in t.auth_scopes}),
                "sourceType": row.source_type if row else "builtin",
                "installDir": _skill_install_dir(s.name) if row and row.files_json else None,
            }
        )
    return out


def advertised_skill_names(
    manifest_skills: Iterable[Any], store: AgentConfigStore
) -> list[str]:
    """对模型可见的 skill 名 —— ``enabled``（override ?? default_enabled）**且** ``available``。

    供 /chat/config 下发给 AI SDK Gateway 的 M4a skill→tool 门控（flag
    ``MAILAGENT_SKILL_SELF_MOUNT``）：gateway 拥有自己的 gateway-工具→skill 映射，对每个
    skill，若其名不在本列表则 drop 它独占的工具。= 前端 ``computeSkillEnablement`` 的
    *advertised*（effectiveEnabled && available）概念的后端权威版。

    **数据所有权**：业务状态（哪些 skill 对模型可见）属 Python；工具集结构（哪个 gateway
    工具属哪个 skill + 据此过滤）属 Node。复用 ``resolved_skills``（不重写 enabled/available
    逻辑，免双实现漂移）。
    """
    return [
        s["name"]
        for s in resolved_skills(manifest_skills, store)
        if s["enabled"] and s["available"]
    ]
