from typing import Any, Dict, List, Mapping, Optional, Set, Tuple, TYPE_CHECKING

if TYPE_CHECKING:
    from src.mail.icalendar_parser import MeetingInvite
    from src.mail.sync_store import SyncStore
    from src.repository import AttachmentRecord, EmailBodyRecord, EmailRepository

from src.models import Email, Attachment
from src.notion._common import BEIJING_TZ, CreateEmailFromSqliteResult, RolloutMetrics
from src.notion.client import NotionClient
from src.notion.pages import PageOps
from src.notion.queries import QueryOps
from src.notion.threads import ThreadOps
from src.converter.html_converter import HTMLToNotionConverter
from src.converter.eml_generator import EMLGenerator

__all__ = ["BEIJING_TZ", "CreateEmailFromSqliteResult", "NotionSync"]


class NotionSync:
    """Notion 同步器"""

    _SENSITIVE_PATH_PATTERN = PageOps._SENSITIVE_PATH_PATTERN
    _V4_ATTACHMENT_SRC_RE = PageOps._V4_ATTACHMENT_SRC_RE

    def __init__(
        self,
        *,
        email_repo: 'EmailRepository',
        sync_store: 'SyncStore',
    ):
        """初始化（strict DI，PR-1 R-01）.

        Args:
            email_repo: EmailRepository 实例（v4 SSoT 读路径）。生产 caller 必须传单实例。
            sync_store: SyncStore 实例（旧 metadata 路径）。同上。

        删除 lazy init / Optional 标注 — caller 显式提供以避免单进程内多实例（I-03）。
        """
        self.client = NotionClient()
        self.html_converter = HTMLToNotionConverter()
        self.eml_generator = EMLGenerator()
        self._email_repo = email_repo
        self._sync_store = sync_store
        self._rollout = RolloutMetrics(sync_store=sync_store)
        self._queries = QueryOps(client=self.client)
        self._threads = ThreadOps(client=self.client, email_repo=email_repo)
        self._pages = PageOps(
            client=self.client,
            html_converter=self.html_converter,
            eml_generator=self.eml_generator,
            email_repo=email_repo,
            sync_store=sync_store,
            rollout=self._rollout,
            threads=self._threads,
        )

    def _ensure_rollout_counters(self) -> None:
        """Lazy-init for callers that bypass __init__ via __new__ (tests)."""
        if not hasattr(self, "_rollout"):
            self._rollout = RolloutMetrics(sync_store=getattr(self, "_sync_store", None))
        self._rollout._ensure()

    @property
    def _route_hit(self) -> int:
        self._ensure_rollout_counters()
        return self._rollout._route_hit

    @_route_hit.setter
    def _route_hit(self, value: int) -> None:
        self._ensure_rollout_counters()
        self._rollout._route_hit = value

    @property
    def _route_miss(self) -> int:
        self._ensure_rollout_counters()
        return self._rollout._route_miss

    @_route_miss.setter
    def _route_miss(self, value: int) -> None:
        self._ensure_rollout_counters()
        self._rollout._route_miss = value

    @property
    def _route_error(self) -> int:
        self._ensure_rollout_counters()
        return self._rollout._route_error

    @_route_error.setter
    def _route_error(self, value: int) -> None:
        self._ensure_rollout_counters()
        self._rollout._route_error = value

    @property
    def _route_latency_samples(self) -> List[float]:
        self._ensure_rollout_counters()
        return self._rollout._route_latency_samples

    @_route_latency_samples.setter
    def _route_latency_samples(self, value: List[float]) -> None:
        self._ensure_rollout_counters()
        self._rollout._route_latency_samples = value

    @property
    def _body_miss_recent(self):
        self._ensure_rollout_counters()
        return self._rollout._body_miss_recent

    @_body_miss_recent.setter
    def _body_miss_recent(self, value) -> None:
        self._ensure_rollout_counters()
        self._rollout._body_miss_recent = value

    # ============================================================
    # PR-4 R-06: v4 rollout 路由命中计数 + flush
    # ============================================================

    def record_route_hit(self, latency_ms: float = 0.0) -> None:
        """SQLite 路径命中."""
        self._ensure_rollout_counters()
        self._rollout.record_hit(latency_ms)

    def record_route_miss(self, internal_id: int = 0) -> None:
        """SQLite body miss → fallback 老路径."""
        self._ensure_rollout_counters()
        self._rollout.record_miss(internal_id)

    def record_route_error(self) -> None:
        """SQLite 路由抛异常 → fallback."""
        self._ensure_rollout_counters()
        self._rollout.record_error()

    def snapshot_rollout_stats(self) -> dict:
        self._ensure_rollout_counters()
        return self._rollout.snapshot()

    def flush_rollout_stats(
        self,
        sync_store=None,
        *,
        window_seconds: int = 60,
    ) -> Optional[int]:
        self._ensure_rollout_counters()
        return self._rollout.flush(sync_store=sync_store, window_seconds=window_seconds)

    def _ensure_threads(self) -> ThreadOps:
        if not hasattr(self, "_threads"):
            self._threads = ThreadOps(client=self.client, email_repo=self._email_repo)
        self._threads.client = self.client
        self._threads._email_repo = self._email_repo
        return self._threads

    def _ensure_queries(self) -> QueryOps:
        if not hasattr(self, "_queries"):
            self._queries = QueryOps(client=self.client)
        self._queries.client = self.client
        return self._queries

    def _ensure_pages(self) -> PageOps:
        if not hasattr(self, "_pages"):
            self._ensure_rollout_counters()
            self._pages = PageOps(
                client=self.client,
                html_converter=self.html_converter,
                eml_generator=self.eml_generator,
                email_repo=self._email_repo,
                sync_store=self._sync_store,
                rollout=self._rollout,
                threads=self._ensure_threads(),
            )
        self._pages.client = self.client
        self._pages.html_converter = self.html_converter
        self._pages.eml_generator = self.eml_generator
        self._pages._email_repo = self._email_repo
        self._pages._sync_store = self._sync_store
        self._pages._rollout = self._rollout
        self._pages._threads = self._ensure_threads()
        if (
            "create_email_page_from_sqlite" in self.__dict__
            or
            type(self).create_email_page_from_sqlite
            is not _ORIGINAL_CREATE_EMAIL_PAGE_FROM_SQLITE
        ):
            self._pages._create_email_page_from_sqlite = (
                self.create_email_page_from_sqlite
            )
        for name in (
            "_upload_attachments",
            "_upload_eml_file",
            "_create_page_with_blocks",
            "_build_properties",
            "_build_image_map",
            "_build_children",
            "_handle_thread_relations",
            "_convert_office_attachments",
        ):
            if name in self.__dict__:
                setattr(self._pages, name, self.__dict__[name])
        return self._pages

    # ---------- public delegates ----------

    async def sync_email(self, email: Email) -> bool:
        return await self._ensure_pages().sync_email(email)

    async def create_email_page_v2(
        self,
        email: Email,
        skip_parent_lookup: bool = False,
        calendar_page_id: str = None,
        meeting_invite: 'MeetingInvite' = None
    ) -> Optional[str]:
        return await self._ensure_pages().create_email_page_v2(
            email,
            skip_parent_lookup=skip_parent_lookup,
            calendar_page_id=calendar_page_id,
            meeting_invite=meeting_invite,
        )

    async def create_email_page_from_sqlite(
        self,
        internal_id: int,
        *,
        repo: 'EmailRepository',
        sync_store: 'SyncStore',
        meeting_invite: Optional['MeetingInvite'] = None,
        calendar_page_id: Optional[str] = None,
        skip_parent_lookup: bool = False,
        replace_existing: bool = False,
    ) -> CreateEmailFromSqliteResult:
        return await self._ensure_pages().create_email_page_from_sqlite(
            internal_id,
            repo=repo,
            sync_store=sync_store,
            meeting_invite=meeting_invite,
            calendar_page_id=calendar_page_id,
            skip_parent_lookup=skip_parent_lookup,
            replace_existing=replace_existing,
        )

    async def update_sub_items(self, page_id: str, child_page_ids: List[str]) -> bool:
        return await self._ensure_threads().update_sub_items(page_id, child_page_ids)

    async def update_parent_item(self, page_id: str, parent_page_id: str) -> bool:
        return await self._ensure_queries().update_parent_item(page_id, parent_page_id)

    async def query_all_message_ids(self) -> Set[str]:
        return await self._ensure_queries().query_all_message_ids()

    async def query_all_row_ids(self) -> Set[int]:
        return await self._ensure_queries().query_all_row_ids()

    async def query_pages_for_reverse_sync(self) -> List[Dict]:
        return await self._ensure_queries().query_pages_for_reverse_sync()

    async def query_by_row_id(self, row_id: int) -> Optional[Dict]:
        return await self._ensure_queries().query_by_row_id(row_id)

    async def update_page_mail_sync_status(
        self,
        page_id: str,
        synced: bool = True,
        processing_status: str = ""
    ):
        return await self._ensure_queries().update_page_mail_sync_status(
            page_id,
            synced=synced,
            processing_status=processing_status,
        )

    async def update_email_flags(
        self,
        page_id: str,
        is_read: bool,
        is_flagged: bool,
        processing_status: str = ""
    ):
        return await self._ensure_queries().update_email_flags(
            page_id,
            is_read,
            is_flagged,
            processing_status=processing_status,
        )

    # ---------- quasi-public _-prefix delegates ----------

    async def _upload_attachments(self, email: Email):
        return await self._ensure_pages()._upload_attachments(email)

    def _convert_office_attachments(self, email: Email) -> List[Attachment]:
        return self._ensure_pages()._convert_office_attachments(email)

    async def _upload_eml_file(self, email: Email) -> Optional[str]:
        return await self._ensure_pages()._upload_eml_file(email)

    async def _create_page_with_blocks(
        self,
        properties: Dict[str, Any],
        children: List[Dict[str, Any]],
        icon: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        return await self._ensure_pages()._create_page_with_blocks(
            properties, children, icon
        )

    def _create_meeting_callout(self, invite: 'MeetingInvite') -> Dict[str, Any]:
        return self._ensure_pages()._create_meeting_callout(invite)

    def _build_image_map(self, email: Email, uploaded_attachments: List[Dict]) -> Dict[str, tuple]:
        return self._ensure_pages()._build_image_map(email, uploaded_attachments)

    def _build_properties(self, email: Email, eml_file_upload_id: str = None) -> Dict[str, Any]:
        return self._ensure_pages()._build_properties(email, eml_file_upload_id)

    @classmethod
    def _sanitize_text(cls, text: str) -> str:
        return PageOps._sanitize_text(text)

    @classmethod
    def _sanitize_rich_text_list(cls, rich_text_list: list):
        return PageOps._sanitize_rich_text_list(rich_text_list)

    @classmethod
    def _sanitize_blocks(cls, blocks: list):
        return PageOps._sanitize_blocks(blocks)

    def _build_children(
        self,
        email: Email,
        uploaded_attachments: List[Dict] = None,
        image_map: Dict[str, tuple] = None,
        meeting_invite: 'MeetingInvite' = None
    ) -> List[Dict[str, Any]]:
        return self._ensure_pages()._build_children(
            email, uploaded_attachments, image_map, meeting_invite
        )

    @classmethod
    def _restore_cid_in_body_html(
        cls, html: Optional[str], attachments: List['AttachmentRecord']
    ) -> str:
        return PageOps._restore_cid_in_body_html(html, attachments)

    @staticmethod
    def _materialize_attachments(
        att_records: List['AttachmentRecord'],
        work_dir,
        repo: 'EmailRepository',
    ) -> Tuple[List[Attachment], List[int]]:
        return PageOps._materialize_attachments(att_records, work_dir, repo)

    @staticmethod
    def _parse_iso_to_beijing(date_str: Optional[str]):
        return PageOps._parse_iso_to_beijing(date_str)

    @classmethod
    def _build_email_from_sqlite(
        cls,
        internal_id: int,
        body_record: 'EmailBodyRecord',
        metadata: Mapping[str, Any],
        att_records: List['AttachmentRecord'],
        work_dir,
        repo: 'EmailRepository',
    ) -> Email:
        return PageOps._build_email_from_sqlite(
            internal_id,
            body_record,
            metadata,
            att_records,
            work_dir,
            repo,
        )

    @staticmethod
    def _build_file_id_map(
        uploaded_attachments: List[Dict[str, Any]],
        att_records: List['AttachmentRecord'],
    ) -> Dict[int, str]:
        return PageOps._build_file_id_map(uploaded_attachments, att_records)

    async def _find_thread_parent_by_thread_id(self, thread_id: Optional[str]) -> Optional[str]:
        return await self._ensure_threads()._find_thread_parent_by_thread_id(thread_id)

    async def _find_all_thread_members_with_date(
        self,
        thread_id: str,
        exclude_message_id: str = None
    ) -> List[Dict[str, Any]]:
        return await self._ensure_threads()._find_all_thread_members_with_date(
            thread_id,
            exclude_message_id=exclude_message_id,
        )

    def _parse_date_to_beijing(self, date_str: str):
        return self._ensure_threads()._parse_date_to_beijing(date_str)

    async def _handle_thread_relations(self, page_id: str, email: Email):
        threads = self._ensure_threads()
        if "update_sub_items" in self.__dict__:
            threads.update_sub_items = self.__dict__["update_sub_items"]
        if "_find_all_thread_members_with_date" in self.__dict__:
            threads._find_all_thread_members_with_date = self.__dict__["_find_all_thread_members_with_date"]
        if "_parse_date_to_beijing" in self.__dict__:
            threads._parse_date_to_beijing = self.__dict__["_parse_date_to_beijing"]
        return await threads.handle_thread_relations(page_id, email)


_ORIGINAL_CREATE_EMAIL_PAGE_FROM_SQLITE = NotionSync.create_email_page_from_sqlite
