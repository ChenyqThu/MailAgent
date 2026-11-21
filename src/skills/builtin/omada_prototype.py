"""omada_prototype skill —— 基于 omada-ui-kit 真实组件库的高保真原型构建规范（零动态工具）。"""

from __future__ import annotations

from src.skills.registry import BoundSkill

_PROMPT_FRAGMENT = """When the user asks to build an Omada product prototype, management console, dashboard, or
interactive UI demo based on `omada-ui-kit`, first call `skill_read` with name `"omada_prototype"` to load
the real component playbook, then write a complete TSX demo and compile it with `artifact_build_omada`.

Rules:
- Use real `@/omada` components, Ant Design 6 + Tailwind utilities, and authentic network/device telemetry;
  never hand-roll plain HTML imitations when an `omada-ui-kit` component exists.
- Reuse the same `slug` across revisions so `artifact_build_omada` produces immutable `v1`, `v2`, ... bundles.
- After building, optionally inspect `local_preview_url` via `browser_use` if available to verify visual layout."""


def build_skill() -> BoundSkill:
    return BoundSkill(
        name="omada_prototype",
        version="1.0.0",
        title="Omada UI Prototype Studio",
        description=(
            "Build and compile interactive React prototypes backed by real ~/Documents/omada-ui-kit "
            "components, tokens, and Vite bundling via artifact_build_omada."
        ),
        default_enabled=True,
        prompt_fragment=_PROMPT_FRAGMENT,
        docs_path="skills/omada_prototype/SKILL.md",
        tools=[],
    )
