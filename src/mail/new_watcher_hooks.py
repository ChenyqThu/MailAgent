"""Post-sync dispatch hooks and folder-gate mixin for NewWatcher."""

from __future__ import annotations

import asyncio
import json
import sqlite3
import time
from datetime import datetime
from typing import Any, Dict, Optional

from loguru import logger

from src.config import config as settings
from src.mail.ingest_provenance import is_history_ingest
from src.mail.mailbox_semantics import is_custom_folder_mailbox, is_sent_mailbox
from src.matters.resource_identity import (
    EMAIL_PROVIDER,
    email_resource_key,
    thread_resource_key,
)
from src.models import Email
from src.repository import build_storage_payloads


def should_skip_feishu_for_folder(mailbox: str, notify_enabled: frozenset) -> bool:
    """L3 通知降噪: 自定义文件夹**默认不通知**, 仅 notify_enabled 内的才通知。

    标准邮箱 (收件箱等) 不受影响 (返回 False = 不 skip)。

    ⚠️ v62 起这是**回退路径** —— 运行时权威是 folder_pref 行 (见
    ``NewWatcher._skip_feishu_for_folder``), 本函数只在该文件夹没有 pref 行时接管,
    吃的是 env ``FOLDER_NOTIFY_ENABLED`` 冻结出来的集合。
    """
    if not is_custom_folder_mailbox(mailbox):
        return False
    return mailbox not in notify_enabled


def should_skip_llm_for_folder(mailbox: str, llm_disabled: frozenset) -> bool:
    """L2 LLM gate: 自定义文件夹**默认跑 LLM**, 仅 llm_disabled 内的才跳过。

    标准邮箱不受影响 (返回 False = 不 skip)。

    ⚠️ v62 起这是**回退路径** —— 运行时权威是 folder_pref 行 (见
    ``NewWatcher._skip_llm_for_folder``), 本函数只在该文件夹没有 pref 行时接管。
    """
    if not is_custom_folder_mailbox(mailbox):
        return False
    return mailbox in llm_disabled


