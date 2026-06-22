"""Capability & Context 配置面（Phase -1 / 0A，task 06-22-harness-agent-polish）.

eval 评测的是「某一套 agent profile + active skills + memory + rules 版本」下的行为，
所以先把 agent 的能力配置面 + 站立上下文做成稳定、可复现、可 hash 的底座：

  - 统一 skill registry（builtin 懒覆盖 + 用户安装 skill）→ merge 进 src/skills/registry。
  - Standing Context 文档 SOUL/AGENT/RULES/USER（用户/agent 经确认可编辑，带版本历史）。
  - 配置快照 hash（agent_profile_hash / installed_skills_hash），供 Phase 0 eval trace。

存储铁律：backend-owned ``agent_config.db``（sync_store 同目录，可经
``MAILAGENT_AGENT_CONFIG_DB_PATH`` 覆盖），**绝不**写前端 owned 的 ``ai_chat.db``，
不参与 ``DB_VERSION``（CREATE TABLE IF NOT EXISTS 幂等）。详见 ``store.py``。
"""

from src.agent_config.store import (
    AgentConfigStore,
    ProfileDoc,
    ProfileHistoryEntry,
    SkillRow,
    get_agent_config_store,
    resolve_agent_config_db_path,
    resolve_enabled,
    reset_agent_config_store_cache,
)

__all__ = [
    "AgentConfigStore",
    "ProfileDoc",
    "ProfileHistoryEntry",
    "SkillRow",
    "get_agent_config_store",
    "resolve_agent_config_db_path",
    "resolve_enabled",
    "reset_agent_config_store_cache",
]
