"""Recipient autocomplete / contact suggestion mixin for EmailRepository."""

from __future__ import annotations

import json
import re
import threading
import time
from datetime import datetime
from typing import Optional

from loguru import logger

from src.mail.mailbox_semantics import is_sent_mailbox
from src.repository.email_models import ContactSuggestion, _ContactCandidate

_CONTACT_CACHE_TTL_SECONDS = 10 * 60
_CONTACT_SUGGEST_CACHE: dict[str, tuple[float, list["_ContactCandidate"]]] = {}
_CONTACT_CACHE_LOCK = threading.Lock()
_CONTACT_BUILD_LOCKS: dict[str, threading.Lock] = {}
_CONTACT_REFRESHING: set[str] = set()
# 合流结果的短 TTL (沿用 /chat/config 快照那档 15s): 通讯录是小表、改名要「几乎
# 立刻」在 compose 里生效, 不能跟着邮件头聚合那份 10 分钟缓存走; 但每次按键都重做
# 一遍 O(全部候选) 的合流也不必要。第三元 = 建这份合流用的历史 lane 列表本体 ——
# 历史缓存一被清 (测试 / TTL 到期重建) 身份就变, 合流缓存随之失效。
_CONTACT_DIRECTORY_TTL_SECONDS = 15
_CONTACT_MERGED_CACHE: dict[
    str, tuple[float, list["_ContactCandidate"], list["_ContactCandidate"]]
] = {}
# 通讯录 lane 的取数 (🔴 与 Electron main 的 handlers/contacts.ts `DIRECTORY_SQL`
# 逐字同款 —— 桌面走 IPC、远程 web 走 GET /api/email/contacts, 是同一产品行为的
# 两份实现, 两侧必须同步改, 否则两端补全语义劈叉)。
# 三类排除 (merged_into / hidden_at / is_self) 不在 WHERE 直接筛掉, 而是带回
# excluded 标位: 它们同时还要把**邮件头聚合出来的同一地址**压下去 (合并走的旧身份 /
# owner 隐藏掉的噪音 / 自己的历史别名都不该再进候选)。
_CONTACT_DIRECTORY_SQL = """SELECT c.display_name AS display_name,
       c.formal_name AS formal_name,
       c.organization AS organization,
       c.name_variants_json AS name_variants_json,
       ce.email_normalized AS email_normalized,
       ce.former_at AS former_at,
       CASE WHEN c.merged_into IS NOT NULL OR c.hidden_at IS NOT NULL
                 OR c.is_self = 1 THEN 1 ELSE 0 END AS excluded
  FROM contact c
  JOIN contact_email ce ON ce.contact_id = c.id"""
_CONTACT_NAME_TOKEN_RE = re.compile(r"[\s,.;:()\"'<>]+")
_CONTACT_LOCAL_TOKEN_RE = re.compile(r"[._%+-]+")
_EMAIL_RE = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.IGNORECASE)
_ANGLE_RE = re.compile(r"^(.*?)<([^>]+)>")


def _get_build_lock(cache_key: str) -> threading.Lock:
    with _CONTACT_CACHE_LOCK:
        lock = _CONTACT_BUILD_LOCKS.get(cache_key)
        if lock is None:
            lock = threading.Lock()
            _CONTACT_BUILD_LOCKS[cache_key] = lock
        return lock

def _normalize_contact_name(value: Optional[str]) -> Optional[str]:
    trimmed = (value or "").strip().strip("\"'")
    return trimmed or None


def _contact_date_key(value: Optional[str]) -> float:
    if not value:
        return 0.0
    try:
        normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
        return datetime.fromisoformat(normalized).timestamp()
    except ValueError:
        return 0.0


