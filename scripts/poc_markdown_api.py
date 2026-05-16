#!/usr/bin/env python3
"""One-shot Notion Enhanced Markdown API file_upload image probe."""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import aiohttp
from loguru import logger


REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

API_BASE = "https://api.notion.com/v1"
API_VERSION = "2025-09-03"
DEFAULT_INTERNAL_ID = 53667
PHASE1_ATTACHMENT_INTERNAL_ID = 53667
OLD_PAGE_ID = "36115375-830d-81dc-b465-ffb7f99239f5"
MARKDOWN_SNIPPET_LIMIT = 3 * 1024


class NotionMarkdownError(RuntimeError):
    pass


@dataclass
class PageRef:
    page_id: str
    url: str


class MarkdownProbeClient:
    """Small aiohttp client mirroring src/project_progress/notion_sync.py."""

    MAX_RETRIES = 5
    BASE_RETRY_DELAY = 1.0

    def __init__(self, database_id: str, token: str):
        self.database_id = database_id
        self.token = token
        self._ds_id: Optional[str] = None
        self._session: Optional[aiohttp.ClientSession] = None

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()
            self._session = None

    async def __aenter__(self):
        await self._get_session()
        return self

    async def __aexit__(self, *exc):
        await self.close()

    def _headers(self, *, json_content: bool = True) -> Dict[str, str]:
        h = {
            "Authorization": f"Bearer {self.token}",
            "Notion-Version": API_VERSION,
        }
        if json_content:
            h["Content-Type"] = "application/json"
        return h

    async def _request(
        self,
        method: str,
        url: str,
        *,
        json_body: Optional[Dict[str, Any]] = None,
        expect_json: bool = True,
    ) -> Any:
        session = await self._get_session()
        last_exc: Optional[Exception] = None
        for attempt in range(self.MAX_RETRIES):
            try:
                async with session.request(
                    method,
                    url,
                    headers=self._headers(),
                    json=json_body,
                    timeout=aiohttp.ClientTimeout(total=120),
                ) as resp:
                    if resp.status == 429:
                        ra = resp.headers.get("Retry-After")
                        delay = float(ra) if ra else self.BASE_RETRY_DELAY * (2**attempt)
                        logger.warning(
                            f"[notion-md] 429 rate-limit, retry in {delay:.1f}s "
                            f"(attempt {attempt+1}/{self.MAX_RETRIES})"
                        )
                        await asyncio.sleep(delay)
                        continue
                    if resp.status >= 500:
                        delay = self.BASE_RETRY_DELAY * (2**attempt)
                        logger.warning(
                            f"[notion-md] {resp.status} server error, retry in {delay:.1f}s"
                        )
                        await asyncio.sleep(delay)
                        continue
                    if resp.status not in (200, 201, 204):
                        body = await resp.text()
                        raise NotionMarkdownError(
                            f"HTTP {resp.status} on {method} {url}: {body[:500]}"
                        )
                    if expect_json:
                        return await resp.json()
                    return None
            except asyncio.CancelledError:
                raise
            except (aiohttp.ClientError, asyncio.TimeoutError) as e:
                last_exc = e
                delay = self.BASE_RETRY_DELAY * (2**attempt)
                logger.warning(f"[notion-md] network error {e!r}, retry in {delay:.1f}s")
                await asyncio.sleep(delay)
        raise NotionMarkdownError(f"Max retries exceeded. Last: {last_exc}")

    async def get_data_source_id(self) -> str:
        if self._ds_id is not None:
            return self._ds_id
        data = await self._request("GET", f"{API_BASE}/databases/{self.database_id}")
        sources = data.get("data_sources", [])
        if not sources:
            raise NotionMarkdownError(
                f"No data_sources on database {self.database_id}"
            )
        self._ds_id = sources[0]["id"]
        logger.debug(f"[notion-md] resolved data_source_id={self._ds_id}")
        return self._ds_id

    async def create_sandbox_page(self, title: str) -> PageRef:
        ds_id = await self.get_data_source_id()
        body = {
            "parent": {"data_source_id": ds_id},
            "properties": {
                "Subject": {
                    "title": [
                        {"type": "text", "text": {"content": safe_title(title)}}
                    ]
                }
            },
        }
        data = await self._request("POST", f"{API_BASE}/pages", json_body=body)
        page_id = data["id"]
        return PageRef(page_id=page_id, url=page_url(data))

    async def append_file_upload_image(self, page_id: str, file_upload_id: str) -> None:
        body = {
            "children": [
                {
                    "type": "image",
                    "image": {
                        "type": "file_upload",
                        "file_upload": {"id": file_upload_id},
                    },
                }
            ]
        }
        await self._request(
            "PATCH",
            f"{API_BASE}/blocks/{page_id}/children",
            json_body=body,
        )

    async def get_markdown(self, page_id: str) -> str:
        data = await self._request("GET", f"{API_BASE}/pages/{page_id}/markdown")
        return data.get("markdown", "") or ""

    async def replace_markdown(self, page_id: str, new_markdown: str) -> None:
        body = {
            "type": "replace_content",
            "replace_content": {"new_str": new_markdown},
        }
        await self._request(
            "PATCH",
            f"{API_BASE}/pages/{page_id}/markdown",
            json_body=body,
            expect_json=True,
        )

    async def get_block_children(self, page_id: str) -> Dict[str, Any]:
        return await self._request("GET", f"{API_BASE}/blocks/{page_id}/children")

    async def archive_page(self, page_id: str) -> None:
        await self._request(
            "PATCH",
            f"{API_BASE}/pages/{page_id}",
            json_body={"archived": True},
            expect_json=True,
        )


