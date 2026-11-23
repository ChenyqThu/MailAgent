"""Group chat membership, configuration, metrics, and thread routes."""

from __future__ import annotations

import sqlite3
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Query, Request

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.chat.db import parse_group_member_ids
from src.chat.group_limits import (
    CHAIN_CAP_MAX,
    CHAIN_CAP_MIN,
    MAX_GROUP_MEMBERS,
    MODEL_OVERRIDE_MAX_CHARS,
    RESPONSE_MODES,
    THREAD_TITLE_MAX_CHARS,
    TOPIC_MAX_CHARS,
    group_scope_hash,
)

router = APIRouter()


def _chat_facade():
    from src.api.routers import chat as m

    return m


def _require_group_session(session_id: int) -> Dict[str, Any]:
    """群端点的共用前置：会话必须存在且 origin='group'，返回该行。

    🔴 非群会话一律 400 而不是「按空群处理」——群设置写到普通会话行上是静默的数据污染
    （那一列在别的读面上不显示，谁都不会发现）。"""
    session = _chat_facade().get_chat_db().get_session(session_id)
    if session is None:
        raise APIError("E_NOT_FOUND", f"session {session_id} not found", source="sqlite")
    if (session.get("origin") or "") != "group":
        raise APIError(
            "E_INVALID_ARG", f"session {session_id} is not a group session", source="sqlite"
        )
    return session


def _group_member_ids(session: Dict[str, Any]) -> List[str]:
    """``members_json`` → 成员 id 列表（宽容解析，与 TS ``parseGroupMemberIds`` 同口径：
    坏 JSON / 非数组 / 非字符串项一律丢弃 → 空名单 = 任何 modes 键都不合法）。"""
    return parse_group_member_ids(session.get("members_json"))


def _require_id_list(value: Any, field: str) -> List[str]:
    """``{add, remove}`` 的一项 → 去空白后的 id 列表。非数组 / 非字符串项 / 组内重复 → 400。"""
    if value is None:
        return []
    if not isinstance(value, list) or any(
        not isinstance(m, str) or not m.strip() for m in value
    ):
        raise APIError(
            "E_INVALID_ARG",
            f"group-members {field} must be an array of agent ids",
            hint=f"{field} 只接受非空字符串数组（省略该键 = 不动）",
            source="sqlite",
        )
    ids = [m.strip() for m in value]
    if len(set(ids)) != len(ids):
        raise APIError(
            "E_INVALID_ARG",
            f"group-members {field} must not repeat an agent id",
            hint=f"{field} 里有重复的成员 id",
            source="sqlite",
        )
    return ids


