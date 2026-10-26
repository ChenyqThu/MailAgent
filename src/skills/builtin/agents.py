"""agents skill —— 自定义 agent（type='custom'）的只读 + 唯一一个触发型写：手动跑一次。

skill 名不叫 ``custom_agent``：那个名字已是零工具的「配置 agent 的对话流程」skill
（``builtin/custom_agent.py``），不往里挂工具。

取数：配置走 ``ReportStore`` + ``src/reports/wire.py::resolve_agent``（与 ``GET /api/report-agents``
同源）；最近运行走 ``AsyncJobRepository.list_runs`` + ``routers/agent_runs._run_history_item``（run 历史
行投影单源，``state`` 只经 ``derive_agent_run_state`` 派生）。手动触发走
``src/agents/run_queue.py::enqueue_manual_agent_run``（与 ``POST /api/report-agents/{id}/run`` 的
custom 分支同一份）。

**返回字段对照 gateway 同名工具**（``frontend/src/ai-gateway/tools/agents.ts``），对外更严：
只给身份、描述、启用状态、触发方式、预算与最近运行。``prompt`` / ``model`` / 六档能力 /
``allowed_tools`` / ``grant_*`` / ``skills`` / ``grant_connectors`` 都不出现（那是这个 agent 的指令与
权限面）。gateway 的 ``trigger_summary`` 是 TS 侧从 ``trigger`` 派生的一行字，Python 无对应实现，
这里直接给结构化的 ``trigger``，不另抄一份格式化逻辑。

``custom_agent_run_now`` 的门（顺序即判定顺序）：scope ``agents:run`` → ``confirm:true`` →
每把 key 每小时 10 次（以上三道在 invoke chokepoint）→ ``MAILAGENT_CUSTOM_AGENTS_ENABLED`` →
agent 存在且是 custom（否则 404）→ ``enabled``（停用 409，**不入队、不占当日次数**）→ 入队（每日
次数上限照旧在 ``enqueue_agent_run`` 里生效）。入参只有 ``agent_id``：外部 key 只能决定「哪个
agent、什么时候跑」，不能带指令也不能覆盖配置，run 用 agent 自己配置的权限。
"""

from __future__ import annotations

from typing import Any

from src.skills.builtin._common import api_router, cap_list, int_arg, str_arg
from src.skills.errors import SkillError
from src.skills.models import ToolDef, ToolHandler
from src.skills.registry import BoundSkill, BoundTool

_LIST_LIMIT_MAX = 100  # == gateway customAgentListSchema.limit.max
_RUNS_LIMIT_MAX = 20  # == gateway customAgentGetSchema.runs_limit.max
_AGENT_ID_MAX_CHARS = 128
# ``confirm`` 只是确认闸的意图标记（MCP 路径已被 pop 走；REST 调用方若误放进 input 也不当成指令）。
_RUN_NOW_FIELDS = frozenset({"agent_id", "confirm"})


def _require_feature(ctx: Any) -> None:
    try:
        enabled = bool(getattr(ctx.config(), "custom_agents_enabled", False))
    except Exception:  # noqa: BLE001 — 配置读失败 → 当作关闭（fail-closed，同 routers/reports.py）
        enabled = False
    if not enabled:
        raise SkillError(
            "E_SKILL_DISABLED",
            "custom agents are disabled (MAILAGENT_CUSTOM_AGENTS_ENABLED=false)",
            http_status=409,
            hint="the owner has to turn custom agents back on before these tools work",
        )


def _require_custom_agent(ctx: Any, agent_id: str) -> dict[str, Any]:
    agent = ctx.report_store().get_agent(agent_id)
    if agent is None or agent.get("type") != "custom":
        raise SkillError("E_NOT_FOUND", f"custom agent {agent_id!r} not found", http_status=404)
    return agent


def _job_repo(ctx: Any) -> Any:
    from src.sync.async_jobs import AsyncJobRepository

    return AsyncJobRepository(db_path=ctx.config().sync_store_db_path)


def _custom_agent_list(ctx: Any, params: dict[str, Any]) -> dict[str, Any]:
    limit = int_arg(params, "limit", default=50, lo=1, hi=_LIST_LIMIT_MAX)
    _require_feature(ctx)
    from src.reports import wire

    custom = [wire.resolve_agent(a) for a in ctx.report_store().list_agents() if a.get("type") == "custom"]
    items, cut = cap_list(custom, limit)
    return {
        "count": len(items),
        "truncated": cut,
        "items": [
            {"id": a["id"], "title": a["title"], "enabled": a["enabled"], "trigger": a["trigger"]}
            for a in items
        ],
    }


def _custom_agent_get(ctx: Any, params: dict[str, Any]) -> dict[str, Any]:
    runs_limit = int_arg(params, "runs_limit", default=5, lo=0, hi=_RUNS_LIMIT_MAX)
    agent_id = str_arg(params, "agent_id", max_len=_AGENT_ID_MAX_CHARS, required=True)
    _require_feature(ctx)
    from src.reports import wire

    spec = wire.resolve_agent(_require_custom_agent(ctx, agent_id))
    recent_runs: list[dict[str, Any]] = []
    if runs_limit > 0:
        agent_runs_router = api_router("agent_runs")
        for job in _job_repo(ctx).list_runs(job_type="agent_run", target_key=agent_id, limit=runs_limit):
            item = agent_runs_router._run_history_item(job)
            recent_runs.append(
                {
                    "job_id": item["jobId"],
                    "state": item["state"],
                    "outcome": item["outcome"],
                    "approval_state": item["approvalState"],
                    "session_id": item["sessionId"],
                    "created_at": item["createdAt"],
                    "finished_at": item["finishedAt"],
                    "error": item["error"],
                }
            )
    return {
        "id": spec["id"],
        "type": spec["type"],
        "title": spec["title"],
        "description": spec["description"],
        "enabled": spec["enabled"],
        "trigger": spec["trigger"],
        "budget": spec["budget"],
        "updated_at": spec["updated_at"],
        "recent_runs": recent_runs,
    }