def safe_title(title: str) -> str:
    title = (title or "").strip() or "(untitled)"
    return title[:2000]


def page_url(page_data: Dict[str, Any]) -> str:
    if page_data.get("url"):
        return page_data["url"]
    return f"https://www.notion.so/{page_data['id'].replace('-', '')}"


def timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def blank_report() -> Dict[str, Any]:
    return {
        "phase1": {
            "sandbox_page_id": "",
            "sandbox_page_url": "",
            "uploaded_file_id": "",
            "markdown_snippet": "",
            "image_form": "unknown",
            "image_url_or_ref": "",
        },
        "phase2": {
            "sandbox_page_id": "",
            "executed": False,
            "block_type_after_patch": "",
            "is_file_upload_image": False,
            "image_url_after_patch": "",
            "roundtrip_form": "",
        },
        "phase3": {
            "sandbox_page_id": "",
            "sandbox_page_url": "",
            "compared_to_old_page": OLD_PAGE_ID,
        },
        "recommendation": "CANCEL_T01",
        "rationale": "",
        "sandbox_pages_to_review": [],
    }


def remember_page(report: Dict[str, Any], created_page_ids: List[str], page: PageRef) -> None:
    created_page_ids.append(page.page_id)
    if page.url and page.url not in report["sandbox_pages_to_review"]:
        report["sandbox_pages_to_review"].append(page.url)


def truncate_markdown(markdown: str) -> str:
    return markdown[:MARKDOWN_SNIPPET_LIMIT]


def detect_image_form(markdown: str) -> Tuple[str, str, str]:
    patterns = [
        ("s3_url", re.compile(r"!\[.*?\]\((https://prod-files-secure\.s3[^)]+)\)", re.S)),
        ("file_upload_url", re.compile(r"!\[.*?\]\(([^)]*file_upload[^)]*)\)", re.S)),
        ("html_tag_extension", re.compile(r"<image[^>]*src=\"([^\"]+)\"", re.S)),
    ]
    for image_form, pattern in patterns:
        match = pattern.search(markdown)
        if match:
            return image_form, match.group(1), match.group(0)
    return "stripped", "", ""


def find_phase1_image() -> Optional[Path]:
    attachment_dir = REPO_ROOT / "data" / "attachments" / str(PHASE1_ATTACHMENT_INTERNAL_ID)
    preferred = attachment_dir / "image001.png"
    if preferred.exists():
        return preferred
    candidates = sorted(attachment_dir.glob("*.png"))
    if candidates:
        logger.warning(
            f"[phase1] {preferred} not found; using fallback PNG {candidates[0]}"
        )
        return candidates[0]
    logger.warning(f"[phase1] no PNG found under {attachment_dir}; skipping upload")
    return None