@router.patch(
    "/sessions/{session_id:int}/group-members", dependencies=[Depends(verify_cf_access)]
)
async def patch_group_members(
    request: Request, session_id: int, body: Optional[Dict[str, Any]] = None
):
    """群成员写面：加人 / 踢人。body = ``{add?: [agentId], remove?: [agentId]}``（至少一项非空）。

    **权威校验全在这里**（红线 5：UI 只是礼貌提示）：会话必须 origin='group'；add 的每一位
    必须存在且 chat-capable；add 不许已在群里；remove 必须都在群里；add ∩ remove = ∅；
    结果名单 1 ≤ len ≤ MAX_GROUP_MEMBERS（空群拒 —— 没有成员的群谁都唤不醒，只会静默不回）。
    全部 4xx 走 ``E_INVALID_ARG`` + ``hint``，**不新增错误码**：没在 ERROR_CODE_TO_HTTP 登记的
    码会被 app.py 兜底成 500，UI 拿到的就是「服务器错误」而不是「这个人已经在群里了」。

    新名单 = 原序 − remove + add（append 到尾）—— 成员序就是无 @ 时的回复序，加人不该打乱
    既有顺序。踢掉法官 → ``judgeAgentId`` 与 ``judgeScopeHash`` 一并清空（没有法官就没有免卡
    锚）；踢的不是法官 → hash **不动**，于是自然失配 = ``judgeScopeStale``，UI 提示重新确认。
    """
    session = _require_group_session(session_id)
    opts = body or {}
    add = _require_id_list(opts.get("add"), "add")
    remove = _require_id_list(opts.get("remove"), "remove")
    if not add and not remove:
        raise APIError(
            "E_INVALID_ARG",
            "group-members requires a non-empty add or remove",
            hint="body 至少要有一个非空的 add 或 remove",
            source="sqlite",
        )
    overlap = [m for m in add if m in remove]
    if overlap:
        raise APIError(
            "E_INVALID_ARG",
            f"group-members add and remove overlap: {overlap}",
            hint="同一个成员不能同时加和踢",
            source="sqlite",
        )
    members = _group_member_ids(session)
    for member_id in add:
        _chat_facade()._require_chat_capable(member_id, what="group member")
        if member_id in members:
            raise APIError(
                "E_INVALID_ARG",
                f"group-members {member_id!r} is already a member",
                hint="该成员已经在群里了",
                source="sqlite",
            )
    missing = [m for m in remove if m not in members]
    if missing:
        raise APIError(
            "E_INVALID_ARG",
            f"group-members cannot remove non-members: {missing}",
            hint="要移出的成员不在这个群里（名单可能刚被别处改过，刷新再试）",
            source="sqlite",
        )
    next_members = [m for m in members if m not in remove] + add
    if not next_members:
        raise APIError(
            "E_INVALID_ARG",
            "group-members cannot remove the last member",
            hint="群至少要留一位成员；不要这个群就整个删掉",
            source="sqlite",
        )
    if len(next_members) > MAX_GROUP_MEMBERS:
        raise APIError(
            "E_INVALID_ARG",
            f"group-members supports at most {MAX_GROUP_MEMBERS} members",
            hint=f"已达成员上限（{MAX_GROUP_MEMBERS}）",
            source="sqlite",
        )

    db = _chat_facade().get_chat_db()
    config = dict(db.get_group_config(session_id)["config"])
    # 🔴 cleared = remove ∪ add：add 也删行，清掉 gateway 在踢人窗口里 INSERT OR IGNORE 重建的
    # 残留游标行（见 ChatDb.update_group_members 的头注）。
    db.update_group_members(session_id, next_members, [*remove, *add])
    if config.get("judgeAgentId") in remove:
        config["judgeAgentId"] = None
        config["judgeScopeHash"] = None
        db.update_group_config(session_id, config)
    return success_envelope(db.get_group_config(session_id), request=request, source="sqlite")


@router.get(
    "/sessions/{session_id:int}/group-turns", dependencies=[Depends(verify_cf_access)]
)
async def get_group_turns(
    request: Request,
    session_id: int,
    limit: int = Query(200, ge=1, le=500),
    before: Optional[int] = Query(None, ge=1),
    since: Optional[int] = Query(None, ge=0),
):
    """turn 台账只读分页（新→旧）：``{turns, hasMore}``。

    renderer 靠它在刷新后还原「沉默 / 重复折叠 / 跳过 / 失败 / 停止」那些**没有落库消息**的
    turn（红线 1：在场态只能来自服务端事实，前端不推断）。``before`` = 上一页最旧一行的 id；
    ``since`` = 只要 ``started_at >= since`` 的行，renderer 恒传「最早一条落库消息的时间」，
    使清空历史后旧 meta 行不再回到对话里。未迁移的旧库 → 空结果。"""
    _require_group_session(session_id)
    return success_envelope(
        _chat_facade().get_chat_db().list_group_turns(
            session_id, limit=limit, before_id=before, since_ms=since
        ),
        request=request,
        source="sqlite",
    )


@router.get("/sessions/{session_id:int}/group-config", dependencies=[Depends(verify_cf_access)])
async def get_group_config(request: Request, session_id: int):
    """群设置读面（g1，CHAT_DB v31）：``{modes, config}``。

    ``modes`` 只含**有行**的成员（缺行 = 'mention'，PRD Q1，读侧兜底）；``config`` 为
    ``group_config_json`` 解析结果，NULL / 脏 JSON → ``{"v": 1}`` = 全取出厂默认（默认值单源在
    ``ai-gateway/groupFloors.ts``，服务端不抄一份数值）。非群会话 400。"""
    _require_group_session(session_id)
    return success_envelope(
        _chat_facade().get_chat_db().get_group_config(session_id), request=request, source="sqlite"
    )


