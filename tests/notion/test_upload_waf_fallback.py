"""NotionClient.upload_file 的 Cloudflare-WAF zip fallback 回归 (task 07-04)。

Notion API 前置 CF WAF 会按 multipart body 内容拦截 (真实报表 HTML 稳定 403，
改名/改 content-type 躲不过)；zip 打包后 (`.zip` 受支持) 可过。这里 mock HTTP 层
(`_request_with_retry` / `_get_http_session`)，不发真实网络：
  - CF WAF HTML 403 → 走一次 zip fallback、Step 1 声明名变 `xxx.html.zip`、返回新 id
  - Notion JSON 403 (非 CF) → 不触发 fallback、照旧抛
"""
import pytest

from src.notion.client import NotionClient

_FILE_UPLOADS_URL = "https://api.notion.com/v1/file_uploads"
_CF_BLOCK_403 = (
    "HTTP POST failed: 403 - <html><head><title>Just a moment...</title></head>"
    "<body>Sorry, you have been blocked</body></html>"
)
_NOTION_JSON_403 = (
    'HTTP POST failed: 403 - {"object":"error","status":403,'
    '"code":"restricted_resource","message":"Insufficient permissions."}'
)


def _wire(client, monkeypatch, send_error: str):
    """把 client 的 HTTP 层换成受控替身。

    ``send_error`` 是内容上传 (Send) 第一次抛出的异常消息；后续 Send 成功。
    返回捕获状态 dict: step1_filenames (每次 Step 1 声明的文件名) + send_calls。
    """
    state = {"step1_filenames": [], "send_calls": 0}

    async def fake_session():
        return object()

    async def fake_request(session, method, url, *, headers=None, json=None, data=None, expect_json=True):
        if url == _FILE_UPLOADS_URL:
            state["step1_filenames"].append(json["filename"])
            return {
                "upload_url": "https://upload.example/u",
                "id": f"fuid-{len(state['step1_filenames'])}",
            }
        # 内容上传 (Send) 步骤
        state["send_calls"] += 1
        if state["send_calls"] == 1:
            raise Exception(send_error)
        return None

    monkeypatch.setattr(client, "_get_http_session", fake_session)
    monkeypatch.setattr(client, "_request_with_retry", fake_request)
    return state


@pytest.mark.asyncio
async def test_cf_waf_block_triggers_zip_fallback(tmp_path, monkeypatch):
    f = tmp_path / "report.html"
    f.write_bytes(b"<html><body>real report body that CF blocks</body></html>")

    client = NotionClient(token="test-token", email_db_id="db")
    state = _wire(client, monkeypatch, send_error=_CF_BLOCK_403)

    result_id = await client.upload_file(str(f))

    # 返回的是 zip 重传拿到的第二个 upload id
    assert result_id == "fuid-2"
    # fallback 只重试一次 (原始 + zip 各一次 Send)
    assert state["send_calls"] == 2
    # Step 1 先按原名声明，WAF 命中后按 zip 名声明
    assert state["step1_filenames"] == ["report.html", "report.html.zip"]


@pytest.mark.asyncio
async def test_notion_json_403_does_not_trigger_fallback(tmp_path, monkeypatch):
    f = tmp_path / "report.html"
    f.write_bytes(b"<html><body>body</body></html>")

    client = NotionClient(token="test-token", email_db_id="db")
    state = _wire(client, monkeypatch, send_error=_NOTION_JSON_403)

    with pytest.raises(Exception) as ei:
        await client.upload_file(str(f))

    # 原样抛出 Notion JSON 403，不被 zip fallback 吞掉
    assert "403" in str(ei.value)
    # 没有 zip 重试：Send 只发了一次，Step 1 也只声明了原名
    assert state["send_calls"] == 1
    assert state["step1_filenames"] == ["report.html"]
