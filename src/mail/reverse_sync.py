"""
反向同步模块: Notion -> Mail.app (轮询路径 B)

当 AI 审核完邮件后，根据 Action Type 同步操作到 Mail.app，并对重要邮件发送飞书通知。

Action Type → Mail.app 操作映射:
- 需要回复/需要决策/需要Review/需要会议/需要跟进/等待响应 → 设置旗标
- 仅供参考/已完结 → 标记已读

Sprint 15 起 (架构纯净化, hotfix 2):
  outbox_repo 注入时, sync_single_page 改写 SQLite intent + outbox.enqueue
  (target='mailapp', source='reverse_sync_poll'), 不再直调 AppleScript.
  FanoutWorker 异步消费派发, 跟 webhook 路径 A / handle_ai_reviewed / CLI
  email flag 完全统一。admin queue-depth 100% 覆盖反向写; 失败统一进
  outbox 重试 / dead_letter。

  update_page_mail_sync_status (Synced to Mail checkbox + Processing Status)
  仍走直接调 (跟 handle_ai_reviewed 一致): 这是 Notion 端状态机标记, 不进
  outbox, 否则 query_pages_for_reverse_sync 的 filter 失效 -> 下次轮询又拉
  同一批 page 导致 outbox 重复入队。

  outbox_repo=None 时走老路径 (灰度回退兼容)。
"""

from datetime import datetime
from typing import Any, Dict, Optional, Tuple
from loguru import logger

from src.mail.applescript_arm import AppleScriptArm
from src.mail.sync_store import SyncStore
from src.mail.sqlite_radar import SQLiteRadar
from src.notion.sync import NotionSync
from src.config import config