def _custom_agent_run_now(ctx: Any, params: dict[str, Any]) -> dict[str, Any]:
    extra = sorted(set(params) - _RUN_NOW_FIELDS)
    if extra:
        raise SkillError(
            "E_INVALID_ARG",
            f"unexpected field(s) {extra}: run_now only takes agent_id; the run uses the agent's own configuration",
        )
    agent_id = str_arg(params, "agent_id", max_len=_AGENT_ID_MAX_CHARS, required=True)
    _require_feature(ctx)
    agent = _require_custom_agent(ctx, agent_id)
    # 🔴 停用判定必须在入队之前：入队后 gateway 拉 spec 才拒的那条 failed run 也算进当日次数。
    if not agent.get("enabled"):
        raise SkillError(
            "E_CONFLICT",
            f"custom agent {agent_id!r} is disabled",
            http_status=409,
            hint="the owner has to enable this agent before it can be run",
        )
    from src.agents.run_queue import enqueue_manual_agent_run

    queued = enqueue_manual_agent_run(_job_repo(ctx), agent_id=agent_id, budget_json=agent.get("budget_json"))
    return {
        "job_id": queued["job_id"],
        "agent_id": agent_id,
        "status": "skipped" if queued["skipped"] else "queued",
        "was_created": queued["was_created"],
    }


def build_skill() -> BoundSkill:
    agent_id_prop = {"type": "string", "maxLength": _AGENT_ID_MAX_CHARS, "description": "from custom_agent_list"}
    tools = [
        BoundTool(
            ToolDef(
                name="custom_agent_list",
                description="List the owner's custom agents: id, title, enabled and trigger.",
                input_schema={
                    "type": "object",
                    "properties": {
                        "limit": {"type": "integer", "minimum": 1, "maximum": _LIST_LIMIT_MAX},
                    },
                },
                output_schema={"type": "object", "description": "{count, truncated, items}"},
                confirmation_tier="none",
                side_effect="read",
                auth_scopes=["agents:read"],
                mcp_exposed=True,
                handler=ToolHandler(kind="service", target="ReportStore.list_agents"),
            ),
            _custom_agent_list,
        ),
        BoundTool(
            ToolDef(
                name="custom_agent_get",
                description=(
                    "Read one custom agent: title, description, enabled, trigger, run budget and its "
                    "most recent runs (state: queued / running / completed / skipped / paused_* / "
                    "failed; skipped = the daily run limit prevented execution)."
                ),
                input_schema={
                    "type": "object",
                    "properties": {
                        "agent_id": agent_id_prop,
                        "runs_limit": {"type": "integer", "minimum": 0, "maximum": _RUNS_LIMIT_MAX},
                    },
                    "required": ["agent_id"],
                },
                output_schema={"type": "object"},
                confirmation_tier="none",
                side_effect="read",
                auth_scopes=["agents:read"],
                mcp_exposed=True,
                handler=ToolHandler(kind="service", target="ReportStore.get_agent"),
            ),
            _custom_agent_get,
        ),
        BoundTool(
            ToolDef(
                name="custom_agent_run_now",
                description=(
                    "Run an enabled custom agent once, now. The run is queued and executes in the "
                    "background with the agent's own configured permissions; check custom_agent_get "
                    "for its result. Takes only agent_id. Requires confirm=true; counts against the "
                    "agent's daily run limit (status=skipped when it is used up)."
                ),
                input_schema={
                    "type": "object",
                    "properties": {
                        "agent_id": agent_id_prop,
                        "confirm": {
                            "type": "boolean",
                            "description": "must be true — explicit intent to start a run",
                        },
                    },
                    "required": ["agent_id"],
                },
                output_schema={"type": "object", "description": "{job_id, agent_id, status, was_created}"},
                confirmation_tier="edit",
                side_effect="write",
                auth_scopes=["agents:run"],
                mcp_exposed=True,
                # 配额闸（src/skills/rate_limit.py）：每次触发都是一次真实的 LLM run，挡跑飞的外部 agent。
                rate_limit={"limit": 10, "per_seconds": 3600, "scope": "principal"},
                handler=ToolHandler(kind="service", target="run_queue.enqueue_manual_agent_run"),
            ),
            _custom_agent_run_now,
        ),
    ]
    return BoundSkill(
        name="agents",
        version="1.0.0",
        title="Custom Agents",
        description="Read the owner's custom agents and trigger one manual run of an enabled agent.",
        default_enabled=True,
        prompt_fragment=(
            "Use custom_agent_list and custom_agent_get to see the owner's custom agents and their "
            "recent runs. custom_agent_run_now starts one background run of an enabled agent "
            "(confirm=true required); it cannot change what the agent does."
        ),
        docs_path="skills/agents/SKILL.md",
        tools=tools,
    )
