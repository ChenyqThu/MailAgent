"""custom_agent skill -- code-owned conversational workflow for configuring custom agents.

The six CRUD tools themselves live in the AI SDK gateway and remain manual-chat-only,
capability-change operations. This zero-tool builtin contributes the product contract and keeps the
workflow visible through the same manifest / installed-skill / advertisedSkills projection as other
skills without creating a second execution path.
"""

from __future__ import annotations

from src.skills.registry import BoundSkill


_PROMPT_FRAGMENT = """When the user wants to create or update a Custom Agent, use the Custom Agent
configuration workflow. First understand the job, then ask only for missing trigger, capability,
and output details. An optional description (maximum 1000 characters) explains in the Agent Catalog
when the main agent should choose this specialist; it is distinct from the run instructions.
Configure permissions with the six capability tiers, never by inventing atomic
tool names: Email read/organize/draft; Calendar off/read/write; Knowledge and sessions off/on;
Reports read/produce; Web off/gated/open; Files and commands off/on. Before proposing a write, show
a complete summary covering identity, description, instructions, trigger/timezone, all six tiers, output, run
limits, and enabled state. Invoke custom_agent_create or custom_agent_update only after the user
agrees to that summary; the mandatory approval card remains the final gate. Calendar writes always
require human approval. Web open and Files/commands are high risk, and grants never create
card-free rules. For updates, read the server's current agent first and preserve fields the user did
not ask to change. Never claim an agent was created, changed, deleted, or run until the tool result
confirms it."""


def build_skill() -> BoundSkill:
    return BoundSkill(
        name="custom_agent",
        version="1.0.0",
        title="Custom Agent Builder",
        description=(
            "Design, review, create, and update Custom Agents through a clarification-first, "
            "capability-tier workflow with mandatory human approval."
        ),
        default_enabled=True,
        prompt_fragment=_PROMPT_FRAGMENT,
        docs_path="skills/custom_agent/SKILL.md",
        tools=[],
    )