def analyze_blocks_for_image(blocks_response: Dict[str, Any]) -> Tuple[str, bool, str]:
    results = blocks_response.get("results") or []
    if not results:
        return "none", False, ""

    first_type = results[0].get("type", "unknown")
    for block in results:
        if block.get("type") != "image":
            continue
        image = block.get("image") or {}
        image_type = image.get("type", "")
        image_ref = ""
        if image_type == "file_upload":
            file_upload = image.get("file_upload") or {}
            image_ref = file_upload.get("id") or file_upload.get("url") or ""
        elif image_type == "file":
            image_ref = (image.get("file") or {}).get("url", "")
        elif image_type == "external":
            image_ref = (image.get("external") or {}).get("url", "")
        return "image", image_type == "file_upload", image_ref

    return first_type, False, ""


async def run_phase1(
    client: MarkdownProbeClient,
    report: Dict[str, Any],
    created_page_ids: List[str],
    ts: str,
) -> str:
    page = await client.create_sandbox_page(f"[PoC] markdown-api-phase1-{ts}")
    remember_page(report, created_page_ids, page)
    report["phase1"]["sandbox_page_id"] = page.page_id
    report["phase1"]["sandbox_page_url"] = page.url

    image_path = find_phase1_image()
    if image_path is not None:
        from src.notion.client import NotionClient

        upload_client = NotionClient()
        try:
            file_upload_id = await upload_client.upload_file(str(image_path))
        finally:
            await upload_client.close()
        report["phase1"]["uploaded_file_id"] = file_upload_id
        await client.append_file_upload_image(page.page_id, file_upload_id)

    markdown = await client.get_markdown(page.page_id)
    print("\n===== PHASE 1 MARKDOWN START =====")
    print(markdown)
    print("===== PHASE 1 MARKDOWN END =====\n")

    image_form, image_url_or_ref, image_snippet = detect_image_form(markdown)
    report["phase1"]["markdown_snippet"] = truncate_markdown(markdown)
    report["phase1"]["image_form"] = image_form
    report["phase1"]["image_url_or_ref"] = image_url_or_ref
    return image_snippet


async def run_phase2(
    client: MarkdownProbeClient,
    report: Dict[str, Any],
    created_page_ids: List[str],
    ts: str,
    phase1_image_snippet: str,
) -> None:
    page = await client.create_sandbox_page(f"[PoC] markdown-api-phase2-{ts}")
    remember_page(report, created_page_ids, page)
    report["phase2"]["sandbox_page_id"] = page.page_id

    if report["phase1"]["image_form"] == "stripped" or not phase1_image_snippet:
        logger.warning("[phase2] skipped because phase1 returned no image markdown")
        report["phase2"]["block_type_after_patch"] = "skipped"
        report["phase2"]["roundtrip_form"] = "skipped"
        return

    report["phase2"]["executed"] = True
    await client.replace_markdown(page.page_id, phase1_image_snippet)

    roundtrip_markdown = await client.get_markdown(page.page_id)
    roundtrip_form, roundtrip_ref, _ = detect_image_form(roundtrip_markdown)
    blocks = await client.get_block_children(page.page_id)
    block_type, is_file_upload_image, block_image_ref = analyze_blocks_for_image(blocks)

    report["phase2"]["block_type_after_patch"] = block_type
    report["phase2"]["is_file_upload_image"] = is_file_upload_image
    report["phase2"]["image_url_after_patch"] = block_image_ref or roundtrip_ref
    report["phase2"]["roundtrip_form"] = roundtrip_form


