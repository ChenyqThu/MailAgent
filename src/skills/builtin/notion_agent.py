"""notion_agent skill —— 把 notion-agent subprocess 包成可调用 tool。

handler 跑 ``src/chat/notion_agent.py:run_notion_agent``（notion-agent CLI subprocess 是该
工具自身的领域实现，**不是** fork mailagent CLI —— 符合 BASE-1）。复用其 serial gate +
idle 看门狗 + exit 分类 + safe error。``thread_id`` 支持续轮。

默认 ``mcp_exposed=False`` 且 scope ``notion_agent:invoke`` 不进 P1 handoff key —— 外部
agent 默认不直调 notion-agent，需显式授权。
"""

from __future__ import annotations

import json
from typing import Any

from src.skills.errors import SkillError
from src.skills.models import ToolDef, ToolHandler
from src.skills.registry import BoundSkill, BoundTool


async def _notion_agent_chat(ctx: Any, params: dict[str, Any]) -> dict[str, Any]:
    from src.chat.notion_agent import run_notion_agent

    prompt = str(params["prompt"])
    thread_id = params.get("thread_id")
    model = params.get("model")

    history: list[dict[str, Any]] = []
    if thread_id:
        # 让 extract_turn 从 assistant.metadata 取到续轮 thread_id。
        history.append(
            {"role": "assistant", "content": "", "metadata": json.dumps({"thread_id": thread_id})}
        )
    history.append({"role": "user", "content": prompt})
    req: dict[str, Any] = {"history": history}
    if model:
        req["model"] = model

    final_content = ""
    new_thread_id = thread_id
    async for ev in run_notion_agent(req):
        etype = ev.get("type")
        if etype == "done":
            final_content = ev.get("finalContent", "") or ""
            md = ev.get("metadata") or {}
            new_thread_id = md.get("thread_id") or new_thread_id
        elif etype == "error":
            raise SkillError(
                ev.get("code", "E_LLM_FAILED"),
                ev.get("message", "notion-agent failed"),
                http_status=502,
            )
    return {"final_content": final_content, "thread_id": new_thread_id}


_TOOL_DESCRIPTION = (
    "Delegate a Notion-workspace request to the notion-agent (a separate AI that runs with the "
    "owner's bound Custom Agent persona and can both ANSWER questions from the Notion workspace "
    "AND EXECUTE Notion tasks — e.g. look up a page, update a schedule/calendar entry, or edit a "
    "context/notes page). Pass `prompt` in natural language describing what to find or do; pass "
    "`thread_id` (returned by a prior call) to continue that same Notion conversation. Returns "
    "{final_content, thread_id}. 🔴 This makes an EXTERNAL AI call and any side effects land on the "
    "Notion side; the user must approve each call and, once approved, a Notion write it performs "
    "cannot be undone from here. This is a SYNCHRONOUS request that waits for the notion-agent to "
    "finish — good for quick lookups and small edits (seconds); a task you expect to take longer "
    "than ~60s is not a good fit for this synchronous call."
)

_PROMPT_FRAGMENT = (
    "notion_agent_chat delegates a request to the Notion knowledge agent (the owner's bound Custom "
    "Agent persona). Use it to (a) answer questions grounded in the Notion workspace and (b) EXECUTE "
    "Notion tasks — update a schedule, edit a context/notes page, etc. — when the user asks. Pass a "
    "natural-language `prompt`; pass `thread_id` from a previous result to continue the same "
    "conversation. It runs synchronously (best for second-scale lookups / small edits; not for tasks "
    "you expect to exceed ~60s). Every call is external and asks for the user's approval first; a "
    "Notion write it makes takes effect on the Notion side and is not reversible from here. Not "
    "enabled by default."
)


def build_skill() -> BoundSkill:
    tools = [
        BoundTool(
            ToolDef(
                name="notion_agent_chat",
                description=_TOOL_DESCRIPTION,
                input_schema={
                    "type": "object",
                    "properties": {
                        "prompt": {
                            "type": "string",
                            "description": (
                                "Natural-language request for the Notion agent: a question to "
                                "answer from the workspace, or a task to perform (update schedule, "
                                "edit a context page, …)."
                            ),
                        },
                        "thread_id": {
                            "type": "string",
                            "description": (
                                "Continue a prior Notion conversation — pass the thread_id returned "
                                "by a previous call."
                            ),
                        },
                        "model": {
                            "type": "string",
                            "description": "Override the bound default model (optional).",
                        },
                    },
                    "required": ["prompt"],
                },
                output_schema={"type": "object", "description": "{final_content, thread_id}"},
                # 07-21 (codex HIGH-2) — edit tier (was preview): the invoke chokepoint then
                # REQUIRES an explicit boolean confirm=true (like send/draft), so a direct
                # /api/skills/invoke call cannot silently run this external-AI, irreversible-写
                # tool. The gateway passes confirm=true only AFTER its own 恒-HITL card is
                # approved; an external scoped key must opt in the same way (403 without it).
                confirmation_tier="edit",
                side_effect="external_call",
                auth_scopes=["notion_agent:invoke"],
                mcp_exposed=False,
                timeout_ms=600000,
                handler=ToolHandler(kind="subprocess", target="chat.notion_agent.run_notion_agent"),
            ),
            _notion_agent_chat,
        ),
    ]
    return BoundSkill(
        name="notion_agent",
        version="1.0.0",
        title="Notion Agent",
        description=(
            "Delegate Notion-workspace questions and tasks (update schedule, edit context pages, …) "
            "to the notion-agent CLI, run with the owner's bound Custom Agent persona."
        ),
        default_enabled=False,
        prompt_fragment=_PROMPT_FRAGMENT,
        docs_path="skills/notion_agent/SKILL.md",
        tools=tools,
    )
