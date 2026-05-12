"""通用响应模型。"""

from __future__ import annotations

from typing import Any, Generic, List, Optional, TypeVar

from pydantic import BaseModel

T = TypeVar("T")


class PagedResponse(BaseModel, Generic[T]):
    items: List[T]
    total: int
    page: int
    page_size: int
    has_more: bool


class APIResponse(BaseModel):
    ok: bool = True
    message: str = ""
    data: Optional[Any] = None