def _parse_address_segment(segment: str) -> Optional[tuple[str, Optional[str]]]:
    if "@" not in segment:
        return None
    lt = segment.find("<")
    if lt != -1:
        gt = segment.find(">", lt + 1)
        if gt > lt + 1 and "\n" not in segment[:gt]:
            email_match = _EMAIL_RE.search(segment, lt + 1, gt)
            if not email_match:
                return None
            return email_match.group(0).lower(), _normalize_contact_name(segment[:lt])
        if "\n" in segment:
            angle = _ANGLE_RE.match(segment)
            if angle:
                email_match = _EMAIL_RE.search(angle.group(2) or "")
                if not email_match:
                    return None
                return email_match.group(0).lower(), _normalize_contact_name(angle.group(1))

    email_match = _EMAIL_RE.search(segment)
    if not email_match:
        return None
    name = _normalize_contact_name(segment[:email_match.start()])
    return email_match.group(0).lower(), name


def _parse_address_list(value: Optional[str]) -> list[tuple[str, Optional[str]]]:
    if not value:
        return []
    items: list[tuple[str, Optional[str]]] = []
    for segment in value.split(","):
        parsed = _parse_address_segment(segment.strip())
        if parsed is not None:
            items.append(parsed)
    return items


def _normalize_exclude(exclude: Optional[str | list[str]]) -> set[str]:
    values = exclude if isinstance(exclude, list) else ([exclude] if exclude else [])
    result: set[str] = set()
    for value in values:
        for part in str(value).split(","):
            email = part.strip().lower()
            if email:
                result.add(email)
    return result


def _contact_prefix_match(item: "_ContactCandidate", q: str) -> bool:
    if not q:
        return False
    return any(token.startswith(q) for token in item.tokens)


def _contact_email_tokens(email: str) -> list[str]:
    local_part = email.split("@", 1)[0]
    return [t for t in [local_part, *_CONTACT_LOCAL_TOKEN_RE.split(local_part)] if t]


def _contact_name_tokens(value: Optional[str]) -> list[str]:
    lowered = (value or "").lower()
    if not lowered:
        return []
    return [t for t in _CONTACT_NAME_TOKEN_RE.split(lowered) if t]


def _push_contact_field(fields: list[str], value: Optional[str]) -> None:
    lowered = (value or "").strip().lower()
    if lowered:
        fields.append(lowered)


def _parse_name_variants(raw: Optional[str]) -> list[str]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return []
    if not isinstance(parsed, list):
        return []
    return [v for v in parsed if isinstance(v, str)]


def _history_candidate(item: ContactSuggestion) -> "_ContactCandidate":
    fields: list[str] = []
    _push_contact_field(fields, item.email)
    _push_contact_field(fields, item.name)
    return _ContactCandidate(
        email=item.email,
        name=item.name,
        score=item.score,
        last_seen=item.last_seen,
        last_seen_ts=_contact_date_key(item.last_seen),
        former=False,
        fields=fields,
        tokens=[
            *_contact_email_tokens(item.email),
            *_contact_name_tokens(item.name),
        ],
    )


def _build_contact_candidates(
    history: list["_ContactCandidate"],
    rows: list[dict],
) -> list["_ContactCandidate"]:
    """两条 lane 合流 (按归一 email 去重)。

    通讯录侧的 display_name / 组织 / 曾用地址覆盖邮件头猜出来的名字, 往来频度
    score 仍由历史 lane 提供 (通讯录里零往来的人 score=0)。
    """
    suppressed: set[str] = set()
    directory: list[dict] = []
    for row in rows:
        email = (row.get("email_normalized") or "").strip().lower()
        if not email:
            continue
        if row.get("excluded"):
            suppressed.add(email)
        else:
            directory.append(row)

    by_email: dict[str, _ContactCandidate] = {
        item.email: item for item in history if item.email not in suppressed
    }

    for row in directory:
        email = (row["email_normalized"] or "").strip().lower()
        prev = by_email.get(email)
        prev_name = prev.name if prev else None
        # 通讯录的名字优先; display_name 空则退 formal_name, 再退邮件头学到的名字。
        name = (
            _normalize_contact_name(row.get("display_name"))
            or _normalize_contact_name(row.get("formal_name"))
            or prev_name
        )
        variants = _parse_name_variants(row.get("name_variants_json"))

        # 可搜面 = 邮件头名字 (保留: 改名前的老叫法仍能搜到) + 通讯录四字段, 与
        # GET /api/contacts?q= 的口径一致 (display_name / formal_name / organization /
        # name_variants / email)。
        fields: list[str] = []
        _push_contact_field(fields, email)
        _push_contact_field(fields, prev_name)
        _push_contact_field(fields, row.get("display_name"))
        _push_contact_field(fields, row.get("formal_name"))
        _push_contact_field(fields, row.get("organization"))
        for variant in variants:
            _push_contact_field(fields, variant)

        tokens = [
            *_contact_email_tokens(email),
            *_contact_name_tokens(prev_name),
            *_contact_name_tokens(row.get("display_name")),
            *_contact_name_tokens(row.get("formal_name")),
            *_contact_name_tokens(row.get("organization")),
        ]
        for variant in variants:
            tokens.extend(_contact_name_tokens(variant))

        by_email[email] = _ContactCandidate(
            email=email,
            name=name,
            score=prev.score if prev else 0,
            last_seen=prev.last_seen if prev else None,
            last_seen_ts=prev.last_seen_ts if prev else 0.0,
            former=row.get("former_at") is not None,
            fields=fields,
            tokens=tokens,
            org=_normalize_contact_name(row.get("organization")),
        )

    return list(by_email.values())


