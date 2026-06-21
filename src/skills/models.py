"""Skill manifest v1 的 Pydantic 模型（序列化真源）。

字段对齐 architecture.md §2.1 manifest v1：
  Manifest = manifest_version / generated_at / server_version / capabilities / skills[]
  Skill    = name / version / title / description / default_enabled / availability /
             prompt_fragment / docs_path / tools[]
  Tool     = name / description / input_schema / output_schema / confirmation_tier /
             side_effect / auth_scopes / timeout_ms / rate_limit / mcp_exposed / handler

JSON schema snapshot 测试（tests/api/test_skill_manifest.py）锁这份形状。
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

MANIFEST_VERSION = "1.0"

ConfirmationTier = Literal["none", "preview", "edit"]
SideEffect = Literal["read", "write", "external_call", "send"]
HandlerKind = Literal["service", "repository", "subprocess", "api"]


class ToolHandler(BaseModel):
    """handler binding 元数据（**展示用**，非可调用对象 —— 实际 callable 在 registry 里）。"""

    kind: HandlerKind
    target: str  # 如 'reports.run_report_once' / 'EmailRepository.search_email_bodies_with_meta'


class ToolDef(BaseModel):
    name: str
    description: str
    input_schema: dict[str, Any]
    output_schema: dict[str, Any]
    confirmation_tier: ConfirmationTier
    side_effect: SideEffect
    auth_scopes: list[str]
    mcp_exposed: bool
    handler: ToolHandler
    timeout_ms: Optional[int] = None
    rate_limit: Optional[dict[str, Any]] = None


class SkillAvailability(BaseModel):
    available: bool
    reason: Optional[str] = None


class SkillDef(BaseModel):
    name: str
    version: str
    title: str
    description: str
    default_enabled: bool
    availability: SkillAvailability
    prompt_fragment: str
    docs_path: str
    tools: list[ToolDef]


class SkillManifest(BaseModel):
    manifest_version: str = MANIFEST_VERSION
    generated_at: str
    server_version: str
    capabilities: dict[str, Any] = Field(default_factory=dict)
    skills: list[SkillDef]
