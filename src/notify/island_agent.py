"""Harness agent 上灵动岛（Part B）—— serve-api 侧 agent envelope 构造 + 发送.

背景（设计 `docs/plans/agent-experience-epic/harness-island-integration-design.md`）：
把前端 chat 多轮 agent（引擎 = AI SDK Gateway）的**工具审批（HITL）** 搬上灵动岛，做成
「类似 Claude Code」的体验 —— 审批卡上岛，岛上点批准经**解耦 ack 通道**（Part A）触发
gateway **服务端 resume**，用户**完全离开 app** 也能执行。

拓扑（Python 作 island broker，Node gateway 作审批大脑）：
- gateway `needsApproval` 暂停时 → `POST serve-api /api/island/agent/announce` → 本模块
  ``announce_approval`` 组 ``AgentApproval`` envelope（waitingForInput + intervention
  approve/reject）+ 登记 agent ack pending（复用 Part A ``island_ack``，kind="agent"）+ 发
  ``/tmp/island.sock``。
- 岛上点批准 → fork **复用 Part A 出站** `POST /api/island/ack {ack_token, choice}` →
  serve-api ``kind=="agent"`` 分支 → `POST gateway /api/ai/approval/decide` → 服务端 resume。
- resume 完成 → serve-api 追发 ``AgentCompleted`` / ``AgentError`` envelope 清卡。

🔴 为何 Python broker：复用 Python island 全套基础设施（envelope builder + Part A ack
   ingress + ping_island fail-open socket）最 DRY；Node gateway 只管审批语义。本模块跑在
   **serve-api 进程**（announce/ack 端点），故不依赖 mail-sync 的 ``island_dispatch._state``
   单例 —— 直接构造 envelope + 用 ``ping_island.send_async``。
"""

from __future__ import annotations

import logging
import os
from typing import Dict, Optional

from src.notify import island_ack, island_i18n, ping_island
from src.notify.island_envelope import (
    BridgeEnvelope,
    Intervention,
    InterventionOption,
)

log = logging.getLogger(__name__)

# 岛上 agent 审批 TTL（比 mail 5min 长 —— HITL 场景用户可能离开一会才回来点）。
# 🔴 必须与 gateway ApprovalGuard TTL 同步（ai_gateway_lifecycle 在 island agent 开时把
#    guard TTL 也设 30min），否则岛上超 guard TTL 才点 → resume 时 guard.verify 报
#    E_APPROVAL_EXPIRED。见设计 §6。
DEFAULT_AGENT_ACK_TTL_SEC = 1800.0

# agent 上岛用自己的文案词汇（mail island_i18n 的 locale 是 per-user 外部文件、缺 key 会渲染成
# 裸 key）；故内联双语，按 island_i18n.resolve_lang() 选 zh/en，自包含永不 fallback 到 key。
_AGENT_STRINGS = {
    "zh-CN": {
        "approval.title": "AI 助手请求批准",
        "approve": "批准",
        "reject": "拒绝",
        "running.title": "AI 正在处理…",
        "completed.title": "AI 已完成",
        "error.title": "AI 出错",
    },
    "en-US": {
        "approval.title": "AI needs approval",
        "approve": "Approve",
        "reject": "Reject",
        "running.title": "AI working…",
        "completed.title": "AI done",
        "error.title": "AI error",
    },
}


def _t(key: str) -> str:
    lang = island_i18n.resolve_lang()
    table = _AGENT_STRINGS.get(lang) or _AGENT_STRINGS["en-US"]
    return table.get(key) or _AGENT_STRINGS["en-US"].get(key) or key


