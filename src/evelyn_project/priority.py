"""Priority 处理。用户指示保留 excel 原值写入 Notion select。

Notion select 在收到未见过的 option 时会自动创建。xlsx 实际取值:
  N / TBD / Y / Y-Pledge / R&D project
"""

from typing import Optional


def normalize_priority(raw: Optional[str]) -> Optional[str]:
    """去空白 + 非空判断。None / 空串 → None（Notion 侧空）。

    不做语义映射——保留原值。
    """
    if raw is None:
        return None
    s = str(raw).strip()
    if not s or s in {"/", "-"}:
        return None
    return s
