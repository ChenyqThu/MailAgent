from typing import List, Dict, Any
from bs4 import BeautifulSoup
import html2text
from loguru import logger

class HTMLToNotionConverter:
    """HTML 转 Notion Blocks 转换器"""

    def __init__(self):
        self.html2text = html2text.HTML2Text()
        self.html2text.ignore_links = False
        self.html2text.body_width = 0  # 不换行
        self.image_map = {}  # cid/filename -> file_upload_id映射

    def convert(self, html_content: str, image_map: Dict[str, tuple] = None) -> List[Dict[str, Any]]:
        """
        转换 HTML 为 Notion Blocks

        Args:
            html_content: HTML 内容
            image_map: 映射 {filename_or_cid: (file_upload_id, content_type)}

        Returns:
            Notion Blocks 列表
        """
        try:
            # 保存图片映射
            self.image_map = image_map or {}

            # 如果是纯文本，直接返回段落
            if not self._is_html(html_content):
                return self._text_to_blocks(html_content)

            # 预处理：移除 MSO/IE 条件注释 (<!--[if ...]> ... <![endif]-->)
            import re
            # 移除条件注释块
            html_content = re.sub(r'<!--\[if[^\]]*\]>.*?<!\[endif\]-->', '', html_content, flags=re.DOTALL | re.IGNORECASE)
            # 移除条件注释开始/结束标记（有时不匹配）
            html_content = re.sub(r'<!--\[if[^\]]*\]>', '', html_content, flags=re.IGNORECASE)
            html_content = re.sub(r'<!\[endif\]-->', '', html_content, flags=re.IGNORECASE)
            # 移除普通 HTML 注释
            html_content = re.sub(r'<!--.*?-->', '', html_content, flags=re.DOTALL)

            # 解析 HTML
            soup = BeautifulSoup(html_content, "lxml")

            # 移除 script 和 style 标签
            for tag in soup(["script", "style", "head", "title", "meta", "link"]):
                tag.decompose()

            # 移除 HTML 注释节点
            from bs4 import Comment
            for comment in soup.find_all(string=lambda text: isinstance(text, Comment)):
                comment.extract()

            # 提取 body 内容（如果有）
            body = soup.find("body")
            if body:
                soup = body

            # 转换为 Notion Blocks
            blocks = self._convert_element(soup)

            # 过滤掉无意义的 blocks（空白或隐形字符）
            blocks = [b for b in blocks if self._is_meaningful_block(b)]

            # 如果没有生成任何 block，使用 html2text 降级处理
            if not blocks:
                text = self.html2text.handle(html_content)
                blocks = self._text_to_blocks(text)

            # 注意：不在这里限制 block 数量，由调用方（sync.py）处理分批上传

            return blocks

        except Exception as e:
            logger.error(f"Failed to convert HTML to Notion blocks: {e}")
            # 降级：返回纯文本
            text = self.html2text.handle(html_content)
            return self._text_to_blocks(text[:2000])  # 限制长度

    def _is_meaningful_block(self, block: Dict[str, Any]) -> bool:
        """检查 block 是否包含有意义的内容（非空白/隐形字符）"""
        block_type = block.get('type', '')

        # 图片、文件、分割线等总是保留
        if block_type in ('image', 'file', 'divider', 'table', 'code'):
            return True

        # 检查文本内容
        rich_text = None
        if block_type == 'paragraph':
            rich_text = block.get('paragraph', {}).get('rich_text', [])
        elif block_type.startswith('heading_'):
            rich_text = block.get(block_type, {}).get('rich_text', [])
        elif block_type == 'bulleted_list_item':
            rich_text = block.get('bulleted_list_item', {}).get('rich_text', [])
        elif block_type == 'numbered_list_item':
            rich_text = block.get('numbered_list_item', {}).get('rich_text', [])
        elif block_type == 'quote':
            rich_text = block.get('quote', {}).get('rich_text', [])
        elif block_type == 'callout':
            rich_text = block.get('callout', {}).get('rich_text', [])

        if not rich_text:
            return False

        text = rich_text[0].get('text', {}).get('content', '') if rich_text else ''
        return self._is_meaningful_text(text)

    @staticmethod
    def _is_meaningful_text(text: str) -> bool:
        """检查文本是否有意义（非纯空白/隐形字符）"""
        if not text:
            return False

        # 移除各种隐形字符和空白
        # - \u200b: zero-width space
        # - \u200c: zero-width non-joiner
        # - \u200d: zero-width joiner
        # - \u034f: combining grapheme joiner
        # - \u00ad: soft hyphen
        # - \u2060: word joiner
        # - \u00a0: non-breaking space
        # - \ufeff: BOM / zero-width no-break space
        import re
        # 移除隐形字符
        cleaned = re.sub(r'[\u200b\u200c\u200d\u034f\u00ad\u2060\ufeff]', '', text)
        # 移除空白
        cleaned = cleaned.strip()
        # 移除只包含空格和 non-breaking space 的文本
        cleaned = re.sub(r'^[\s\u00a0]+$', '', cleaned)

        # 检查是否只剩下标点或空白
        if not cleaned:
            return False

        # 过滤掉 MSO 条件注释残留（文本形式）
        if re.match(r'^\[if\s+.*\]$', cleaned, re.IGNORECASE):
            return False
        if re.match(r'^\[endif\]$', cleaned, re.IGNORECASE):
            return False

        # 过滤掉模板注释（如 "A1 Top DS logo with sign in"）
        # 这些通常是简短的、以字母数字开头的标记
        if re.match(r'^[A-Z]\d+[a-z]?\s+\w+', cleaned) and len(cleaned) < 50:
            # 可能是模板标记，检查是否像正常句子
            words = cleaned.split()
            if len(words) <= 6 and not any(c in cleaned for c in '.?!,'):
                return False

        return len(cleaned) > 0

    def _convert_element(self, element) -> List[Dict[str, Any]]:
        """递归转换 HTML 元素"""
        blocks = []

        for child in element.children:
            if isinstance(child, str):
                text = child.strip()
                if text:
                    blocks.append(self._create_paragraph(text))

            elif child.name == "p":
                # 先检查段落内是否有图片
                imgs = child.find_all("img")
                for img in imgs:
                    image_block = self._handle_image(img)
                    if image_block:
                        blocks.append(image_block)

                # 然后处理文本内容
                text = child.get_text(strip=True)
                if text:
                    blocks.append(self._create_paragraph(text))

            elif child.name in ["h1", "h2", "h3"]:
                text = child.get_text(strip=True)
                if text:
                    blocks.append(self._create_heading(text, int(child.name[1])))

            elif child.name == "ul":
                for li in child.find_all("li", recursive=False):
                    text = li.get_text(strip=True)
                    if text:
                        blocks.append(self._create_bulleted_list(text))

            elif child.name == "ol":
                for li in child.find_all("li", recursive=False):
                    text = li.get_text(strip=True)
                    if text:
                        blocks.append(self._create_numbered_list(text))

            elif child.name == "blockquote":
                text = child.get_text(strip=True)
                if text:
                    blocks.append(self._create_quote(text))

            elif child.name == "pre" or child.name == "code":
                text = child.get_text(strip=True)
                if text:
                    blocks.append(self._create_code(text))

            elif child.name == "img":
                # 处理图片标签
                image_block = self._handle_image(child)
                if image_block:
                    blocks.append(image_block)

            elif child.name == "a":
                href = child.get("href", "")
                text = child.get_text(strip=True)

                # 跳过空链接或仅为图片的链接
                if not href:
                    continue

                # 如果链接内包含图片，先处理图片
                img = child.find("img")
                if img:
                    image_block = self._handle_image(img)
                    if image_block:
                        blocks.append(image_block)

                # 如果有文本，创建带链接的段落
                if text:
                    # 过滤掉明显的按钮样式文本
                    if href.startswith(("http://", "https://")):
                        # 创建带链接的文本（Notion 支持 rich_text 中的链接）
                        blocks.append(self._create_link_paragraph(text, href))
                elif href.startswith(("http://", "https://")) and not img:
                    # 纯链接无文本：显示 URL
                    blocks.append(self._create_link_paragraph(href, href))

            elif child.name == "br":
                continue

            elif child.name == "div" or child.name == "span":
                # 递归处理 div 和 span
                blocks.extend(self._convert_element(child))

            elif child.name == "table":
                # 检测是否是布局表格（Microsoft/Office 邮件常用）
                if self._is_layout_table(child):
                    # 布局表格：递归处理内容，不创建 table block
                    blocks.extend(self._convert_element(child))
                else:
                    # 数据表格：转换为Notion table block
                    table_block = self._table_to_notion_table(child)
                    if table_block:
                        blocks.append(table_block)
                    else:
                        # 降级：递归处理内容
                        blocks.extend(self._convert_element(child))

            elif child.name == "td" or child.name == "tr" or child.name == "tbody" or child.name == "thead":
                # 表格元素：递归处理（处理布局表格的子元素）
                blocks.extend(self._convert_element(child))

        return blocks

    def _text_to_blocks(self, text: str) -> List[Dict[str, Any]]:
        """纯文本转 Notion Blocks"""
        blocks = []

        # 按段落分割
        paragraphs = text.split("\n\n")

        for para in paragraphs:
            para = para.strip()
            if not para:
                continue

            # 限制每个段落的长度
            if len(para) > 2000:
                para = para[:1997] + "..."

            blocks.append(self._create_paragraph(para))

        return blocks

    @staticmethod
    def _truncate_by_utf16(text: str, max_length: int = 1990) -> str:
        """根据UTF-16长度截断文本（Notion API使用UTF-16计算长度）"""
        if not text:
            return text

        # 快速检查：如果文本很短，直接返回
        if len(text) < max_length:
            return text

        # 检查UTF-16长度
        utf16_len = len(text.encode('utf-16')) // 2
        if utf16_len <= max_length:
            return text

        # 需要截断：二分查找最佳截断点
        left, right = 0, len(text)
        result = text

        while left < right:
            mid = (left + right + 1) // 2
            if len(text[:mid].encode('utf-16')) // 2 <= max_length:
                result = text[:mid]
                left = mid
            else:
                right = mid - 1

        return result

    @staticmethod
    def _create_paragraph(text: str) -> Dict[str, Any]:
        """创建段落 Block"""
        safe_text = HTMLToNotionConverter._truncate_by_utf16(text)
        return {
            "object": "block",
            "type": "paragraph",
            "paragraph": {
                "rich_text": [{"type": "text", "text": {"content": safe_text}}]
            }
        }

    @staticmethod
    def _create_heading(text: str, level: int) -> Dict[str, Any]:
        """创建标题 Block"""
        safe_text = HTMLToNotionConverter._truncate_by_utf16(text)
        heading_type = f"heading_{min(level, 3)}"
        return {
            "object": "block",
            "type": heading_type,
            heading_type: {
                "rich_text": [{"type": "text", "text": {"content": safe_text}}]
            }
        }

    @staticmethod
    def _create_bulleted_list(text: str) -> Dict[str, Any]:
        """创建无序列表 Block"""
        safe_text = HTMLToNotionConverter._truncate_by_utf16(text)
        return {
            "object": "block",
            "type": "bulleted_list_item",
            "bulleted_list_item": {
                "rich_text": [{"type": "text", "text": {"content": safe_text}}]
            }
        }

    @staticmethod
    def _create_numbered_list(text: str) -> Dict[str, Any]:
        """创建有序列表 Block"""
        safe_text = HTMLToNotionConverter._truncate_by_utf16(text)
        return {
            "object": "block",
            "type": "numbered_list_item",
            "numbered_list_item": {
                "rich_text": [{"type": "text", "text": {"content": safe_text}}]
            }
        }

    @staticmethod
    def _create_quote(text: str) -> Dict[str, Any]:
        """创建引用 Block"""
        safe_text = HTMLToNotionConverter._truncate_by_utf16(text)
        return {
            "object": "block",
            "type": "quote",
            "quote": {
                "rich_text": [{"type": "text", "text": {"content": safe_text}}]
            }
        }

    @staticmethod
    def _create_code(text: str) -> Dict[str, Any]:
        """创建代码 Block"""
        safe_text = HTMLToNotionConverter._truncate_by_utf16(text)
        return {
            "object": "block",
            "type": "code",
            "code": {
                "rich_text": [{"type": "text", "text": {"content": safe_text}}],
                "language": "plain text"
            }
        }

    @staticmethod
    def _create_link_paragraph(text: str, url: str) -> Dict[str, Any]:
        """创建带链接的段落 Block"""
        safe_text = HTMLToNotionConverter._truncate_by_utf16(text)
        # 截断过长的 URL
        safe_url = url[:2000] if len(url) > 2000 else url
        return {
            "object": "block",
            "type": "paragraph",
            "paragraph": {
                "rich_text": [{
                    "type": "text",
                    "text": {
                        "content": safe_text,
                        "link": {"url": safe_url}
                    }
                }]
            }
        }

    def _handle_image(self, img_element) -> Dict[str, Any]:
        """
        处理HTML中的图片标签

        Args:
            img_element: BeautifulSoup的img元素

        Returns:
            Notion block (image/file/callout)，如果无法处理则返回None
        """
        try:
            src = img_element.get("src", "")
            alt = img_element.get("alt", "")

            if not src:
                return None

            # 处理cid:引用（内联内容）
            if src.startswith("cid:"):
                cid = src[4:]  # 移除"cid:"前缀

                # 尝试从image_map中查找
                # cid可能是完整的Content-ID，也可能只是文件名
                upload_info = None
                matched_key = None

                # 直接匹配
                if cid in self.image_map:
                    upload_info = self.image_map[cid]
                    matched_key = cid
                else:
                    # 尝试通过文件名匹配（cid通常包含文件名）
                    for key, info in self.image_map.items():
                        if cid in key or key in cid:
                            upload_info = info
                            matched_key = key
                            break

                if upload_info:
                    # 解构 tuple: (file_upload_id, content_type)
                    # 兼容旧格式：如果是 str 则视为 file_upload_id，类型为 image
                    if isinstance(upload_info, tuple):
                        file_upload_id, content_type = upload_info
                    else:
                        # 兼容旧格式
                        file_upload_id = upload_info
                        content_type = 'image/unknown'

                    logger.debug(f"Matched cid:{cid} to uploaded file (type={content_type})")

                    # 根据 content_type 决定使用 image block 还是 file block
                    if content_type.startswith('image/'):
                        return {
                            "object": "block",
                            "type": "image",
                            "image": {
                                "type": "file_upload",
                                "file_upload": {"id": file_upload_id},
                                "caption": [{"text": {"content": alt[:2000]}}] if alt else []
                            }
                        }
                    else:
                        # 非图片内联内容：使用 file block
                        # 使用匹配到的文件名作为 caption（如果 key 是文件名）
                        caption_text = matched_key if matched_key and '.' in matched_key else f"cid:{cid}"
                        return {
                            "object": "block",
                            "type": "file",
                            "file": {
                                "type": "file_upload",
                                "file_upload": {"id": file_upload_id},
                                "caption": [{"text": {"content": caption_text[:2000]}}]
                            }
                        }
                else:
                    logger.warning(f"Could not find uploaded file for cid:{cid} (attachment may have failed to upload)")
                    # 返回占位符文本块，而不是完全隐藏图片
                    return {
                        "object": "block",
                        "type": "callout",
                        "callout": {
                            "rich_text": [{"text": {"content": f"[图片无法显示: cid:{cid}]"}}],
                            "icon": {"emoji": "⚠️"},
                            "color": "yellow_background"
                        }
                    }

            # 处理外部URL（http/https）
            elif src.startswith(("http://", "https://")):
                return {
                    "object": "block",
                    "type": "image",
                    "image": {
                        "type": "external",
                        "external": {"url": src},
                        "caption": [{"text": {"content": alt[:2000]}}] if alt else []
                    }
                }

            # 处理data URI（base64编码的图片）
            elif src.startswith("data:image"):
                # Notion不支持data URI，跳过
                logger.debug(f"Skipping data URI image")
                return None

            else:
                logger.debug(f"Unsupported image src format: {src[:100]}")
                return None

        except Exception as e:
            logger.error(f"Failed to handle image: {e}")
            return None

    @staticmethod
    def _is_html(content: str) -> bool:
        """判断是否是 HTML"""
        return "<html" in content.lower() or "<body" in content.lower() or "<div" in content.lower()

    def _is_layout_table(self, table_element) -> bool:
        """
        检测表格是否是布局表格（用于邮件排版，而非数据展示）

        Microsoft/Office 邮件通常使用嵌套表格进行布局，这些表格不应该转换为 Notion table。
        布局表格的特征：
        1. role="presentation" 属性
        2. 只有单列或单行
        3. 包含嵌套表格
        4. border="0" 且没有 th 元素
        5. 主要包含图片或链接（而非数据）

        Returns:
            True 如果是布局表格，False 如果是数据表格
        """
        try:
            # 1. 检查 role="presentation"（明确标记为布局表格）
            if table_element.get("role") == "presentation":
                return True

            # 2. 检查是否包含嵌套表格（布局表格的典型特征）
            nested_tables = table_element.find_all("table", recursive=True)
            if nested_tables:
                return True

            # 获取所有行
            rows = table_element.find_all("tr", recursive=False)
            if not rows:
                # 尝试在 tbody 中查找
                tbody = table_element.find("tbody")
                if tbody:
                    rows = tbody.find_all("tr", recursive=False)

            if not rows:
                return True  # 空表格视为布局表格

            # 3. 统计列数和行数
            max_cols = 0
            total_rows = len(rows)
            has_th = False
            has_meaningful_content = False

            for row in rows:
                cells = row.find_all(["td", "th"], recursive=False)
                max_cols = max(max_cols, len(cells))
                if any(cell.name == "th" for cell in cells):
                    has_th = True

                # 检查是否有有意义的文本内容（不只是图片/空格）
                for cell in cells:
                    text = cell.get_text(strip=True)
                    if text and len(text) > 3:  # 超过3个字符的文本
                        has_meaningful_content = True

            # 4. 单列表格通常是布局表格
            if max_cols == 1:
                return True

            # 5. 只有一行且没有表头通常是布局表格
            if total_rows == 1 and not has_th:
                return True

            # 6. border="0" 且没有 th 且内容很少 → 布局表格
            border = table_element.get("border", "")
            if border == "0" and not has_th and not has_meaningful_content:
                return True

            # 7. 检查表格属性（常见的布局表格属性）
            cellpadding = table_element.get("cellpadding", "")
            cellspacing = table_element.get("cellspacing", "")
            width = table_element.get("width", "")

            # 如果有布局相关属性且没有表头，很可能是布局表格
            if (cellpadding or cellspacing or width == "100%") and not has_th:
                # 额外检查：如果有多行多列的有意义内容，可能是数据表格
                if total_rows >= 2 and max_cols >= 2 and has_meaningful_content:
                    return False
                return True

            # 8. 默认：如果有表头或多行多列数据，认为是数据表格
            if has_th or (total_rows >= 2 and max_cols >= 2):
                return False

            return True  # 其他情况默认为布局表格

        except Exception as e:
            logger.debug(f"Error detecting layout table: {e}")
            return True  # 出错时默认为布局表格，避免生成混乱的 table block

    def _table_to_notion_table(self, table_element) -> Dict[str, Any]:
        """
        将HTML table转换为Notion table block

        Returns:
            Notion table block，如果转换失败返回None
        """
        try:
            rows = table_element.find_all("tr")
            if not rows:
                return None

            # 解析表格结构
            table_rows = []
            max_columns = 0
            has_header = False

            for i, row in enumerate(rows):
                # 查找单元格（th或td）- 只查找直接子元素，避免嵌套表格导致重复
                cells = row.find_all(["th", "td"], recursive=False)
                if not cells:
                    continue

                # 检测是否有表头（第一行包含<th>标签）
                if i == 0 and any(cell.name == "th" for cell in cells):
                    has_header = True

                # 提取单元格内容
                row_cells = []
                for cell in cells:
                    text = cell.get_text(strip=True)
                    # Notion table cell限制为2000字符
                    text = self._truncate_by_utf16(text, 1990)
                    row_cells.append([{"type": "text", "text": {"content": text}}])

                table_rows.append(row_cells)
                max_columns = max(max_columns, len(row_cells))

            if not table_rows:
                return None

            # 确保所有行的列数一致（填充空单元格）
            for row_cells in table_rows:
                while len(row_cells) < max_columns:
                    row_cells.append([{"type": "text", "text": {"content": ""}}])

            # 限制表格大小：Notion限制表格最多100行
            if len(table_rows) > 100:
                logger.warning(f"Table has {len(table_rows)} rows, truncating to 100")
                table_rows = table_rows[:100]

            # 限制列数：避免过宽的表格
            if max_columns > 20:
                logger.warning(f"Table has {max_columns} columns, truncating to 20")
                max_columns = 20
                table_rows = [row[:20] for row in table_rows]

            # 构建table block
            table_block = {
                "object": "block",
                "type": "table",
                "table": {
                    "table_width": max_columns,
                    "has_column_header": has_header,
                    "has_row_header": False,
                    "children": []
                }
            }

            # 添加表格行
            for row_cells in table_rows:
                table_block["table"]["children"].append({
                    "object": "block",
                    "type": "table_row",
                    "table_row": {
                        "cells": row_cells
                    }
                })

            return table_block

        except Exception as e:
            logger.error(f"Failed to convert table to Notion table block: {e}")
            return None

    @staticmethod
    def _table_to_text(table_element) -> str:
        """表格转文本（降级处理）"""
        lines = []
        rows = table_element.find_all("tr")

        for row in rows:
            cells = row.find_all(["td", "th"])
            line = " | ".join(cell.get_text(strip=True) for cell in cells)
            lines.append(line)

        return "\n".join(lines)
