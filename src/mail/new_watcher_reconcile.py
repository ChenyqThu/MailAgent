"""Inbound read, inbox/drafts reconcile, and KOS retry mixin for NewWatcher."""

from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any, Dict, List

from loguru import logger

from src.config import config as settings
from src.mail.backend.serial_executor import run_backend_io
from src.mail.mailbox_semantics import INBOX_LABEL
from src.mail.sync_store import DRAFT_MAILBOX_LABELS


def _watcher_mod():
    from src.mail import new_watcher as _nw

    return _nw


def _publish_email_new(rows: List[tuple], *, source: str = "new_watcher") -> None:
    """新邮件 save_email 落库后发 ``email.new`` —— 入库即上列表, 不等 AI/Notion 管线。

    ``rows`` = [(internal_id, mailbox), ...] 本轮真正**新建**的行 (merge 进已有行不算)。

    发布节流取舍 (perf-sse-realtime R1-1): **每轮聚合成一条事件**而不是每封一条 ——
    单封时走 internal_id 单值 wire, 多封时走 issue #58 已有的批量 wire
    (internal_id=null + data.internal_ids, 前端 emailInvalidation 的 batch 分支免费
    复用, 超 cap 置 ids_truncated 由前端退化成 ['email'] 前缀失效)。初始批量同步
    (``src/init/initial_sync.py``) 与 backfill **不经过这里** (它们直调 save_email /
    save_emails_batch, 不发事件) —— 3000 封初始灌库天然打不到事件桥; 本入口最坏是
    离线后追赶的一个 poll 窗口 (受 DAVMAIL_FOLDER_SIZE_LIMIT 截断), 一轮一条不刷屏。
    lossy 总线纪律: 事件只是加速, 正确性靠前端保险轮询/staleTime 兜底。
    """
    if not rows:
        return
    try:
        from src.events.publisher import safe_publish

        if len(rows) == 1:
            internal_id, mailbox = rows[0]
            safe_publish(
                "email.new",
                internal_id=internal_id,
                data={"mailbox": mailbox},
                source=source,
            )
            return
        ids = [iid for iid, _ in rows]
        id_cap = _watcher_mod().READ_RECONCILE_EVENT_ID_CAP
        safe_publish(
            "email.new",
            data={
                # cap 复用入向已读回收的 wire 契约 (前端 MAX_BATCH_IDS=200 同值镜像)
                "internal_ids": ids[:id_cap],
                "ids_truncated": len(ids) > id_cap,
                "mailboxes": sorted({mb for _, mb in rows if mb}),
            },
            source=source,
        )
    except Exception:
        pass


