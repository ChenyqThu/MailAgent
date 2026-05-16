"""HTML → Markdown 转换（v4 架构统一入口）.

使用 markdownify 作主路径；输出供 SQLite email_body.body_markdown、LLM agent、
RAG / FTS5 索引、Notion Markdown API 镜像共享。

特性:
    - 邮件签名 / quoted reply 不做特殊处理（保留原样，便于上游 LLM 自行判断）
    - 默认保留 inline image 引用（src 已被 reader.parse_for_storage 重写为相对路径）
    - heading_style=ATX（# 形式），便于 Notion Markdown API 透传
    - 去除 script/style，保留链接 href

不在本模块处理的事:
    - HTML 清洗（reader 已经做了 BeautifulSoup 解析）
    - cid: → 本地路径重写（reader.parse_for_storage 内做）
"""

from __future__ import annotations

from typing import Optional

from loguru import logger

try:
    from markdownify import markdownify as _markdownify
    _HAS_MARKDOWNIFY = True
except ImportError:  # pragma: no cover - markdownify 在 requirements.txt 里
    _HAS_MARKDOWNIFY = False
    _markdownify = None  # type: ignore


def html_to_markdown(
    html: Optional[str],
    *,
    strip_images: bool = False,
    heading_style: str = "ATX",
) -> str:
    """把 HTML 字符串转成 Markdown.

    Args:
        html: HTML 字符串（可空/None）
        strip_images: True 时去除所有 <img> 标签（FTS5 索引时可用）
        heading_style: 'ATX' (# h1) / 'SETEXT' (=== 下划线); 默认 ATX

    Returns:
        Markdown 字符串。html 为空时返回 ""。

    Notes:
        - markdownify 默认 escape 部分字符（如 *），输出适合 LLM 阅读
        - inline image src 由调用方负责重写（本函数仅做格式转换）
    """
    if not html:
        return ""

    if not _HAS_MARKDOWNIFY:
        # 兜底：用 html2text（已在 requirements.txt）
        import html2text
        h = html2text.HTML2Text()
        h.body_width = 0  # 不强制换行
        h.ignore_images = strip_images
        h.ignore_links = False
        return h.handle(html).strip()

    strip_tags: list[str] = []
    if strip_images:
        strip_tags.append("img")

    try:
        md = _markdownify(
            html,
            heading_style=heading_style,
            strip=strip_tags or None,
            # markdownify 的 escape_asterisks / escape_underscores 默认是 True，对邮件已够用
        )
    except Exception as e:
        logger.warning(f"markdownify failed, falling back to html2text: {e}")
        import html2text
        h = html2text.HTML2Text()
        h.body_width = 0
        h.ignore_images = strip_images
        md = h.handle(html)

    return md.strip()