class NotionToMailSync:
    """反向同步: Notion -> Mail.app"""

    # Action Type → Mail.app 操作映射
    FLAG_ACTIONS = {"需要回复", "需要决策", "需要Review", "需要会议", "需要跟进", "等待响应"}
    READ_ACTIONS = {"仅供参考", "已完结"}

    # 飞书通知触发条件
    NOTIFY_ACTIONS = {"需要回复", "需要决策"}
    NOTIFY_PRIORITIES = {"🔴 紧急", "🟡 重要"}

    def __init__(
        self,
        notion_sync: NotionSync,
        arm: AppleScriptArm = None,
        sync_store: SyncStore = None,
        skip_notify: bool = False,
        outbox_repo: Optional[Any] = None,
    ):
        if notion_sync is None:
            raise TypeError(
                "NotionToMailSync requires notion_sync to be injected (R-01 strict DI)"
            )
        self.notion_sync = notion_sync
        self.arm = arm or AppleScriptArm()
        self.sync_store = sync_store
        self._skip_notify = skip_notify
        # Sprint 15: 注入后 sync_single_page 改 outbox 路径 (架构纯净化)
        self.outbox_repo = outbox_repo
        self.last_check: Optional[datetime] = None
        self.sync_count = 0
        self.error_count = 0
        self.notify_count = 0

        self._feishu = None
        if config.feishu_notify_enabled:
            from src.notify.feishu import FeishuNotifier
            self._feishu = FeishuNotifier(
                app_id=config.feishu_app_id,
                app_secret=config.feishu_app_secret,
                chat_id=config.feishu_chat_id,
                webhook_url=config.feishu_webhook_url,
                secret=config.feishu_webhook_secret,
                database_id=config.email_database_id,
            )
            mode = "app_api" if config.feishu_app_id else "webhook"
            logger.info(f"Feishu notification enabled (mode={mode})")

        logger.info("NotionToMailSync initialized")

    async def close(self):
        if self._feishu:
            await self._feishu.close()

    async def check_and_sync(self) -> Dict[str, int]:
        """检查 Notion 状态变更并同步到 Mail.app"""
        stats = {"synced": 0, "failed": 0, "skipped": 0, "notified": 0}

        try:
            pages = await self.notion_sync.query_pages_for_reverse_sync()

            if not pages:
                logger.debug("No pages need reverse sync")
                self.last_check = datetime.now()
                return stats

            logger.info(f"Found {len(pages)} pages for reverse sync")

            for page in pages:
                try:
                    success = await self.sync_single_page(page)
                    if success:
                        stats["synced"] += 1
                        if await self._try_notify(page):
                            stats["notified"] += 1
                    else:
                        stats["skipped"] += 1
                except Exception as e:
                    logger.error(f"Failed to sync page {page.get('page_id', '?')}: {e}")
                    stats["failed"] += 1

            self.sync_count += stats["synced"]
            self.error_count += stats["failed"]
            self.notify_count += stats["notified"]

            logger.info(
                f"Reverse sync: synced={stats['synced']}, "
                f"failed={stats['failed']}, notified={stats['notified']}"
            )

        except Exception as e:
            logger.error(f"Reverse sync check failed: {e}")

        self.last_check = datetime.now()
        return stats

    async def sync_single_page(self, page: Dict) -> bool:
        """同步单个 Notion 页面到 Mail.app"""
        page_id = page.get("page_id")
        message_id = page.get("message_id")
        ai_action = page.get("ai_action", "")
        mailbox = page.get("mailbox") or None

        if not message_id:
            logger.warning(f"Page {page_id} has no Message ID, skipping")
            return False

        msg_short = message_id[:40] + "..." if len(message_id) > 40 else message_id
        logger.info(f"Syncing to Mail: {msg_short} action={ai_action}")

        internal_id = self._lookup_internal_id(message_id)
        page["internal_id"] = internal_id  # 注入供通知回调使用

        # 邮件已不在 Mail.app 中（被删除/移动），直接标记已同步
        if not internal_id:
            logger.info(f"Email not found in Mail.app, marking as synced: {msg_short}")
            try:
                await self.notion_sync.update_page_mail_sync_status(
                    page_id, synced=True, processing_status="已同步"
                )
            except Exception as e:
                logger.error(f"Failed to update Notion sync status: {e}")
                return False
            return True

        # Sprint 15 新路径: outbox enabled → 写 intent + outbox, fanout 异步派发
        if self.outbox_repo is not None:
            success = self._enqueue_outbox(internal_id, ai_action, msg_short)
        else:
            # 老路径: 直调 AppleScript + update_local_flags (灰度回退兼容)
            if ai_action in self.FLAG_ACTIONS:
                success = self._do_mark_read_and_flag(internal_id, message_id, mailbox)
            elif ai_action in self.READ_ACTIONS:
                success = self._do_mark_read(internal_id, message_id, mailbox)
            else:
                if ai_action:
                    logger.warning(f"Unknown action '{ai_action}', defaulting to mark as read")
                success = self._do_mark_read(internal_id, message_id, mailbox)
            # 老路径下立即写 SQLite (echo prevention)
            self._update_store_flags(internal_id, ai_action)

        # 操作失败（邮件可能已被删除），仍标记已同步防止无限重试
        if not success:
            logger.warning(f"Mail.app action failed (email may be deleted), marking synced: {msg_short}")

        try:
            await self.notion_sync.update_page_mail_sync_status(
                page_id, synced=True, processing_status="已同步"
            )
            logger.info(f"Reverse sync completed for {msg_short}")
        except Exception as e:
            logger.error(f"Failed to update Notion sync status: {e}")
            return False

        # v14 (Sprint 16 收尾, codex P1): 把 Notion 端的 AI props 回写 SQLite SSoT
        # (Custom Agent / 人工改的 label 会被本路径拿到, 但之前只用于飞书通知不入库).
        # 失败 non-fatal — 反向同步主流程不受影响.
        try:
            external_labels = {}
            if ai_action:
                external_labels["action_type"] = ai_action
            for src_key, dst_key in (
                ("ai_priority", "priority"),
                ("ai_summary", "ai_summary"),
                ("category", "category"),
                ("reply_suggestion", "reply_suggestion_md"),
            ):
                val = page.get(src_key, "")
                if val:
                    external_labels[dst_key] = val
            if external_labels:
                from src.llm_agent.store import LLMProcessingStore
                if not hasattr(self, "_llm_store_lazy"):
                    self._llm_store_lazy = LLMProcessingStore()
                self._llm_store_lazy.upsert_external_labels(
                    internal_id, external_labels,
                    source="reverse_sync_poll",
                    notion_page_id=page_id,
                    mailbox=mailbox or None,
                )
        except Exception as e:
            logger.warning(
                f"upsert_external_labels failed (non-fatal) for "
                f"internal_id={internal_id}: {e}"
            )

        return True

    def _compute_payload_and_target(
        self, ai_action: str, record: Optional[Dict]
    ) -> Tuple[Dict[str, bool], bool, bool]:
        """ai_action + 当前 SQLite state → outbox payload + 目标 (is_read, is_flagged).

        - FLAG_ACTIONS: payload {is_read:True, is_flagged:True}, target 双 True
        - READ_ACTIONS / 未知 / 空: payload {is_read:True}, is_flagged 保留 current

        payload 只含真要改的字段; MailAppFanout 看 payload 决定调哪个 AppleScript.
        target 用于 update_local_flags 立即写 SQLite intent (echo prevention).
        """
        current_flagged = bool(record.get("is_flagged", False)) if record else False

        if ai_action in self.FLAG_ACTIONS:
            return {"is_read": True, "is_flagged": True}, True, True
        # READ_ACTIONS / 未知 → 仅标已读, is_flagged 不动
        return {"is_read": True}, True, current_flagged

    def _enqueue_outbox(self, internal_id: int, ai_action: str, msg_short: str) -> bool:
        """outbox 路径: update_local_flags (echo prevention) + enqueue outbox.

        与 handle_ai_reviewed (source='ai_reviewed_handler') / handle_flag_changed
        (source='notion_webhook') 同模式; 这里 source='reverse_sync_poll' 标识
        本路径, 便于 debug / 审计区分。

        target='mailapp' only — Notion 端是 intent 来源, 不回写 Notion outbox
        (跟 handle_flag_changed 一致防回环)。Notion 端 Processing Status / Synced
        to Mail 标记走 update_page_mail_sync_status 直接调 (带外 ack, 不进 outbox)。
        """
        try:
            # SSoT 守卫: 本邮件还有未派发完成的本地 flag intent (用户刚在前端/CLI
            # 改过, fanout 没跑完或派发器曾关闭积压) → Notion 端状态是旧的, 不许
            # 回写覆盖本地 (曾实测: resync 重建页面后本路径把旧旗标写回, 制造
            # "已完成 + is_flagged=1" 僵尸)。跳过本条, 返回 True 让 Notion 页正常
            # ack 成已同步, 不无限重试; 本地 intent 派发完成后 Mail 端自然达到终态。
            try:
                pending = self.outbox_repo.count_pending(
                    internal_id, op_type="flag_sync"
                )
            except Exception:
                pending = 0
            if pending:
                logger.info(
                    f"[reverse_sync→outbox] skip internal_id={internal_id}: "
                    f"{pending} 条本地 flag intent 未派发完成, "
                    f"Notion 端旧状态不回写本地 (SSoT)"
                )
                return True

            record = self.sync_store.get(internal_id) if self.sync_store else None
            payload, target_read, target_flagged = self._compute_payload_and_target(
                ai_action, record
            )

            # 立即 update_local_flags — echo prevention, 让下一轮 SQLite Radar 不
            # 把 fanout 即将派发的状态作为新 diff 触发反向链路
            # Sprint 16 收尾 (codex 审 P0): sync_single_page() 同步把 Notion 标成
            # Processing Status=已同步, SQLite 这边也要镜像, 否则前端 listEnriched
            # 跟 Notion 看到的状态不一致.
            if self.sync_store:
                self.sync_store.update_local_flags(
                    internal_id, target_read, target_flagged,
                    processing_status='已同步',
                )

            outbox_id = self.outbox_repo.enqueue(
                internal_id=internal_id,
                op_type="flag_sync",
                target="mailapp",
                payload=payload,
                source="reverse_sync_poll",
            )
            logger.info(
                f"[reverse_sync→outbox] internal_id={internal_id} "
                f"outbox_id={outbox_id} payload={payload} ({msg_short})"
            )
            return True
        except Exception as e:
            logger.error(f"reverse_sync outbox enqueue failed: {e}")
            return False

    def _lookup_internal_id(self, message_id: str) -> Optional[int]:
        # 1. SyncStore 查找
        if self.sync_store:
            try:
                record = self.sync_store.get_by_message_id(message_id)
                if record:
                    iid = record.internal_id if hasattr(record, 'internal_id') else record.get('internal_id')
                    if iid:
                        return iid
            except Exception:
                pass

        # 2. Fallback: 直接查 Mail.app SQLite Envelope Index（毫秒级）
        try:
            radar = SQLiteRadar(account_url_prefix=config.mail_account_url_prefix)
            if radar.db_path:
                return radar.lookup_internal_id_by_message_id(message_id)
        except Exception as e:
            logger.debug(f"Envelope Index fallback failed: {e}")

        return None

    def _do_mark_read(self, internal_id: Optional[int], message_id: str, mailbox: str = None) -> bool:
        try:
            if internal_id:
                return self.arm.mark_as_read_by_id(internal_id, True, mailbox)
            return self.arm.mark_as_read(message_id, True, mailbox)
        except Exception as e:
            logger.error(f"mark_as_read failed: {e}")
            return False

    def _do_flag(self, internal_id: Optional[int], message_id: str, mailbox: str = None) -> bool:
        try:
            if internal_id:
                return self.arm.set_flag_by_id(internal_id, True, mailbox)
            return self.arm.set_flag(message_id, True, mailbox)
        except Exception as e:
            logger.error(f"set_flag failed: {e}")
            return False

    def _do_mark_read_and_flag(self, internal_id: Optional[int], message_id: str, mailbox: str = None) -> bool:
        try:
            if not self._do_mark_read(internal_id, message_id, mailbox):
                return False
            return self._do_flag(internal_id, message_id, mailbox)
        except Exception as e:
            logger.error(f"mark_read_and_flag failed: {e}")
            return False

    async def _try_notify(self, page: Dict) -> bool:
        if self._skip_notify or not self._feishu:
            return False

        ai_action = page.get("ai_action", "")
        ai_priority = page.get("ai_priority", "")

        # 发件箱不通知
        mailbox = page.get("mailbox", "")
        if mailbox == "发件箱":
            return False

        # 重要/紧急 且 需要行动
        should_notify = (
            ai_priority in self.NOTIFY_PRIORITIES
            and ai_action in self.FLAG_ACTIONS
        )

        if not should_notify:
            return False

        return await self._feishu.notify_important_email(page)

    def _update_store_flags(self, internal_id: Optional[int], ai_action: str):
        """Echo prevention: 反向同步后更新 SyncStore flags"""
        if not self.sync_store or not internal_id:
            return

        try:
            record = self.sync_store.get(internal_id)
            if not record:
                return

            is_read = record.get('is_read', False) if isinstance(record, dict) else getattr(record, 'is_read', False)
            is_flagged = record.get('is_flagged', False) if isinstance(record, dict) else getattr(record, 'is_flagged', False)

            if ai_action in self.FLAG_ACTIONS or ai_action in self.READ_ACTIONS:
                is_read = True
            if ai_action in self.FLAG_ACTIONS:
                is_flagged = True

            # Sprint 16 收尾 (codex 审 P1): 老路径 fallback 同样镜像 ps='已同步'.
            # 语义跟 outbox 主路径 _enqueue_outbox 一致, 不同的只是派发方式.
            self.sync_store.update_local_flags(
                internal_id, bool(is_read), bool(is_flagged),
                processing_status='已同步',
            )
        except Exception as e:
            logger.warning(f"Failed to update store flags for echo prevention: {e}")

    def get_stats(self) -> Dict:
        return {
            "last_check": self.last_check.isoformat() if self.last_check else None,
            "total_synced": self.sync_count,
            "total_errors": self.error_count,
            "total_notified": self.notify_count,
        }
