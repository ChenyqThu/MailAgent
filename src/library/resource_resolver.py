"""matters ← library 的存在性 / 摘要回调（进程级注册一次）。

matters 域**不直接 import 资料库存储层**（design §9.2）：它只持有 ``library:{id}`` 这个键，
存在性与摘要经一个注入的回调拿。本模块就是那个回调的实现，放在 library 侧 ——
依赖方向因此是 library → matters，与设计一致。

没注册回调时 matters 侧 fail-closed（`library:` 键恒判为不可用）。那道判定唯一的作用
是挡住模型编造的 file id，「读不到就放行」等于把它整条关掉，所以 fail-closed 是对的；
代价是漏注册 = 已关联的库文件在列表里显示不可用（显示降级，不崩、不放行）。
"""

from __future__ import annotations

import logging
from typing import Any, Mapping, Optional

logger = logging.getLogger(__name__)

#: frontmatter 里认哪个键当摘要（择一，取先命中的）。matters 侧不解析 frontmatter。
_SUMMARY_KEYS = ("summary", "description")


def _frontmatter_summary(markdown: str) -> Optional[str]:
    """只认文件开头的 YAML frontmatter，且只取标量。解析不了就返回 None，绝不抛。"""
    if not markdown.startswith("---"):
        return None
    end = markdown.find("\n---", 3)
    if end < 0:
        return None
    for line in markdown[3:end].splitlines():
        key, sep, value = line.partition(":")
        if not sep:
            continue
        if key.strip().lower() in _SUMMARY_KEYS:
            text = value.strip().strip("'\"")
            return text or None
    return None


def make_library_file_resolver(service_factory):
    """`service_factory()` → `LibraryService`。返回可直接交给 `set_library_file_resolver` 的回调。"""

    def _resolve(file_id: int, *, with_text: bool = False) -> Optional[Mapping[str, Any]]:
        service = service_factory()
        # 🔴 走 files() 而不是 file()：后者会把文本类文件整个读进内存再截，而存在性判定是
        # **逐行**调用的（资料列表投影每份资料一次）。files() 只查元数据行。
        rows = service.files([int(file_id)])
        if not rows:
            return None
        row = rows[0]
        if row.get("status") != "present":
            return None
        if not with_text:
            return row
        text = ""
        try:
            payload = service.file_text(int(file_id))
            text = payload.get("markdown") or ""
        except Exception as exc:  # noqa: BLE001 — 抽取没就绪不该让关联失败
            logger.warning(f"[library] file_text failed for {file_id}: {exc}")
        out = dict(row)
        out["text"] = text
        summary = _frontmatter_summary(text)
        if summary:
            out["summary"] = summary
        return out

    return _resolve


def install_library_resolver(service_factory) -> None:
    """把回调装进 matters 的注册表。serve-api 与主服务各调一次（进程级事实）。"""
    from src.matters.resource_identity import set_library_file_resolver

    set_library_file_resolver(make_library_file_resolver(service_factory))
