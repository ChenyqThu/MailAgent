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

from pydantic import BaseModel, Field, model_validator

from src.skills.secret_names import validate_secret_name

MANIFEST_VERSION = "1.0"

ConfirmationTier = Literal["none", "preview", "edit"]
SideEffect = Literal["read", "write", "external_call", "send"]
HandlerKind = Literal["service", "repository", "subprocess", "api"]

# ── skill 包 manifest v2（S2 W2）—— skill 包内 manifest.json 的**校验 schema** ──────────────
# ≠ 上面 build_manifest 组装的对外交付 SkillManifest v1（那份是 delivery，principal-scoped）。
# 这份是「装进本机的包」的 manifest，pack_verify 用它做结构校验。
MANIFEST_VERSION_V2 = 2

# skill 包类型（installed.py 投影据此分流）：
#   document      —— 纯文档（prompt_fragment + SKILL.md），零工具。
#   existing-tool —— 复用既有 builtin 只读工具（tool 带 bind='existing'）。
#   mcp           —— schema-only（真实调用推迟）。
#   script        —— 带脚本（manifest + SKILL.md + 脚本文件），**强制零工具**，经 run_command 执行。
SkillType = Literal["document", "existing-tool", "mcp", "script"]


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


# ── skill 包 manifest v2 校验模型（S2 W2）────────────────────────────────────────────────


class SkillSecretDecl(BaseModel):
    """script skill 声明它需要的一个密钥 —— **只声明名字 + 说明，永无值**。值经 Settings 单独写、
    脚本执行时注入子进程 env（W3），永不进 manifest / prompt / 日志 / 审计。"""

    name: str
    description: str = ""


class SkillPackageManifest(BaseModel):
    """skill 包内 ``manifest.json`` 的 v2 校验 schema。

    v1 严格向后兼容：**无** ``manifest_version:2`` / **无** ``type`` 的旧 inline manifest 仍走
    ``AgentConfigStore.install_skill`` 的 schemaless dict 路径（不过本模型）；本模型只在
    ``pack_verify`` 校验 v2 包时使用。``type=='script'`` 硬约束 ``tools==[]`` = 「script skill 不
    做动态一等工具注册」的机械保证（不碰 skill_gating 完整性测试）。
    """

    manifest_version: int = MANIFEST_VERSION_V2
    type: SkillType
    name: str
    version: str = "0.0.0"
    title: str = ""
    description: str = ""
    default_enabled: bool = False
    prompt_fragment: str = ""
    docs_path: str = ""
    entry_hint: Optional[str] = None  # 纯提示文本（如 "python3 main.py"），非执行依据
    secrets: list[SkillSecretDecl] = Field(default_factory=list)
    config_schema: Optional[dict[str, Any]] = None  # 非敏感配置的 JSON schema，供 Settings 表单
    # 占位不实现验签（S2 无发布方生态 / 密钥分发；字段先占位避免 v3 再迁移）。
    signature: Optional[str] = None
    publisher: Optional[str] = None
    tools: list[dict[str, Any]] = Field(default_factory=list)

    # 供应链 manifest 应严格：拒未知字段（防投毒经额外字段夹带被下游误读）。
    model_config = {"extra": "forbid"}

    @model_validator(mode="after")
    def _enforce_constraints(self) -> "SkillPackageManifest":
        # 机械保证：script skill 零工具（经 run_command 执行，不注册一等工具）。
        if self.type == "script" and self.tools:
            raise ValueError(
                "a 'script' skill must declare zero tools (tools == []); scripts run via "
                "run_command, not dynamic tool registration"
            )
        # secret 名硬校验（安装侧第一重；注入侧 W3 二重）——防覆盖执行环境 / 冒充全局密钥。
        seen: set[str] = set()
        for decl in self.secrets:
            reason = validate_secret_name(decl.name)
            if reason:
                raise ValueError(reason)
            if decl.name in seen:
                raise ValueError(f"duplicate secret name in manifest.secrets: {decl.name!r}")
            seen.add(decl.name)
        return self
