"""全局「跟进 Agent 默认」（model / effort / fallback）的存取单源（0813 dogfood 轮 3 · B10）。

owner 原话：「跟进规则的**全局** matter agent 配置，仍然没有模型配置啊，看设计，override
倒是有了」—— 上一批只给了**事项级覆盖**（`schedule_json` envelope 的 `agent` 块），而
「全局 matter agent」这一层自己对模型没有任何意见，于是所有没单独配过的事项只能跟绑定
profile 或 gateway 全局默认走。这个模块补的就是中间那一层。

落点 = `agent_config.db` 的 `owner_settings`（键 `matter_agent_defaults`），理由：
  · 同一个弹窗里的网页三档（`matter_run_web_face`）已经走这条路，读写设施现成；
  · **零 DB 迁移**（该库不进 `DB_VERSION`）、**零 env 载体**（不必再养一份跨语言 flag 闸），
    且 owner UI 保存即生效（不重启后端）。

🔴 值域校验**不另写一份** —— 直接复用事项级那套（`triggers.normalize_agent_overrides` 写侧
严格 / `triggers.coerce_agent_overrides` 读侧宽容）。两层配的是同三个键、同一份 effort 词表、
同一个 `[]` 语义，各写一遍就会在「新增一档 effort」这类边角上悄悄漂开。

🔴 `fallback_models: []` 在这一层同样是**显式不设兜底**，与「没配过」不是一回事：前者会压过
gateway 的默认兜底链，后者跟着它走。所以判的一直是「键在不在」，不是「列表真不真」。
"""

from __future__ import annotations

import json
from typing import Any

from loguru import logger

from .triggers import coerce_agent_overrides

#: owner_settings 的键名。🔴 只有本模块与 `src/api/routers/matters.py` 的两个端点碰它。
MATTER_AGENT_DEFAULTS_KEY = "matter_agent_defaults"


def load_agent_defaults() -> dict[str, Any]:
    """读全局默认 → `{model?, effort?, fallback_models?}`；没配过 → `{}`。

    读侧一律**宽容**（同 `parse_agent_overrides` 的取舍）：无行 / 坏 JSON / 认不出的字段
    统统降级成「这一项没配」，剩下的照用。跟进 run 不该因为一段可选的默认值读不出来就
    跑不起来 —— 读不出来时它本来就该退回 gateway 全局默认，那正是没有这个功能时的行为。
    """
    try:
        from src.agent_config.store import get_agent_config_store

        raw = get_agent_config_store().get_owner_setting(MATTER_AGENT_DEFAULTS_KEY)
    except Exception as exc:  # noqa: BLE001 — 配置库未初始化/权限/损坏都回落「没配过」
        logger.debug(f"[matter-run] matter agent defaults unavailable: {exc}")
        return {}
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        logger.debug("[matter-run] matter agent defaults row is not valid JSON")
        return {}
    return coerce_agent_overrides(data)


def dump_agent_defaults(normalized: dict[str, Any] | None) -> str:
    """归一化结果 → 落库字符串。一项都没配 → `'{}'`（`set_owner_setting` 只收字符串，
    且「清空」必须能表达 —— 留着旧行会让 UI 上刚清掉的值在下一轮 run 里复活）。"""
    return json.dumps(normalized or {}, ensure_ascii=False, sort_keys=True)
