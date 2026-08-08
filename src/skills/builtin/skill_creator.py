"""Builtin Skill Creator guidance skill (zero dynamic tools)."""

from src.skills.models import SkillAvailability
from src.skills.registry import BoundSkill


def build_skill() -> BoundSkill:
    return BoundSkill(
        name="skill_creator",
        version="1.0.0",
        title="Skill Creator",
        description="Turn a successful workflow into a validated, reviewable MailAgent skill draft.",
        default_enabled=True,
        availability=SkillAvailability(available=True, reason=None),
        prompt_fragment="",
        docs_path="skills/skill_creator/SKILL.md",
        tools=[],
    )
