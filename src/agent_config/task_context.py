"""按需把 Standing Context 身份文档注入后台任务的 system prompt（issue #31/#32 Part2 增量1）。

Part 1 已把 reports / LLM 邮件分类的 prompt 去硬编码成通用「用户」表述；这里把用户的
真实身份（姓名 / 工作方式 / 偏好）从 backend `agent_config.db` 的 Standing Context
身份文档（soul / user）读出来 prepend，让通用措辞被真实身份 grounding。

- **总开关** `cfg.task_identity_docs_enabled`（默认 True）；off → 返回空串 →
  调用点 prepend 空串 = 字节级回退到 Part 1 的通用 prompt（不可弱化的回退不变量）。
- **只读**：`seed_if_absent=False`，绝不从后台任务写库 / 触发 seed（seed 由编辑器 /
  /chat/config 等前台路径负责）。文档缺失 / 为空 → 跳过该文档。
- per-task 勾选哪些文档（默认勾选一些）是增量 2 的事；本增量用全局默认文档集
  （soul + user）+ 总开关，不加 DB 列、不 bump DB_VERSION。
"""

from __future__ import annotations

from typing import Sequence

from loguru import logger

from src.config import config as cfg

# 增量 1 默认注入的身份文档：soul（身份 / 语气）+ user（画像 / 偏好）。
# agent（工作方式）/ rules（用户级硬规则）偏 agent 行为，后台策展任务不默认拉。
DEFAULT_TASK_IDENTITY_DOCS: tuple[str, ...] = ("soul", "user")


def build_task_identity_context(
    doc_names: Sequence[str] = DEFAULT_TASK_IDENTITY_DOCS,
) -> str:
    """读身份文档拼成 system prompt 注入块；关 / 空 / 失败 → 返回 ``""``。

    返回非空时形如 ``"## User identity ...\\n\\n<doc>\\n\\n<doc>\\n\\n"``，供调用点直接
    prepend 到 persona / header 前。返回 ``""`` 时 prepend 无副作用（字节级不变）。
    """
    if not getattr(cfg, "task_identity_docs_enabled", True):
        return ""

    try:
        from src.agent_config import get_agent_config_store
        from src.agent_config.store import PROFILE_DOC_NAMES
    except Exception as e:  # agent_config 不可用（异常环境）→ 静默降级
        logger.debug(f"[task-identity] agent_config import failed: {e!r}")
        return ""

    names = [n for n in doc_names if n in PROFILE_DOC_NAMES]
    if not names:
        return ""

    try:
        store = get_agent_config_store()
    except Exception as e:
        logger.debug(f"[task-identity] store unavailable: {e!r}")
        return ""

    parts: list[str] = []
    for name in names:
        try:
            doc = store.get_profile_doc(name, seed_if_absent=False)
        except Exception:
            # 文档尚未 seed（KeyError）或读失败 → 跳过（不从后台写库）
            continue
        text = (doc.content or "").strip()
        if text:
            parts.append(text)

    if not parts:
        return ""

    return (
        "## User identity & preferences (Standing Context — read-only background; "
        "do not echo verbatim)\n\n"
        + "\n\n".join(parts)
        + "\n\n"
    )
