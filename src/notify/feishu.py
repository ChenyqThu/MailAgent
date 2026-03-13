"""
飞书应用机器人通知模块

通过飞书 Open API 发送交互式卡片消息，用于通知重要邮件。
支持卡片按钮回调（由 Openclaw 处理）。
"""

import json
import time
from datetime import datetime, timedelta
from typing import Dict, Optional

import aiohttp
from loguru import logger


class FeishuNotifier:
    """飞书应用机器人通知器"""

    NOTIFY_MAX_AGE_DAYS = 3
    TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"
    MSG_URL = "https://open.feishu.cn/open-apis/im/v1/messages"

    def __init__(
        self,
        app_id: str = "",
        app_secret: str = "",
        chat_id: str = "",
        webhook_url: str = "",
        secret: str = "",
        database_id: str = "",
    ):
        self.app_id = app_id
        self.app_secret = app_secret
        self.chat_id = chat_id
        self._database_id = database_id
        # webhook 作为 fallback
        self.webhook_url = webhook_url
        self.webhook_secret = secret
        self._session: Optional[aiohttp.ClientSession] = None
        self._token: str = ""
        self._token_expire: float = 0
        self._use_app_api = bool(app_id and app_secret and chat_id)
        # 去重：记录最近已通知的 page_id -> timestamp，防止双路径重复通知
        self._notified_pages: Dict[str, float] = {}
        self._dedup_ttl = 600  # 10 分钟内同一 page_id 不重复通知

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        return self._session

    async def close(self):
        if self._session and not self._session.closed:
            await self._session.close()
            self._session = None

    async def _get_token(self) -> str:
        if self._token and time.time() < self._token_expire - 60:
            return self._token
        session = await self._get_session()
        async with session.post(self.TOKEN_URL, json={
            "app_id": self.app_id, "app_secret": self.app_secret
        }) as resp:
            data = await resp.json()
            if data.get("code") != 0:
                logger.error(f"Feishu token failed: {data}")
                return ""
            self._token = data["tenant_access_token"]
            self._token_expire = time.time() + data.get("expire", 7200)
            return self._token

    def _is_recent(self, date_str: str) -> bool:
        if not date_str:
            return True
        try:
            dt = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
            cutoff = datetime.now(dt.tzinfo) - timedelta(days=self.NOTIFY_MAX_AGE_DAYS)
            return dt >= cutoff
        except (ValueError, TypeError):
            return True

    async def notify_important_email(self, page_info: Dict) -> bool:
        """发送重要邮件通知卡片"""
        if not self._use_app_api and not self.webhook_url:
            return False

        # 跳过发件箱邮件
        mailbox = page_info.get("mailbox", "")
        if mailbox in ("发件箱", "已发送邮件", "已发送"):
            return False

        date_str = page_info.get("date", "")
        if not self._is_recent(date_str):
            logger.debug(f"Skipping notification for old email: {page_info.get('subject', '')[:40]}")
            return False

        # 去重：同一 page_id 短时间内不重复通知
        page_id = page_info.get("page_id", "")
        if page_id:
            now = time.time()
            # 清理过期条目
            self._notified_pages = {
                k: v for k, v in self._notified_pages.items()
                if now - v < self._dedup_ttl
            }
            if page_id in self._notified_pages:
                logger.info(f"Skipping duplicate notification for {page_id[:15]}, "
                            f"last notified {now - self._notified_pages[page_id]:.0f}s ago")
                return False

        subject = page_info.get("subject") or "(No Subject)"
        from_name = page_info.get("from_name", "")
        from_email = page_info.get("from_email", "")
        sender_display = from_name or from_email or "Unknown"
        ai_priority = page_info.get("ai_priority", "")
        ai_action = page_info.get("ai_action", "")
        page_id = page_info.get("page_id", "")
        ai_summary = page_info.get("ai_summary", "")
        row_id = page_info.get("row_id")
        internal_id = page_info.get("internal_id")
        message_id = page_info.get("message_id", "")
        category = page_info.get("category", "")
        reply_suggestion = page_info.get("reply_suggestion", "")
        to_addr = page_info.get("to_addr", "")
        cc_addr = page_info.get("cc_addr", "")

        notion_url = f"https://notion.so/{page_id.replace('-', '')}" if page_id else ""
        template = "red" if ai_priority in ("🔴 紧急",) else \
                   "orange" if ai_priority in ("🟡 重要",) else "blue"

        card = self._build_card(
            subject=subject, sender_display=sender_display,
            ai_priority=ai_priority, ai_action=ai_action,
            category=category, date_str=date_str,
            ai_summary=ai_summary, reply_suggestion=reply_suggestion,
            notion_url=notion_url, template=template,
            page_id=page_id, message_id=message_id,
            row_id=row_id, internal_id=internal_id,
            from_email=from_email,
            to_addr=to_addr, cc_addr=cc_addr,
            mailbox=mailbox,
        )

        if self._use_app_api:
            ok = await self._send_via_app_api(card, subject)
        else:
            ok = await self._send_via_webhook(card, subject)

        if ok and page_id:
            self._notified_pages[page_id] = time.time()
        return ok

    def _build_card(self, **kw) -> Dict:
        subject = kw["subject"]
        sender_display = kw["sender_display"]
        ai_priority = kw["ai_priority"]
        ai_action = kw["ai_action"]
        category = kw["category"]
        date_str = kw["date_str"]
        ai_summary = kw["ai_summary"]
        reply_suggestion = kw["reply_suggestion"]
        notion_url = kw["notion_url"]
        template = kw["template"]
        page_id = kw["page_id"]
        message_id = kw["message_id"]
        internal_id = kw.get("internal_id")
        from_email = kw["from_email"]
        to_addr = kw.get("to_addr", "")
        cc_addr = kw.get("cc_addr", "")
        mailbox = kw.get("mailbox", "")

        # 日期格式：MM-DD HH:MM（不带年）
        date_short = "N/A"
        if date_str and len(date_str) >= 16:
            date_short = date_str[5:16]  # "MM-DDTHH:MM" -> "MM-DD HH:MM"
            date_short = date_short.replace("T", " ")
        elif date_str:
            date_short = date_str[:10]
        priority_color = "red" if ai_priority in ("🔴 紧急",) else \
                         "orange" if ai_priority in ("🟡 重要",) else "blue"

        # --- body elements ---
        elements = []

        if ai_summary:
            elements.append({"tag": "markdown", "content": f"📝 **概要**\n{ai_summary[:300]}"})

        # 回调元数据（reply_suggestion 已是独立 form input，不占 metadata 空间）
        # 飞书回调自带 open_message_id 和 open_chat_id，无需传递
        metadata = {
            "internal_id": internal_id, "page_id": page_id,
            "database_id": self._database_id,
            "message_id": message_id,
            "subject": subject[:100], "mailbox": mailbox,
            "from_email": from_email, "from_name": sender_display,
            "to": to_addr[:200], "cc": cc_addr[:200],
            "date": date_str, "category": category,
            "chat_id": self.chat_id,
            "ai_action": ai_action, "ai_priority": ai_priority,
            "notion_url": notion_url,
        }
        metadata_json = json.dumps(metadata, ensure_ascii=False)

        # form: 建议回复(可编辑) + 修改意见 + 附加收件人 + 元数据 + 按钮
        form_elements = []

        # 建议回复：可编辑 input，用户可直接微调后点创建草稿
        # 提交时自动在 form_value.reply_suggestion 中
        if reply_suggestion:
            form_elements.append({
                "tag": "input",
                "name": "reply_suggestion",
                "input_type": "multiline_text",
                "default_value": reply_suggestion[:1500],
                "label": {"tag": "plain_text", "content": "✍️ 建议回复（可直接编辑）"},
                "label_position": "top",
                "rows": 4,
                "auto_resize": True,
                "max_rows": 20,
                "width": "fill",
            })

        # 修改意见输入框（用于 AI 优化回复）
        form_elements.append({
            "tag": "input",
            "name": "user_feedback",
            "placeholder": {"tag": "plain_text", "content": "输入修改意见（如：语气正式一些、补充提到 Q1 进展、改为拒绝...）"},
            "input_type": "multiline_text",
            "max_length": 1000,
            "label": {"tag": "plain_text", "content": "✏️ 修改意见（AI 优化用，可选）"},
            "label_position": "top",
            "rows": 2,
            "auto_resize": True,
            "max_rows": 10,
            "width": "fill",
        })

        # 附加收件人 + 元数据：折叠隐藏
        form_elements.append({
            "tag": "collapsible_panel",
            "expanded": False,
            "header": {"title": {"tag": "plain_text", "content": "📋 更多选项"}},
            "elements": [
                {
                    "tag": "input",
                    "name": "extra_to",
                    "input_type": "text",
                    "placeholder": {"tag": "plain_text", "content": "追加收件人邮箱（逗号分隔）"},
                    "label": {"tag": "plain_text", "content": "➕ 附加收件人"},
                    "label_position": "top",
                    "width": "fill",
                },
                {
                    "tag": "input",
                    "name": "extra_cc",
                    "input_type": "text",
                    "placeholder": {"tag": "plain_text", "content": "追加抄送邮箱（逗号分隔）"},
                    "label": {"tag": "plain_text", "content": "➕ 附加抄送"},
                    "label_position": "top",
                    "width": "fill",
                },
                {
                    "tag": "input",
                    "name": "metadata",
                    "input_type": "multiline_text",
                    "default_value": metadata_json,
                    "label": {"tag": "plain_text", "content": "元数据（请勿修改）"},
                    "label_position": "top",
                    "rows": 1,
                    "width": "fill",
                    "disabled": True,
                },
            ],
        })

        # 按钮列（通过 action.name 区分动作：btn_enhance / btn_draft / btn_done）
        btn_columns = [
            {
                "tag": "column", "width": "auto",
                "elements": [{
                    "tag": "button",
                    "text": {"content": "✨ 优化回复", "tag": "plain_text"},
                    "type": "primary",
                    "form_action_type": "submit",
                    "name": "btn_enhance",
                }],
            },
        ]

        if reply_suggestion:
            btn_columns.append({
                "tag": "column", "width": "auto",
                "elements": [{
                    "tag": "button",
                    "text": {"content": "📝 创建草稿", "tag": "plain_text"},
                    "type": "default",
                    "form_action_type": "submit",
                    "name": "btn_draft",
                }],
            })

        btn_columns.append({
            "tag": "column", "width": "auto",
            "elements": [{
                "tag": "button",
                "text": {"content": "✅ 已完成", "tag": "plain_text"},
                "type": "default",
                "form_action_type": "submit",
                "name": "btn_done",
            }],
        })

        if notion_url:
            btn_columns.append({
                "tag": "column", "width": "auto",
                "elements": [{
                    "tag": "button",
                    "text": {"content": "📬 打开邮件", "tag": "plain_text"},
                    "type": "default",
                    "multi_url": {"url": notion_url},
                }],
            })

        form_elements.append({
            "tag": "column_set",
            "flex_mode": "none",
            "columns": btn_columns,
        })

        elements.append({
            "tag": "form",
            "name": "mail_form",
            "elements": form_elements,
        })

        # --- header ---
        subtitle_parts = [sender_display, date_short, ai_priority or "一般"]
        subtitle_right = " · ".join(filter(None, [mailbox, category]))
        subtitle = " · ".join(subtitle_parts)
        if subtitle_right:
            subtitle += f" | {subtitle_right}"

        return {
            "schema": "2.0",
            "config": {"width_mode": "fill", "update_multi": True},
            "header": {
                "title": {"content": f"📬「{ai_action or '需要处理'}」{subject[:50]}", "tag": "plain_text"},
                "subtitle": {"content": subtitle, "tag": "plain_text"},
                "template": template,
                "text_tag_list": [
                    {"tag": "text_tag", "text": {"tag": "plain_text", "content": ai_priority or "一般"}, "color": priority_color}
                ],
            },
            "body": {
                "direction": "vertical",
                "vertical_spacing": "4px",
                "elements": elements,
            },
        }

    async def _send_via_app_api(self, card: Dict, subject: str) -> bool:
        token = await self._get_token()
        if not token:
            return False
        try:
            session = await self._get_session()
            headers = {"Authorization": f"Bearer {token}"}
            async with session.post(
                self.MSG_URL,
                params={"receive_id_type": "chat_id"},
                headers=headers,
                json={
                    "receive_id": self.chat_id,
                    "msg_type": "interactive",
                    "content": json.dumps(card),
                },
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                data = await resp.json()
                if data.get("code") != 0:
                    logger.error(f"Feishu app API error: {data}")
                    return False

            msg_id = data.get("data", {}).get("message_id", "")
            logger.info(f"Feishu app notification sent: {subject[:50]} ({msg_id})")

            # 回写 open_message_id 到按钮回调
            if msg_id:
                self._inject_open_message_id(card, msg_id)
                async with session.patch(
                    f"{self.MSG_URL}/{msg_id}",
                    headers=headers,
                    json={"content": json.dumps(card)},
                    timeout=aiohttp.ClientTimeout(total=5),
                ) as patch_resp:
                    patch_data = await patch_resp.json()
                    if patch_data.get("code") != 0:
                        logger.warning(f"Feishu PATCH open_message_id failed: {patch_data}")

            return True
        except Exception as e:
            logger.error(f"Feishu app notification failed: {e}")
            return False

    @staticmethod
    def _inject_open_message_id(card: Dict, msg_id: str):
        """将 open_message_id 注入 metadata input 的 default_value JSON 中"""
        body_elements = card.get("body", {}).get("elements", [])
        for el in body_elements:
            if el.get("tag") == "form":
                for form_el in el.get("elements", []):
                    if form_el.get("tag") == "collapsible_panel":
                        for panel_el in form_el.get("elements", []):
                            if panel_el.get("tag") == "input" and panel_el.get("name") == "metadata":
                                try:
                                    meta = json.loads(panel_el.get("default_value", "{}"))
                                    meta["open_message_id"] = msg_id
                                    panel_el["default_value"] = json.dumps(meta, ensure_ascii=False)
                                except (json.JSONDecodeError, TypeError):
                                    pass

    async def _send_via_webhook(self, card: Dict, subject: str) -> bool:
        """Webhook fallback"""
        import hmac, hashlib, base64
        payload = {"msg_type": "interactive", "card": card}
        if self.webhook_secret:
            timestamp = int(time.time())
            string_to_sign = f"{timestamp}\n{self.webhook_secret}"
            hmac_code = hmac.new(string_to_sign.encode("utf-8"), digestmod=hashlib.sha256).digest()
            payload["timestamp"] = str(timestamp)
            payload["sign"] = base64.b64encode(hmac_code).decode("utf-8")
        try:
            session = await self._get_session()
            async with session.post(
                self.webhook_url, json=payload,
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status == 200:
                    result = await resp.json()
                    if result.get("code") == 0:
                        logger.info(f"Feishu webhook notification sent: {subject[:50]}")
                        return True
                    logger.error(f"Feishu webhook error: {result}")
                return False
        except Exception as e:
            logger.error(f"Feishu webhook notification failed: {e}")
            return False
