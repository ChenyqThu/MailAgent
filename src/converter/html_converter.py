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

    def convert(self, html_content: str, image_map: Dict[str, str] = None) -> List[Dict[str, Any]]:
        """
        转换 HTML 为 Notion Blocks

        Args:
            html_content: HTML 内容
            image_map: 图片映射 {filename: file_upload_id}

        Returns:
            Notion Blocks 列表
        """
        try:
            # 保存图片映射
            self.image_map = image_map or {}

            # 如果是纯文本，直接返回段落
            if not self._is_html(html_content):
                return self._text_to_blocks(html_content)

            # 解析 HTML
            soup = BeautifulSoup(html_content, "lxml")

            # 移除 script 和 style 标签
            for tag in soup(["script", "style"]):
                tag.decompose()

            # 提取 body 内容（如果有）
            body = soup.find("body")
            if body:
                soup = body

            # 转换为 Notion Blocks
            blocks = self._convert_element(soup)

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
                text = child.get_text(strip=True)
                href = child.get("href", "")
                if text and href:
                    blocks.append(self._create_paragraph(f"{text} ({href})"))

            elif child.name == "br":
                continue

            elif child.name == "div" or child.name == "span":
                # 递归处理 div 和 span
                blocks.extend(self._convert_element(child))

            elif child.name == "table":
                # 表格转换为Notion table block
                table_block = self._table_to_notion_table(child)
                if table_block:
                    blocks.append(table_block)
                else:
                    # 降级：转换为代码块
                    table_text = self._table_to_text(child)
                    blocks.append(self._create_code(table_text))

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

    def _handle_image(self, img_element) -> Dict[str, Any]:
        """
        处理HTML中的图片标签

        Args:
            img_element: BeautifulSoup的img元素

        Returns:
            Notion image block，如果无法处理则返回None
        """
        try:
            src = img_element.get("src", "")
            alt = img_element.get("alt", "")

            if not src:
                return None

            # 处理cid:引用（内联图片）
            if src.startswith("cid:"):
                cid = src[4:]  # 移除"cid:"前缀

                # 尝试从image_map中查找
                # cid可能是完整的Content-ID，也可能只是文件名
                file_upload_id = None

                # 直接匹配
                if cid in self.image_map:
                    file_upload_id = self.image_map[cid]
                else:
                    # 尝试通过文件名匹配（cid通常包含文件名）
                    for filename, upload_id in self.image_map.items():
                        if cid in filename or filename in cid:
                            file_upload_id = upload_id
                            break

                if file_upload_id:
                    logger.debug(f"Matched cid:{cid} to uploaded file")
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
