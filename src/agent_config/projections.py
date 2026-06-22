"""MEMORY/SKILLS 投影 + 配置快照 hash（Phase -1 / 0A · PR2）.

- ``MEMORY.md`` / ``SKILLS.md`` 不存表 —— 它们是 ``agent_memory_kv`` 与 skill registry
  的**只读投影**（避免双 SSoT 漂移，plan §D）。MEMORY 投影**复用** ``ChatDb.memory_summary()``
  语义（不重写）。
- hash helpers 给 Phase 0 eval trace 提供**确定性**配置快照：``installed_skills_hash``
  （builtin name|version 签名 + store 安装行指纹，canonical 排序 → sha256）。
  ``agent_profile_hash`` 由 ``AgentConfigStore.profile_hash()`` 提供；``active_skills_hash``
  是客户端派生（含 @mention 叠加 + collision-exempt），不在后端（plan §F）。
"""

from __future__ import annotations

import hashlib
from typing import Any, Iterable

from src.agent_config.store import AgentConfigStore


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# 文档投影
# ---------------------------------------------------------------------------


def memory_doc_projection(memory_summary: str) -> str:
    """MEMORY.md 投影 —— 包一层 markdown 头。``memory_summary`` 来自 ``ChatDb.memory_summary()``
    （scope='user' top-20，``- key: val``，trunc 2000）。空 → 友好占位。"""
    body = (memory_summary or "").strip()
    if not body:
        return "# MEMORY\n\n(No durable memory yet.)\n"
    return f"# MEMORY\n\n{body}\n"


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
