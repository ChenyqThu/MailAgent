"""Missing body candidates are not search hits, and completeness is channel-aware."""
import sqlite3

from src.repository import BodyPayload, EmailRepository
from tests.repository.test_email_repository import fresh_db, _insert_metadata


def test_coverage_distinguishes_missing_and_unindexed_bodies(fresh_db):
    for iid in (1, 2, 3):
        _insert_metadata(fresh_db, iid)
    repo = EmailRepository(db_path=str(fresh_db), trigram_enabled=False)
    for iid in (1, 2):
        repo.commit_email_with_body(iid, BodyPayload(html=None, markdown="coverage needle"), [])
    with sqlite3.connect(fresh_db) as conn:
        conn.execute("DELETE FROM email_body_fts WHERE rowid=2")
    result = repo.search_email_bodies_with_meta("needle")
    assert [hit.internal_id for hit in result.hits] == [1]
    assert result.coverage["candidate_count"] == 3
    assert result.coverage["body_missing"] == 1
    assert result.coverage["body_unsearchable"] == 1
    assert result.coverage["complete"] is False
    assert {row["internal_id"] for row in result.coverage["samples"]} == {2, 3}
    assert repo.search_email_bodies_with_meta("needle OR absent").coverage["scope"] == "unknown"


def test_v74_upgrade_is_idempotent_and_preserves_unknown_skip_reason(fresh_db):
    from src.mail.sync_store import SyncStore
    _insert_metadata(fresh_db, 1)
    with sqlite3.connect(fresh_db) as conn:
        conn.execute("DROP TABLE today_reply_dismissal")
        conn.execute("ALTER TABLE email_metadata DROP COLUMN sync_skip_reason")
        conn.execute("UPDATE sync_state SET value='73' WHERE key='db_version'")
    store = SyncStore(str(fresh_db))
    SyncStore(str(fresh_db))
    with sqlite3.connect(fresh_db) as conn:
        assert conn.execute("SELECT sync_skip_reason FROM email_metadata WHERE internal_id=1").fetchone() == (None,)
    store.mark_skipped(1, reason="notion_date_filter")
    with sqlite3.connect(fresh_db) as conn:
        assert conn.execute("SELECT sync_status, sync_skip_reason FROM email_metadata WHERE internal_id=1").fetchone() == ("skipped", "notion_date_filter")


def test_bulk_recovery_includes_unmirrored_only_when_requested(fresh_db):
    from src.sync.backfill_builders import _pick_candidates
    _insert_metadata(fresh_db, 1)
    with sqlite3.connect(fresh_db) as conn:
        conn.execute("UPDATE email_metadata SET sync_status='skipped', notion_page_id=NULL")
    opts = dict(force=False, since_date=None, until_date=None, mailbox=None, limit=10)
    assert _pick_candidates(str(fresh_db), **opts) == []
    rows = _pick_candidates(str(fresh_db), include_unmirrored=True, **opts)
    assert [row['internal_id'] for row in rows] == [1]
