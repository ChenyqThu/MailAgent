"""omada_prototype skill —— 基于 @chenyqthu/omada-ui-kit 组件库的高保真原型构建规范（零动态工具）。"""

from __future__ import annotations

from src.skills.registry import BoundSkill

_PROMPT_FRAGMENT = """When the user asks to build an Omada product prototype, management console, dashboard, or
interactive UI demo based on `omada-ui-kit`, first call `skill_read` with name `"omada_prototype"`, inspect
verified component props and Figma asset slugs with `omada_catalog_query`, and write a zero-build single-file
HTML5 prototype referencing `@chenyqthu/omada-ui-kit` CDN (`dist/style.css` + `dist/standalone.js` +
`@babel/standalone@7`) via `artifact_write` (`artifact_type: "app"`). Use `artifact_build_omada` only as Mode B
fallback when an offline/no-CDN bundle or custom Tailwind/TypeScript Vite compile is required.

Rules:
- Always check props, `SIcon` names, and `SProductImage`/`SIllustration` slugs via `omada_catalog_query`; never guess.
- Inside Mode A single-file HTML demos, use `S*` layout components, AntD `Row`/`Col`/`Space`/`Flex`, inline `style`,
  or classes from `dist/style.css` (do not assume consumer Tailwind JIT), and clear `SEmulatorShell`'s quick-drawer
  handle (`paddingRight: 40`).
- Never pass CSS variable strings (`var(--omada-*)`) to ECharts chart `color` props (`SLineChart` /
  `SSparkChart`); always pass concrete hex/rgb colors or `omadaChartPalette` / `useOmadaTheme().tokens`.
- Reuse the same `slug` across revisions (`artifact_write` or `artifact_build_omada`) so immutable `v1`, `v2`, ... advance cleanly.
- To publish a saved deliverable to Canvas Artifact Server, call `artifact_publish_bundle` (with `slug` and optional
  `visibility`) instead of pasting HTML/bundles into `mcp__artifact_server__artifact_publish`.
- After building, optionally inspect `local_preview_url` via `browser_use` if available to verify visual layout."""


def build_skill() -> BoundSkill:
    return BoundSkill(
        name="omada_prototype",
        version="1.1.0",
        title="Omada UI Prototype Studio",
        description=(
            "Build interactive TP-Link Omada Controller v6.3 prototypes using @chenyqthu/omada-ui-kit "
            "(omada_catalog_query + zero-build standalone HTML via artifact_write, or local Vite via artifact_build_omada)."
        ),
        default_enabled=True,
        prompt_fragment=_PROMPT_FRAGMENT,
        docs_path="skills/omada_prototype/SKILL.md",
        tools=[],
    )
