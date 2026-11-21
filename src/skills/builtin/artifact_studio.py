"""artifact_studio skill —— 高审美交互式 HTML5 产物创作规范（零动态工具，渐进披露）。

遵循 ``matters`` / ``skill_creator`` 同款设计：``tools=[]``，常驻 ``prompt_fragment`` 保持极简，
仅在用户要求生成看板 / 演示文稿 / 深度简报 / 架构图 / 交互原型时引导模型先调用
``skill_read("artifact_studio")`` 获取完整审美与骨架规范，再调用 gateway 写工具
``artifact_write`` 版本化落盘。
"""

from __future__ import annotations

from src.skills.registry import BoundSkill

_PROMPT_FRAGMENT = """When the user asks to create, visualize, or prototype a rich interactive deliverable
(such as a dashboard, presentation slide deck, editorial report, architecture diagram, or web mini-app),
first call `skill_read` with name `"artifact_studio"` to load the design and engineering playbook, then
produce a complete self-contained HTML5 document via `artifact_write`.

Rules:
- Ground every metric, table row, and claim in verified context or tool results; never invent numbers or
  fill gaps with placeholders.
- Reuse the same `slug` when revising an existing artifact so `artifact_write` produces clean immutable
  versions (`v1`, `v2`, ...).
- Do not call `artifact_write` for short inline chat answers that are better served as plain Markdown."""


def build_skill() -> BoundSkill:
    return BoundSkill(
        name="artifact_studio",
        version="1.0.0",
        title="Artifact Studio",
        description=(
            "Craft high-aesthetic, self-contained HTML5 dashboards, slide decks, editorial reports, "
            "diagrams, and interactive prototypes via artifact_write."
        ),
        default_enabled=True,
        prompt_fragment=_PROMPT_FRAGMENT,
        docs_path="skills/artifact_studio/SKILL.md",
        tools=[],
    )