@router.put("/sessions/{session_id:int}/group-config", dependencies=[Depends(verify_cf_access)])
async def put_group_config(
    request: Request, session_id: int, body: Optional[Dict[str, Any]] = None
):
    """群设置写面（g1）：响应模式 + 法官位 + 链上限 / 小时预算 + 用途 / 全群模型 / 通知。

    body = ``{modes?, judgeAgentId?, chainCap?, hourlyTurns?, hourlyTokens?, hourlyUsd?,
    sessionTurnCap?, topic?, modelOverride?, notify?}``（全部可选，只写传了的键）。
    **权威校验在服务端**：会话必须 origin='group'；modes 的键必须 ⊆ 本群 members_json；
    judgeAgentId 必须 ∈ members 或 null；响应模式值域按 ``group_limits.RESPONSE_MODES``；
    chainCap ∈ [CHAIN_CAP_MIN, CHAIN_CAP_MAX]。

    **显式 null = 删键**（不是存 None）：五个数值键 + topic / modelOverride / notify 传 null
    （或空白字符串）都从 JSON 里 pop 掉 = 恢复出厂默认。存 None 会让读侧分不清「owner 清回
    默认」与「owner 设了个空值」，且默认值副本一旦落库就与 groupFloors.ts 的单源脱钩。

    🔴 judgeAgentId 只要**传了**就重写 ``judgeScopeHash = sha256(members_json 原文)`` —— 这是
    g2 法官免卡的锚（成员名单一变 hash 就失配，法官的建群/投递工具直接拒绝而不是弹一张无人
    在场的卡）。传同值也重写 = 群详情面「重新确认法官位」的写法（g1 只在变更时写，那样
    owner 就没有任何办法在改完名单后重新确认）。

    modes 走**列级 UPSERT**（``upsert_group_member_modes``，语句里没有 seen_through_id）——
    见 src/chat/db.py 头注的两写者纪律。"""
    session = _require_group_session(session_id)
    opts = body or {}
    members = _group_member_ids(session)
    db = _chat_facade().get_chat_db()
    current = db.get_group_config(session_id)
    config: Dict[str, Any] = dict(current["config"])

    modes = opts.get("modes")
    if modes is not None:
        if not isinstance(modes, dict):
            raise APIError("E_INVALID_ARG", "group-config modes must be an object", source="sqlite")
        for agent_id, mode in modes.items():
            if agent_id not in members:
                raise APIError(
                    "E_INVALID_ARG",
                    f"group-config modes key {agent_id!r} is not a member of this group",
                    source="sqlite",
                )
            if mode not in RESPONSE_MODES:
                raise APIError(
                    "E_INVALID_ARG",
                    f"group-config response mode must be one of {list(RESPONSE_MODES)}",
                    source="sqlite",
                )

    if "judgeAgentId" in opts:
        judge = opts.get("judgeAgentId")
        if judge is not None and (not isinstance(judge, str) or judge not in members):
            raise APIError(
                "E_INVALID_ARG",
                "group-config judgeAgentId must be a member of this group or null",
                source="sqlite",
            )
        config["judgeAgentId"] = judge
        # 名单原文（不是解析后再序列化）—— hash 要钉的就是「owner 确认时看到的那份名单」。
        raw_members = session.get("members_json") or ""
        config["judgeScopeHash"] = (
            group_scope_hash(raw_members) if judge is not None else None
        )

    for key, low, high in (
        ("chainCap", CHAIN_CAP_MIN, CHAIN_CAP_MAX),
        ("hourlyTurns", 1, 100_000),
        ("hourlyTokens", 1, 100_000_000),
        ("sessionTurnCap", 1, 100_000),
    ):
        if key not in opts:
            continue
        value = opts.get(key)
        if value is None:
            config.pop(key, None)
            continue
        if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
            raise APIError(
                "E_INVALID_ARG",
                f"group-config {key} must be an integer in [{low}, {high}]",
                source="sqlite",
            )
        config[key] = value

    if "hourlyUsd" in opts:
        usd = opts.get("hourlyUsd")
        if usd is None:
            config.pop("hourlyUsd", None)
        elif isinstance(usd, bool) or not isinstance(usd, (int, float)) or not 0 < usd <= 1000:
            raise APIError(
                "E_INVALID_ARG",
                "group-config hourlyUsd must be a number in (0, 1000]",
                source="sqlite",
            )
        else:
            config["hourlyUsd"] = float(usd)

    for key, max_chars in (
        ("topic", TOPIC_MAX_CHARS),
        ("modelOverride", MODEL_OVERRIDE_MAX_CHARS),
    ):
        if key not in opts:
            continue
        value = opts.get(key)
        if value is None or (isinstance(value, str) and not value.strip()):
            # 空白 = 没填 = 删键（UI 的输入框清空与显式 null 走同一条路，读侧只有「有值 / 没值」）。
            config.pop(key, None)
            continue
        if not isinstance(value, str):
            raise APIError(
                "E_INVALID_ARG",
                f"group-config {key} must be a string or null",
                hint=f"{key} 只接受字符串；清空传 null",
                source="sqlite",
            )
        trimmed = value.strip()
        if len(trimmed) > max_chars:
            raise APIError(
                "E_INVALID_ARG",
                f"group-config {key} must be at most {max_chars} characters",
                hint=f"最多 {max_chars} 个字符（当前 {len(trimmed)}）",
                source="sqlite",
            )
        config[key] = trimmed

    if "notify" in opts:
        notify = opts.get("notify")
        if notify is None:
            config.pop("notify", None)
        elif not isinstance(notify, bool):
            raise APIError(
                "E_INVALID_ARG",
                "group-config notify must be a boolean or null",
                hint="notify 只接受 true / false；恢复默认传 null",
                source="sqlite",
            )
        else:
            config["notify"] = notify

    db.update_group_config(session_id, config)
    if modes:
        db.upsert_group_member_modes(session_id, modes)
    return success_envelope(db.get_group_config(session_id), request=request, source="sqlite")