class _NewWatcherReconcileMixin:
    """Inbox/drafts reconciliation, inbound read convergence, and KOS retry methods."""

    async def _extract_contacts(self):
        """通讯录 L0+L1 增量扫描。

        镜像 ``_reconcile_inbox`` 的独立低频节拍纪律: 🔴 绝不挂 5s radar poll —— 独立 interval
        (``MAILAGENT_CONTACT_EXTRACT_INTERVAL_SEC``, 默认 120s), 每 tick 有界批
        (batch 500 + 墙钟预算, 见 scanner.DEFAULT_TICK_BUDGET_SEC), 积压时
        单 tick 多消化几批、追平后回低频。全程幂等 (backfill = watermark 从 0
        的同一段代码, CLI ``mailagent contact backfill`` 催跑)。

        纯本地 SQL 放 ``asyncio.to_thread``: BEGIN IMMEDIATE 的锁**等待**发生在
        工作线程, 不冻 event loop (镜像 read-reconcile 的收敛纪律)。
        """
        interval = max(5, int(getattr(settings, "contact_extract_interval_sec", 120)))
        now = _watcher_mod().time.monotonic()
        last = self._last_contact_extract_at
        if last is not None and (now - last) < interval:
            return
        self._last_contact_extract_at = now
        try:
            from src.contacts.scanner import run_tick

            stats = await asyncio.to_thread(run_tick, str(self.sync_store.db_path))
            if stats and stats.get("processed"):
                logger.info(
                    f"[contact-extract] processed={stats['processed']} "
                    f"contacts+={stats['contacts_created']} "
                    f"links+={stats['links_inserted']} "
                    f"watermark={stats['watermark']} drained={stats['drained']}"
                )
        except Exception as e:
            logger.warning(f"[contact-extract] tick failed (skip cycle): {e}")

    async def _scan_calendar_contacts(self):
        """通讯录日历第三源: calendar_event 与会者 → contact 三列 (task 08-24 #4)。

        节拍纪律与 ``_extract_contacts`` 同款 (🔴 绝不挂 5s radar poll), 但是**另一条**
        游标与 interval (``MAILAGENT_CONTACT_CALENDAR_INTERVAL_SEC``, 默认 900s):
        这一轮是窗口内全量重算 (calendar_event 是可变表, 改期/取消会回写既有行),
        比邮件那条增量扫描重, 频率低一档。

        运行前提 = 日历同步开着; 关掉时 ``calendar_event`` 是陈旧快照, 重算出来的
        「下一场会议」只会是过时事实 —— 整段跳过, 不写。
        """
        if not getattr(settings, "calendar_caldav_sync_enabled", False):
            return
        interval = max(60, int(getattr(settings, "contact_calendar_interval_sec", 900)))
        now = _watcher_mod().time.monotonic()
        last = self._last_contact_calendar_scan_at
        if last is not None and (now - last) < interval:
            return
        self._last_contact_calendar_scan_at = now
        try:
            from src.contacts.calendar_scan import run_tick

            stats = await asyncio.to_thread(run_tick, str(self.sync_store.db_path))
            if stats and (
                stats["contacts_created"] or stats["contacts_updated"]
                or stats["contacts_reset"]
            ):
                logger.info(
                    f"[contact-calendar] occurrences={stats['occurrences']} "
                    f"participants={stats['participants']} "
                    f"contacts+={stats['contacts_created']} "
                    f"updated={stats['contacts_updated']} "
                    f"reset={stats['contacts_reset']}"
                )
        except Exception as e:
            logger.warning(f"[contact-calendar] tick failed (skip cycle): {e}")

    async def _reconcile_inbound_read(self):
        """入向「未读→已读」单向回收 (davmail-only, MAILAGENT_INBOUND_READ_RECONCILE_ENABLED)。

        Outlook/OWA 等外部客户端标已读后, MailAgent 未读不回流 (Sprint15 为避 flag/unflag
        死循环禁了入向回收, 见 _detect_and_sync_flag_changes docstring)。这里加**安全版**
        单向收敛: 服务器上确认带 \\Seen 的本地未读邮件 → 收敛为已读。

        判定分两步, **SEARCH 只出候选、FETCH 才是判据**:
          1. ``UID SEARCH UNSEEN`` 拿服务器未读集 → 本地未读且不在其中的 = 候选;
          2. 提交前对候选 uid 定向 ``UID FETCH (FLAGS)`` 复核 —— 未返回 (已归档/删除/
             被规则搬走/UID 空洞) 或返回但无 \\Seen (SEARCH 快照期间又被标未读) 一律
             跳过, 只有确证带 \\Seen 才收敛。缺了这步就会把 "不在 INBOX" 误解释成
             "已读", 把归档掉的未读邮件永久标已读 (codex review BLOCK 1/2)。

        安全闸 (缺一不可):
          (a) outbox 有未终态 (pending/processing/failed) flag_sync intent → 跳过 (避
              Sprint15 fanout 窗口把 "出向 intent 尚未派发" 误判为入向 drift)。这道闸与
              本地 CAS + 入队在**同一个事务**内 (converge_local_read_atomic), 消 TOCTOU。
          (b) 恒走 outbox 单向派发 (target='notion', 不入 mailapp 队) —— **绝不直调
              Notion** (Sprint15 死循环根因之一); 服务器本就是已读真源, 不回写 Mail.app。
          (c) 本地 imap_uidvalidity 与服务器当前 UIDVALIDITY 一致才用 imap_uid 匹配;
              不一致的行整批跳过 (uidvalidity 变化让 imap_uid 全失效 → 批量误判污染)。
              两次 IMAP 会话之间 uv 变了同样整轮作废。
          (c2) uid 必须落在服务器 IMAP 视图的截断窗口内 (davmail.folderSizeLimit 只保留
              最近 N 封) —— 窗口外老邮件在 UNSEEN 里必然缺席, 缺席 ≠ 已读。

        ⚠️ 已知残留竞态 (有意不彻底消除, 见 test_marked_unread_between_verify_and_commit):
          定向 FETCH 说「已读」之后、本轮事务提交之前, 用户在 Outlook 把这封标回未读 ——
          此刻**还没有**任何本地写或 outbox intent, 所以 CAS 与在途闸都看不见它, 这封会
          被收敛成已读; 下轮它已不在本地未读集, 而本功能单向 (不做已读→未读) → 不自愈。
          处置: 复核与提交按 chunk 紧邻 (READ_RECONCILE_CONVERGE_CHUNK), 把窗口从「整批
          候选的处理时长」(候选多时可达数秒) 收窄到「单 chunk 内、该封之前那些收敛事务的
          累计时长」—— 无锁竞争时全是本地语句, 毫秒级; 一旦有一封等锁超时就**立即终止本轮**
          (见 READ_RECONCILE_LOCK_TIMEOUT_SEC), 不让 2s 级的锁等待逐封累加把窗口撑大, 也不
          再消费已经变旧的 seen_map。另有**累计耗时预算**
          (READ_RECONCILE_CHUNK_BUDGET_SEC) 兜住「每封都等很久、但都在 timeout 之前拿到锁」
          这一形态 —— 那种情况一次 ConvergeLockBusy 都不抛, 却同样把窗口按 chunk 长度撑大。
          两道闸合起来把窗口钉在常数量级 (预算 + 一次锁等待), 与候选量、chunk 长度都解耦。
          再窄一档要 CONDSTORE/MODSEQ (DavMail 经 EWS 桥支持存疑) —— 但那也只是"提交前
          再便宜地复核一次", **写在本地**, TOCTOU 依旧, 只是窗口更小; 真正闭合只有提交后
          补偿事务 (撤销本地已读 + 取消/覆盖可能已派发的 Notion intent, 而"覆盖"就是
          Sprint15 死循环那条出向路径, 补偿本身又有自身竞态) —— 对一个默认关的便利功能
          不成比例。用户侧兜底: 在 Outlook 重新标未读一次即可。

        只做未读→已读单向 (已读→未读 / \\Flagged 不碰), 只收件箱; 任何异常仅 warning 不阻塞。
        绝不挂 5s radar poll: 独立低频周期 (interval env), 避免 UID SEARCH 重现 EWS 全量枚举
        限流 (issue #46)。AppleScript fallback 无这两个方法 → 整段 noop。
        SQLite 侧的查询与收敛事务全部 ``asyncio.to_thread`` 出去 —— 锁等待发生在工作线程,
        不冻住 event loop (与 SEARCH/FETCH 走 backend-io 队列同理)。
        """
        # flag 门 (默认 false → 字节级 inert, 不发 SEARCH、不改任何行)
        if not getattr(settings, "inbound_read_reconcile_enabled", False):
            return
        backend = self.backend
        # davmail-only: AppleScript backend 无这两个方法 → noop (应急回切也安全)。
        # 定向复核缺席时**整段不激活** —— 没有 FETCH 判据就只能靠 SEARCH 缺席猜,
        # 那正是会误标归档邮件的不安全形态。
        if not (hasattr(backend, "search_inbox_unseen")
                and hasattr(backend, "fetch_inbox_seen_flags")):
            return

        # 独立低频节拍: 距上次收敛不足 interval → 本轮跳过 (与 5s radar poll 解耦)。
        # 失败也推进游标 (下 interval 再试), 不在失败时高频重试打限流。
        nw = _watcher_mod()
        interval = max(1, int(getattr(settings, "inbound_read_reconcile_interval_sec", 300)))
        now = nw.time.monotonic()
        last = self._last_inbound_read_reconcile_at
        if last is not None and (now - last) < interval:
            return
        self._last_inbound_read_reconcile_at = now

        try:
            # 走 backend-io 单线程队列: SELECT+SEARCH 在大邮箱可能数分钟 (issue #46),
            # 直接在事件循环里跑会连带冻住 fanout / reverse / island 所有 worker 的 tick。
            result = await run_backend_io(backend.search_inbox_unseen)
        except Exception as e:
            logger.warning(f"[read-reconcile] search_inbox_unseen failed (skip cycle): {e}")
            return
        if result is None:
            logger.debug("[read-reconcile] server UNSEEN unavailable, skip this cycle")
            return
        server_uv, server_unseen, min_visible_uid = result

        try:
            # to_thread: 全表 is_read=0 扫描在大邮箱不是 O(1), 别占着事件循环线程跑
            rows = await asyncio.to_thread(
                self.sync_store.get_inbox_unread_for_read_reconcile, INBOX_LABEL
            )
        except Exception as e:
            logger.warning(f"[read-reconcile] local unread query failed (skip cycle): {e}")
            return
        if not rows:
            return

        # 候选筛选: 只是"值得复核"的集合, **不是**判定结果 —— 判定在下面的定向 FETCH。
        # 用 list 而非 uid→id 字典: 幽灵重复行可能共享同一 imap_uid, 字典会静默丢掉一封。
        # updated_at 一并带着: 提交时的 CAS 要用它认出"本轮期间这行被别处写过"。
        candidates: List[tuple] = []             # [(imap_uid, internal_id, updated_at)]
        for row in rows:
            imap_uid = row.get("imap_uid")
            row_uv = row.get("imap_uidvalidity")
            # (c) uidvalidity 一致性闸: imap_uid/uv 缺失 (AppleScript 行) 或与服务器
            # 当前 uv 不一致 → 该 imap_uid 已失效, 跳过 (不拿失效 uid 去匹配)。
            if imap_uid is None or row_uv is None or int(row_uv) != int(server_uv):
                continue
            # (c2) 截断窗口下界闸: davmail.folderSizeLimit 让 IMAP 视图只剩最近 N 封,
            # 窗口外的老邮件在 UNSEEN 里**必然缺席** —— 缺席 ≠ 已读, 少了这道闸会把
            # 真未读老邮件批量误标已读 (见 backend._lowest_visible_uid)。
            if int(imap_uid) < int(min_visible_uid):
                continue
            # 服务器仍未读 → 真未读, 连候选都不是
            if int(imap_uid) in server_unseen:
                continue
            candidates.append((int(imap_uid), row["internal_id"], row.get("updated_at")))
        if not candidates:
            return
        # uid 升序: 分块边界确定 (便于排查/测试), 定向 FETCH 的 uid set 也更紧凑
        candidates.sort(key=lambda c: c[0])

        from src.sync.outbox import OutboxRepository

        outbox = OutboxRepository(str(self.sync_store.db_path))
        converged_ids: List[int] = []
        stats = {
            "gone": 0,        # 已不在 INBOX (归档/删除/规则搬走/UID 空洞)
            "unread": 0,      # 服务器仍未读 (SEARCH 快照期间又被标未读)
            "busy": 0,        # 事务内被闸住: 在途 intent, 或本轮期间该行被别处写过
            "locked": 0,      # 短 busy timeout 内没拿到 SQLite 写锁 → 让路
            "lock_abort": False,
            "abort_reason": "",   # 'lock_timeout' | 'time_budget' (日志要能分辨)
        }
        # 🔴 定向复核 (codex BLOCK 1/2 的统一解): 对候选 uid 拉 (UID FLAGS), 把"耗时可能
        # 数分钟的全局 SEARCH 快照"降级为候选筛选, 最终判据以这一步为准。
        # 🔴 按 chunk「复核 → 立即收敛 → 下一 chunk」: 复核与提交之间的外部竞态 (用户在
        # Outlook 标回未读, 此刻无本地写可拦) 无法彻底消除, 只能把窗口收窄到单 chunk 的
        # 本地事务时长 —— 一次性复核全部候选再逐封收敛会把它拉成整批处理时长 (见 docstring)。
        for start in range(0, len(candidates), nw.READ_RECONCILE_CONVERGE_CHUNK):
            chunk = candidates[start:start + nw.READ_RECONCILE_CONVERGE_CHUNK]
            try:
                verified = await run_backend_io(backend.fetch_inbox_seen_flags,
                                                sorted({u for u, _, _ in chunk}))
            except Exception as e:
                logger.warning(f"[read-reconcile] flags verify failed (stop cycle): {e}")
                break
            if verified is None:
                logger.debug("[read-reconcile] flags verify unavailable, stop cycle")
                break
            verify_uv, seen_map = verified
            if int(verify_uv) != int(server_uv):
                # 两次会话之间 UIDVALIDITY 变了 → 剩余候选的 uid 全部失效, 停止本轮
                logger.warning(
                    f"[read-reconcile] UIDVALIDITY changed mid-cycle "
                    f"({server_uv}→{verify_uv}), stop cycle"
                )
                break
            # to_thread: 收敛是同步 SQLite 事务, 锁等待必须发生在工作线程 —— 直接在
            # 事件循环里跑, 别的进程持写锁时会把整个 watcher loop 拖住 (每封都可能等)。
            converged_ids.extend(
                await asyncio.to_thread(
                    self._converge_read_chunk_blocking, outbox, chunk, seen_map, stats
                )
            )
            if stats["lock_abort"]:
                if stats["abort_reason"] == "time_budget":
                    cause = (
                        f"单 chunk 收敛累计耗时超过 {nw.READ_RECONCILE_CHUNK_BUDGET_SEC}s "
                        f"(写锁竞争: 每封都拿到了锁, 但每封都等了很久)"
                    )
                else:
                    cause = (
                        f"有候选在 {nw.READ_RECONCILE_LOCK_TIMEOUT_SEC}s 内没拿到 SQLite 写锁 "
                        f"(写锁竞争)"
                    )
                logger.warning(
                    f"[read-reconcile] {cause}, 本轮提前终止以免消费陈旧的 FETCH 快照; "
                    f"已提交的不回滚, 被跳过的下个周期重新复核重判"
                )
                break
        if stats["gone"] or stats["unread"] or stats["busy"] or stats["locked"]:
            logger.debug(
                f"[read-reconcile] skipped {stats['gone']} 已移出 INBOX / "
                f"{stats['unread']} 服务器仍未读 / {stats['busy']} 在途或并发写 / "
                f"{stats['locked']} 写锁竞争 (候选 {len(candidates)})"
            )
        if converged_ids:
            logger.info(
                f"[read-reconcile] converged {len(converged_ids)} inbox 邮件 未读→已读 "
                f"(outbox→notion, server_uv={server_uv})"
            )
            # 让前端刷新列表 + 未读徽标 + **已打开的详情**。整轮只发一条 (不按封刷屏),
            # 但携带有界的 internal_ids 让前端能失效对应的 ['email', id] detail cache ——
            # 少了它, 列表显示已读而详情 toolbar 仍显示未读 (codex BLOCK 4)。超过上限时
            # ids_truncated=True, 前端据此失效所有活跃 detail。
            # 本地-only 模式 (无 Notion 页) 下这是**唯一**的刷新信号 (notion_fanout
            # 的 email.flag_changed 在 page_id 为空时 noop 不发)。
            try:
                from src.events.publisher import safe_publish
                safe_publish(
                    "email.flag_changed",
                    internal_id=None,
                    data={
                        "target": "local",
                        "converged": len(converged_ids),
                        "reason": "inbound_read_reconcile",
                        "internal_ids": converged_ids[:nw.READ_RECONCILE_EVENT_ID_CAP],
                        "ids_truncated": len(converged_ids) > nw.READ_RECONCILE_EVENT_ID_CAP,
                    },
                    source="read_reconcile",
                )
            except Exception:
                pass

    def _converge_read_chunk_blocking(
        self,
        outbox,
        chunk: List[tuple],
        seen_map: Dict[int, bool],
        stats: Dict[str, Any],
    ) -> List[int]:
        """一个 chunk 的收敛 —— **同步阻塞**, 由 ``_reconcile_inbound_read`` 经
        ``asyncio.to_thread`` 在工作线程里跑, 返回本 chunk 真正收敛的 internal_ids。

        为什么必须离开事件循环: 事务本身无网络 I/O、无内在死锁顺序, 但 SQLite 写锁的
        **等待**是同步阻塞 —— 另一进程 (serve-api / CLI / fanout) 持写锁时, 每封候选
        都可能在这里干等, 多封可重复发生, 把 watcher 的 event loop 整个卡住。

        ``stats`` 就地累加各跳过原因; 两种情况会置 ``stats['lock_abort']=True`` 并提前
        返回 (由调用方停掉后续 chunk, ``stats['abort_reason']`` 区分两者):
        ``lock_timeout`` = **第一封**等满 busy timeout 仍没拿到锁;
        ``time_budget``  = 本 chunk 收敛累计耗时超过 READ_RECONCILE_CHUNK_BUDGET_SEC
        (每封都拿到了锁、但每封都等很久 —— 一次 ConvergeLockBusy 都不抛的那种竞争)。
        两者语义相同: 等锁 = 手里的 seen_map 在变旧, 让路比硬等更保守。
        已提交的前序封不回滚 —— 与 chunk 级失败 break 的既有语义一致, 收敛本身幂等。
        """
        from src.sync.outbox_intents import ConvergeLockBusy, converge_local_read_atomic

        nw = _watcher_mod()
        converged: List[int] = []
        started = nw.time.monotonic()
        for imap_uid, internal_id, snapshot_updated_at in chunk:
            seen = seen_map.get(imap_uid)
            if seen is None:
                stats["gone"] += 1
                continue
            if not seen:
                stats["unread"] += 1
                continue
            # 累计耗时预算 (在开一笔新事务**之前**判, 不做已知会迟到的提交): 每封都在
            # busy timeout 之前拿到锁时 ConvergeLockBusy 永远不抛, 但 seen_map 照样在
            # 变旧 —— 这道闸把陈旧窗口钉在常数量级, 不随 chunk 长度膨胀。跳过与被闸住的
            # 封不花时间, 故正常路径 (毫秒级) 永远碰不到它。
            if nw.time.monotonic() - started > nw.READ_RECONCILE_CHUNK_BUDGET_SEC:
                stats["lock_abort"] = True
                stats["abort_reason"] = "time_budget"
                logger.debug(
                    f"[read-reconcile] 本 chunk 收敛累计超 {nw.READ_RECONCILE_CHUNK_BUDGET_SEC}s "
                    f"(锁竞争但每封都拿到了锁), 从 {internal_id} 起终止本轮, 下轮重判"
                )
                break
            # (a)+(b) 在途 intent 复核 + 本地 CAS 置已读 + notion 入队, 同一事务内完成:
            # 任一步不成立就整体回滚, 不会留下"本地已读但 Notion intent 缺失"的半提交
            # (那种半提交下轮不再进候选 → 永久漏 Notion 收敛)。
            try:
                ok = converge_local_read_atomic(
                    self.sync_store,
                    outbox,
                    internal_id,
                    expected_updated_at=snapshot_updated_at,
                    notion_payload={"is_read": True},
                    source="read_reconcile",
                    busy_timeout_sec=nw.READ_RECONCILE_LOCK_TIMEOUT_SEC,
                )
            except ConvergeLockBusy:
                # 保守让路 + 立即终止本轮: 等过锁就说明这份 seen_map 已经旧了, 剩下的封
                # 下个 interval 会重新 FETCH 取新鲜真值再判 (收敛幂等, 不丢状态)。
                stats["locked"] += 1
                stats["lock_abort"] = True
                stats["abort_reason"] = "lock_timeout"
                logger.debug(
                    f"[read-reconcile] {internal_id} 写锁竞争 "
                    f"({nw.READ_RECONCILE_LOCK_TIMEOUT_SEC}s 未获锁), 终止本轮, 下轮重判"
                )
                break
            except Exception as e:
                logger.warning(f"[read-reconcile] converge failed for {internal_id}: {e}")
                continue
            if ok:
                converged.append(internal_id)
            else:
                # 静默跳过会让"为什么这封没收敛"无从排查 —— 事务内的两道闸
                # (在途 intent / CAS 快照失配) 各自留一条可追溯的 debug 行。
                stats["busy"] += 1
                logger.debug(
                    f"[read-reconcile] {internal_id} 本轮被闸住 (在途 flag_sync "
                    f"intent 或期间被别处写过), 下轮重判"
                )
        return converged

    async def _process_kos_retry_queue(self) -> None:
        """6c: KOS 入库失败重试 (issue #59, MAILAGENT_KOS_RETRY_ENABLED 默认开)。

        生产实测 (2026-07-24): KOS 卡死 35 分钟 → producer 推送全部失败且 fire-and-
        forget 直接丢弃 → 101 封邮件 KOS 侧永久空洞 (+69 条图谱边挂不上), 只能手动
        bulk_ingest 找回。台账 (kos_ingest_log, v41) 落地后, 这里对 status='failed'
        且到期 (next_retry_at <= now) 的行做队列驱动补偿。

        形状**镜像 6b _process_llm_retry_queue** (llm_processing 是逐字对应的现成
        模板): 每 tick 一次轻量 SQLite 队列探测, 空即返; 有到期行才处理, 上限
        KOS_RETRY_BATCH_PER_TICK=3 (≈0.6/s, 与 KOS 50 req/15min 限流天然匹配;
        101 封积压约 3 分钟排干)。不新起 worker、不进 supervise 心跳。
        与 6b 的两点差异 (KOS 是外部服务, LLM 是本地):
          - R4 前置健康探活: 不可用 → 本 tick 整体跳过、不逐封试 (故障期逐封重试
            会把每行 retry_count 白烧到上限转 dead, 等于重试机制自废), 并进入
            kos_retry_interval_sec (默认 300s) 冷却 —— 不必每个 5s tick 都对着
            倒掉的 KOS 探活。探活结果落 sync_state kos.health.*。
          - 超限终态是台账自己的 'dead' (kos_ingest_log 内, 由 record_failure 判),
            与 email_outbox 的 dead_letter 告警体系完全解耦 (镜像 llm 的 gave_up
            不触发死信告警的纪律)。

        MAILAGENT_KOS_INGEST_ENABLED=false 时整段不激活 (链路字节级 inert)。
        SQLite 读与探活/重推的网络调用全部 to_thread / 已在 producer 内 to_thread。
        """
        if not getattr(settings, "mailagent_kos_ingest_enabled", False):
            return
        # 默认开 (D1 有意偏离"新功能默认关"惯例): 重试是纯补偿, 只重推本该推、且已
        # 因 put_page 覆盖写幂等的内容; ingest 总闸关着时整段不激活, 灰度价值≈0。
        if not getattr(settings, "kos_retry_enabled", True):
            return
        # 不健康冷却: 上次探活失败后 interval 内直接跳过 (连队列探测都省)
        nw = _watcher_mod()
        now = nw.time.monotonic()
        if self._kos_unhealthy_until is not None and now < self._kos_unhealthy_until:
            return

        from src.kos import ingest_log
        from src.kos.producer import (
            llm_labels_settled,
            make_bulk_kos_client,
            repush_stored_email_to_kos,
        )

        db_path = str(self.sync_store.db_path)
        batch_limit = nw.KOS_RETRY_BATCH_PER_TICK
        try:
            ready = await asyncio.to_thread(
                ingest_log.claim_due_retries, db_path, batch_limit
            )
            due_deferred = await asyncio.to_thread(
                ingest_log.claim_due_deferred, db_path, batch_limit
            )
        except Exception as e:  # noqa: BLE001 — 补偿层, 绝不炸 watcher (镜像 6b)
            logger.warning(f"[kos-retry] queue probe failed: {e}")
            return
        if not ready and not due_deferred:
            return

        # deferred (等 LLM 标签) 行的就绪判定 —— 纯本地 SQLite, 不需要 client/探活。
        # 就绪 = llm_processing 终态 (success/gave_up) 或等待轮数达 DEFER_MAX_CHECKS
        # 兜底 (LLM dispatch 失败的孤例不能永久卡队); 未就绪 → bump 下轮再看
        # (retry_count 在 pending 行上 = 已检查轮数)。issue #64 Lane A。
        ready_deferred: List[int] = []
        if due_deferred:
            def _classify_deferred() -> List[int]:
                out: List[int] = []
                for iid, checks in due_deferred:
                    if (llm_labels_settled(db_path, iid)
                            or checks >= ingest_log.DEFER_MAX_CHECKS):
                        out.append(iid)
                    else:
                        ingest_log.bump_deferred(db_path, iid)
                return out

            try:
                ready_deferred = await asyncio.to_thread(_classify_deferred)
            except Exception as e:  # noqa: BLE001
                logger.warning(f"[kos-retry] deferred classify failed: {e}")
        if not ready and not ready_deferred:
            return  # 本 tick 全是等标签 bump, 无网络工作 (不探活)
        client = make_bulk_kos_client()
        if not client.configured:
            logger.debug("[kos-retry] bulk client not configured, skip")
            return

        # R4 健康探活 (只在有到期行时发, 不给 KOS 发无谓请求)
        health_err = ""
        try:
            h = await asyncio.to_thread(client.health)
            healthy = isinstance(h, dict) and h.get("status") == "ok"
            if not healthy:
                health_err = f"health status={h.get('status') if isinstance(h, dict) else h!r}"
        except Exception as e:  # noqa: BLE001 — 探活失败 = 不健康, 不上抛
            healthy = False
            health_err = str(e)
        try:
            recovered = await asyncio.to_thread(
                ingest_log.record_health, db_path, healthy, health_err
            )
        except Exception as e:  # noqa: BLE001
            logger.warning(f"[kos-retry] record_health failed: {e}")
            recovered = False
        if not healthy:
            cooldown = max(1, int(getattr(settings, "kos_retry_interval_sec", 300)))
            self._kos_unhealthy_until = now + cooldown
            logger.warning(
                f"[kos-retry] KOS 不可用 ({health_err}), 跳过并冷却 {cooldown}s "
                f"(到期 {len(ready) + len(ready_deferred)} 封原地等待, "
                f"retry_count 不增长)"
            )
            return
        if recovered:
            logger.info("[kos-retry] KOS 已恢复, 积压将按 tick 逐批补偿")

        priority_floor = getattr(settings, "kos_ingest_priority_floor", "normal")
        require_labeled = bool(getattr(settings, "kos_require_labeled", False))
        logger.info(
            f"[kos-retry] processing {len(ready)} failed retry + "
            f"{len(ready_deferred)} label-ready deferred push(es)"
        )
        for iid in [*ready, *ready_deferred]:
            outcome = await repush_stored_email_to_kos(
                db_path, iid, client=client,
                priority_floor=priority_floor, require_labeled=require_labeled,
            )
            if outcome.failed:
                # 台账已按退避重排 / 转 dead; 本 tick 剩余的照常试 (batch 只有 3,
                # 真是 KOS 又倒了的话, 下个 tick 的探活会拦住并进入冷却)。
                logger.debug(
                    f"[kos-retry] internal_id={iid} still failing "
                    f"code={outcome.error_code}"
                )

    # sync_state 键 (镜像 davmail.* / kos.* 先例, **不进 DB_VERSION**)
    _RECONCILE_LAST_COMPLETE_KEY = "inbox_reconcile.last_complete_at"
    _RECONCILE_TRUNCATED_KEY = "inbox_reconcile.window_truncated_total"
    _RECONCILE_OLDEST_VISIBLE_KEY = "inbox_reconcile.oldest_visible_date"
    _RECONCILE_RECOVERED_KEY = "inbox_reconcile.recovered_total"
    _RECONCILE_LAST_RUN_KEY = "inbox_reconcile.last_run_at"

    async def _reconcile_inbox(self):
        """收件箱对账兜底 (2026-08-11 丢邮件事故 · 方案 C, davmail-only, 默认关)。

        增量 marker 依赖"UID 单调递增", 而 davmail/EWS 上该假设不完全成立
        (实测 32% 的行 uid 与服务器现值不符)。本对账**与漏抓成因无关**: 直接按
        Message-ID 比对服务器与本地, 补回任何原因漏掉的邮件。

        🔴 **绝不挂 5s radar poll** —— UID SEARCH 在大邮箱会重现 EWS 全量枚举限流
        (issue #46), 故独立低频节拍 (默认 1800s)。
        🔴 **只补不删** (见 backend.reconcile_inbox docstring)。

        补抓的行走 ``save_email(pending)`` 进主链路, 与正常新邮件同路: 由
        ``_process_pending_emails`` 抓正文 → Notion / LLM / FTS / KOS 全套。
        唯一差别是 ``ingest_reason='inbox_reconcile'``, 供飞书通知门控用
        (见 ``_suppress_reconcile_notify``)。
        """
        if not getattr(settings, "inbox_reconcile_enabled", False):
            return                          # flag off: 字节级 inert, 零 IMAP 命令
        backend = self.backend
        if not hasattr(backend, "reconcile_inbox"):
            return                          # AppleScript fallback: 整段不激活

        interval = max(60, int(getattr(settings, "inbox_reconcile_interval_sec", 1800)))
        now = _watcher_mod().time.monotonic()
        last = self._last_inbox_reconcile_at
        if last is not None and (now - last) < interval:
            return
        self._last_inbox_reconcile_at = now

        window_days = max(1, int(getattr(settings, "inbox_reconcile_window_days", 2)))
        try:
            # backend-io 单线程队列: SEARCH+FETCH 可能数十秒, 不能占着 event loop
            # (会连带冻住 fanout / reverse / island 所有 worker 的 tick)。
            result = await run_backend_io(backend.reconcile_inbox, window_days)
        except Exception as e:
            logger.warning(f"[inbox-reconcile] failed (skip cycle): {e}")
            return

        try:
            self.sync_store.set_state(
                self._RECONCILE_LAST_RUN_KEY, datetime.now().isoformat()
            )
            if result.oldest_visible_iso:
                self.sync_store.set_state(
                    self._RECONCILE_OLDEST_VISIBLE_KEY, result.oldest_visible_iso
                )
        except Exception:
            pass

        if result.status == "skipped":
            logger.info(f"[inbox-reconcile] skipped: {result.reason}")
            return

        if result.status == "incomplete":
            # 🔴 容量不足 / 长时间停摆: 窗口被 folderSizeLimit 截断视图打断,
            # 窗口更老那段在 IMAP 层不可见 ⇒ 缺什么都判断不出来。补抓照做,
            # 但**不能**记成一次成功对账, 否则"看起来有兜底"比没有更危险。
            try:
                n = int(
                    self.sync_store.get_state(self._RECONCILE_TRUNCATED_KEY) or 0
                ) + 1
                self.sync_store.set_state(self._RECONCILE_TRUNCATED_KEY, str(n))
            except Exception:
                pass
            logger.warning(
                f"[inbox-reconcile] 窗口未被完整覆盖 (incomplete): 视图最老一封 "
                f"{result.oldest_visible_iso} 晚于窗口起点 {result.window_floor_iso} "
                f"—— folderSizeLimit 截断视图装不下 {window_days} 天。"
                f"调小 MAILAGENT_INBOX_RECONCILE_WINDOW_DAYS 或调大 "
                f"DAVMAIL_FOLDER_SIZE_LIMIT; 本轮补抓照做但不算「查全」。"
            )
        else:
            try:
                self.sync_store.set_state(
                    self._RECONCILE_LAST_COMPLETE_KEY, datetime.now().isoformat()
                )
            except Exception:
                pass

        if result.empty_msgid or result.duplicate_msgid:
            logger.warning(
                f"[inbox-reconcile] 异常 Message-ID: 空 {result.empty_msgid} 封 / "
                f"远端重复 {result.duplicate_msgid} 封 (重复的已跳过 —— 当前 schema 的 "
                f"message_id UNIQUE 表达不了两封物理邮件共用一个 ID)"
            )

        if not result.missing:
            logger.debug(
                f"[inbox-reconcile] {result.status}: 远端 {result.remote_total} 封, "
                f"本地无缺失"
            )
            return

        saved = 0
        merged = 0
        saved_rows: List[tuple] = []
        for meta in result.missing:
            payload = {
                "internal_id": meta["internal_id"],
                "message_id": meta.get("message_id"),
                "subject": meta.get("subject", ""),
                "sender": meta.get("sender") or meta.get("sender_email", ""),
                "sender_name": meta.get("sender_name", ""),
                "date_received": meta.get("date_received", ""),
                "mailbox": meta.get("mailbox", INBOX_LABEL),
                "is_read": meta.get("is_read", False),
                "is_flagged": meta.get("is_flagged", False),
                "thread_id": meta.get("thread_id"),
                "sync_status": "pending",
                "backend_origin": "davmail",
                "ingest_reason": "inbox_reconcile",
            }
            if meta.get("imap_uid") is not None:
                payload["imap_uid"] = meta["imap_uid"]
            if meta.get("imap_uidvalidity") is not None:
                payload["imap_uidvalidity"] = meta["imap_uidvalidity"]
            try:
                if self.sync_store.save_email(payload):
                    # 🔴 save_email 只返回 bool, 分不清「新建行」与「merge 进已有行」——
                    # merge guard 命中时新分配的 internal_id **不会存在于库中**。
                    # 用它回查区分, 否则边界误判 (远端 Date header 与 INTERNALDATE 不同口径)
                    # 造成的重复"补抓"会被虚假累计成 recovered, 让这个数字失去意义。
                    if self.sync_store.get(meta["internal_id"]) is not None:
                        saved += 1
                        saved_rows.append(
                            (meta["internal_id"], payload["mailbox"])
                        )
                    else:
                        merged += 1
                else:
                    logger.error(
                        f"[inbox-reconcile] save_email failed for "
                        f"uid={meta.get('imap_uid')} msgid={meta.get('message_id')!r}"
                    )
            except Exception as e:
                logger.error(f"[inbox-reconcile] save_email raised: {e}")

        if saved:
            # 补回的行同样即时广播 (来源标记 inbox-reconcile, 一轮聚合一条不刷屏)。
            _publish_email_new(saved_rows, source="inbox-reconcile")
            try:
                total = int(
                    self.sync_store.get_state(self._RECONCILE_RECOVERED_KEY) or 0
                ) + saved
                self.sync_store.set_state(self._RECONCILE_RECOVERED_KEY, str(total))
            except Exception:
                pass
        if saved:
            logger.warning(
                f"[inbox-reconcile] 补回 {saved} 封增量链路漏掉的邮件 "
                f"(status={result.status}, 候选 {len(result.missing)} / 远端 "
                f"{result.remote_total} 封, 其中 {merged} 封 merge 进已有行不计)。"
                f"漏抓不该发生 —— 若持续出现请查增量 marker 语义与 IMAP 协议失败日志。"
            )
        elif merged:
            # 全部 merge = 没有真漏, 只是判据边界把已有行当成了候选。info 不告警。
            logger.info(
                f"[inbox-reconcile] {merged} 封候选全部 merge 进已有行 (无真实缺失)"
            )

    _EMPTY_GAP_TOTAL_KEY = "sync.empty_fetch_gap.total"
    _EMPTY_GAP_LAST_KEY = "sync.empty_fetch_gap.last_at"
    _EMPTY_GAP_LAST_WINDOW_KEY = "sync.empty_fetch_gap.last_window"

    def _record_empty_fetch_gap(
        self, last_max_row_id: int, current_max: int, estimated_count: int
    ) -> None:
        """STATUS 说有新邮件、SEARCH/FETCH 一封没取到 —— 留痕 (B2)。

        🔴 这个落差**曾经是完全静默的**, 而 2026-08-11 那三封丢失邮件的现场就长这样
        (日志里只有 ``Detected ~1 new emails``, 没有任何后续)。落差本身多数良性
        (UIDNEXT 会被删信等推高, SEARCH 无匹配是正常的), 所以**不告警、不阻断**,
        只记 warning + 累计计数, 让"静默"变成"可查"。

        真正守住游标的是 B1′ (FolderFetchError) 与 save_failed, 不是这里。
        """
        try:
            total = int(self.sync_store.get_state(self._EMPTY_GAP_TOTAL_KEY) or 0) + 1
            self.sync_store.set_state(self._EMPTY_GAP_TOTAL_KEY, str(total))
            self.sync_store.set_state(
                self._EMPTY_GAP_LAST_KEY, datetime.now().isoformat()
            )
            self.sync_store.set_state(
                self._EMPTY_GAP_LAST_WINDOW_KEY, f"({last_max_row_id}, {current_max}]"
            )
        except Exception as e:      # 留痕失败绝不能拖垮 poll
            logger.debug(f"[watcher] empty-fetch-gap bookkeeping failed: {e}")
            total = -1
        logger.warning(
            f"[watcher] STATUS 报告 ~{estimated_count} 封新邮件, 但窗口 "
            f"({last_max_row_id}, {current_max}] 一封都没取到 (OK+空结果, 游标照常推进; "
            f"累计 {total} 次). 多为 UIDNEXT 高估(删信等), 若持续出现且伴随丢信请查 "
            f"UID SEARCH 语义与 folderSizeLimit 截断窗口."
        )

    async def _reconcile_drafts(self):
        """草稿箱对账 (davmail-only, DRAFTS_SYNC_ENABLED)。

        backend.reconcile_drafts() 全量 UID 对账（草稿会被编辑/发送/删除，增量 marker
        只见新增不见消失）：新草稿 save_email(pending) 进主链路（_sync_single_email_v3
        的草稿分支只落本地，不进 Notion / LLM / 飞书）；已消失草稿走
        email_repo.delete_email_full（CASCADE 清 body / 附件 / FTS）。
        AppleScript fallback 模式无此方法 → 整段 noop。任何失败不影响主循环。
        """
        backend = self.backend
        if not hasattr(backend, "reconcile_drafts"):
            return
        try:
            to_add, to_delete = backend.reconcile_drafts()
        except Exception as e:
            logger.warning(f"[drafts] reconcile failed (main loop unaffected): {e}")
            return

        added_draft_rows: List[tuple] = []
        for email_meta in to_add:
            internal_id = email_meta.get('internal_id')
            try:
                if self.sync_store.get(internal_id):
                    continue
                payload = {
                    'internal_id': internal_id,
                    'message_id': email_meta.get('message_id'),
                    'subject': email_meta.get('subject', ''),
                    'sender': (
                        email_meta.get('sender')
                        or email_meta.get('sender_email', '')
                    ),
                    'sender_name': email_meta.get('sender_name', ''),
                    'date_received': email_meta.get('date_received', ''),
                    'mailbox': email_meta.get('mailbox', '草稿箱'),
                    # 草稿是自己写的，FLAGS 缺失时按已读处理（不该凸显未读）
                    'is_read': email_meta.get('is_read', True),
                    'is_flagged': email_meta.get('is_flagged', False),
                    'thread_id': email_meta.get('thread_id'),
                    'sync_status': 'pending',
                    'backend_origin': email_meta.get('backend_origin') or 'davmail',
                }
                if email_meta.get('imap_uid') is not None:
                    payload['imap_uid'] = email_meta.get('imap_uid')
                if email_meta.get('imap_uidvalidity') is not None:
                    payload['imap_uidvalidity'] = email_meta.get('imap_uidvalidity')
                # 草稿线程 linkage 透传 (D1 Bug A, reconcile_drafts 已解析/反查)
                for key in (
                    'draft_source_internal_id',
                    'draft_in_reply_to',
                    'draft_references',
                ):
                    if email_meta.get(key) is not None:
                        payload[key] = email_meta.get(key)
                self.sync_store.save_email(payload)
                added_draft_rows.append((internal_id, payload['mailbox']))
                logger.debug(f"[drafts] added draft {internal_id} (pending)")
            except Exception as e:
                logger.warning(f"[drafts] save new draft {internal_id} failed: {e}")
        # 新草稿同样即时广播 (草稿箱列表/badge 不再等下一轮兜底轮询)。
        _publish_email_new(added_draft_rows, source="drafts-reconcile")

        for internal_id in to_delete:
            try:
                # 防御 (纵深): 删前复核该行是否仍是草稿。若已被 sync_store 的
                # Draft→Sent 提升为发件箱 (外部从草稿发送), 就不是"消失草稿"而是
                # 已发邮件 → 删了就丢数据。reconcile 是同步、与 merge 不交错, 正常
                # 路径 merge 先提升 mailbox 使其不进 to_delete; 这里兜底顺序竞态。
                row = self.sync_store.get(internal_id)
                if row is not None and row.get('mailbox') not in DRAFT_MAILBOX_LABELS:
                    logger.info(
                        f"[drafts] skip delete {internal_id}: mailbox="
                        f"{row.get('mailbox')!r} (promoted, sent from draft)"
                    )
                    continue
                self.email_repo.delete_email_full(internal_id)
                logger.info(f"[drafts] deleted vanished draft {internal_id}")
                # 让前端刷新列表/badge（events_bridge 对 email.synced 宽 invalidate）
                try:
                    from src.events.publisher import safe_publish
                    safe_publish(
                        "email.synced",
                        internal_id=internal_id,
                        data={"deleted": True},
                        source="new_watcher",
                    )
                except Exception:
                    pass
            except Exception as e:
                logger.warning(f"[drafts] delete draft {internal_id} failed: {e}")