class _NewWatcherHooksMixin:
    """Post-sync dual-write, LLM, KOS, agent, and notification hooks for NewWatcher."""

    async def _dispatch_post_sync_hooks(
        self, email_obj: Email, internal_id: int, page_id: str
    ) -> None:
        """邮件落库（Notion 建页成功或 local-only）后的钩子派发。

        主路径 ``_sync_single_email_v3`` 与重试路径 ``_process_retry_queue`` 共用这一份,
        两条路径分别手抄时曾漂移：重试补同步的邮件从不做 LLM 分类、不推 KOS。
        草稿箱不进这里（只落本地）。``page_id`` 为空串 = Notion 关闭，各钩子自行容忍。

        「同步历史邮件」(task 09-11) 补录的行不走三个**实时性语义**的钩子:
        灵动岛推送 / Custom Agent 的 email_filter 触发 / 项目周报钩子。补一年前的
        邮件不该弹通知、起 agent run、跑周报同步。LLM 分类 / KOS / 事项线程关联
        照常 —— 那是对邮件内容的加工, 与"什么时候到的"无关。
        """
        history_ingest = is_history_ingest(self.sync_store, internal_id)

        await self._maybe_link_matter_thread_subscriptions(email_obj, internal_id)

        # 项目周报外挂钩子（非阻塞、异常不影响主流程）
        if not history_ingest:
            self._maybe_trigger_project_progress_hook(email_obj, internal_id, page_id)

        # 本地 LLM Agent 钩子（非阻塞、异常不影响主流程）
        self._maybe_trigger_llm_hook(email_obj, internal_id, page_id)

        # KOS producer 钩子 (PR-2d, Sprint 19 M2)
        # — 非阻塞推 Jarvis KOS v2 让图谱跨域 entity 合并丰富
        self._maybe_trigger_kos_hook(email_obj, internal_id, page_id)

        if not history_ingest:
            # Custom Agent email_filter 触发钩子（S4，非阻塞，默认关）
            self._maybe_trigger_custom_agents(email_obj, internal_id)

    def _maybe_dual_write_body(
        self,
        email_obj: Email,
        internal_id: int,
        raw_mime_source: Optional[str],
    ) -> None:
        """v4: 把邮件正文 + 附件双写到 SQLite（SSoT 切换）.

        - BODY_DUAL_WRITE_ENABLED=false 时直接返回
        - 任何失败仅 warning，不阻断 Notion sync 主流程
        - 详见 docs/reference/architecture/architecture_v4_sqlite_ssot.md

        v4 子步骤:
            1. build_storage_payloads → SQLite commit

        原先第 1 步是「预跑 Office 转换」（docx→pdf / xlsx→csv 产物追加进
        email_obj.attachments，好让 dual-write 的附件列表含 derived 行）。2026-08 随
        Notion 派生退役一并删除 —— 它不受 OFFICE_CONVERT_ENABLED 门控，是自动链路里
        产生派生附件的第二条路。存量 derived 行不受影响（读路径未动）。
        """
        if not getattr(settings, "body_dual_write_enabled", True):
            return
        try:
            body, attachments = build_storage_payloads(
                email_obj,
                internal_id,
                raw_mime_source=raw_mime_source,
                attachment_store=self.email_repo.attachment_store,
            )
            self.email_repo.commit_email_with_body(
                internal_id,
                body,
                attachments,
                message_id=email_obj.message_id,
            )
            logger.debug(
                f"[v4] body+attachments committed to SQLite: internal_id={internal_id}, "
                f"format={body.body_format}, attachments={len(attachments)}, "
                f"inline_images={body.has_inline_images}"
            )
        except Exception as e:
            logger.warning(
                f"[v4] dual-write to SQLite failed for internal_id={internal_id}: {e}"
            )

    def _track_bg_task(self, task) -> None:
        """持有 fire-and-forget hook task 的强引用 (task 06-10, prd Fix 2d).

        Python 3.11 asyncio loop 只弱引用 task — 无强引用的 pending task 可能
        被 GC 中途回收 (生产实证: start() 里 _rollout_flush_task 注释记录的同
        类 bug)。完成后 done_callback 自动 discard, 集合大小 = 当前 in-flight
        hook 数 (可观测)。部分测试用 NewWatcher.__new__ 构造不走 __init__ →
        lazy init 防 AttributeError。
        """
        tasks = getattr(self, "_bg_tasks", None)
        if tasks is None:
            tasks = set()
            self._bg_tasks = tasks
        tasks.add(task)
        task.add_done_callback(tasks.discard)

    async def _maybe_link_matter_thread_subscriptions(
        self, email_obj: Email, internal_id: int
    ) -> None:
        thread_id = str(getattr(email_obj, "thread_id", "") or "").strip()
        if not thread_id:
            return

        def _link() -> None:
            db_path = str(self.sync_store.db_path)
            thread_key = thread_resource_key(thread_id)
            with sqlite3.connect(db_path, timeout=30.0) as lookup_conn:
                lookup_conn.row_factory = sqlite3.Row
                subscriptions = lookup_conn.execute(
                    "SELECT mr.matter_id FROM resource r "
                    "JOIN matter_resource mr ON mr.resource_id=r.id "
                    "JOIN matter m ON m.id=mr.matter_id "
                    "WHERE r.provider=? AND r.external_key=? AND r.kind='thread' "
                    "AND mr.deleted_at IS NULL AND mr.sub_state='active' AND m.deleted_at IS NULL",
                    (EMAIL_PROVIDER, thread_key),
                ).fetchall()
            for subscription in subscriptions:
                matter_id = int(subscription["matter_id"])
                try:
                    conn = sqlite3.connect(db_path, timeout=30.0)
                    conn.execute("PRAGMA foreign_keys=ON")
                    conn.execute("BEGIN IMMEDIATE")
                    now = int(time.time() * 1000)
                    email_key = email_resource_key(internal_id)
                    conn.execute(
                        "INSERT OR IGNORE INTO resource "
                        "(kind,provider,external_key,title,metadata_json,access_policy,created_at,updated_at) "
                        "VALUES ('email',?,?,?,?, 'allowed',?,?)",
                        (
                            EMAIL_PROVIDER,
                            email_key,
                            getattr(email_obj, "subject", None),
                            json.dumps({"internal_id": internal_id}, separators=(",", ":")),
                            now,
                            now,
                        ),
                    )
                    resource_id = int(
                        conn.execute(
                            "SELECT id FROM resource WHERE provider=? AND external_key=?",
                            (EMAIL_PROVIDER, email_key),
                        ).fetchone()[0]
                    )
                    cursor = conn.execute(
                        "INSERT OR IGNORE INTO matter_resource "
                        "(matter_id,resource_id,added_by_kind,provenance_json,sub_state,created_at,updated_at) "
                        "VALUES (?,?,'system',?,'none',?,?)",
                        (
                            matter_id,
                            resource_id,
                            json.dumps(
                                {"via": "thread_subscription", "thread_key": thread_key},
                                separators=(",", ":"),
                            ),
                            now,
                            now,
                        ),
                    )
                    if cursor.rowcount:
                        conn.execute(
                            "INSERT OR IGNORE INTO matter_event "
                            "(matter_id,kind,happened_at,actor_kind,source,resource_id,dedupe_key,payload_json,created_at) "
                            "VALUES (?,'resource_linked',?,'system','thread_subscription',?,?,?,?)",
                            (
                                matter_id,
                                now,
                                resource_id,
                                f"matter:{matter_id}:auto_link:email:{internal_id}",
                                json.dumps(
                                    {"via": "thread_subscription", "thread_key": thread_key},
                                    separators=(",", ":"),
                                ),
                                now,
                            ),
                        )
                        conn.execute(
                            "UPDATE matter SET last_activity_at=?,updated_at=?,version=version+1 WHERE id=?",
                            (now, now, matter_id),
                        )
                    conn.commit()
                except Exception as exc:
                    try:
                        conn.rollback()
                    except Exception:
                        pass
                    logger.warning(
                        f"Matter thread subscription auto-link failed "
                        f"(matter_id={matter_id}, internal_id={internal_id}): {exc}"
                    )
                finally:
                    try:
                        conn.close()
                    except Exception:
                        pass

        try:
            await asyncio.to_thread(_link)
        except Exception as exc:
            # 订阅 lookup 本身失败（DB busy 等）也不许穿透——本函数在 _sync_email 的
            # 大 try 里、且调用点位于 mark_synced 之后，异常外泄会把已 synced 的邮件
            # 改写成 failed（外层 except mark_failed_v3），违反「自动关联失败不阻断
            # 邮件同步」。per-matter 事务失败已在 _link 内部各自兜住，这里兜整体。
            logger.warning(
                f"Matter thread subscription lookup failed "
                f"(internal_id={internal_id}): {exc}"
            )

    def _maybe_trigger_project_progress_hook(
        self, email_obj: Email, internal_id: int, notion_page_id: str
    ) -> None:
        """若该邮件匹配项目周报规则，派发后台任务跑外挂同步（S5 W5a 行内热读）。

        运行判定 = env 总闸 PROJECT_PROGRESS_SYNC_ENABLED（+database_id，__init__ gate）AND
        行 enabled AND ProjectProgressDetector.is_match。触发配置每封邮件从 report_agent 的
        project_progress 行热读（Settings 改即生效）；行不存在（老库未跑 v31）→ 回退 env 构造。
        runner 逐字不变、执行仍 fire-and-forget 直调（不进 async_jobs / gateway）。
        任何失败只打 warning，不影响主同步流程。
        """
        if not getattr(self, "_progress_hook_active", False):
            return
        try:
            from src.project_progress.agent_config import get_project_progress_agent_config
            from src.project_progress.detector import ProjectProgressDetector

            cfg = get_project_progress_agent_config(self._agent_db_path)
            if cfg.row_exists:
                if not cfg.enabled:
                    return
                detector = ProjectProgressDetector(
                    sender=cfg.sender, subject_pattern=cfg.subject_pattern
                )
            else:
                # 老库未跑 v31 迁移 → 回退 env 构造（行为等价窗口）。
                if not getattr(settings, "project_progress_auto_sync_enabled", False):
                    return
                detector = ProjectProgressDetector(
                    sender=settings.project_progress_sender,
                    subject_pattern=settings.project_progress_subject_pattern,
                )
            if not detector.is_match(sender=email_obj.sender, subject=email_obj.subject):
                return
            logger.info(
                f"[pp-hook] matched internal_id={internal_id} subject="
                f"{(email_obj.subject or '')[:60]!r}; dispatching background task"
            )
            from src.project_progress.runner import ProjectProgressRunner

            runner = ProjectProgressRunner()

            async def _bg():
                try:
                    summary = await runner.sync_from_email(
                        internal_id=internal_id,
                        notion_email_page_id=notion_page_id,
                        force=False,
                        dry_run=False,
                    )
                    logger.info(f"[pp-hook] done: {summary.as_log_line()}")
                    await self._notify_project_progress(
                        internal_id, status=summary.status, error=summary.error
                    )
                except Exception as e:
                    logger.warning(f"[pp-hook] background task failed: {e}")
                    await self._notify_project_progress(
                        internal_id, status="failed", error=str(e)
                    )

            self._track_bg_task(asyncio.create_task(_bg()))
        except Exception as e:
            logger.warning(f"[pp-hook] dispatch failed: {e}")

    async def _notify_project_progress(
        self, internal_id: int, *, status: str, error: Optional[str]
    ) -> None:
        """项目周报自动同步的失败 / 恢复 → 通知中心（task 08-20-notification-center）。

        无人值守的 fire-and-forget 链路：失败此前只有一行 log，连飞书都没有。

        🔴 判据是 ``summary.status`` 而不是「有没有抛异常」—— runner 的多数失败
        路径（附件解析失败 / 全部项目写失败）**正常返回** status='failed'，只接
        except 分支会漏掉大半失败面。``skipped``（幂等命中 / 无匹配附件）既不算
        失败也不算恢复：它在真正写 Notion 之前就短路了，证明不了链路已好。

        落库失败只 warning：通知路径绝不影响主同步流程。
        """
        if status not in ("failed", "completed"):
            return
        from src.notify.center import NotifyCenter

        center = NotifyCenter(str(self.sync_store.db_path))
        dedupe_key = "project_progress_sync_failed"
        try:
            if status == "completed":
                await asyncio.to_thread(center.resolve_by_dedupe, dedupe_key)
                return
            await asyncio.to_thread(
                center.publish,
                category="results",
                source="project_progress",
                title="项目周报自动同步失败",
                body=(
                    f"邮件 internal_id={internal_id} 触发的周报同步未完成: "
                    f"{(error or '未知错误')[:240]}"
                ),
                severity="warn",
                dedupe_key=dedupe_key,
                payload={"link": {"type": "route", "to": "/admin/kanban"}},
            )
        except Exception as e:  # noqa: BLE001 — 通知落库失败不影响同步流程
            logger.warning(f"[pp-hook] notify center failed: {e}")

    def _skip_feishu_for_folder(self, mailbox: str) -> bool:
        """L3: 这封邮件该不该跳过飞书通知 (True = 跳过)。"""
        if not is_custom_folder_mailbox(mailbox):
            return False
        gates = self.sync_store.get_folder_gates(mailbox)
        if gates.row_exists:
            return not gates.notify_enabled       # 白名单语义: 没 opt-in 就跳过
        return should_skip_feishu_for_folder(mailbox, self._folder_notify_enabled)

    def _skip_llm_for_folder(self, mailbox: str) -> bool:
        """L2: 这封邮件该不该跳过 LLM 分类 (True = 跳过)。"""
        if not is_custom_folder_mailbox(mailbox):
            return False
        gates = self.sync_store.get_folder_gates(mailbox)
        if gates.row_exists:
            return gates.llm_disabled             # 黑名单语义: opt-out 了才跳过
        return should_skip_llm_for_folder(mailbox, self._folder_llm_disabled)

    def _any_llm_gate_active(self) -> bool:
        """有没有任何文件夹关掉了 LLM —— 重试队列的短路探针。

        保住升级前的行为: 旧代码用 ``if llm_disabled:`` (env frozenset 非空) 决定要
        不要为每个重试行多查一次 mailbox。两侧都空时这一整段依然零额外查询。
        """
        return bool(self._folder_llm_disabled) or self.sync_store.has_any_llm_disabled()

    def _maybe_trigger_llm_hook(
        self, email_obj: Email, internal_id: int, notion_page_id: str
    ) -> None:
        """若启用本地 LLM Agent，派发后台任务填充 Notion AI 字段。

        任何失败只打 warning，不影响主同步流程。
        失败 N 次后由 _process_llm_retry_queue 接手重试。
        """
        if self._llm_runner is None:
            return
        # L2 gate: 自定义文件夹默认跑 LLM, 关掉的跳过 (省成本去噪)。权威是 folder_pref
        # 行, 无行时回退 FOLDER_LLM_DISABLED (见 _skip_llm_for_folder)。
        mailbox = getattr(email_obj, "mailbox", "") or ""
        if self._skip_llm_for_folder(mailbox):
            logger.debug(
                f"[llm-hook] skip internal_id={internal_id} mailbox={mailbox!r} "
                f"(folder AI 分类已关)"
            )
            return
        try:
            subject_preview = (getattr(email_obj, "subject", "") or "")[:60]
            logger.debug(
                f"[llm-hook] dispatching internal_id={internal_id} subject={subject_preview!r}"
            )

            async def _bg():
                try:
                    result = await self._llm_runner.run_for_internal_id(
                        internal_id,
                        dry_run=False,
                        force=False,
                        overwrite=True,
                    )
                    # skipped='already_success' 说明此邮件 LLM 早已处理 + 已通知,
                    # labels 为空 → 不重发灵动岛通知 (问题 A 去重根因 2)。
                    if result.get("ok") and not result.get("skipped"):
                        labels = result.get("labels") or {}
                        logger.info(
                            f"[llm-hook] ok internal_id={internal_id} "
                            f"priority={labels.get('priority')} "
                            f"action_type={labels.get('action_type')} "
                            f"tokens={labels.get('tokens')}"
                        )
                        # 飞书推送先判定；开启 skipBannerWhenFeishuSent 时本地通知不再重复弹桌面横幅
                        feishu_sent = await self._maybe_notify_feishu(
                            email_obj, internal_id, notion_page_id, labels,
                        )
                        if feishu_sent:
                            await self._maybe_notify_center_reviewed(
                                email_obj, internal_id, labels, feishu_sent=True,
                            )
                        else:
                            await self._maybe_notify_center_reviewed(
                                email_obj, internal_id, labels,
                            )
                    else:
                        logger.warning(
                            f"[llm-hook] failed internal_id={internal_id} "
                            f"error={result.get('error')} retry={result.get('retry_count')}"
                        )
                except Exception as e:
                    logger.warning(f"[llm-hook] background task failed: {e}")

            self._track_bg_task(asyncio.create_task(_bg()))
        except Exception as e:
            logger.warning(f"[llm-hook] dispatch failed: {e}")

    def _maybe_trigger_custom_agents(self, email_obj: Email, internal_id: int) -> None:
        """若启用 Custom Agent，匹配 email_filter 规则并派发后台 run（S4，ADR D5）。

        主循环只做 flag + 存在性检查（不解析/编译 trigger 正则）；正则匹配 + enqueue 移出
        当封邮件的内联处理路径（放后台 task）。任何失败只 warning。
        注意：bg task 仍跑在同一 asyncio 事件循环（create_task 不换线程、re 匹配持 GIL），
        owner 若配 catastrophic pattern 仍会卡循环——ReDoS 防线是 pattern≤256 + 输入截断 512
        + owner 配置（非攻击者），不是这层 task 隔离。
        """
        if not self._custom_agents_enabled or self._agent_store is None:
            return
        try:
            # 廉价存在性检查：有无 enabled 的 type='custom' 行（不碰正则）。
            candidates = [
                a for a in self._agent_store.list_agents()
                if a.get("enabled") and a.get("type") == "custom"
            ]
            if not candidates:
                return
            sender = getattr(email_obj, "sender", None)
            subject = getattr(email_obj, "subject", None)
            mailbox = getattr(email_obj, "mailbox", None)
            thread_id = getattr(email_obj, "thread_id", None)
            repo = self._agent_job_repo

            async def _bg():
                try:
                    from src.agents.email_dispatch import dispatch_email_agents
                    dispatch_email_agents(
                        candidates,
                        sender=sender,
                        subject=subject,
                        mailbox=mailbox,
                        thread_id=thread_id,
                        internal_id=internal_id,
                        repo=repo,
                    )
                except Exception as e:
                    logger.warning(f"[custom-agent] background dispatch failed: {e}")

            self._track_bg_task(asyncio.create_task(_bg()))
        except Exception as e:
            logger.warning(f"[custom-agent] dispatch failed: {e}")

    def _maybe_trigger_kos_hook(
        self, email_obj: Email, internal_id: int, notion_page_id: str
    ) -> None:
        """KOS Producer (PR-2d, Sprint 19 M2) — 异步推邮件入 Jarvis KOS v2.

        从 SQLite 读 LLM 已 classify 的 ai_priority 做 priority floor 过滤;
        body markdown 从 EmailRepository.get_body_markdown (v4 SSoT) 取;
        调 src.kos.producer.push_email_to_kos fire-and-forget.

        任何失败 (KOS 不可达 / KOSError / unexpected) 仅 warning 不阻塞主流程
        (KOS 是图谱丰富, 不丢功能性数据 — Mail.app + Notion 仍 SSoT).
        默认 MAILAGENT_KOS_INGEST_ENABLED=false 整段 noop.
        """
        if not getattr(settings, "mailagent_kos_ingest_enabled", False):
            return
        try:
            from src.kos.producer import push_email_to_kos, resolve_thread_refs

            # 完整 AI labels (llm_processing.labels_json) + body + 附件 — 增量入图
            # 跟 bulk historical ingest 形态一致 (category/ai_summary/key_points 都带)
            priority_floor = getattr(settings, "kos_ingest_priority_floor", "normal")
            require_labeled = bool(getattr(settings, "kos_require_labeled", False))
            dry_run = getattr(settings, "kos_ingest_dry_run", False)

            # issue #64 Lane A: 本 hook 与步骤 9 的 LLM hook 同为 fire-and-forget,
            # 曾在 LLM 后台任务写完 labels **之前**就同步读 LLMProcessingStore →
            # 100% 读空 (实测 83/83 封 pushed_at 平均早于 llm_processing.updated_at
            # 911s): priority floor 恒按 normal 放行 (23 封 ⚪低 误入库)、增量页面
            # 无 AI 标签、KOS_REQUIRE_LABELED 一开即全 skipped。修法 = 会跑 LLM 的
            # 邮件不在此刻推, 落台账 status='pending' 排队 (record_deferred), 由
            # 6c _process_kos_retry_queue 在 llm_processing 终态 (success/gave_up)
            # 或 DEFER_MAX_CHECKS 兜底后用 repush_stored_email_to_kos 从 SQLite
            # SSoT 重建 payload 首推 —— floor/require_labeled 在标签就位后才第一次
            # 真正生效, 主同步路径反而少了几次 SQLite 读 (fetch 块整个跳过)。
            # 不会跑 LLM 的路径 (LLM 未启用 / FOLDER_LLM_DISABLED) 走下方直推,
            # labels 空是事实而非 race; kos_retry_enabled=false (6c 应急关, defer
            # 无消费者会永久卡队) 或 dry_run (defer 后 repush 是真推) 同样保持
            # 直推老行为 —— 即整套 defer 的应急回退 = MAILAGENT_KOS_RETRY_ENABLED=false。
            mailbox = getattr(email_obj, "mailbox", "") or ""
            will_run_llm = (
                self._llm_runner is not None
                and not should_skip_llm_for_folder(
                    mailbox, getattr(self, "_folder_llm_disabled", frozenset())
                )
            )
            if (will_run_llm and not dry_run
                    and getattr(settings, "kos_retry_enabled", True)):
                from src.kos import ingest_log

                db_path = str(self.sync_store.db_path)
                logger.debug(
                    f"[kos-hook] deferring internal_id={internal_id} until LLM "
                    f"labels settle (status='pending' in kos_ingest_log)"
                )

                async def _bg_defer():
                    # 入队失败 (台账写锁 5s 超时等) 只 warning: 后果 = 这封不进
                    # KOS 队列 (与修复前 fire-and-forget 丢失同级), 日志可见 +
                    # bulk_ingest 补漏可捞, 不为极低概率路径加直推回退分支。
                    try:
                        await asyncio.to_thread(
                            ingest_log.record_deferred, db_path, internal_id,
                            f"sources/email/{internal_id}", "producer",
                        )
                    except Exception as e:
                        logger.warning(
                            f"[kos-hook] defer enqueue failed "
                            f"internal_id={internal_id}: {e}"
                        )

                self._track_bg_task(asyncio.create_task(_bg_defer()))
                return

            labels: Optional[dict] = None
            body_markdown: Optional[str] = None
            attachments: Optional[list] = None
            thread_parent = None
            thread_root = None
            try:
                from src.llm_agent.store import LLMProcessingStore

                labels = LLMProcessingStore().get_labels(internal_id)
                body_markdown = self.email_repo.get_body_markdown(
                    internal_id, max_chars=200_000
                )
                attachments = [
                    {"filename": a.filename, "size": a.size_bytes,
                     "content_type": a.content_type}
                    for a in self.email_repo.get_attachments(internal_id)
                    if not a.is_inline
                ]
                # Thread 链接反查 (parent=In-Reply-To, root=thread_id) — 行已落库
                # (save_email + _persist_email_metadata_after_parse 在 hook 前跑)。
                # 与 bulk_ingest 共用同一 SQLite 反查 → 两路径 payload 一致。
                refs = resolve_thread_refs(str(self.sync_store.db_path), internal_id)
                thread_parent = refs.get("parent")
                thread_root = refs.get("root")
            except Exception as e:
                # warning 而非 debug (issue #64 Lane A): 这里吞掉的异常曾让孤例
                # internal_id=1000010856 (4 附件) 既无 llm_processing 行也无台账行
                # 且日志零线索 —— fetch 失败虽不阻断推送 (labels/body 缺省 None),
                # 但必须在默认日志级别可见。
                logger.warning(
                    f"[kos-hook] labels/body/attachments/thread fetch failed "
                    f"internal_id={internal_id}: {e}"
                )

            subject_preview = (getattr(email_obj, "subject", "") or "")[:60]
            logger.debug(
                f"[kos-hook] dispatching internal_id={internal_id} "
                f"priority={(labels or {}).get('priority')!r} floor={priority_floor!r} "
                f"require_labeled={require_labeled} "
                f"subject={subject_preview!r}"
            )

            async def _bg():
                try:
                    outcome = await push_email_to_kos(
                        email_obj,
                        internal_id,
                        body_markdown=body_markdown,
                        notion_page_id=notion_page_id,
                        labels=labels,
                        attachments=attachments,
                        thread_parent=thread_parent,
                        thread_root=thread_root,
                        priority_floor=priority_floor,
                        require_labeled=require_labeled,
                        dry_run=dry_run,
                        db_path=str(self.sync_store.db_path),
                    )
                    # issue #59: 失败与跳过必须分级 —— 老实现两者都返 None 一律记
                    # debug "skipped", 101 页空洞在日志层面伪装成正常跳过。
                    if outcome.failed:
                        logger.warning(
                            f"[kos-hook] push FAILED internal_id={internal_id} "
                            f"code={outcome.error_code} (已记台账, 瞬时错误由重试"
                            f"扫描补偿): {outcome.error}"
                        )
                    elif outcome.skipped:
                        logger.debug(
                            f"[kos-hook] skipped internal_id={internal_id} "
                            f"({outcome.reason})"
                        )
                except Exception as e:
                    logger.warning(
                        f"[kos-hook] background task failed internal_id={internal_id}: {e}"
                    )

            self._track_bg_task(asyncio.create_task(_bg()))
        except Exception as e:
            logger.warning(
                f"[kos-hook] dispatch failed internal_id={internal_id}: {e}"
            )

    async def _maybe_notify_feishu(
        self, email_obj: Email, internal_id: int,
        notion_page_id: str, labels: Dict[str, Any],
    ) -> bool:
        """本地 LLM review 完成后, 对重要/紧急且需行动的邮件直推飞书通知.

        取代旧链路: Notion Email Agent → Automation webhook(ai_reviewed) → Redis
        → handle_ai_reviewed → 飞书. 本地 LLM 接管分类后 Notion 端不再触发该
        automation, 旧链路断供 (用户现象: 切换后再也收不到飞书通知).

        判据与 handlers.handle_ai_reviewed / reverse_sync._try_notify 一致
        (重要/紧急 + 需行动 + 非发件箱). priority/action_type 直接来自
        labels.summary_for_log(), 格式与飞书判据天然一致 (PRIORITY_ENUM).
        飞书内部自带 page_id 去重(10min) + 3 天时效过滤; 失败仅 warning 不阻塞.
        """
        if getattr(self, "_feishu", None) is None:
            return False
        # 与 handlers.FLAG_ACTIONS / reverse_sync.NOTIFY_PRIORITIES 同口径
        notify_priorities = {"🔴 紧急", "🟡 重要"}
        flag_actions = {
            "需要回复", "需要决策", "需要Review",
            "需要会议", "需要跟进", "等待响应",
        }
        try:
            priority = str(labels.get("priority") or "")
            action = str(labels.get("action_type") or "")
            mailbox = getattr(email_obj, "mailbox", "") or ""
            if priority not in notify_priorities:
                return False
            if action not in flag_actions:
                return False
            if is_sent_mailbox(mailbox):
                return False
            # L3 降噪: 自定义文件夹默认不通知 (PRD §2.3); 开了通知的才推。权威是
            # folder_pref 行, 无行时回退 FOLDER_NOTIFY_ENABLED (见 _skip_feishu_for_folder)。
            if self._skip_feishu_for_folder(mailbox):
                logger.debug(
                    f"[feishu] skip custom folder internal_id={internal_id} "
                    f"mailbox={mailbox!r} (L3 降噪; 设置里打开该文件夹的通知即可)"
                )
                return False

            # E: 对账补抓的**老**邮件不推送 (通知是实时性语义)。判据是
            # 「补抓来源 AND 超龄」—— 正常增量 (含停机后的积压) 不受此门约束。
            if self._suppress_reconcile_notify(internal_id):
                return False

            email_date = getattr(email_obj, "date", None)
            date_iso = (
                email_date.isoformat()
                if isinstance(email_date, datetime)
                else ""
            )
            page_info = {
                "page_id": notion_page_id or "",
                "message_id": getattr(email_obj, "message_id", "") or "",
                "internal_id": internal_id,
                "subject": getattr(email_obj, "subject", "") or "",
                "from_name": getattr(email_obj, "sender_name", "") or "",
                "from_email": getattr(email_obj, "sender", "") or "",
                "to_addr": getattr(email_obj, "to", "") or "",
                "cc_addr": getattr(email_obj, "cc", "") or "",
                "date": date_iso,
                "mailbox": mailbox,
                "ai_action": action,
                "ai_priority": priority,
                "ai_summary": str(
                    labels.get("ai_summary_full") or labels.get("ai_summary") or ""
                ),
                "category": str(labels.get("category") or ""),
                # reply_suggestion 不在 summary_for_log (防完整回复泄露进日志),
                # 飞书卡片回复按钮由 Openclaw 按 page_id/message_id 处理, 此处留空.
                "reply_suggestion": "",
            }
            ok = bool(await self._feishu.notify_important_email(page_info))
            if ok:
                logger.info(
                    f"[feishu] notified internal_id={internal_id} "
                    f"priority={priority} action={action}"
                )
            return ok
        except Exception as e:
            logger.warning(f"[feishu] notify failed internal_id={internal_id}: {e}")
            return False

    async def _maybe_notify_center_reviewed(
        self,
        email_obj: Email,
        internal_id: int,
        labels: Dict[str, Any],
        *,
        feishu_sent: bool = False,
    ) -> None:
        """本地 LLM review 完成后, 将重要/紧急且需行动的邮件按偏好发布到 NotifyCenter.

        遵守分场景渠道偏好 (mailDelivery / mailScope / mailActionsEnabled /
        skipBannerWhenFeishuSent), 失败 fail-open.
        """
        notify_priorities = {"🔴 紧急", "🟡 重要"}
        flag_actions = {
            "需要回复", "需要决策", "需要Review",
            "需要会议", "需要跟进", "等待响应",
        }
        try:
            priority = str(labels.get("priority") or "")
            action = str(labels.get("action_type") or "")
            mailbox = getattr(email_obj, "mailbox", "") or ""
            if priority not in notify_priorities:
                return
            if action not in flag_actions:
                return
            if is_sent_mailbox(mailbox):
                return
            if self._skip_feishu_for_folder(mailbox):
                return
            if self._suppress_reconcile_notify(internal_id):
                return
            db_path = getattr(getattr(self, "sync_store", None), "db_path", None)
            if not db_path:
                return

            from src.notify.center import NotifyCenter
            from src.notify.prefs import load_notification_prefs

            is_urgent = priority == "🔴 紧急"
            prefs = load_notification_prefs(db_path)
            delivery = str(prefs.get("mailDelivery") or "both")
            if delivery == "off":
                return
            if not is_urgent and prefs.get("mailScope") == "urgent_only":
                if delivery == "system_only":
                    return
                if delivery == "both":
                    delivery = "center_only"
            if feishu_sent and prefs.get("skipBannerWhenFeishuSent", True):
                if delivery == "system_only":
                    return
                if delivery == "both":
                    delivery = "center_only"

            sender_display = (
                getattr(email_obj, "sender_name", "") or getattr(email_obj, "sender", "") or ""
            ).strip()
            subject = (getattr(email_obj, "subject", "") or "").strip()
            if sender_display and subject:
                title = f"{sender_display}: {subject}"
            else:
                title = subject or sender_display or f"Email #{internal_id}"
            ai_summary = str(
                labels.get("ai_summary_full") or labels.get("ai_summary") or ""
            ).strip()
            payload: Dict[str, Any] = {
                "delivery": delivery,
                "link": {"type": "email", "emailId": int(internal_id)},
            }
            if prefs.get("mailActionsEnabled", True):
                actions: list[dict[str, Any]] = [
                    {
                        "id": "open_email_ai",
                        "label": "AI 拟稿 / 跟进",
                        "emailId": int(internal_id),
                        "emailSubject": (subject or title)[:80],
                    }
                ]
                if delivery != "system_only":
                    actions.append({"id": "snooze_1h", "label": "1小时后提醒"})
                payload["actions"] = actions

            center = NotifyCenter(db_path)
            publish_kwargs: Dict[str, Any] = {}
            if delivery == "system_only":
                publish_kwargs["system_only"] = True
            await asyncio.to_thread(
                center.publish,
                category="action_required" if is_urgent else "reviews",
                source="mail_urgent" if is_urgent else "mail_important",
                severity="critical" if is_urgent else "warn",
                title=title[:120],
                body=ai_summary[:240],
                dedupe_key=f"mail_review:{internal_id}",
                payload=payload,
                **publish_kwargs,
            )
        except Exception as e:
            logger.debug(f"[notify-center] mail review publish skipped internal_id={internal_id}: {e}")

    async def _process_llm_retry_queue(self) -> None:
        """重试 LLM 失败的邮件（指数退避：1m/5m/15m/1h/2h）。

        超过 LLM_MAX_RETRIES 的邮件状态转 gave_up：
        - 不再重试
        - 不写 AI 字段
        - 不动 Processing Status（保持'未处理'）
        - 让 Notion Custom Agent 自然接手（如果还活着）
        """
        if self._llm_runner is None:
            return
        try:
            ready = self._llm_runner._store.get_ready_for_retry(limit=3)
        except Exception as e:
            logger.warning(f"[llm-retry] queue probe failed: {e}")
            return
        if not ready:
            return
        logger.info(f"[llm-retry] retrying {len(ready)} failed email(s)")
        # 短路探针: 一个文件夹都没关 LLM 时整段跳过, 不为每行多查一次 mailbox
        # (逐字保住旧的 `if llm_disabled:` 语义, 只是判据从 env 集合扩到 env + 行)。
        any_llm_gate = self._any_llm_gate_active()
        for row in ready:
            internal_id = row.get("internal_id")
            # L2 gate: 关了 AI 的文件夹, retry 也跳过 (与新邮件 dispatch 一致，省成本去噪)。
            # mailbox 不在 llm_processing 表 → 从 sync_store 按 internal_id 查。
            if any_llm_gate:
                meta = self.sync_store.get(internal_id)
                mailbox = (meta or {}).get("mailbox", "") if meta else ""
                if self._skip_llm_for_folder(mailbox or ""):
                    logger.debug(
                        f"[llm-retry] skip internal_id={internal_id} "
                        f"mailbox={mailbox!r} (folder AI 分类已关)"
                    )
                    continue
            try:
                result = await self._llm_runner.run_for_internal_id(
                    internal_id,
                    dry_run=False,
                    force=True,          # bypass already-success short-circuit
                    overwrite=True,
                )
                if result.get("ok"):
                    logger.info(f"[llm-retry] recovered internal_id={internal_id}")
                else:
                    logger.warning(
                        f"[llm-retry] still failing internal_id={internal_id} "
                        f"retry={result.get('retry_count')} status={result.get('status')}"
                    )
            except Exception as e:
                logger.warning(f"[llm-retry] internal_id={internal_id} exception: {e}")
