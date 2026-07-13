"""report 读形状投影 + config patch 规范化 —— transport-neutral 单一真源。

CLI (``src/cli/commands/report.py``) 与 serve-api (``src/api/routers/reports.py``)
都经此做「DB 行 → 前端配置/列表/详情」投影 + 「friendly patch → DB 列」规范化，
避免两份手抄（仿 ``src/services/wire.py`` 的读形状单一真源范式）。

零 transport 依赖：只 import ``src.reports.*`` + 标准库，不 import cli / api / fastapi。
校验错误用 ``ValueError``（caller 各自转 ``CliInvalidArgError`` / ``APIError('E_INVALID_ARG')``）。

形状权威 = 前端 ``ReportAgentConfig`` / ``ReportListItem`` / ``ReportDetail``
（``frontend/src/shared/api/types.ts``）+ 本地 IPC handler（``handlers/report.ts``）。
"""

from __future__ import annotations

import json
from typing import Any, Dict


def parse_counts(raw: Any) -> Dict[str, Any]:
    """counts_json → dict（解析失败/非 dict → {}）。"""
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def resolve_agent(agent: Dict[str, Any]) -> Dict[str, Any]:
    """report_agent DB 行 → 前端友好配置（``ReportAgentConfig``）。

    schedule_json 解析、bool 还原、prompt/model 缺省回填默认（**in-process**
    ``get_default_prompt``，无 CLI fork —— 修「getConfig fork CLI 拖慢 /agents」根因）、
    prompt_is_default flag。逐字段对齐本地 IPC ``report:getConfig`` 形状。
    """
    from src.reports.prompts import get_default_prompt
    from src.reports.summarizer import DEFAULT_REPORT_MODEL

    try:
        schedule = json.loads(agent.get("schedule_json") or "{}")
    except (json.JSONDecodeError, TypeError):
        schedule = {}
    # 防御坏/旧数据：非 dict（JSON array/scalar 会让下面 .get() 崩）或空 dict → 默认 schedule
    # （对齐前端 ReportAgentConfig.schedule 类型契约 cadence/hours 必填 + TS _toAgentConfig fallback）。
    if not isinstance(schedule, dict) or not schedule:
        schedule = {"cadence": "daily", "hours": [9]}
    cadence = schedule.get("cadence", "daily")
    prompt = (agent.get("prompt") or "").strip()
    try:
        body_full_priorities = json.loads(agent.get("body_full_priorities") or "[]")
        if not isinstance(body_full_priorities, list):
            body_full_priorities = []
    except (json.JSONDecodeError, TypeError):
        body_full_priorities = []
    agent_type = agent.get("type", "report")
    # v27: 文档勾选（profile-doc 名列表），preprocess 与 report（增量 2）都用。区分 NULL
    # （列缺失/未设）与 []（用户显式取消全部）：NULL 投影成运行时默认 ['soul','user']（与
    # get_preprocess_config / worker._parse_context_docs 的 None→默认一致，避免 UI 显
    # "未勾选"、保存其他字段时把 docs 覆写成 []→关掉身份注入，codex MED）；
    # [] 保持显式空；非法当 NULL 处理。search 不用此字段 → 一律 []。
    _raw_docs = agent.get("context_docs_json")
    try:
        _parsed_docs = json.loads(_raw_docs) if _raw_docs else None
        if _parsed_docs is not None and not isinstance(_parsed_docs, list):
            _parsed_docs = None
    except (json.JSONDecodeError, TypeError):
        _parsed_docs = None
    if agent_type in ("preprocess", "report"):
        context_docs = _parsed_docs if _parsed_docs is not None else ["soul", "user"]
    else:
        # search 不用此字段 → 一律 []，忽略任何残留列值（codex 复审 MED）。
        context_docs = []
    # v29: preprocess 行级 fallback 链。NULL/非法 → None（投影 null = 跟随全局
    # LLM_FALLBACK_MODELS —— 与 context_docs 不同, 不回填默认: "跟随全局"本身就是前端要显示
    # 的态）；JSON list → list（[] = 显式不设兜底）。非 preprocess 一律 None（不用此字段）。
    _raw_fb = agent.get("fallback_models_json")
    try:
        _parsed_fb = json.loads(_raw_fb) if _raw_fb else None
        if _parsed_fb is not None and not isinstance(_parsed_fb, list):
            _parsed_fb = None
    except (json.JSONDecodeError, TypeError):
        _parsed_fb = None
    if agent_type == "preprocess" and _parsed_fb is not None:
        fallback_models = [str(x) for x in _parsed_fb]
    else:
        fallback_models = None
    # v32: preprocess 行级「处理后自动标已读」。NULL / 缺列默认 true，保证升级前后
    # 行为零变化；非 preprocess 不暴露此语义，投影也保持 true 便于前端类型稳定。
    mark_read_after_processing = (
        bool(agent.get("mark_read_after_processing"))
        if agent_type == "preprocess" and agent.get("mark_read_after_processing") is not None
        else True
    )
    # tools_json → list（DB 存 JSON 串）。NULL/非法：type='search' 回退默认搜索工具,
    # 其余（report）回退空 list（report agent 历史上 tools_json 全 NULL, 不破坏其投影）。
    _tools_default = ["email_search_fulltext"] if agent_type == "search" else []
    try:
        tools_json = json.loads(agent.get("tools_json") or "null")
        if not isinstance(tools_json, list):
            tools_json = _tools_default
    except (json.JSONDecodeError, TypeError):
        tools_json = _tools_default
    # v30: custom agent 三列（trigger/tool_policy/budget）。NULL/非法 → None（投影 null =
    # 非事件型 / 不收窄 / 全默认——都是前端要显示的态，不回填默认）。均为 JSON object。
    # 保存时 set_config(REST)/CLI config-set 已接 validate_agent_config_patch → parse_trigger 拒坏
    # 配置（坏 cron/未知 kind/超长 pattern）；运行时 worker/dispatch 再 parse_trigger 双保险 fail-closed。
    # wire 层 transport-neutral 只做 parse，不深校验。custom 之外的 type 一律 None（不用此三字段）。
    def _parse_obj(raw: Any) -> Any:
        try:
            v = json.loads(raw) if raw else None
        except (json.JSONDecodeError, TypeError):
            return None
        return v if isinstance(v, dict) else None
    _is_custom = agent_type == "custom"
    # v31: project_progress 单例行也用 trigger_json 存触发配置（email_filter 词汇，运行时走
    # ProjectProgressDetector 子串匹配）→ 投影 trigger 供 Settings 抽屉读 sender/subject。
    # tool_policy/budget 仍 custom-only（project_progress 执行不进 gateway，无工具/预算语义）。
    _projects_trigger = agent_type in ("custom", "project_progress")
    trigger = _parse_obj(agent.get("trigger_json")) if _projects_trigger else None
    tool_policy = _parse_obj(agent.get("tool_policy_json")) if _is_custom else None
    budget = _parse_obj(agent.get("budget_json")) if _is_custom else None
    return {
        "id": agent.get("id"),
        "type": agent_type,
        "enabled": bool(agent.get("enabled")),
        "title": agent.get("title") or "",
        "schedule": schedule,
        "window_hours": agent.get("window_hours"),
        "prompt": prompt or (get_default_prompt(cadence) if agent_type == "report" else ""),
        "prompt_is_default": not prompt,
        "model": (agent.get("model") or "").strip()
        or (DEFAULT_REPORT_MODEL if agent_type == "report" else ""),
        "tools_json": tools_json,
        "kos_enrich": bool(agent.get("kos_enrich")),
        # clamp（对齐 TS _toAgentConfig：仅 natural_day 认，其余/坏值回落 rolling_24h）。
        "trigger_mode": (
            "natural_day" if agent.get("trigger_mode") == "natural_day" else "rolling_24h"
        ),
        "timezone": (agent.get("timezone") or ""),
        "body_full_priorities": body_full_priorities,
        "context_docs": context_docs,  # v27: 文档勾选（preprocess + report 增量 2）
        "fallback_models": fallback_models,  # v29: preprocess 行级 fallback（null=跟随全局）
        "mark_read_after_processing": mark_read_after_processing,
        "trigger": trigger,  # v30: custom agent 触发判别式（null=非事件型）
        "tool_policy": tool_policy,  # v30: custom agent 工具收窄（null=不额外收窄）
        "budget": budget,  # v30: custom agent 预算（null=全默认）
        "updated_at": agent.get("updated_at"),
    }


