"""项目名 → external_id 的 slug 生成。

规则（符合 Guide 4.2.3 + 碰撞容错）:
  - 纯英文/数字: 小写 + 非字母数字替换为 '-' + 去首尾 '-' 。
    例: "Omada SDN Controller V6.3" -> "omada-sdn-controller-v6-3"
  - 含中文/非 ASCII: 保留可转 ASCII 部分 + 短 sha1 后缀，避免信息丢失导致的 slug 碰撞。
    例: "EAP725-Wall(EU)2.0-适配Controller 6.1" -> "eap725-wall-eu-2-0-controller-6-1-a3f7c2"
  - 完全无 ASCII 可用字符: "proj-{sha1[:10]}"
  - 截断到 80 字符（保留 hash 后缀优先）

稳定性：slug 只依赖 Project Name 的 UTF-8 bytes，因此同一 Project Name 在任意周都生成相同 slug。
"""

import hashlib
import re
import unicodedata

_SLUG_CLEAN = re.compile(r"[^a-z0-9]+")

MAX_SLUG_LEN = 80
HASH_SUFFIX_LEN = 6  # -{6-char-sha1}


def slugify(name: str) -> str:
    """把任意 Project Name 转成稳定 slug。

    Args:
        name: 原始 Project Name（可能含中文 / 符号 / 空白）

    Returns:
        slug 字符串，保证长度 ∈ [3, 80]，内容 ∈ [a-z0-9-]。
    """
    s = (name or "").strip()
    ascii_part = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    slug_core = _SLUG_CLEAN.sub("-", ascii_part.lower()).strip("-")

    has_non_ascii = any(ord(c) > 127 for c in s)
    digest = hashlib.sha1(s.encode("utf-8")).hexdigest()

    if len(slug_core) < 3:
        return f"proj-{digest[:10]}"[:MAX_SLUG_LEN]

    if has_non_ascii:
        suffix = f"-{digest[:HASH_SUFFIX_LEN]}"
        # 保留后缀，前半按剩余长度截断
        head = slug_core[: MAX_SLUG_LEN - len(suffix)].rstrip("-")
        return f"{head}{suffix}"

    return slug_core[:MAX_SLUG_LEN]
