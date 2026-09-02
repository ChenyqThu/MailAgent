"""g3 狼人杀实验 —— 一键建局的业务叶子（HTTP 端点在 ``src/api/routers/agent.py``）。

一局 = 七个 custom agent 行（法官 + 六玩家，按标题跨局复用）+ 三个群会话（主群 M、狼群 W、
预言家群 S，W/S 的父是 M）+ 三份群设置（``preset`` / ``game`` / 法官位）。

红线：成员上限、子群 ⊆ 父群、chat-capable 的权威校验只有 ``chat.create_session_validated``
一条路径，本文件一条都不复制；地板数值（chainCap / hourly* / sessionTurnCap）**不落库**，
由 gateway 按 ``preset`` 套 groupFloors.ts 的缺省。

🔴 ``roles`` 是服务端事实：只出现在返回值与 ``group_config_json`` 里，本文件零 logger 调用
（端点层只打 session id / seed / reusedAgents）。
"""

from __future__ import annotations

import contextlib
import random
from typing import Any, Dict, List, Sequence, Tuple

from src.agents.agent_templates import (
    AGENT_TEMPLATES,
    WEREWOLF_JUDGE_TITLE,
    WEREWOLF_PLAYER_TITLES,
)
from src.agents.plugin_compat import import_custom_agent
from src.agents.trigger import normalize_agent_config_patch
from src.chat.group_limits import group_scope_hash
from src.reports import wire

#: 角色池（洗牌后按顺序发给六个玩家）。🔴 元素顺序是契约的一部分：改它会改变同 seed 的结果。
_WEREWOLF_ROLE_POOL: Tuple[str, ...] = (
    "wolf",
    "wolf",
    "seer",
    "villager",
    "villager",
    "villager",
)
#: 写库前的值域校验用（``game.roles`` 的值集）。
WEREWOLF_ROLES: Tuple[str, ...] = ("wolf", "seer", "villager")

_TEMPLATE_JUDGE = "werewolf_judge"
_TEMPLATE_PLAYER = "werewolf_player"


def seeded_roles(seed: int, player_agent_ids: Sequence[str]) -> Dict[str, str]:
    """按 seed 洗牌角色池后 zip 玩家 id。

    🔴 顺序与算法都是契约：``random.Random(seed).shuffle(list(_WEREWOLF_ROLE_POOL))``。改元素序
    会改变同 seed 的结果；跨 CPython 大版本不保证复现（roles 落库即权威，读侧不靠重算）。
    """
    pool = list(_WEREWOLF_ROLE_POOL)
    random.Random(seed).shuffle(pool)
    return dict(zip(player_agent_ids, pool))


def ensure_template_agent(store: Any, template_key: str, title: str) -> Tuple[str, bool]:
    """按 ``(type=='custom', title.strip())`` 查重；命中返回 ``(id, True)``，否则导入返回 ``(id, False)``。

    ``report_agent`` 没有 template_key 列（g3 无 schema 变更），标题就是唯一可用的查重键 ——
    owner 手改了标题，下一局会新建一份（近似解，行为闸 test_renamed_title_creates_new_row）。
    导入恒走 ``import_custom_agent`` 的 payload 分支：六玩家共用一个模板、只覆写 title，
    template 分支没有 title 覆写入口。
    """
    wanted = title.strip()
    for row in store.list_agents():
        if (row.get("type") or "") == "custom" and str(row.get("title") or "").strip() == wanted:
            return str(row.get("id")), True
    result = import_custom_agent(
        {
            "payload": {
                "schema_version": 1,
                "kind": "mailagent.custom_agent",
                "agent": {**AGENT_TEMPLATES[template_key], "title": wanted},
            }
        },
        store,
    )
    return str(result["agent"]["id"]), False


def _require_provider(model_ref: Any) -> None:
    """``providerId:modelId`` 的 provider 必须已配置，否则 400（**不静默回落全局默认**）。

    静默回落的代价是第三个 turn 整局死：speakAsGroupMember 拿不到凭证就 throw，调度器连续
    三次 failed 之后按 'error' 停 —— owner 只会看到「群自己不说话了」。
    """
    if not model_ref:
        return
    from src.agent_config.llm_providers import get_llm_provider_store
    from src.api.app import APIError

    provider_id = str(model_ref).split(":", 1)[0]
    if get_llm_provider_store().get_provider(provider_id) is None:
        raise APIError(
            "E_INVALID_ARG",
            f"model provider {provider_id!r} is not configured",
            hint="先在设置 → 模型服务里配置该 provider",
            source="sqlite",
        )


def _apply_model(store: Any, agent_id: str, model_ref: Any) -> None:
    """写 agent 的模型引用（复用 normalize + wire 的列映射，不直接写列）。"""
    if not model_ref:
        return
    patch = normalize_agent_config_patch({"model": str(model_ref)}, agent_type="custom")
    store.update_agent(agent_id, wire.config_patch_to_db(patch))


def _agent_titles(store: Any, agent_ids: Sequence[str]) -> Dict[str, str]:
    """七个 agent 行的显示名（导入 / 复用后的 ``report_agent`` 行 title），写进 ``game.titles``。

    子群名单里只有本群成员，法官在子群的 ``<game_secret>`` 全表要靠这份表给不在名单里的
    玩家取名；否则预言家说「验玩家丁」时法官只看得到 agentId，对不上人。
    """
    wanted = set(agent_ids)
    return {
        str(row.get("id")): str(row.get("title") or "")
        for row in store.list_agents()
        if str(row.get("id")) in wanted
    }


