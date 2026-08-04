"""connector 工具调用的**单源闸序 + 执行**（08-01 阶段 1 PR3 T3）。

PR2 把闸序写在 ``routers/connector.py`` 的 invoke handler 里；PR3 起有**第二个**调用面
（Python 侧 LLM tool loop —— 报告 Agent / 邮件预处理分类经 ``connectors/llm_tools.py``
直调，不过 HTTP）。两个面必须走**同一份**闸，故整块搬到这里：router 与工厂各调一次
``invoke_connector_tool``，闸逻辑绝不手抄两份（手抄两份 = 改一处漏一处、静默放宽）。

闸序（伪造 / 未同步 / orphan / 未启用 / 越天花板的名字**到不了远端**）：

  1. 未知 connector id（不在 registry）              → 404 ``E_NOT_FOUND``
  2. 工具不在已同步清单里（伪造 / 未同步）           → 404 ``E_NOT_FOUND``
  3. orphan（远端清单里已消失）                      → 409 ``E_CONNECTOR_TOOL_ORPHAN``
  4. **crud 天花板**（PR3 新增，见下）                → 403 ``E_CONNECTOR_GRANT_DENIED``
  5. ``effective_enabled`` 折算为 False              → 409 ``E_CONNECTOR_TOOL_DISABLED``

🔴 原闸 3（``crud_type='delete'`` → 403 ``E_CONNECTOR_TOOL_FORBIDDEN``）**08-03 整闸退役**：
delete 档位本身已退役（MCP annotations 没有 delete 语义位 ⇒ ``derive_crud_type`` 结构上不
产出它），闸就成了不可达代码。破坏性由 ``connector_tool.destructive`` 列在审批卡上红警告
表达，写类恒 HITL 的安全地板不变。

flag 门（``MAILAGENT_MCP_CONNECTORS``）**不在这里** —— 它是 router 的 ``_require_enabled``
（HTTP 面）与工厂的「flag off 返回空工具集」（LLM 面）各自的入口纪律，本模块只管闸与执行。

🔴 **天花板闸是「授权判定与执行同侧」的第二道**（PRD ADR Approach A 的决定性理由）：
gateway 注册期过滤（grant 外根本不注册）是第一道，但那道在 TS 侧、由调用方自证；服务端
这道以 ``report_agent.tool_policy_json`` 的 ``grant_connectors`` 为准重新判一次。
``ceiling=None`` = 不加天花板闸（owner 本人的 manual 面 / 直调 curl —— 与 PR2 逐字节相同）。
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Mapping, Optional

from loguru import logger

#: crud 天花板的**序**（PRD 决策 5 / grill Q3=B）：read < write < update。
#: 工具可用 iff ``rank(crud_type) <= rank(ceiling)``。
#: 🔴 表内三档就是 crud 的**全部**值域（``store.CONNECTOR_CRUD_TYPES`` 同步；delete 档位
#: 08-03 已退役）。值域外的 crud / 天花板一律 fail-closed（``ceiling_allows`` 返回 False）。
CONNECTOR_CRUD_RANK: dict[str, int] = {"read": 1, "write": 2, "update": 3}

#: 授权失效的错误码（PR5）：命中即把连接落 ``needs_reauth``（可行动状态）。**两个调用面
#: （本模块的 invoke / routers/connector.py 的 sync）共用这一份**，别在第二处手抄码表。
#: 🔴 timeout / network / protocol 有意**不**在内：那些是瞬时故障，落态会把「远端抖了一下」
#: 说成「授权没了」，把 owner 支去做一次无用的重新授权。
CONNECTOR_REAUTH_ERROR_CODES: tuple[str, ...] = (
    "E_CONNECTOR_OAUTH",
    "E_CONNECTOR_NOT_CONNECTED",
)

#: needs_reauth 的对外文案（落库 ``last_error`` + 抛给调用方/模型的 message 同一份）。
#: 🔴 面向**人与模型**，不是面向 curl —— client 层的原始 message 里有「run POST
#: /api/connector/{id}/oauth/start」这类只有开发者能执行的指令，原样摆进设置页的 lastError
#: 与模型看到的工具错误里 = 看得懂但做不了。原始技术细节留在异常链（``from e``）与日志里，
#: client.py 那份原文不动（它对开发者仍是对的）。
CONNECTOR_REAUTH_MESSAGE = (
    "Connector authorization expired or revoked. The owner must reconnect it in "
    "Settings → Custom AI → Connectors."
)

#: caller.context_mode 的合法值域（镜像 TS ``AGENT_CONTEXT_MODES``：manual + 两个 headless
#: + 阶段 0b 预置的 im_chat）。Python ``policy.CONTEXT_MODES`` 只有前三个（policy_rules 的
#: 轴），故这里独立成表 —— 本闸判的是「谁在调」，不是「哪条白名单规则命中」。
CALLER_CONTEXT_MODES: tuple[str, ...] = (
    "manual_chat",
    "untrusted_trigger",
    "cron_headless",
    "im_chat",
)

#: 需要 per-connector grant 才能调的模式（headless run：无人在环，靠 owner 预先配的天花板）。
HEADLESS_CONTEXT_MODES: tuple[str, ...] = ("untrusted_trigger", "cron_headless")


class ConnectorInvokeDenied(Exception):
    """闸拒（stable code + HTTP 语义）。router 转 ``APIError``，LLM 工厂转 ``"error: …"`` 串。"""

    def __init__(self, code: str, message: str, http_status: int = 403) -> None:
        super().__init__(message)
        self.code = code
        self.http_status = http_status


def ceiling_allows(crud_type: str, ceiling: Optional[str]) -> bool:
    """该 crud 类工具是否在天花板之内（``ceiling=None`` = 无天花板，恒 True）。

    未知 crud / 未知天花板（含已退役的 ``'delete'``）→ **False**（fail-closed：值域外一律
    不放行 —— 手改 DB / 老配置里残留的档位名不会被当成"什么都放行"）。
    """
    if ceiling is None:
        return True
    rank = CONNECTOR_CRUD_RANK.get(crud_type)
    cap = CONNECTOR_CRUD_RANK.get(ceiling)
    return rank is not None and cap is not None and rank <= cap


def _load_agent_row(agent_id: str) -> Optional[dict[str, Any]]:
    """``report_agent`` 行（custom agent / 报告 Agent 同表）。读不到 → None。

    模块级函数（非内联）= 测试可 monkeypatch 的接缝；生产路径读 ``config.sync_store_db_path``
    （与 ``api.deps.get_report_store`` 同库同口径）。函数内 import：避免 connectors 包在
    import 期就把 pydantic config + reports 链拖进来（裸 worktree import 自检纪律）。
    """
    try:
        from src.config import config as settings
        from src.reports.store import ReportStore

        return ReportStore(settings.sync_store_db_path).get_agent(agent_id)
    except Exception as exc:  # noqa: BLE001 — 读不到 agent 行 = 无授权（fail-closed）
        logger.warning(f"[connector] agent row read failed agent_id={agent_id!r}: {exc}")
        return None


def connector_grants_for_agent(agent_id: str) -> dict[str, str]:
    """agent 行 → ``{connector_id: 天花板}``（读侧宽容：坏 ``tool_policy_json`` → 空 dict）。

    宽容解析对齐 ``agent_runs._tool_policy_lenient``：保存面已严格拒（值域外的天花板入库即拒），
    运行时坏形状退回「未配置」= 无授权，方向 fail-closed。
    """
    from src.agents.trigger import parse_tool_policy

    row = _load_agent_row(agent_id)
    if row is None:
        return {}
    try:
        policy = parse_tool_policy(row.get("tool_policy_json"))
    except ValueError:
        return {}
    return dict(policy.grant_connectors)


def resolve_caller_ceiling(
    caller: Optional[Mapping[str, Any]], connector_id: str
) -> Optional[str]:
    """``caller`` 信封 → 该 connector 的 crud 天花板（``None`` = 不加天花板闸）。

    - ``caller`` 缺席 → ``None``：PR2 行为逐字节保留（owner 直调 / 尚未升级的 gateway）。
    - ``context_mode='manual_chat'`` → ``None``：owner 本人在环，审批链在 gateway 侧
      （grill Q5=A：读免批、写弹卡），服务端不再叠加天花板。
    - 非 headless 白名单的 mode（当前只有 ``im_chat``，阶段 0b 预置的第四场地）→ **恒拒**；
      镜像 TS ``isToolClassAllowedInMode`` 对 im_chat 的硬地板 —— grants 根本不查。
    - headless（``untrusted_trigger`` / ``cron_headless``）→ 按 ``agent_id`` 读该 agent 的
      ``grant_connectors``；无 agent_id / 无行 / 该 connector 不在 grants 里 → **拒**
      （grant 外根本不该注册，走到这里说明第一道漏了或被绕过）。
    - 形状不对 / 未知 context_mode → 400（调用方 bug 早暴露，不静默降级成「无约束」——
      镜像 ``routers/web.py`` 对非法 context_mode 的处置）。
    """
    if caller is None:
        return None
    if not isinstance(caller, Mapping):
        raise ConnectorInvokeDenied(
            "E_INVALID_ARG", "caller must be an object", http_status=400
        )
    mode = caller.get("context_mode")
    if mode not in CALLER_CONTEXT_MODES:
        raise ConnectorInvokeDenied(
            "E_INVALID_ARG",
            f"caller.context_mode must be one of {list(CALLER_CONTEXT_MODES)}",
            http_status=400,
        )
    if mode == "manual_chat":
        return None
    if mode not in HEADLESS_CONTEXT_MODES:
        # im_chat（阶段 0b 预置的第四场地）以及**将来任何新增的 mode**：默认不放行。
        # 🔴 写成显式白名单而非「排除 manual/im 后就当 headless」—— 后者会让某天跟着 TS
        # ``AGENT_CONTEXT_MODES`` 新增的第五种 mode 悄悄落进 headless 分支（拿到 grant 语义），
        # 而新场地该不该有 connector 是一次独立决策，不是继承来的。
        raise ConnectorInvokeDenied(
            "E_CONNECTOR_GRANT_DENIED",
            f"connector tools are not available in {mode} (only manual_chat and the headless "
            f"agent modes {list(HEADLESS_CONTEXT_MODES)} may call them; a new venue's opt-in "
            "is a separate switch, never a grant)",
        )
    agent_id = caller.get("agent_id")
    if not agent_id or not isinstance(agent_id, str):
        raise ConnectorInvokeDenied(
            "E_CONNECTOR_GRANT_DENIED",
            f"headless caller ({mode}) must carry agent_id to be authorized for connector "
            f"{connector_id!r}",
        )
    ceiling = connector_grants_for_agent(agent_id).get(connector_id)
    if ceiling is None:
        raise ConnectorInvokeDenied(
            "E_CONNECTOR_GRANT_DENIED",
            f"agent {agent_id!r} has no grant for connector {connector_id!r} "
            "(set tool_policy.grant_connectors to read|write|update)",
        )
    return ceiling


async def invoke_connector_tool(
    connector_id: str,
    tool_name: str,
    arguments: Optional[dict[str, Any]] = None,
    *,
    ceiling: Optional[str] = None,
) -> dict[str, Any]:
    """闸序 + 远端调用（HTTP invoke 端点与 Python LLM 工厂的**共用**执行路径）。

    返回 ``{content, is_error, truncated, elapsed_ms}``；``content`` 已在
    ``ConnectorClient.call_tool`` 截断（``CALL_RESULT_MAX_CHARS``），围栏由各调用面自己套
    （TS gateway 走 contextSerializer，Python 走 ``llm_tools`` 的 ``fence_untrusted``）。

    闸拒 → ``ConnectorInvokeDenied``；远端 / 传输 / 授权失效 → ``ConnectorBusy`` /
    ``ConnectorError`` 原样上抛（各调用面自行映射 HTTP 语义 or 回灌给模型）。
    """
    from src.agent_config.store import (
        connector_tool_effective_enabled,
        get_agent_config_store,
    )
    from src.connectors.registry import get_connector_def

    try:
        get_connector_def(connector_id)
    except KeyError as e:
        raise ConnectorInvokeDenied("E_NOT_FOUND", str(e), http_status=404) from None
    if arguments is not None and not isinstance(arguments, dict):
        raise ConnectorInvokeDenied(
            "E_INVALID_ARG", "arguments must be an object", http_status=400
        )

    store = get_agent_config_store()
    rows = await asyncio.to_thread(store.list_connector_tools, connector_id)
    row = next((r for r in rows if r.tool_name == tool_name), None)
    if row is None:
        raise ConnectorInvokeDenied(
            "E_NOT_FOUND",
            f"tool {tool_name!r} is not in the synced manifest of connector "
            f"{connector_id!r} (unsynced/forged tool names are never forwarded)",
            http_status=404,
        )
    if row.orphan:
        raise ConnectorInvokeDenied(
            "E_CONNECTOR_TOOL_ORPHAN",
            f"tool {tool_name!r} vanished from the remote manifest (orphan) — re-sync "
            "the connector before calling it",
            http_status=409,
        )
    if not ceiling_allows(row.crud_type, ceiling):
        raise ConnectorInvokeDenied(
            "E_CONNECTOR_GRANT_DENIED",
            f"tool {tool_name!r} is {row.crud_type}-class on connector {connector_id!r}, "
            f"above the caller's granted ceiling {ceiling!r}",
            http_status=403,
        )
    if not connector_tool_effective_enabled(row.crud_type, row.enabled):
        raise ConnectorInvokeDenied(
            "E_CONNECTOR_TOOL_DISABLED",
            f"tool {tool_name!r} is disabled — enable it in Settings → Custom AI → "
            "Connectors if you want the assistant to use it",
            http_status=409,
        )

    # 调用时 import：``ConnectorClient`` 名字在**调用瞬间**从模块对象取（测试 monkeypatch
    # ``src.connectors.client.ConnectorClient`` 才生效 —— PR2 router 的既有手法）。
    from src.connectors.client import ConnectorClient, ConnectorError

    client = ConnectorClient(connector_id, interactive=False)
    started = time.monotonic()
    try:
        result = await client.call_tool(tool_name, arguments)
    except ConnectorError as e:
        # 授权失效 → 连接落 needs_reauth + **可行动**文案（PRD「不静默重试到死」；镜像 sync
        # 端点）。原始技术 message 换成 CONNECTOR_REAUTH_MESSAGE：这条会一路走到设置页的
        # lastError 和模型看到的工具错误串，那两处都执行不了「run POST /api/connector/...」。
        if getattr(e, "code", "") in CONNECTOR_REAUTH_ERROR_CODES:
            await asyncio.to_thread(
                store.update_connector_state,
                connector_id,
                status="needs_reauth",
                last_error=CONNECTOR_REAUTH_MESSAGE,
            )
            logger.warning(
                "[connector] {} needs reauth (tool={}): {}", connector_id, tool_name, e
            )
            raise ConnectorError(CONNECTOR_REAUTH_MESSAGE, code=e.code) from e
        raise
    return {
        "content": result["content"],
        "is_error": result["is_error"],
        "truncated": result["truncated"],
        "elapsed_ms": int((time.monotonic() - started) * 1000),
    }
