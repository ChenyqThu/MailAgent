"""matters skill —— 事项跟进的方法论（零工具，只出 prompt_fragment）。

🔴 这个 skill **不解锁任何工具**：``matter_*`` 十二件都在 gateway 的
``CORE_UNGATED_GATEWAY_TOOLS`` 里（``frontend/src/ai-gateway/tools/skill_gating.ts``），永不被
skill→tool 门控 —— 它们的开关权在 ``MAILAGENT_MATTERS_ENABLED`` + 审批，不在这里。所以本 skill
的价值是「教会 agent 怎么跟进一件事」，与 ``custom_agent`` 同形（``tools=[]``）。

🔴 命名：仓内另有一个 headless run kind 叫 ``matter_followup``（``src/matters/run_spec.py`` /
``src/agents/run_worker.py``），**同名不同物**。skill 名取 ``matters``，别撞。

``default_enabled`` 跟随 ``MAILAGENT_MATTERS_ENABLED``：事项功能没开时注入一段「怎么用事项工具」的
方法论 = 教模型去调一组根本没注册的工具（capability hallucination）。flag 与本 skill 一样是重启语义
（``code_builtin_skills()`` 是 ``lru_cache``），两者一致。

⚠️ 本 fragment 是 **manual-only**（gateway ``systemPrompt.ts`` 的 ``!headlessAgentRun`` 门）；
跟进 run 的对应物 = ``src/matters/run_spec.py`` 的 ``_RUN_METHODOLOGY``（0813 轮 3 O4，按
headless 场地改写的子集，**有意不同文** —— 那边没有任何写工具，措辞必须如实）。改判断纪律时
两处都过一眼。
"""

from __future__ import annotations

from src.skills.registry import BoundSkill


_PROMPT_FRAGMENT = """When the user is working on a Matter (a tracked piece of work with status,
action items, stakeholders, linked evidence, and a timeline), follow the Matter workflow.

Before creating anything, call matter_find with the user's own words and look for an existing Matter
that already covers this work; joining or updating an existing Matter is almost always better than
creating a near-duplicate. Only create when nothing matches, and say which existing Matters you
checked.

Creating a Matter is a research step, not a form to fill in. Once you know you are creating one,
gather the material it should start with instead of working from the single message in front of you:
the surrounding thread, related mail, and the documents that already describe this work. Which
sources you can reach is decided by the tools actually registered in this conversation — look at
your own tool list and use what is there (mailbox full-text search, a Notion or knowledge-base
search, a connected external service). Never imply you searched a source you have no tool for: name
it as unsearched instead. Link what you found as resources on the Matter rather than leaving it in
the chat, and close by reporting which sources you searched, what you found, and where you came up
empty.

Before judging progress, read the evidence with matter_get instead of inferring from the title.
Compare the open action items, the stakeholders, and the recent timeline events against the accepted
summary, and separate what the evidence shows from what you are guessing. When evidence is missing,
say what is missing rather than filling the gap.

Prefer the smallest write that records the change: add a note or update one item instead of
rewriting the summary. Rewrite the current summary only when the evidence supports a new state. A
follow-up email is drafted for the owner to review, never sent by you. Every matter write returns a
receipt with an undo descriptor and needs the owner's approval card; never report a Matter as
created, updated, or advanced until the tool result confirms it."""


def _default_enabled() -> bool:
    try:
        from src.api.deps import get_settings

        return bool(getattr(get_settings(), "matters_enabled", False))
    except Exception:  # noqa: BLE001 — 配置读不到时保守不宣传（skill 面不该拖垮启动）
        return False


def build_skill() -> BoundSkill:
    return BoundSkill(
        name="matters",
        version="1.0.0",
        title="Matter Follow-up",
        description=(
            "Track a piece of work end to end: find before creating, read the evidence before "
            "judging progress, and record changes as reviewable writes."
        ),
        default_enabled=_default_enabled(),
        prompt_fragment=_PROMPT_FRAGMENT,
        docs_path="skills/matters/SKILL.md",
        tools=[],
    )
