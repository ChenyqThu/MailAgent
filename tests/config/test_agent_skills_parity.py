"""一致性闸：.claude/skills/ 下的项目级 Skill 必须完整同步到 .agents/skills/。

Antigravity 与 Codex 从 `.agents/skills/` 发现项目级 Skill，Claude Code 从 `.claude/skills/` 发现；
防止某次只在 `.claude/skills/` 新增或更新自研运维 Skill 后忘记同步，造成另一端缺失或行为漂移。
"""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CLAUDE_SKILLS_DIR = REPO_ROOT / ".claude" / "skills"
AGENTS_SKILLS_DIR = REPO_ROOT / ".agents" / "skills"

# 本仓自建的运维/工程 Skill，两边 SKILL.md 必须逐字节一致。
PROJECT_OWNED_SKILLS = frozenset(
    {
        "agent-eval",
        "db-migration",
        "debug",
        "deploy",
        "health",
        "release",
        "sprint-handoff",
    }
)


def test_every_claude_skill_exists_in_agents_skills() -> None:
    claude_names = {p.name for p in CLAUDE_SKILLS_DIR.iterdir() if p.is_dir()}
    agents_names = {p.name for p in AGENTS_SKILLS_DIR.iterdir() if p.is_dir()}
    missing = sorted(claude_names - agents_names)
    assert missing == [], (
        f".claude/skills 中存在未同步到 .agents/skills 的技能: {missing}。"
        "请同步对应 SKILL.md 到 .agents/skills/<name>/。"
    )


def test_project_owned_skills_match_byte_for_byte() -> None:
    for name in sorted(PROJECT_OWNED_SKILLS):
        claude_skill = CLAUDE_SKILLS_DIR / name / "SKILL.md"
        agents_skill = AGENTS_SKILLS_DIR / name / "SKILL.md"
        assert claude_skill.is_file(), f"缺少 .claude/skills/{name}/SKILL.md"
        assert agents_skill.is_file(), f"缺少 .agents/skills/{name}/SKILL.md"
        assert agents_skill.read_text(encoding="utf-8") == claude_skill.read_text(
            encoding="utf-8"
        ), f".agents/skills/{name}/SKILL.md 与 .claude/skills/{name}/SKILL.md 内容漂移"
