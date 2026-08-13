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

import base64
import json
import re
from typing import Any, Dict, Tuple

# ─── 上传态头像（0804 dogfood WP7）───────────────────────────────────────────
# owner 拍板 base64 内嵌：图片随 report_agent.avatar_json 一起走既有 PATCH。前端已把图裁成
# ≤256×256 的 webp，这里是**服务端复核**（前端可被绕过：CLI / serve-api / agent 工具都能直发
# patch）。上限与前端 `avatarImage.ts` 的 AVATAR_IMAGE_MAX_BYTES 各自成文、数值必须一致。
AVATAR_IMAGE_MAX_BYTES = 150 * 1024
# 先按**字符数**拒超长，再 b64decode —— 反过来就是拿无界字符串去解码（一个 100MB 的 data URI
# 能把 serve-api 的内存打上去）。4/3 膨胀 + data URI 前缀，留 64 字符余量。
AVATAR_IMAGE_MAX_DATA_URI_CHARS = (AVATAR_IMAGE_MAX_BYTES + 2) // 3 * 4 + 64
# 🔴 尾锚必须是 ``\Z`` 不是 ``$``：Python 的 ``$`` 还匹配「结尾换行**之前**」，而前端渲染判别
# （agentAvatarIdentity.isAgentAvatarImage）用的 JS ``$``（无 m 标志）只匹配真结尾。用 ``$`` 时
# ``…base64,QUJD\n`` 会被后端收下并原样落库，前端却认不出 → 头像在界面上静默变回生成头像
# （正是下面两道跨语言闸想防的失败形态，但闸只比 mime 集合、比不到锚点语义）。
_AVATAR_IMAGE_DATA_URI_RE = re.compile(
    r"^data:image/(?:webp|png|jpeg);base64,([A-Za-z0-9+/]+={0,2})\Z"
)


def _normalize_avatar_image(avatar: Dict[str, Any]) -> Dict[str, Any]:
    """``{"type":"image","data":"data:image/webp;base64,…"}`` → 规范化 dict（坏值 ValueError）。

    只认 base64 data URI（webp/png/jpeg 三 mime），不认 http(s) URL —— 外链头像会让本地
    渲染发出网络请求（追踪像素/离线空图两个问题），与「桌面 app 本地优先」相悖。
    """
    data = avatar.get("data")
    if not isinstance(data, str) or not data:
        raise ValueError("avatar.data must be a non-empty data URI string")
    if len(data) > AVATAR_IMAGE_MAX_DATA_URI_CHARS:
        raise ValueError(f"avatar.data exceeds {AVATAR_IMAGE_MAX_BYTES} bytes")
    match = _AVATAR_IMAGE_DATA_URI_RE.match(data)
    if not match:
        raise ValueError("avatar.data must be a base64 data URI of image/webp|png|jpeg")
    try:
        # binascii.Error 是 ValueError 子类；validate=True 顺带拒掉换行/空格等非规范形态。
        decoded = base64.b64decode(match.group(1), validate=True)
    except ValueError as exc:
        raise ValueError("avatar.data is not valid base64") from exc
    if not decoded:
        raise ValueError("avatar.data decodes to empty bytes")
    if len(decoded) > AVATAR_IMAGE_MAX_BYTES:
        raise ValueError(f"avatar.data exceeds {AVATAR_IMAGE_MAX_BYTES} bytes")
    return {"type": "image", "data": data}


# ─── bot 头像词表（08-12 living-bot-avatar）──────────────────────────────────
# avatar_json 第三种 kind：{"type":"bot","shape":…,"color":…}（另两种：type='image' 上传态、
# 无 type 键 = legacy oreo 生成式）。词表以这里为跨语言 canonical —— 前端
# frontend/src/shared/bot-avatar/{shapes,colors}.ts 手抄同一份驱动编辑器网格与渲染，
# 闸 = tests/config/test_bot_avatar_vocab_parity.py（任一侧漂移/改名/重排必红）。
BOT_AVATAR_SHAPES = (
    "blob",
    "capsule",
    "squircle",
    "egg",
    "wedge",
    "hex",
    "cloud",
    "teardrop",
)
BOT_AVATAR_COLORS = (
    "white",
    "brown",
    "red",
    "orange",
    "yellow",
    "green",
    "teal",
    "blue",
    "purple",
    "pink",
    "gray",
)