@router.get("/sessions/{session_id:int}/group-metrics", dependencies=[Depends(verify_cf_access)])
async def get_group_metrics(request: Request, session_id: int):
    """群成本两指标 + 两个滚动窗口（g1，只读 ``ai_chat_group_turn``，design §6）。

    先于级联上线（红线 4：先量得出来再让 agent 互相唤醒）。指标口径见
    ``ChatDb.group_metrics``；未迁移的旧库返空窗口而不是报错。"""
    _require_group_session(session_id)
    return success_envelope(
        _chat_facade().get_chat_db().group_metrics(session_id), request=request, source="sqlite"
    )


# ── 话题 thread（T3，CHAT_DB v32）───────────────────────────────────────────
#
# 话题 = 从群里某一条消息开出来的**独立上下文子会话**（``invoked_by='thread'``）。发言 / 停止 /
# 已读 / 改名 / 删除 / 列消息全部复用既有的会话端点（话题 id 与群 id 同一个命名空间），所以这里
# 只有两个新端点：建话题、列本群的话题。
#
# 🔴 契约：
#   • 顶层群限定 —— 父群必须 ``parent_session_id IS NULL``；在子群 / 话题上开话题一律 400
#     （单层嵌套校验不放宽：family 的定义与停止通道都建立在「至多一层」上）。
#   • 根消息必须属于该群且 ``role in ('user','assistant')``。
#   • 同一条根消息重复 POST 是**幂等**的：返回已有话题（200），不是 409，也不建第二个
#     —— 落库根据是 v32 的唯一部分索引 ``idx_chat_sessions_thread_root``。
#   • 建行走 ``create_session_validated``（members 取父群快照、``group_config_json`` 复制父群、
#     title = 根消息前 ``THREAD_TITLE_MAX_CHARS`` 字），**不复制** ``ai_chat_group_member`` 行
#     （话题内的唤醒是参与者制，由 gateway 按事实推导）。
#   • 创建者的 ``last_read_at`` 写成 now —— 否则「没打开过不算未读」的口径会让别人回的第一条
#     永远不亮。
def _thread_title(content: Any) -> str:
    """根消息正文 → 话题标题（连续空白折成一个空格后截 ``THREAD_TITLE_MAX_CHARS`` 字）。

    截在**服务端**：标题作为 ``title`` 列落库，前端只显示那一列，不自己再截一刀（没有第二处
    手抄，所以 THREAD_TITLE_MAX_CHARS 不进 parity 闸）。正文为空（只带附件的消息）→ 空串，
    ``create_session_validated`` 会把它落成 NULL —— 读侧照 ``title or ''`` 拿到空串，由前端
    决定显示什么，这里不编一个服务端中文兜底字符串。"""
    return " ".join(str(content or "").split())[:THREAD_TITLE_MAX_CHARS]


def _thread_summary(row: Dict[str, Any]) -> Dict[str, Any]:
    """``ChatDb.list_threads`` 的一行 → ``GroupThreadSummary``（形状见 shared/chat_model.ts）。

    ``unread`` 与群行同口径：``last_read_at IS NOT NULL`` 且 ``updated_at > last_read_at``
    —— 「从没打开过」不算未读（建话题时创建者的 last_read_at 已写成 now）。"""
    updated_at = int(row.get("updated_at") or 0)
    last_read_at = row.get("last_read_at")
    content = row.get("last_message_content")
    role = row.get("last_message_role")
    return {
        "sessionId": int(row["session_id"]),
        "rootMessageId": int(row["root_message_id"]),
        "title": row.get("title") or "",
        "replyCount": int(row.get("reply_count") or 0),
        # 两列任一为 NULL = 话题里还没有 user/assistant 行（刚开出来的话题）。
        "lastMessage": None
        if content is None or role is None
        else {
            "role": role,
            "content": content,
            "speakerAgentId": row.get("last_message_speaker_agent_id"),
            "createdAt": int(row.get("last_message_created_at") or 0),
        },
        "updatedAt": updated_at,
        "unread": last_read_at is not None and updated_at > int(last_read_at),
    }