def _agent_metadata(
    *,
    session_id: int,
    scenario: str,
    tool_name: str = "",
    summary: str = "",
    risk: str = "",
    accent: str = "coral",
    theme: str = "dark",
) -> Dict[str, str]:
    """构造 agent envelope 的 ``metadata.mailagent.*`` 命名空间 + fork brand keys。

    fork ``HookSocketServer.makeClientInfo`` 用 ``client_*`` keys 推 brand=.mail →
    渲染 ``MailAgentSessionView``；``mailagent.scenario`` 选 agent* 布局（见 fork
    ``MailAgentSessionView.layoutKind``）。缺失字段 fork 有 fallback。
    """
    meta: Dict[str, str] = {
        "mailagent.scenario": scenario,
        "mailagent.agentSessionId": str(session_id),
        "mailagent.lang": island_i18n.resolve_lang(),
        "mailagent.accent": accent or "coral",
        "mailagent.theme": theme or "dark",
        # fork brand 推导（见 island_dispatch._base_metadata 同段注释）——不带这些 key
        # fork brand fallback .neutral，渲染 generic 卡（zZz mascot + 乱码）。
        "client_kind": "mailagent",
        "client_name": "MailAgent",
        "client_origin": "plugin",
        "client_originator": "MailAgent",
        "thread_source": "mailagent-hooks",
    }
    if tool_name:
        meta["mailagent.agentTool"] = tool_name
    if risk:
        meta["mailagent.agentRisk"] = risk
    if summary:
        # 复用 aiSummary 通道（fork agent 布局读它渲染「AI 想做什么」预览）。
        meta["mailagent.aiSummary"] = summary[:2000]
    return meta


def build_approval_envelope(
    *,
    session_id: int,
    tool_name: str,
    input_preview: str,
    risk: str = "",
    title: str = "",
    accent: str = "coral",
    theme: str = "dark",
) -> BridgeEnvelope:
    """组 ``AgentApproval`` envelope（waitingForInput + approve/reject intervention）。

    sessionKey = ``mailagent:agent:{session_id}``；intervention.id 由 envelope 层派生
    ``mail:agent:{session_id}:AgentApproval`` 对齐 fork stableID（同 session 重发同身份、幂等）。
    """
    disp_title = title or _t("approval.title")
    message = input_preview.strip() or tool_name or "?"
    intervention = Intervention(
        title=disp_title,
        message=_one_line(message, max_len=500),
        options=[
            InterventionOption(id="approve", title=_t("approve")),
            InterventionOption(id="reject", title=_t("reject")),
        ],
    )
    return BridgeEnvelope(
        event_type="AgentApproval",
        session_key=f"mailagent:agent:{session_id}",
        title=disp_title,
        preview=_one_line(input_preview),
        status_kind="waitingForInput",
        metadata=_agent_metadata(
            session_id=session_id, scenario="AgentApproval",
            tool_name=tool_name, summary=input_preview, risk=risk,
            accent=accent, theme=theme,
        ),
        intervention=intervention,
        expects_response=True,
    )


def build_status_envelope(
    *,
    session_id: int,
    status_kind: str,
    title: str = "",
    summary: str = "",
    tool_name: str = "",
    accent: str = "coral",
    theme: str = "dark",
) -> BridgeEnvelope:
    """组 agent 生命周期 envelope（``AgentRunning`` / ``AgentCompleted`` / ``AgentError``，无 intervention）。

    ``status_kind`` ∈ {notification, completed, error} → scenario 映射，清/更新岛卡。
    """
    scenario_map = {
        "completed": "AgentCompleted",
        "error": "AgentError",
        "notification": "AgentRunning",
    }
    scenario = scenario_map.get(status_kind, "AgentRunning")
    default_title = {
        "AgentCompleted": _t("completed.title"),
        "AgentError": _t("error.title"),
        "AgentRunning": _t("running.title"),
    }[scenario]
    return BridgeEnvelope(
        event_type=scenario,
        session_key=f"mailagent:agent:{session_id}",
        title=title or default_title,
        preview=_one_line(summary),
        status_kind=status_kind if status_kind in ("completed", "error") else "notification",
        status_detail=(summary[:200] if status_kind == "error" and summary else None),
        metadata=_agent_metadata(
            session_id=session_id, scenario=scenario,
            tool_name=tool_name, summary=summary, accent=accent, theme=theme,
        ),
        intervention=None,
        expects_response=False,
    )


