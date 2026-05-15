"""Priority 处理: 把 xlsx 取值映射成 Notion select 的语义化标签.

xlsx 实际取值:
  英文 (v1 / v2 Sheet 1): N / TBD / Y / Y-Pledge / R&D project
  中文 (v2 Sheet 3 Suspended): 是 / 否

映射规则:
  Y-Pledge      → 军令状项目
  Y / 是         → 高优先级
  N / 否         → 低优先级
  TBD            → 原样 (Notion 侧自然显示 "TBD")
  R&D project    → 原样
  其他未识别值    → 原样直写

匹配大小写不敏感 ('y-pledge' / 'Y-PLEDGE' 都识别); 中文走精确匹配.
"""

from typing import Optional


_PRIORITY_MAP = {
    "y-pledge": "军令状项目",
    "y": "高优先级",
    "n": "低优先级",
    "是": "高优先级",
    "否": "低优先级",
}


def normalize_priority(raw: Optional[str]) -> Optional[str]:
    """去空白 + 非空判断 + 语义映射.

    None / 空串 / "/" / "-" → None (Notion 侧空).
    其它按 _PRIORITY_MAP 查表; 命中映射, 未命中保留原值.
    """
    if raw is None:
        return None
    s = str(raw).strip()
    if not s or s in {"/", "-"}:
        return None
    mapped = _PRIORITY_MAP.get(s.lower())
    if mapped:
        return mapped
    return s