def parse_counts(raw: Any) -> Dict[str, Any]:
    """counts_json → dict（解析失败/非 dict → {}）。"""
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def connector_grants_of(agent: Dict[str, Any]) -> Tuple[Tuple[str, str], ...]:
    """report_agent 行 → ``((connector_id, crud 天花板), …)``（MCP connector PR3）。

    读侧**宽容**（镜像 ``agent_runs._tool_policy_lenient``）：坏 / 缺失 ``tool_policy_json``
    → ``()`` = 无授权 = 不挂任何 connector 工具（fail-closed 方向）。保存面
    （``validate_agent_config_patch`` → ``parse_tool_policy``）已严格拒坏形状与 ``delete``
    天花板，故这里退回空集只发生在旧行 / 手改库上。

    函数内 import ``src.agents.trigger``：wire 模块的 transport-neutral 承诺是「不 import
    cli / api / fastapi」，且顶层 import 会把 agents 链拖进每个 wire 使用者的启动路径。
    """
    from src.agents.trigger import parse_tool_policy

    try:
        return parse_tool_policy(agent.get("tool_policy_json")).grant_connectors
    except ValueError:
        return ()


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
    # v38: preprocess 行级参考上下文源。合法值（'standing_docs'|'notion_context'）原样投影；
    # NULL/野值 → None（前端 deriveContextSource 按 LLM_CONTEXT_PAGE_ID 继承派生显示态，与后端
    # _resolve_context_source 一致）。非 preprocess 恒 None（不用此字段）。
    _raw_src = (agent.get("context_source") or "").strip().lower() if agent_type == "preprocess" else ""
    context_source = _raw_src if _raw_src in ("standing_docs", "notion_context") else None
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
    if _is_custom:
        tool_policy = _parse_obj(agent.get("tool_policy_json"))
    else:
        # MCP connector PR3：**报告 Agent 也是 connector 的调用方**（PRD 决策 8），故 report 行
        # 的 tool_policy 需要能 round-trip 回来 —— 否则 owner PUT 了 grant_connectors、GET 读不到，
        # 界面永远显示"没配"。只投影 grant_connectors 这一个键：allowed_tools / grant_exec /
        # grant_web / skills 对 report 行无语义（报告执行是 Python 直调 tool loop，不进 gateway
        # 矩阵），维持 custom-only 现状不动。
        _raw_tp = _parse_obj(agent.get("tool_policy_json")) if agent_type == "report" else None
        _gc = _raw_tp.get("grant_connectors") if isinstance(_raw_tp, dict) else None
        tool_policy = {"v": 1, "grant_connectors": _gc} if isinstance(_gc, dict) and _gc else None
    raw_budget = _parse_obj(agent.get("budget_json")) if _is_custom else None
    # 07-28 W1: max_steps 已退出用户契约。旧行可继续带该键，但 wire 永不再投影；保存路径同样
    # 只接受/持久化频率与 wall-clock 两门，做到无需 DB 迁移即可收敛公开形状。
    budget = None
    if raw_budget is not None:
        budget = {"v": 1}
        for key in ("max_runs_per_day", "max_run_seconds"):
            if key in raw_budget:
                budget[key] = raw_budget[key]
    avatar = _parse_obj(agent.get("avatar_json"))
    return {
        "id": agent.get("id"),
        "type": agent_type,
        "enabled": bool(agent.get("enabled")),
        "title": agent.get("title") or "",
        "description": agent.get("description"),
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
        "context_source": context_source,  # v38: preprocess 参考上下文源（null=继承派生）
        "trigger": trigger,  # v30: custom agent 触发判别式（null=非事件型）
        "tool_policy": tool_policy,  # v30: custom agent 工具收窄（null=不额外收窄）
        "budget": budget,  # v30: custom agent 预算（null=全默认）
        "avatar": avatar,  # v42: null=按 agent id 确定性派生
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
    if "description" in raw:
        description = raw["description"]
        if description is None:
            db_patch["description"] = None
        elif isinstance(description, str):
            normalized = description.strip()
            if len(normalized) > 1000:
                raise ValueError("description must be at most 1000 characters")
            db_patch["description"] = normalized or None
        else:
            raise ValueError("description must be string or null")
    if "prompt" in raw:
        # None / "" → 重置为默认（存空，resolve_agent 回填）。
        p = raw["prompt"]
        db_patch["prompt"] = (str(p).strip() or None) if p is not None else None
    if "model" in raw:
        # None / "" → 重置为默认（存 NULL，resolve 侧回落）；此前无条件 str() 会把
        # None 落成字面 'None' 字符串（P9 agent 导入/模板是首个显式传 null 的调用方）。
        m = raw["model"]
        db_patch["model"] = (str(m).strip() or None) if m is not None else None
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
    if "context_source" in raw:
        # v38: preprocess 参考上下文源。None → SQL NULL（重置回继承派生）；合法枚举串 → 原样落列；
        # 其它值 → ValueError（保存闸，防野值污染热读）。仅 'standing_docs'|'notion_context' 二选一。
        cs = raw["context_source"]
        if cs is None:
            db_patch["context_source"] = None
        elif isinstance(cs, str) and cs in ("standing_docs", "notion_context"):
            db_patch["context_source"] = cs
        else:
            raise ValueError("context_source must be 'standing_docs'|'notion_context'|null")
    if "avatar" in raw:
        avatar = raw["avatar"]
        if avatar is None:
            db_patch["avatar_json"] = None
        elif isinstance(avatar, dict) and avatar.get("type") == "image":
            # WP7 上传态。判别式只在 image 一侧 —— 存量生成式行没有 type 键，缺省即生成式
            # （零迁移），下面那支逐字不动。
            db_patch["avatar_json"] = json.dumps(
                _normalize_avatar_image(avatar), ensure_ascii=False
            )
        elif isinstance(avatar, dict) and avatar.get("type") == "bot":
            # bot 生成式（灵动头像，08-12）。排序理由：三种 kind 的判别都压在 `type` 键上
            # （'image' / 'bot' / 无 type = legacy oreo），而最后的 legacy 支是
            # `isinstance(dict)` 兜底 —— bot 放它后面结构上不可达（会被按 oreo 词表误拒）；
            # 放 image 前面又打乱「显式 type 逐个判、无 type 落兜底」的读法。存量两支逐字不动。
            shape = avatar.get("shape")
            color = avatar.get("color")
            if shape not in BOT_AVATAR_SHAPES:
                raise ValueError("avatar.shape must be a supported bot shape")
            if color not in BOT_AVATAR_COLORS:
                raise ValueError("avatar.color must be a supported bot color")
            if set(avatar) != {"type", "shape", "color"}:
                # 与 image 支的「静默剥多余键」不同：bot 的生产者只有本仓前端与 P9 导入闸，
                # 多余键只可能是词表演进期的形状漂移 —— 宽容剥键会把它掩埋成静默丢字段。
                raise ValueError("avatar with type=bot accepts only keys: type, shape, color")
            db_patch["avatar_json"] = json.dumps(
                {"type": "bot", "shape": shape, "color": color}, ensure_ascii=False
            )
        elif isinstance(avatar, dict):
            shape = avatar.get("shape")
            palette = avatar.get("palette")
            variant_id = avatar.get("variant_id")
            if shape not in ("bloom", "silk", "flare", "nova", "void", "jade"):
                raise ValueError("avatar.shape must be a supported shape")
            if not isinstance(palette, str) or not palette.strip() or len(palette) > 80:
                raise ValueError("avatar.palette must be a non-empty string (max 80 chars)")
            if variant_id is not None and (
                not isinstance(variant_id, str) or len(variant_id) > 160
            ):
                raise ValueError("avatar.variant_id must be a string (max 160 chars)")
            normalized = {"shape": shape, "palette": palette.strip()}
            if variant_id:
                normalized["variant_id"] = variant_id
            db_patch["avatar_json"] = json.dumps(normalized, ensure_ascii=False)
        else:
            raise ValueError("avatar must be object or null")
    # v30: custom agent 三列（trigger/tool_policy/budget）。dict → JSON 串；None → SQL NULL
    # （清空该配置）；非 dict → ValueError（结构闸）。深校验（trigger 判别式 / cron 合法性 /
    # ReDoS 长度）由 set_config(REST)/CLI config-set 的 validate_agent_config_patch → parse_trigger
    # 在保存时做（坏配置拒并给 owner 反馈）；运行时 worker/dispatch 再 parse_trigger 双保险 fail-closed。
    for _friendly, _col in (
        ("trigger", "trigger_json"),
        ("tool_policy", "tool_policy_json"),
    ):
        if _friendly in raw:
            _v = raw[_friendly]
            if _v is None:
                db_patch[_col] = None
            elif isinstance(_v, dict):
                db_patch[_col] = json.dumps(_v, ensure_ascii=False)
            else:
                raise ValueError(f"{_friendly} must be object or null")
    if "budget" in raw:
        value = raw["budget"]
        if value is None:
            db_patch["budget_json"] = None
        elif isinstance(value, dict):
            clean = {"v": 1}
            for key in ("max_runs_per_day", "max_run_seconds"):
                if key in value:
                    clean[key] = value[key]
            db_patch["budget_json"] = json.dumps(clean, ensure_ascii=False)
        else:
            raise ValueError("budget must be object or null")
    return db_patch
