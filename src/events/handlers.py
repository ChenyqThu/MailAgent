"""
Webhook 事件处理器

处理从 Redis 队列收到的 Notion 变更事件：
- flag_changed: Is Read / Is Flagged 变化 → 同步到 Mail.app
- ai_reviewed: AI Review 完成 → 飞书通知
- completed: 用户标记已完成 → 移除 Mail.app 旗标
- create_draft: 创建 Mail.app 回复草稿
- page_updated: 通用事件 → 自动判断处理方式
"""

import asyncio
import json
import os
from typing import Callable, Awaitable, Dict, Optional
from loguru import logger

from src.mail.applescript_arm import AppleScriptArm
from src.mail.sync_store import SyncStore
from src.notify.feishu import FeishuNotifier
from src.notion.sync import NotionSync


class EventHandlers:
    """Webhook 事件处理集合"""

    FLAG_ACTIONS = {"需要回复", "需要决策", "需要Review", "需要会议", "需要跟进", "等待响应"}

    def __init__(
        self,
        arm: AppleScriptArm,
        sync_store: SyncStore,
        feishu: Optional[FeishuNotifier] = None,
        notion_sync: Optional[NotionSync] = None,
        result_callback: Optional[Callable[[str, Dict], Awaitable[None]]] = None,
    ):
        self.arm = arm
        self.sync_store = sync_store
        self.feishu = feishu
        self.notion_sync = notion_sync
        self._result_callback = result_callback
        self._radar = None  # 延迟初始化
        self._stats = {
            "flag_changed": 0,
            "ai_reviewed": 0,
            "completed": 0,
            "create_draft": 0,
            "create_draft_success": 0,
            "create_draft_error": 0,
            "query_mail": 0,
            "fetch_mail_content": 0,
            "feishu_notified": 0,
        }

    def get_stats(self) -> Dict:
        """返回事件处理统计"""
        return dict(self._stats)

    async def _fetch_full_page_props(self, page_id: str) -> Dict:
        """从 Notion API 拉取完整页面属性，补全 webhook 缺失字段"""
        page = await self.notion_sync.client.client.pages.retrieve(page_id=page_id)
        raw_props = page.get("properties", {})
        result = {}
        def _text(p):
            for k in ("title", "rich_text"):
                items = p.get(k, [])
                if items:
                    return "".join(i.get("plain_text", "") for i in items)
            return ""
        def _select(p): return (p.get("select") or {}).get("name", "")
        def _email(p): return p.get("email", "") or ""
        def _checkbox(p): return bool(p.get("checkbox"))
        def _date(p): return (p.get("date") or {}).get("start", "")
        field_map = {
            "Subject": ("subject", _text),
            "From Name": ("from_name", _text),
            "From": ("from_email", _email),
            "To": ("to_addr", _text),
            "CC": ("cc_addr", _text),
            "Date": ("date", _date),
            "Action Type": ("ai_action", _select),
            "Priority": ("ai_priority", _select),
            "Mailbox": ("mailbox", _select),
            "Category": ("category", _select),
            "AI Summary": ("ai_summary", _text),
            "Reply Suggestion": ("reply_suggestion", _text),
            "Message ID": ("message_id", _text),
        }
        for notion_key, (out_key, extractor) in field_map.items():
            prop = raw_props.get(notion_key)
            if prop is not None:
                result[out_key] = extractor(prop)
        return result

    async def handle_flag_changed(self, event: Dict):
        """处理 flag 变化事件: Notion → Mail.app"""
        self._stats["flag_changed"] += 1
        props = event.get("properties", {})
        message_id = props.get("message_id", "")
        is_read = props.get("is_read")
        is_flagged = props.get("is_flagged")

        if not message_id:
            logger.warning(f"flag_changed event missing message_id: {event.get('id')}")
            return

        # 查找 internal_id
        record = self.sync_store.get_by_message_id(message_id)
        if not record:
            logger.warning(f"Email not found in SyncStore: {message_id[:40]}")
            return

        internal_id = record.get('internal_id') if isinstance(record, dict) else getattr(record, 'internal_id', None)
        mailbox = record.get('mailbox') if isinstance(record, dict) else getattr(record, 'mailbox', None)
        stored_read = bool(record.get('is_read') if isinstance(record, dict) else getattr(record, 'is_read', False))
        stored_flagged = bool(record.get('is_flagged') if isinstance(record, dict) else getattr(record, 'is_flagged', False))

        changed = False

        # 同步 read 状态（放到线程避免阻塞事件循环）
        if is_read is not None and is_read != stored_read:
            if internal_id:
                success = await asyncio.to_thread(self.arm.mark_as_read_by_id, internal_id, is_read, mailbox)
            else:
                success = await asyncio.to_thread(self.arm.mark_as_read, message_id, is_read, mailbox)
            if success:
                changed = True
                logger.info(f"Flag sync: read={is_read} for {message_id[:40]}")

        # 同步 flagged 状态
        if is_flagged is not None and is_flagged != stored_flagged:
            if internal_id:
                success = await asyncio.to_thread(self.arm.set_flag_by_id, internal_id, is_flagged, mailbox)
            else:
                success = await asyncio.to_thread(self.arm.set_flag, message_id, is_flagged, mailbox)
            if success:
                changed = True
                logger.info(f"Flag sync: flagged={is_flagged} for {message_id[:40]}")

        # 更新 SyncStore 防止 echo
        if changed and internal_id:
            new_read = is_read if is_read is not None else stored_read
            new_flagged = is_flagged if is_flagged is not None else stored_flagged
            self.sync_store.update_local_flags(internal_id, new_read, new_flagged)

    async def handle_ai_reviewed(self, event: Dict):
        """处理 AI Review 完成事件: Mail.app 标旗 + 飞书通知 + 更新 Notion 状态"""
        self._stats["ai_reviewed"] += 1
        props = event.get("properties", {})
        page_id = event.get("page_id", "")
        ai_priority = props.get("ai_priority", "")
        ai_action = props.get("ai_action", "")
        message_id = props.get("message_id", "")
        mailbox = props.get("mailbox", "")

        # 查找 internal_id
        internal_id = None
        record = None
        if message_id and self.sync_store:
            record = self.sync_store.get_by_message_id(message_id)
            if record:
                internal_id = record.get('internal_id') if isinstance(record, dict) else getattr(record, 'internal_id', None)

        # Mail.app 标旗/已读（放到线程避免阻塞事件循环）
        if internal_id:
            if ai_action in self.FLAG_ACTIONS:
                await asyncio.to_thread(self.arm.mark_as_read_by_id, internal_id, True, mailbox)
                await asyncio.to_thread(self.arm.set_flag_by_id, internal_id, True, mailbox)
                self.sync_store.update_local_flags(internal_id, True, True)
            else:
                await asyncio.to_thread(self.arm.mark_as_read_by_id, internal_id, True, mailbox)
                self.sync_store.update_local_flags(internal_id, True, False)

        # 飞书通知：批阅视图全部（FLAG_ACTIONS）且发件箱排除
        should_notify = (
            True
            and ai_action in self.FLAG_ACTIONS
            and mailbox != "发件箱"
        )
        if should_notify and self.feishu:
            # Notion webhook 只含变更字段，补全缺失的展示字段
            subject = props.get("subject", "")
            if not subject and record:
                subject = (record.get('subject') if isinstance(record, dict)
                           else getattr(record, 'subject', '')) or ''

            # 若 from_name/date/ai_summary 等缺失，从 Notion API 拉完整页面
            full_props = props
            needs_fetch = not props.get("from_name") and not props.get("date") and not props.get("ai_summary")
            if needs_fetch and page_id and self.notion_sync:
                try:
                    full_props = await self._fetch_full_page_props(page_id)
                    full_props.setdefault("subject", subject)
                    full_props.setdefault("ai_action", ai_action)
                    full_props.setdefault("ai_priority", ai_priority)
                    full_props.setdefault("mailbox", mailbox)
                    full_props.setdefault("message_id", message_id)
                except Exception as e:
                    logger.warning(f"Failed to fetch full page props for notification: {e}")

            self._stats["feishu_notified"] += 1
            await self.feishu.notify_important_email({
                "page_id": page_id,
                "message_id": message_id,
                "internal_id": internal_id,
                "subject": full_props.get("subject") or subject,
                "from_name": full_props.get("from_name", ""),
                "from_email": full_props.get("from_email", ""),
                "to_addr": full_props.get("to_addr", ""),
                "cc_addr": full_props.get("cc_addr", ""),
                "date": full_props.get("date", ""),
                "mailbox": mailbox,
                "ai_action": ai_action,
                "ai_priority": ai_priority,
                "ai_summary": full_props.get("ai_summary", ""),
                "reply_suggestion": full_props.get("reply_suggestion", ""),
                "category": full_props.get("category", ""),
            })

        # 本地状态镜像
        if internal_id:
            self.sync_store.update_processing_status(internal_id, "已同步")

        # 更新 Notion: Is Read / Is Flagged + Processing Status → 已同步
        if page_id and self.notion_sync:
            try:
                is_flagged_for_notion = ai_action in self.FLAG_ACTIONS
                await self.notion_sync.update_email_flags(
                    page_id,
                    is_read=True,
                    is_flagged=is_flagged_for_notion,
                    processing_status="已同步"
                )
                await self.notion_sync.update_page_mail_sync_status(
                    page_id, synced=True
                )
            except Exception as e:
                logger.warning(f"Webhook: failed to update Notion status: {e}")

    async def handle_completed(self, event: Dict):
        """处理用户标记已完成事件: 移除 Mail.app 旗标 + 同步 Notion 状态"""
        self._stats["completed"] += 1
        props = event.get("properties", {})
        page_id = event.get("page_id", "")
        message_id = props.get("message_id", "")

        if not message_id:
            logger.warning(f"completed event missing message_id: {event.get('id')}")
            return

        record = self.sync_store.get_by_message_id(message_id)
        if not record:
            logger.warning(f"Email not found in SyncStore: {message_id[:40]}")
            return

        internal_id = record.get('internal_id') if isinstance(record, dict) else getattr(record, 'internal_id', None)
        mailbox = record.get('mailbox') if isinstance(record, dict) else getattr(record, 'mailbox', None)

        # 无条件移除旗标 + 标记已读（放到线程避免阻塞事件循环）
        try:
            if internal_id:
                await asyncio.to_thread(self.arm.set_flag_by_id, internal_id, False, mailbox)
                await asyncio.to_thread(self.arm.mark_as_read_by_id, internal_id, True, mailbox)
            else:
                await asyncio.to_thread(self.arm.set_flag, message_id, False, mailbox)
                await asyncio.to_thread(self.arm.mark_as_read, message_id, True, mailbox)
        except Exception as e:
            logger.error(f"Completed: AppleScript failed for {message_id[:40]}: {e}")

        # Echo prevention + 本地状态镜像
        if internal_id:
            self.sync_store.update_local_flags(internal_id, True, False)
            self.sync_store.update_processing_status(internal_id, "已完成")

        # 同步 Notion: Is Flagged=False + Processing Status→已完成
        if page_id and self.notion_sync:
            try:
                await self.notion_sync.update_email_flags(
                    page_id, is_read=True, is_flagged=False,
                    processing_status="已完成"
                )
            except Exception as e:
                logger.warning(f"Webhook: failed to update Notion status for completed: {e}")

        logger.info(f"Completed: unflagged + Notion synced {message_id[:40]}")

    async def handle_create_draft(self, event: Dict):
        """创建 Mail.app 回复草稿（Notion 按钮 / Openclaw 触发）"""
        self._stats["create_draft"] += 1
        import time as _time
        _t0 = _time.monotonic()

        props = event.get("properties", {})
        event_id = event.get("id", "")
        page_id = event.get("page_id", "")
        message_id = props.get("message_id", "")
        reply_suggestion = props.get("reply_suggestion", "")
        reply_suggestion_rich = props.get("reply_suggestion_rich")
        mailbox = props.get("mailbox", "收件箱")
        event_source = event.get("source", "webhook")

        logger.info(
            f"create_draft: start | source={event_source} page={page_id[:12]} "
            f"has_rich={reply_suggestion_rich is not None} has_md={bool(reply_suggestion)} "
            f"md_len={len(reply_suggestion)} mailbox={mailbox}"
        )

        if not reply_suggestion and not reply_suggestion_rich:
            logger.warning(f"create_draft: no reply_suggestion for {page_id}")
            await self._publish(event_id, {"status": "error", "error": "no reply_suggestion"})
            return

        # 查找 internal_id
        internal_id = None
        if message_id and self.sync_store:
            record = self.sync_store.get_by_message_id(message_id)
            if record:
                internal_id = record.get('internal_id') if isinstance(record, dict) else getattr(record, 'internal_id', None)

        # 预设剪贴板（在 Mail.app 打开前完成 HTML 转换）
        clipboard_ready = False
        script_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "scripts")
        clipboard_py = os.path.join(script_path, "html_clipboard.py")

        clipboard_html_file = None
        if reply_suggestion_rich:
            from src.converter.notion_rich_text import rich_text_to_html
            html = rich_text_to_html(reply_suggestion_rich)
            logger.info(f"create_draft: path=rich_text items={len(reply_suggestion_rich)} html_len={len(html)}")
            proc_clip = await asyncio.create_subprocess_exec(
                "python3", clipboard_py, "--set-html",
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            await proc_clip.communicate(input=html.encode())
            clipboard_ready = proc_clip.returncode == 0
            # 保存 HTML 到临时文件，供脚本粘贴重试时使用
            if clipboard_ready:
                clipboard_html_file = os.path.join('/tmp', f'mail_draft_clip_{int(_t0 * 1000)}.html')
                with open(clipboard_html_file, 'w') as f:
                    f.write(html)
        elif reply_suggestion:
            logger.info(f"create_draft: path=markdown md_len={len(reply_suggestion)}")
            proc_clip = await asyncio.create_subprocess_exec(
                "python3", clipboard_py,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            await proc_clip.communicate(input=reply_suggestion.encode())
            clipboard_ready = proc_clip.returncode == 0

        _t1 = _time.monotonic()
        logger.info(f"create_draft: clipboard_ready={clipboard_ready} took={_t1 - _t0:.1f}s")

        # 构建脚本参数
        mode = props.get("mode", "reply-all")
        extra_to = props.get("extra_to", "")
        extra_cc = props.get("extra_cc", "")
        subject = props.get("subject", "")
        to_email = props.get("to", "") or props.get("to_email", "")

        draft_script = os.path.join(script_path, "create_reply_draft.sh")
        cmd = ["bash", draft_script, "--mode", mode, "--reply-text", reply_suggestion or "(rich text)", "--mailbox", mailbox]
        if clipboard_ready:
            cmd.append("--clipboard-ready")
        if clipboard_html_file:
            cmd.extend(["--clipboard-html-file", clipboard_html_file])
        if internal_id:
            cmd.extend(["--internal-id", str(internal_id)])
        elif message_id:
            cmd.extend(["--message-id", message_id])
        if extra_to:
            cmd.extend(["--extra-to", extra_to])
        if extra_cc:
            cmd.extend(["--extra-cc", extra_cc])
        if mode == "new":
            if to_email:
                cmd.extend(["--to", to_email])
            if subject:
                cmd.extend(["--subject", subject])

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
            output = stdout.decode().strip()

            if proc.returncode == 0:
                result = json.loads(output) if output else {}
                method = result.get("method", "unknown")
                _t2 = _time.monotonic()
                logger.info(f"create_draft: done | method={method} total={_t2 - _t0:.1f}s msg={message_id[:40]}")

                # 更新 Notion Processing Status
                if page_id and self.notion_sync:
                    await self.notion_sync.update_page_mail_sync_status(
                        page_id, synced=True, processing_status="草稿已创建"
                    )
                self._stats["create_draft_success"] += 1
                await self._publish(event_id, {"status": "success", **result})
            else:
                error = (stderr.decode()[:200] + " | " + output[:200]).strip(" |")
                self._stats["create_draft_error"] += 1
                logger.error(f"Draft script failed (rc={proc.returncode}): {error}")
                await self._publish(event_id, {"status": "error", "error": error})
        except asyncio.TimeoutError:
            self._stats["create_draft_error"] += 1
            logger.error(f"Draft script timeout for {message_id[:40]}")
            await self._close_mail_window()
            await self._publish(event_id, {"status": "error", "error": "timeout"})
        except Exception as e:
            self._stats["create_draft_error"] += 1
            logger.error(f"Draft creation error: {e}")
            await self._close_mail_window()
            await self._publish(event_id, {"status": "error", "error": str(e)})
        finally:
            # 清理临时 HTML 文件
            if clipboard_html_file and os.path.exists(clipboard_html_file):
                try:
                    os.unlink(clipboard_html_file)
                except OSError:
                    pass

    async def _publish(self, event_id: str, result: Dict):
        """发布事件执行结果到 Redis"""
        if event_id and self._result_callback:
            try:
                await self._result_callback(event_id, result)
            except Exception as e:
                logger.warning(f"Failed to publish result for {event_id}: {e}")

    @staticmethod
    async def _close_mail_window():
        """关闭 Mail.app 残留的回复窗口"""
        try:
            proc = await asyncio.create_subprocess_exec(
                "osascript", "-e",
                'tell application "Mail"\ntry\nclose front window\nend try\nend tell',
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.wait_for(proc.wait(), timeout=5)
        except Exception:
            pass

    def _get_radar(self):
        """延迟初始化 SQLite Radar（用于搜索 Mail.app 全量邮件）"""
        if self._radar is None:
            from src.mail.sqlite_radar import SQLiteRadar
            from src.config import config
            self._radar = SQLiteRadar(
                mailboxes=[mb.strip() for mb in config.sync_mailboxes.split(',') if mb.strip()] or ["收件箱"],
                account_url_prefix=config.mail_account_url_prefix,
            )
        return self._radar

    async def handle_query_mail(self, event: Dict):
        """查询邮件元数据

        支持两种数据源：
        - source=syncstore（默认）: 查 SyncStore，仅已同步邮件
        - source=mail: 查 Mail.app SQLite Envelope Index，覆盖全部邮件
        """
        self._stats["query_mail"] += 1
        props = event.get("properties", {})
        event_id = event.get("id", "")
        source = props.get("source", "syncstore")

        # 提取查询参数
        filters = {}
        for key in ("query", "from", "subject", "date_from", "date_to", "mailbox"):
            val = props.get(key)
            if val:
                filters[key] = val

        for key in ("is_flagged", "is_read"):
            val = props.get(key)
            if val is not None:
                filters[key] = bool(val)

        # has_notion 仅 syncstore 模式支持
        if source == "syncstore":
            val = props.get("has_notion")
            if val is not None:
                filters["has_notion"] = bool(val)

        limit = min(int(props.get("limit", 10)), 50)
        offset = int(props.get("offset", 0))

        logger.info(f"query_mail: source={source} filters={filters} limit={limit} offset={offset}")

        if source == "mail":
            # 直接查 Mail.app SQLite（覆盖全部 ~24k 邮件）
            radar = self._get_radar()
            if not radar.is_available():
                await self._publish(event_id, {"status": "error", "error": "Mail.app SQLite not available"})
                return
            result = radar.search_all_emails(filters, limit=limit, offset=offset)
            # 附加 SyncStore 中的 Notion 信息（如果有）
            for email in result["emails"]:
                iid = email.get("internal_id")
                record = self.sync_store.get(iid)
                if record:
                    page_id = record.get("notion_page_id")
                    if page_id:
                        email["notion_page_id"] = page_id
                        email["notion_url"] = f"https://www.notion.so/{page_id.replace('-', '')}"
                    email["sync_status"] = record.get("sync_status")
        else:
            # 查 SyncStore（仅已同步邮件）
            result = self.sync_store.search_emails(filters, limit=limit, offset=offset)
            notion_base = "https://www.notion.so/"
            for email in result["emails"]:
                page_id = email.get("notion_page_id")
                if page_id:
                    email["notion_url"] = f"{notion_base}{page_id.replace('-', '')}"

        result["source"] = source
        await self._publish(event_id, {"status": "success", **result})
        logger.info(f"query_mail: source={source} returned {len(result['emails'])}/{result['total']} emails")

    async def handle_fetch_mail_content(self, event: Dict):
        """获取邮件完整内容（通过 AppleScript + internal_id）

        用于检索历史邮件正文，~1s/封。

        请求参数:
            internal_id: int (必填)
            mailbox: str (可选，指定可加速)
            format: "full" | "text" (默认 full)

        返回:
            full: message_id, subject, sender, date, content(纯文本), html, is_read, is_flagged
            text: subject, sender, date, content(纯文本)
        """
        self._stats["fetch_mail_content"] += 1
        props = event.get("properties", {})
        event_id = event.get("id", "")

        internal_id = props.get("internal_id")
        if not internal_id:
            await self._publish(event_id, {"status": "error", "error": "Missing required: internal_id"})
            return

        internal_id = int(internal_id)
        mailbox = props.get("mailbox")
        fmt = props.get("format", "full")

        logger.info(f"fetch_mail_content: internal_id={internal_id} mailbox={mailbox} format={fmt}")

        # AppleScript 获取完整内容（~1s）
        full_email = self.arm.fetch_email_content_by_id(internal_id, mailbox)
        if not full_email:
            await self._publish(event_id, {
                "status": "error",
                "error": f"Failed to fetch email {internal_id}. Mail.app may not be running or email was deleted.",
            })
            return

        # 解析 MIME 获取 HTML 正文
        source = full_email.get("source", "")
        html_body = ""
        plain_body = full_email.get("content", "")

        if source:
            try:
                import email as email_lib
                msg = email_lib.message_from_string(source)
                for part in msg.walk():
                    ct = part.get_content_type()
                    if ct == "text/html" and not html_body:
                        charset = part.get_content_charset() or "utf-8"
                        payload = part.get_payload(decode=True)
                        if payload:
                            html_body = payload.decode(charset, errors="replace")
                    elif ct == "text/plain" and not plain_body:
                        charset = part.get_content_charset() or "utf-8"
                        payload = part.get_payload(decode=True)
                        if payload:
                            plain_body = payload.decode(charset, errors="replace")
            except Exception as e:
                logger.warning(f"MIME parse error for {internal_id}: {e}")

        # 根据 format 构建返回
        if fmt == "text":
            result_data = {
                "internal_id": internal_id,
                "subject": full_email.get("subject", ""),
                "sender": full_email.get("sender", ""),
                "date": full_email.get("date", ""),
                "content": plain_body,
            }
        else:  # full (default)
            result_data = {
                "internal_id": internal_id,
                "message_id": full_email.get("message_id", ""),
                "subject": full_email.get("subject", ""),
                "sender": full_email.get("sender", ""),
                "date": full_email.get("date", ""),
                "content": plain_body,
                "html": html_body,
                "is_read": full_email.get("is_read", False),
                "is_flagged": full_email.get("is_flagged", False),
                "thread_id": full_email.get("thread_id", ""),
            }

        # 附加 Notion 信息
        record = self.sync_store.get(internal_id)
        if record and record.get("notion_page_id"):
            pid = record["notion_page_id"]
            result_data["notion_page_id"] = pid
            result_data["notion_url"] = f"https://www.notion.so/{pid.replace('-', '')}"

        await self._publish(event_id, {"status": "success", **result_data})
        logger.info(f"fetch_mail_content: returned {fmt} for {internal_id}")

    async def handle_page_updated(self, event: Dict):
        """通用事件: 根据内容自动判断"""
        props = event.get("properties", {})
        ai_review_status = props.get("ai_review_status", "")

        if ai_review_status == "AI Reviewed":
            await self.handle_ai_reviewed(event)
        elif ai_review_status == "已完成":
            await self.handle_completed(event)

        # 始终检查 flag 变化
        if "is_read" in props or "is_flagged" in props:
            await self.handle_flag_changed(event)
