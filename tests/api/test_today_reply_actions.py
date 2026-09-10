"""Real authenticated transport and SQLite persistence for reply decisions."""
from types import SimpleNamespace

from fastapi.testclient import TestClient

from src.api.app import app
from src.api.deps import get_settings
from tests.repository.test_email_repository import fresh_db, _insert_metadata


def test_reply_decisions_validate_and_undo_over_http(fresh_db):
    _insert_metadata(fresh_db, 1)
    app.dependency_overrides[get_settings] = lambda: SimpleNamespace(sync_store_db_path=str(fresh_db))
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            for ids in ([], [True], [-1], ['1']):
                response = client.post('/api/today/reply/dismiss', json={'internalIds': ids})
                assert response.status_code in (400, 422)
            response = client.post('/api/today/reply/dismiss', json={'internalIds': [1]})
            assert response.status_code == 200
            operation = response.json()['data']['operationId']
            undone = client.post('/api/today/reply/undo', json={'operationId': operation})
            assert undone.status_code == 200
            assert undone.json()['data']['operationId'] == operation
    finally:
        app.dependency_overrides.pop(get_settings, None)