class _EmailContactsMixin:
    """History + directory contact suggestion methods for EmailRepository."""

    def suggest_contacts(
        self,
        q: str = "",
        *,
        limit: int = 8,
        exclude: Optional[str | list[str]] = None,
    ) -> list[ContactSuggestion]:
        """compose 收件人自动补全候选 = 邮件头聚合 + 通讯录 (contact 三表) 合流。"""
        try:
            limit = min(max(int(limit), 1), 50)
        except (TypeError, ValueError):
            limit = 8
        query = (q or "").strip().lower()
        excluded = _normalize_exclude(exclude)

        items = [
            item
            for item in self._contact_candidates()
            if item.email.lower() not in excluded
        ]
        if query:
            items = [
                item
                for item in items
                if any(query in f for f in item.fields)
            ]

        ordered = sorted(
            items,
            key=lambda item: (
                # ① 强命中 (任一身份 token 前缀命中) 优先 —— 通讯录的名字/组织进了
                #    token 面, 所以「零往来但名字对得上」的人能排上来;
                # ② 曾用邮箱恒沉到主邮箱之后;
                # ③ 同档内仍按往来频度 score 排 —— 高频联系人不会被通讯录条目挤下去。
                0 if _contact_prefix_match(item, query) else 1,
                1 if item.former else 0,
                -item.score,
                -item.last_seen_ts,
                item.email,
            ),
        )[:limit]
        return [item.to_suggestion() for item in ordered]

    def _contact_candidates(self) -> list[_ContactCandidate]:
        """两条 lane 合流后的候选全集（短 TTL 缓存, 见 _CONTACT_MERGED_CACHE）。"""
        history = self._contact_corpus()
        cache_key = str(self.db_path.resolve())
        now = time.time()
        with _CONTACT_CACHE_LOCK:
            cached = _CONTACT_MERGED_CACHE.get(cache_key)
        if cached and cached[0] > now and cached[2] is history:
            return cached[1]
        items = _build_contact_candidates(history, self._contact_directory_rows())
        with _CONTACT_CACHE_LOCK:
            _CONTACT_MERGED_CACHE[cache_key] = (
                time.time() + _CONTACT_DIRECTORY_TTL_SECONDS,
                items,
                history,
            )
        return items

    def _schedule_corpus_refresh(
        self,
        cache_key: str,
        stale_entry: tuple[float, list[_ContactCandidate]],
    ) -> None:
        """Single-flight background refresh for stale contact corpus cache."""
        with _CONTACT_CACHE_LOCK:
            if cache_key in _CONTACT_REFRESHING:
                return
            _CONTACT_REFRESHING.add(cache_key)

        def _run() -> None:
            try:
                items = [
                    _history_candidate(item)
                    for item in self._aggregate_contact_suggestions()
                ]
                with _CONTACT_CACHE_LOCK:
                    if _CONTACT_SUGGEST_CACHE.get(cache_key) is stale_entry:
                        _CONTACT_SUGGEST_CACHE[cache_key] = (
                            time.time() + _CONTACT_CACHE_TTL_SECONDS,
                            items,
                        )
            except Exception as e:
                logger.warning(f"suggest_contacts: background refresh failed: {e}")
            finally:
                with _CONTACT_CACHE_LOCK:
                    _CONTACT_REFRESHING.discard(cache_key)

        threading.Thread(
            target=_run,
            name="mailagent-contact-corpus-refresh",
            daemon=True,
        ).start()

    def _contact_corpus(self) -> list[_ContactCandidate]:
        """邮件头聚合 lane (全表扫 email_metadata, 贵) → 10 分钟缓存 + stale-while-revalidate。"""
        cache_key = str(self.db_path.resolve())
        now = time.time()
        with _CONTACT_CACHE_LOCK:
            cached = _CONTACT_SUGGEST_CACHE.get(cache_key)
        if cached is not None:
            if cached[0] > now:
                return cached[1]
            self._schedule_corpus_refresh(cache_key, cached)
            return cached[1]

        with _get_build_lock(cache_key):
            with _CONTACT_CACHE_LOCK:
                cached = _CONTACT_SUGGEST_CACHE.get(cache_key)
            if cached is not None:
                if cached[0] <= time.time():
                    self._schedule_corpus_refresh(cache_key, cached)
                return cached[1]
            try:
                items = [
                    _history_candidate(item)
                    for item in self._aggregate_contact_suggestions()
                ]
                with _CONTACT_CACHE_LOCK:
                    _CONTACT_SUGGEST_CACHE[cache_key] = (
                        time.time() + _CONTACT_CACHE_TTL_SECONDS,
                        items,
                    )
                return items
            except Exception as e:
                logger.warning(f"suggest_contacts: aggregation failed: {e}")
                return []

    def _email_metadata_watermark(self) -> Optional[tuple[int, int]]:
        """Read (row_count, max_internal_id) watermark to detect concurrent writes."""
        conn = None
        try:
            conn = self._connect()
            conn.row_factory = None
            row = conn.execute(
                "SELECT COUNT(*), COALESCE(MAX(internal_id), 0) FROM email_metadata"
            ).fetchone()
            return (int(row[0]), int(row[1])) if row else (0, 0)
        except Exception as e:
            logger.debug(f"suggest_contacts: watermark check failed: {e}")
            return None
        finally:
            if conn is not None:
                conn.close()

    def warm_contact_suggest_cache(self) -> None:
        """Pre-warm history + merged contact caches off the request path."""
        cache_key = str(self.db_path.resolve())
        now = time.time()
        with _CONTACT_CACHE_LOCK:
            cached = _CONTACT_SUGGEST_CACHE.get(cache_key)
        if cached is not None and cached[0] > now:
            return

        with _get_build_lock(cache_key):
            with _CONTACT_CACHE_LOCK:
                if cache_key in _CONTACT_SUGGEST_CACHE:
                    return
            before_wm = self._email_metadata_watermark()
            if before_wm is None:
                return
            try:
                history = [
                    _history_candidate(item)
                    for item in self._aggregate_contact_suggestions()
                ]
            except Exception as e:
                logger.warning(f"suggest_contacts: warmup failed: {e}")
                return
            after_wm = self._email_metadata_watermark()
            if after_wm != before_wm:
                return
            with _CONTACT_CACHE_LOCK:
                if cache_key in _CONTACT_SUGGEST_CACHE:
                    return
                _CONTACT_SUGGEST_CACHE[cache_key] = (
                    time.time() + _CONTACT_CACHE_TTL_SECONDS,
                    history,
                )

            merged = _build_contact_candidates(history, self._contact_directory_rows())
            with _CONTACT_CACHE_LOCK:
                current = _CONTACT_SUGGEST_CACHE.get(cache_key)
                if current is not None and current[1] is history:
                    _CONTACT_MERGED_CACHE[cache_key] = (
                        time.time() + _CONTACT_DIRECTORY_TTL_SECONDS,
                        merged,
                        history,
                    )

    def _contact_directory_rows(self) -> list[dict]:
        """通讯录 lane 取数 —— 走 15s 那档短 TTL, 不跟邮件头聚合那份 10 分钟缓存。

        contact 是小表, 而刚在通讯录里改完名的人应当马上在 compose 里显示新名字。

        表不存在 (老库升上来 / 精简 schema 的测试库) 或查询异常 → 返回 [],
        历史 lane 一个字节不受影响。
        """
        conn = None
        try:
            conn = self._connect()
            present = conn.execute(
                "SELECT COUNT(*) AS n FROM sqlite_master "
                "WHERE type = 'table' AND name IN ('contact', 'contact_email')"
            ).fetchone()
            if not present or int(present["n"]) < 2:
                return []
            return [dict(row) for row in conn.execute(_CONTACT_DIRECTORY_SQL)]
        except Exception as e:
            logger.warning(f"suggest_contacts: directory lookup failed: {e}")
            return []
        finally:
            if conn is not None:
                conn.close()

    def _aggregate_contact_suggestions(self) -> list[ContactSuggestion]:
        conn = self._connect()
        conn.row_factory = None
        # [score, name, last_seen, last_seen_ts, name_seen_ts]
        contacts: dict[str, list[object]] = {}
        date_cache: dict[str, float] = {}
        sent_cache: dict[Optional[str], bool] = {}
        sender_cache: dict[
            tuple[str, Optional[str]], Optional[tuple[str, Optional[str]]]
        ] = {}
        list_cache: dict[str, list[tuple[str, Optional[str]]]] = {}
        seen_ts = 0.0
        date_received: Optional[str] = None

        def upsert(em: str, name: Optional[str], score_delta: int) -> None:
            rec = contacts.get(em)
            if rec is None:
                contacts[em] = [
                    score_delta,
                    name,
                    date_received or None,
                    seen_ts,
                    seen_ts if name else 0.0,
                ]
                return
            rec[0] = int(rec[0]) + score_delta  # type: ignore[arg-type]
            if seen_ts >= float(rec[3]):  # type: ignore[arg-type]
                rec[3] = seen_ts
                if date_received:
                    rec[2] = date_received
            if name and seen_ts >= float(rec[4]):  # type: ignore[arg-type]
                rec[1] = name
                rec[4] = seen_ts

        try:
            cur = conn.execute(
                """SELECT sender, sender_name, to_addr, cc_addr, mailbox, date_received
                   FROM email_metadata"""
            )
            for sender, sender_name, to_addr, cc_addr, mailbox, date_received in cur:
                if date_received:
                    cached_ts = date_cache.get(date_received)
                    if cached_ts is None:
                        cached_ts = _contact_date_key(date_received)
                        date_cache[date_received] = cached_ts
                    seen_ts = cached_ts
                else:
                    seen_ts = 0.0

                if sender and "@" in sender:
                    skey = (sender, sender_name)
                    sp = sender_cache.get(skey)
                    if sp is None and skey not in sender_cache:
                        parsed = _parse_address_segment(sender)
                        if parsed is not None:
                            sp = (
                                parsed[0],
                                _normalize_contact_name(sender_name) or parsed[1],
                            )
                        sender_cache[skey] = sp
                    if sp is not None:
                        upsert(sp[0], sp[1], 1)

                is_sent = sent_cache.get(mailbox)
                if is_sent is None:
                    is_sent = is_sent_mailbox(mailbox)
                    sent_cache[mailbox] = is_sent
                recipient_score = 3 if is_sent else 1

                for raw_list in (to_addr, cc_addr):
                    if not raw_list or "@" not in raw_list:
                        continue
                    parsed_list = list_cache.get(raw_list)
                    if parsed_list is None:
                        parsed_list = _parse_address_list(raw_list)
                        list_cache[raw_list] = parsed_list
                    for em, nm in parsed_list:
                        upsert(em, nm, recipient_score)

            return [
                ContactSuggestion(
                    email=em,
                    name=rec[1] if isinstance(rec[1], str) else None,
                    score=int(rec[0]),  # type: ignore[arg-type]
                    last_seen=rec[2] if isinstance(rec[2], str) else None,
                )
                for em, rec in contacts.items()
            ]
        finally:
            conn.close()
