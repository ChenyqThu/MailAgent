"""通讯录枚举单源 + function/seniority 确定性词表派生 (task 08-13 WP1)。

- ``CONTACT_*_VALUES`` 是 ``contact`` 表各 CHECK 值域的**唯一权威** ——
  ``src/mail/sync_store.py`` 的 ``CONTACT_TABLE_DDLS`` 经 ``sql_check_clause``
  引用, 不手抄 (仓规: 第二处手抄先消灭镜像; 本模块零依赖, TS 类型 / i18n
  词表加入时在此建 parity 闸, WP2+)。
- ``derive_function`` / ``derive_seniority``: role_title → 枚举的**确定性词表
  映射** (owner 拍板 Q13: 分组与筛选只吃枚举, 绝不 parse 自由文本做分组判据;
  role_title 本身守身份红线 —— owner 手填 / 画像建议「采纳」写入, L0 不猜、
  不做签名档正则直抽)。词表保守: 只映射高置信中英职衔关键词, 不命中返回
  None (分组进「未分组」是预期, 不硬凑)。
- 🔴 WP1 期 role_title 全空 ⇒ 派生实际不产出, 属预期 (不造数据)。
"""

from __future__ import annotations

import re
from typing import Optional, Tuple

# ==================== contact 表 CHECK 值域 (唯一权威) ====================

#: 职能 (展示词表见设计规格 §2.1: 技术/产品/交付/法务/合规/采购/数据/安全/
#: 项目管理/邮件组/系统)。maillist/system 不由 role_title 派生 (kind 域语义)。
CONTACT_FUNCTION_VALUES: Tuple[str, ...] = (
    "tech", "product", "delivery", "legal", "compliance", "procurement",
    "data", "security", "pm", "maillist", "system",
)

#: 职级 (VP·高管 / 总监 / 负责人 / 经理 / 专员)。
CONTACT_SENIORITY_VALUES: Tuple[str, ...] = (
    "vp", "director", "lead", "manager", "staff",
)

#: 联系人类别 (§3.4 噪音治理)。
CONTACT_KIND_VALUES: Tuple[str, ...] = ("person", "robot", "list")

#: 上级来源 (manual=owner 指定; auto=AI 建议采纳)。
CONTACT_MANAGER_SRC_VALUES: Tuple[str, ...] = ("manual", "auto")

#: 可锁字段词表 (WP2 字段级锁定, v55 `contact.identity_locks_json` 的键域唯一
#: 权威)。phone 物理落 ``contact_info_json.phone`` (无独立列); notes **有意不在**
#: 词表里 —— 手记是 owner 私有文本, 自动提取从不写它, 无锁可言。
#: 🔴 三个「名字」字段各管一件事 (task 08-14 WP-6 A, 详见
#: docs/reference/contacts/contact-directory.md §2.1):
#:   - ``display_name``  = **常用名** (同事口头怎么叫: 英文名 / 「x 工」「x 哥」)。
#:     scanner 自动刷 (最近一封的 sender display name), owner 一改即落锁。
#:   - ``formal_name``   = **正式名** (系统/合同上的那个, 中文或英文皆可)。
#:     **纯手填** —— 自动提取从不写它。曾名 ``name_en``, v59 正名。
#:   - ``name_variants_json`` = 自动收集的历史显示名集合, 只喂搜索, 不属上面的
#:     「正式/常用」二分, 故不可锁 (没有「人的决定」可保护)。
CONTACT_LOCKABLE_FIELDS: Tuple[str, ...] = (
    "display_name", "formal_name", "organization", "department",
    "role_title", "phone", "function", "seniority",
)


# ==================== 词表匹配 ====================

def _hit(haystack: str, token: str) -> bool:
    """短拉丁 token 按词边界匹配 (防 'vp' 命中 'avp*'), 其余按子串。"""
    if token.isascii() and len(token) <= 4:
        return re.search(
            rf"(?<![a-z0-9]){re.escape(token)}(?![a-z0-9])", haystack
        ) is not None
    return token in haystack


# 有序词表: 先命中先赢 (更具体/更高层级的在前)。
_SENIORITY_TABLE: Tuple[Tuple[str, Tuple[str, ...]], ...] = (
    ("vp", ("vice president", "vp", "svp", "evp", "president",
            "总裁", "副总裁", "首席", "chief executive", "chief technology",
            "chief financial", "chief operating", "cto", "ceo", "cfo", "coo")),
    ("director", ("director", "总监")),
    ("lead", ("head of", "team lead", "tech lead", "lead", "负责人")),
    ("manager", ("manager", "mgr", "经理")),
    ("staff", ("specialist", "engineer", "analyst", "专员", "工程师")),
)

_FUNCTION_TABLE: Tuple[Tuple[str, Tuple[str, ...]], ...] = (
    # pm 在 product 前: "project/program manager" 不该落进产品。
    ("pm", ("project manager", "program manager", "pmo", "项目经理", "项目管理")),
    ("product", ("product", "产品")),
    ("security", ("security", "安全")),
    ("compliance", ("compliance", "合规")),
    ("legal", ("legal", "counsel", "法务", "律师")),
    ("procurement", ("procurement", "sourcing", "采购")),
    ("data", ("data", "数据")),
    ("delivery", ("delivery", "交付", "实施")),
    # tech 兜后: 上面各域的 "xx engineer" 先按域分。
    ("tech", ("engineer", "engineering", "developer", "architect",
              "技术", "研发", "软件", "架构")),
)


def _normalized_title(role_title: Optional[str]) -> str:
    return str(role_title or "").strip().lower()


def derive_seniority(role_title: Optional[str]) -> Optional[str]:
    """role_title → seniority 枚举; 词表不命中 → None (不硬凑)。"""
    title = _normalized_title(role_title)
    if not title:
        return None
    for value, tokens in _SENIORITY_TABLE:
        if any(_hit(title, token) for token in tokens):
            return value
    return None


def derive_function(role_title: Optional[str]) -> Optional[str]:
    """role_title → function 枚举; 词表不命中 → None (不硬凑)。"""
    title = _normalized_title(role_title)
    if not title:
        return None
    for value, tokens in _FUNCTION_TABLE:
        if any(_hit(title, token) for token in tokens):
            return value
    return None