async def announce_approval(
    *,
    db_path: str,
    session_id: int,
    tool_call_id: str,
    tool_name: str,
    input_preview: str,
    risk: str,
    resume_token: str,
    gateway_port: int,
    api_port: str,
    sock_path: Optional[str] = None,
    ttl_sec: float = DEFAULT_AGENT_ACK_TTL_SEC,
    accent: str = "coral",
    theme: str = "dark",
) -> Optional[str]:
    """登记 agent ack pending + 组 approval envelope + 发岛。返回 ack_token（fail-open：失败返 None）。

    pending metadata 存 ``toolCallId`` / ``resumeToken`` / ``gatewayPort`` —— ``/ack`` 的
    ``kind=="agent"`` 分支 resolve 后据此 `POST gateway /api/ai/approval/decide`（服务端 resume）。
    """
    envelope = build_approval_envelope(
        session_id=session_id, tool_name=tool_name, input_preview=input_preview,
        risk=risk, accent=accent, theme=theme,
    )
    ack_token: Optional[str] = None
    try:
        # 复用 Part A island_ack（kind="agent"）：跨进程 SQLite pending，serve-api ack 端点
        # resolve。metadata 带 gateway resume 所需字段（toolCallId / resumeToken / gatewayPort）。
        ack_meta: Dict[str, str] = {
            **envelope.metadata,
            "mailagent.agentToolCallId": tool_call_id,
            "mailagent.agentResumeToken": resume_token,
            "mailagent.agentGatewayPort": str(gateway_port),
        }
        ack_token = island_ack.register(
            db_path,
            kind="agent",
            session_key=envelope.session_key,
            event_type=envelope.event_type,
            metadata=ack_meta,
            choices={opt.id for opt in envelope.intervention.options},
            internal_id=None,
            ttl_sec=ttl_sec,
        )
    except Exception as e:  # noqa: BLE001
        log.warning("[island-agent] ack register raised: %s", e)
        ack_token = None

    # 🔴 codex Fix 4：无 ack_token（register 落库失败）→ 岛上点批准 /ack 必 404、且连追发
    # AgentError 的 session 元数据都没有 = 「可点却不可 resolve」的死卡。**不发这张卡**：renderer
    # 在场仍可 app 内批准（审批 pending 不依赖岛）；完全离岛则本轮无岛上审批（安全降级，胜过死卡）。
    if not ack_token:
        log.warning(
            "[island-agent] ack register failed — skip approval card (avoid unresumable card) "
            "session_id=%s toolCallId=%s", session_id, tool_call_id,
        )
        return None

    envelope.metadata["ack_token"] = ack_token
    envelope.metadata["ack_url"] = f"http://127.0.0.1:{api_port}/api/island/ack"
    await _send(envelope, sock_path)
    return ack_token


async def announce_status(
    *,
    session_id: int,
    status_kind: str,
    title: str = "",
    summary: str = "",
    tool_name: str = "",
    sock_path: Optional[str] = None,
    accent: str = "coral",
    theme: str = "dark",
) -> None:
    """发 agent 生命周期 envelope（无 intervention，无 ack）。fail-open。"""
    envelope = build_status_envelope(
        session_id=session_id, status_kind=status_kind, title=title,
        summary=summary, tool_name=tool_name, accent=accent, theme=theme,
    )
    await _send(envelope, sock_path)


async def _send(envelope: BridgeEnvelope, sock_path: Optional[str]) -> None:
    """fail-open 发送（ping-island 未装/未跑 → SendResult ok=False，静默）。"""
    try:
        result = await ping_island.send_async(envelope, sock_path=sock_path)
        if not result.ok:
            log.debug(
                "[island-agent] send %s failed (fail-open): %s",
                envelope.event_type, result.error,
            )
    except Exception as e:  # noqa: BLE001
        log.debug("[island-agent] send %s raised (fail-open): %s", envelope.event_type, e)


def _one_line(text: str, max_len: int = 200) -> str:
    if not text:
        return ""
    return " ".join(text.split())[:max_len]


def resolve_api_port() -> str:
    """serve-api 自身端口（ack_url 用）—— 与 island_dispatch 同源（MAILAGENT_API_PORT 默认 8200）。"""
    return os.environ.get("MAILAGENT_API_PORT", "8200")