async def run_phase3(
    client: MarkdownProbeClient,
    report: Dict[str, Any],
    created_page_ids: List[str],
    ts: str,
    internal_id: int,
) -> bool:
    from src.mail.sync_store import SyncStore
    from src.repository.email_repository import EmailRepository

    db_path = str(REPO_ROOT / "data" / "sync_store.db")
    body = EmailRepository(db_path).get_body(internal_id)
    body_markdown = body.markdown if body else None
    if not body_markdown:
        raise RuntimeError(f"No body_markdown found for internal_id={internal_id}")

    metadata = SyncStore(db_path).get(internal_id) or {}
    subject = metadata.get("subject") or f"[PoC] markdown-api-phase3-{internal_id}-{ts}"

    page = await client.create_sandbox_page(str(subject))
    remember_page(report, created_page_ids, page)
    report["phase3"]["sandbox_page_id"] = page.page_id
    report["phase3"]["sandbox_page_url"] = page.url

    await client.replace_markdown(page.page_id, body_markdown)
    print(
        f"[phase3] sandbox page for manual review: {page.url}\n"
        f"[phase3] compare against old page: {OLD_PAGE_ID}\n"
        "[phase3] use --keep-sandbox if you need the page retained after the run"
    )
    return True


def choose_recommendation(report: Dict[str, Any], phase3_ok: bool) -> Tuple[str, str]:
    if report["phase2"].get("is_file_upload_image") is True:
        return (
            "VIABLE_A",
            "Phase 2 produced an image block whose Notion API type is file_upload.",
        )
    if phase3_ok and report["phase3"].get("sandbox_page_url"):
        return (
            "VIABLE_B",
            "Phase 2 did not prove file_upload preservation, but Phase 3 accepted "
            "the real email body_markdown for manual render review.",
        )
    return (
        "CANCEL_T01",
        "Phase 3 did not create a reviewable markdown sandbox page, or an API "
        "failure prevented the probe from completing.",
    )


async def cleanup_sandbox(
    client: MarkdownProbeClient,
    created_page_ids: List[str],
    keep_sandbox: bool,
) -> None:
    if keep_sandbox:
        logger.info("[cleanup] --keep-sandbox set; sandbox pages were not archived")
        return
    for page_id in reversed(created_page_ids):
        try:
            await client.archive_page(page_id)
            logger.info(f"[cleanup] archived sandbox page {page_id}")
        except Exception as exc:
            logger.error(f"[cleanup] failed to archive sandbox page {page_id}: {exc}")


def emit_report(report: Dict[str, Any], output_path: Optional[str]) -> None:
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    print("\n===== FINAL JSON REPORT =====")
    print(rendered)
    if output_path:
        Path(output_path).write_text(rendered + "\n", encoding="utf-8")


async def async_main(args: argparse.Namespace) -> int:
    from src.config import config

    if not config.notion_token.startswith("ntn_"):
        print(
            "ERROR: config.notion_token must start with 'ntn_' for the "
            "Notion Enhanced Markdown API.",
            file=sys.stderr,
        )
        return 1

    report = blank_report()
    created_page_ids: List[str] = []
    phase3_ok = False
    current_phase = "startup"
    failure: Optional[BaseException] = None
    ts = timestamp()
    client = MarkdownProbeClient(config.email_database_id, config.notion_token)

    try:
        current_phase = "phase1"
        phase1_image_snippet = await run_phase1(client, report, created_page_ids, ts)

        current_phase = "phase2"
        await run_phase2(client, report, created_page_ids, ts, phase1_image_snippet)

        current_phase = "phase3"
        phase3_ok = await run_phase3(
            client, report, created_page_ids, ts, args.internal_id
        )

        recommendation, rationale = choose_recommendation(report, phase3_ok)
        report["recommendation"] = recommendation
        report["rationale"] = rationale
    except Exception as exc:
        failure = exc
        logger.exception(f"[{current_phase}] probe failed")
        report["recommendation"] = "CANCEL_T01"
        report["rationale"] = (
            f"Failed during {current_phase}: {type(exc).__name__}: {exc}"
        )
    finally:
        await cleanup_sandbox(client, created_page_ids, args.keep_sandbox)
        await client.close()
        emit_report(report, args.output)

    return 1 if failure else 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Probe Notion Enhanced Markdown API round-trip image support."
    )
    parser.add_argument("--internal-id", type=int, default=DEFAULT_INTERNAL_ID)
    parser.add_argument("--keep-sandbox", action="store_true")
    parser.add_argument("--output", type=str, default=None)
    return parser.parse_args()


def main() -> None:
    raise SystemExit(asyncio.run(async_main(parse_args())))


if __name__ == "__main__":
    main()