def report_to_list_item(row: Dict[str, Any]) -> Dict[str, Any]:
    """report 列表行 → 前端 ``ReportListItem``（counts_json → counts，剔除 raw）。"""
    item = dict(row)
    item["counts"] = parse_counts(item.pop("counts_json", None))
    return item


def report_to_detail(row: Dict[str, Any]) -> Dict[str, Any]:
    """report 详情行 → 前端 ``ReportDetail``（blocks_json → doc，counts_json → counts）。"""
    item = dict(row)
    blocks_json = item.pop("blocks_json", None)
    try:
        doc = json.loads(blocks_json) if blocks_json else None
    except (json.JSONDecodeError, TypeError):
        doc = None
    item["doc"] = doc
    item["counts"] = parse_counts(item.pop("counts_json", None))
    return item


def config_patch_to_db(raw: Dict[str, Any]) -> Dict[str, Any]:
    """friendly patch（前端 ``ReportConfigPatch``）→ DB 列 patch。

    schedule→schedule_json、bool→int、tools/body_full_priorities→JSON 串。
    校验失败 raise ``ValueError``（caller 转 ``CliInvalidArgError`` / ``APIError``）。
    只认已知 key；``prompt`` None/"" → None（重置默认，``resolve_agent`` 回填）。
    """
    db_patch: Dict[str, Any] = {}
    if "enabled" in raw:
        db_patch["enabled"] = 1 if raw["enabled"] else 0
    if "kos_enrich" in raw:
        db_patch["kos_enrich"] = 1 if raw["kos_enrich"] else 0
    if "title" in raw:
        db_patch["title"] = str(raw["title"])
    if "prompt" in raw:
        # None / "" → 重置为默认（存空，resolve_agent 回填）。
        p = raw["prompt"]
        db_patch["prompt"] = (str(p).strip() or None) if p is not None else None
    if "model" in raw:
        db_patch["model"] = str(raw["model"])
    if "window_hours" in raw:
        try:
            db_patch["window_hours"] = int(raw["window_hours"])
        except (TypeError, ValueError):
            raise ValueError("window_hours must be int")
    if "schedule" in raw and isinstance(raw["schedule"], dict):
        db_patch["schedule_json"] = json.dumps(raw["schedule"], ensure_ascii=False)
    if "tools" in raw:
        db_patch["tools_json"] = json.dumps(raw["tools"], ensure_ascii=False)
    if "trigger_mode" in raw:
        tm = str(raw["trigger_mode"] or "").strip()
        if tm not in ("rolling_24h", "natural_day"):
            raise ValueError("trigger_mode must be rolling_24h|natural_day")
        db_patch["trigger_mode"] = tm
    if "timezone" in raw:
        db_patch["timezone"] = str(raw["timezone"] or "").strip() or None
    if "body_full_priorities" in raw and isinstance(raw["body_full_priorities"], list):
        db_patch["body_full_priorities"] = json.dumps(
            raw["body_full_priorities"], ensure_ascii=False
        )
    if "context_docs" in raw and isinstance(raw["context_docs"], list):
        # v27: 文档勾选（preprocess + report 增量 2）。只存字符串项（doc 名）；运行时
        # build_task_identity_context 再按 PROFILE_DOC_NAMES 过滤非法名，wire 层不校验
        # （transport-neutral）。
        db_patch["context_docs_json"] = json.dumps(
            [str(x) for x in raw["context_docs"]], ensure_ascii=False
        )
    if "fallback_models" in raw:
        # v29: preprocess 行级 fallback 链。与 context_docs 不同：None 必须能显式落 SQL NULL
        # （用户从自定义切回"跟随全局"的路径）；list → JSON 串（[] = 显式不设兜底）。
        fb = raw["fallback_models"]
        if fb is None:
            db_patch["fallback_models_json"] = None
        elif isinstance(fb, list):
            db_patch["fallback_models_json"] = json.dumps(
                [str(x) for x in fb], ensure_ascii=False
            )
        else:
            raise ValueError("fallback_models must be list or null")
    if "mark_read_after_processing" in raw:
        value = raw["mark_read_after_processing"]
        if not isinstance(value, bool):
            raise ValueError("mark_read_after_processing must be bool")
        db_patch["mark_read_after_processing"] = 1 if value else 0
    # v30: custom agent 三列（trigger/tool_policy/budget）。dict → JSON 串；None → SQL NULL
    # （清空该配置）；非 dict → ValueError（结构闸）。深校验（trigger 判别式 / cron 合法性 /
    # ReDoS 长度）由 set_config(REST)/CLI config-set 的 validate_agent_config_patch → parse_trigger
    # 在保存时做（坏配置拒并给 owner 反馈）；运行时 worker/dispatch 再 parse_trigger 双保险 fail-closed。
    for _friendly, _col in (
        ("trigger", "trigger_json"),
        ("tool_policy", "tool_policy_json"),
        ("budget", "budget_json"),
    ):
        if _friendly in raw:
            _v = raw[_friendly]
            if _v is None:
                db_patch[_col] = None
            elif isinstance(_v, dict):
                db_patch[_col] = json.dumps(_v, ensure_ascii=False)
            else:
                raise ValueError(f"{_friendly} must be object or null")
    return db_patch
