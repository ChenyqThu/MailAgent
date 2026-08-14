"""Pydantic request schemas for the Contact Directory REST face (task 08-13 WP2).

刻意比 matters 薄: contacts 写面无 version CAS / mutation 幂等信封 (主 session
裁决 —— 治理写全部幂等且低频, 保持简单)。字段值域校验在 service 层
(``src/contacts/service.py``), 这里只承载形状。
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class ContactPatchRequest(BaseModel):
    """身份字段编辑。🔴 「未提供」≠「置空」—— router 用 ``model_dump(
    exclude_unset=True)`` 区分, 只把显式出现的键交给 service (保存即落锁)。"""

    display_name: Optional[str] = None
    name_en: Optional[str] = None
    organization: Optional[str] = None
    department: Optional[str] = None
    role_title: Optional[str] = None
    phone: Optional[str] = None
    notes: Optional[str] = None
    function: Optional[str] = None
    seniority: Optional[str] = None


class ContactLockRequest(BaseModel):
    field: str = Field(min_length=1)
    locked: bool


class ContactHideRequest(BaseModel):
    hidden: bool


class ContactKindRequest(BaseModel):
    kind: str = Field(min_length=1)


class ContactSelfRequest(BaseModel):
    is_self: bool


class ContactPrimaryEmailRequest(BaseModel):
    email: str = Field(min_length=3)


class ContactFormerEmailRequest(BaseModel):
    email: str = Field(min_length=3)
    former: bool
