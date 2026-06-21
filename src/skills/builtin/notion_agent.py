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


def build_skill() -> BoundSkill:
    tools = [
        BoundTool(
            ToolDef(
                name="notion_agent_chat",
                description="Ask the notion-agent (Notion knowledge agent); supports thread_id.",
                input_schema={
                    "type": "object",
                    "properties": {
                        "prompt": {"type": "string"},
                        "thread_id": {"type": "string", "description": "continue a prior thread"},
                        "model": {"type": "string"},
                    },
                    "required": ["prompt"],
                },
                output_schema={"type": "object", "description": "{final_content, thread_id}"},
                confirmation_tier="preview",
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
        description="Bridge to the notion-agent CLI for Notion-backed knowledge Q&A.",
        default_enabled=False,
        prompt_fragment=(
            "Use notion_agent_chat to ask the Notion knowledge agent a question; pass thread_id "
            "to continue a prior conversation. Not enabled by default."
        ),
        docs_path="skills/notion_agent/SKILL.md",
        tools=tools,
    )
