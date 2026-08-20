"""Pydantic request schemas for the Contact Directory REST face (task 08-13 WP2).

刻意比 matters 薄: contacts 写面无 version CAS / mutation 幂等信封 (主 session
裁决 —— 治理写全部幂等且低频, 保持简单)。字段值域校验在 service 层
(``src/contacts/service.py``), 这里只承载形状。
"""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field


class ContactResolveRequest(BaseModel):
    """批量精确解析 (WP4 互链): 邮件详情头一封一次把地址集换成 chip 数据。
    上限 100 在 router 校验 (400 E_INVALID_ARG, 跟随本面 view/sort 的错误形状,
    不用 pydantic 422)。"""

    emails: list[str] = Field(default_factory=list)


class ContactPatchRequest(BaseModel):
    """身份字段编辑。🔴 「未提供」≠「置空」—— router 用 ``model_dump(
    exclude_unset=True)`` 区分, 只把显式出现的键交给 service (保存即落锁)。"""

    display_name: Optional[str] = None
    formal_name: Optional[str] = None
    organization: Optional[str] = None
    department: Optional[str] = None
    role_title: Optional[str] = None
    phone: Optional[str] = None
    notes: Optional[str] = None
    function: Optional[str] = None
    seniority: Optional[str] = None
    gender: Optional[str] = None


class ContactLockRequest(BaseModel):
    field: str = Field(min_length=1)
    locked: bool


class ContactHideRequest(BaseModel):
    hidden: bool


class ContactKindRequest(BaseModel):
    kind: str = Field(min_length=1)


class ContactSelfRequest(BaseModel):
    is_self: bool


class ContactMergeRequest(BaseModel):
    """人级合并 (WP3, D6)。URL 里的 contact_id = winner (保留方)。

    主邮箱/曾用是**预览页勾选结果** —— 默认值推导 (last_seen 最新者做主 +
    60 天条款) 是前端纯函数职责 (`mergeModel.ts`), 服务端只按入参落库
    (service docstring 钉死)。跟随本文件头惯例: 无 CAS / 无幂等信封。"""

    loser_id: int
    primary_email: str = Field(min_length=3)
    former_emails: list[str] = Field(default_factory=list)


class ContactManagerRequest(BaseModel):
    """组织关系 (WP5): 指定/解除上级。null = 解除 (manager_src 一并清)。
    src **不在 wire 形状里** —— REST 面恒写 'manual' (auto 是 WP6/WP7 的
    建议采纳链路, 不从这里进)。"""

    manager_contact_id: Optional[int] = None


class ContactPrimaryEmailRequest(BaseModel):
    email: str = Field(min_length=3)


class ContactFormerEmailRequest(BaseModel):
    email: str = Field(min_length=3)
    former: bool


class ContactProfileSuggestionAdoptRequest(BaseModel):
    field: str = Field(min_length=1)
    value: Any


class ContactProfileSuggestionIgnoreRequest(BaseModel):
    field: str = Field(min_length=1)


class ContactGovernanceEvidence(BaseModel):
    message_id: str = Field(min_length=1)
    quote: str = Field(min_length=1, max_length=5000)


class ContactGovernanceProposalRequest(BaseModel):
    type: str = Field(min_length=1)
    contact_ids: list[int] = Field(min_length=1)
    payload: dict[str, Any]
    evidence: list[ContactGovernanceEvidence] = Field(min_length=1)
    confidence: Optional[float] = None