@router.post("/sessions/{session_id:int}/threads", dependencies=[Depends(verify_cf_access)])
async def create_group_thread(
    request: Request, session_id: int, body: Optional[Dict[str, Any]] = None
):
    """建话题（body ``{rootMessageId: int}``）→ ``{sessionId, rootMessageId, title}``。"""
    db = _chat_facade().get_chat_db()
    group = _require_group_session(session_id)
    if group.get("parent_session_id") is not None:
        raise APIError(
            "E_INVALID_ARG",
            f"session {session_id} is not a top-level group",
            hint="话题只能开在顶层群（子群 / 话题里不能再开话题）",
            source="sqlite",
        )
    root_message_id = (body or {}).get("rootMessageId")
    if (
        not isinstance(root_message_id, int)
        or isinstance(root_message_id, bool)
        or root_message_id <= 0
    ):
        raise APIError(
            "E_INVALID_ARG",
            "threads requires rootMessageId:int (positive)",
            source="sqlite",
        )
    message = db.get_message(root_message_id)
    # 🔴 「消息不存在」与「消息属于**别的**会话」是同一个 400：话题的根必须在这个群里，
    # 否则话题卡会挂到一条谁都看不见的消息下面（而且 family 预算算到别人头上）。
    if message is None or int(message.get("session_id") or 0) != session_id:
        raise APIError(
            "E_INVALID_ARG",
            f"message {root_message_id} does not belong to group {session_id}",
            hint="根消息必须是这个群里的一条消息",
            source="sqlite",
        )
    if (message.get("role") or "") not in ("user", "assistant"):
        raise APIError(
            "E_INVALID_ARG",
            f"message {root_message_id} is not a user/assistant message",
            hint="只能在人或成员说的话上开话题（system 行是编排痕迹）",
            source="sqlite",
        )
    existing = db.find_thread_by_root(session_id, root_message_id)
    if existing is not None:
        # 幂等：「开话题」与「进已有话题」是同一个动作，重复 POST 返回已有的那个（不是 409）。
        return success_envelope(
            {
                "sessionId": int(existing["id"]),
                "rootMessageId": root_message_id,
                "title": existing.get("title") or "",
            },
            request=request,
            source="sqlite",
        )
    title = _thread_title(message.get("content"))
    thread = await _chat_facade().create_session_validated(
        {
            "anchorType": "general",
            "emailId": None,
            "backendKind": group.get("backend_kind") or "ai-sdk",
            # 父群名单的**快照**（此后加人 / 踢人不追平话题：话题是那一刻这群人的一段讨论）。
            "groupMembers": _group_member_ids(group),
            "title": title,
            "parentSessionId": session_id,
            "invokedBy": "thread",
        }
    )
    thread_id = int(thread["id"])
    try:
        db.attach_thread_root(thread_id, root_message_id, group.get("group_config_json"))
    except sqlite3.IntegrityError:
        # 并发的第二个 POST：唯一部分索引挡住了第二个话题（先查再建的检查挡不住这个窗口）。
        # 回收刚 INSERT 的空壳行，返回先到的那一个 —— 幂等对并发同样成立。
        db.delete_session(thread_id)
        winner = db.find_thread_by_root(session_id, root_message_id)
        if winner is None:
            raise
        return success_envelope(
            {
                "sessionId": int(winner["id"]),
                "rootMessageId": root_message_id,
                "title": winner.get("title") or "",
            },
            request=request,
            source="sqlite",
        )
    return success_envelope(
        {"sessionId": thread_id, "rootMessageId": root_message_id, "title": title},
        request=request,
        source="sqlite",
    )


@router.get("/sessions/{session_id:int}/threads", dependencies=[Depends(verify_cf_access)])
async def list_group_threads(request: Request, session_id: int):
    """列本群的话题（新→旧）→ ``GroupThreadSummary[]``（形状见 shared/chat_model.ts）。

    子群 / 话题上调用返回 ``[]``（它们底下不可能有话题）—— 读面不因此报错。"""
    _require_group_session(session_id)
    items = [_thread_summary(row) for row in _chat_facade().get_chat_db().list_threads(session_id)]
    return success_envelope(
        items, request=request, source="sqlite", meta_extra={"count": len(items)}
    )