def _write_group_config(
    db: Any, session_id: int, raw_members_json: Any, patch: Dict[str, Any]
) -> None:
    """整块覆写 ``group_config_json``（``v:1`` 由 update_group_config 补）。

    ``judgeScopeHash`` 由名单列**原文**现算：免卡判据钉的是 owner 确认那一刻的那份原文，
    重序列化（等价重排）即失配。
    """
    cfg = dict(db.get_group_config(session_id)["config"])
    cfg.update(patch)
    cfg["judgeScopeHash"] = group_scope_hash(raw_members_json)
    db.update_group_config(session_id, cfg)


def _next_title(db: Any, title_prefix: str) -> str:
    """``<prefix> #n`` —— n = 已有的同前缀顶级群数 + 1（子群不计，它们带后缀）。"""
    prefix = f"{title_prefix} #"
    existing = db.list_all_sessions(origin="group", include_archived=True, limit=1000)
    used = sum(
        1
        for row in existing
        if str(row.get("title") or "").startswith(prefix) and row.get("parent_session_id") is None
    )
    return f"{prefix}{used + 1}"


async def new_game(
    *,
    seed: int,
    judge_model: Any = None,
    player_model: Any = None,
    title_prefix: str,
) -> Dict[str, Any]:
    """建一局：七个 agent → 角色 → 三群 → 三份群设置。返回端点应答 dict（不含 envelope）。

    建群失败 → 倒序删掉已建的会话再抛原错（半成品比没有更难收拾）；群设置写失败**不抛**，
    以 ``configApplied: False`` 回报 —— 三个群已经在了，owner 至少能看到并自行删。
    """
    from src.api.deps import get_chat_db, get_report_store
    from src.api.routers.chat import create_session_validated

    _require_provider(judge_model)
    _require_provider(player_model)

    store = get_report_store()
    db = get_chat_db()

    judge_id, judge_reused = ensure_template_agent(store, _TEMPLATE_JUDGE, WEREWOLF_JUDGE_TITLE)
    player_ids: List[str] = []
    reused_agents = judge_reused
    for player_title in WEREWOLF_PLAYER_TITLES:
        player_id, reused = ensure_template_agent(store, _TEMPLATE_PLAYER, player_title)
        player_ids.append(player_id)
        reused_agents = reused_agents and reused

    _apply_model(store, judge_id, judge_model)
    for player_id in player_ids:
        _apply_model(store, player_id, player_model)

    titles = _agent_titles(store, [judge_id, *player_ids])
    roles = seeded_roles(seed, player_ids)
    wolves = [pid for pid in player_ids if roles[pid] == "wolf"]
    seers = [pid for pid in player_ids if roles[pid] == "seer"]
    if set(roles.values()) - set(WEREWOLF_ROLES) or len(wolves) != 2 or len(seers) != 1:
        raise RuntimeError("werewolf role pool produced an unexpected distribution")

    title = _next_title(db, title_prefix)
    created: List[int] = []
    try:
        main = await create_session_validated(
            {
                "anchorType": "general",
                "backendKind": "ai-sdk",
                "groupMembers": [judge_id, *player_ids],
                "title": title,
                "invokedBy": "setup",
            }
        )
        created.append(int(main["id"]))
        wolf = await create_session_validated(
            {
                "anchorType": "general",
                "backendKind": "ai-sdk",
                "groupMembers": [judge_id, *wolves],
                "title": f"{title} · 狼群",
                "parentSessionId": int(main["id"]),
                "invokedBy": "setup",
            }
        )
        created.append(int(wolf["id"]))
        seer = await create_session_validated(
            {
                "anchorType": "general",
                "backendKind": "ai-sdk",
                "groupMembers": [judge_id, seers[0]],
                "title": f"{title} · 预言家",
                "parentSessionId": int(main["id"]),
                "invokedBy": "setup",
            }
        )
        created.append(int(seer["id"]))
    except Exception:
        for session_id in reversed(created):
            with contextlib.suppress(Exception):
                db.delete_session(session_id)
        raise

    game = {"kind": "werewolf", "seed": seed, "roles": roles, "titles": titles}
    config_applied = True
    try:
        for session_id, members in (
            (int(main["id"]), player_ids),
            (int(wolf["id"]), wolves),
            (int(seer["id"]), [seers[0]]),
        ):
            raw_members = (db.get_session(session_id) or {}).get("members_json")
            _write_group_config(
                db,
                session_id,
                raw_members,
                {"judgeAgentId": judge_id, "preset": "werewolf", "game": game},
            )
            db.upsert_group_member_modes(
                session_id,
                {judge_id: "realtime", **{pid: "mention" for pid in members}},
            )
    except Exception:  # noqa: BLE001 — 群已建好，写设置失败只降级回报，不回滚整局
        config_applied = False

    return {
        "mainSessionId": int(main["id"]),
        "wolfSessionId": int(wolf["id"]),
        "seerSessionId": int(seer["id"]),
        "mainSession": main,
        "title": title,
        "seed": seed,
        "judgeAgentId": judge_id,
        "roles": roles,
        "players": [
            {"agentId": pid, "title": titles[pid], "role": roles[pid]} for pid in player_ids
        ],
        "reusedAgents": reused_agents,
        "configApplied": config_applied,
    }
