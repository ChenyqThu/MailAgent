from unittest.mock import AsyncMock, MagicMock

import pytest

from src.notion.queries import QueryOps

pytestmark = pytest.mark.asyncio


async def test_update_email_flags_none_omits_is_read_property():
    client = MagicMock()
    client.client.pages.update = AsyncMock(return_value=None)
    queries = QueryOps(client=client)

    await queries.update_email_flags(
        "page-1", is_read=None, is_flagged=True, processing_status="已同步"
    )

    client.client.pages.update.assert_called_once_with(
        page_id="page-1",
        properties={
            "Is Flagged": {"checkbox": True},
            "Processing Status": {"select": {"name": "已同步"}},
        },
    )


async def test_update_email_flags_bool_keeps_existing_shape():
    client = MagicMock()
    client.client.pages.update = AsyncMock(return_value=None)
    queries = QueryOps(client=client)

    await queries.update_email_flags("page-1", is_read=False, is_flagged=True)

    client.client.pages.update.assert_called_once_with(
        page_id="page-1",
        properties={
            "Is Read": {"checkbox": False},
            "Is Flagged": {"checkbox": True},
        },
    )
