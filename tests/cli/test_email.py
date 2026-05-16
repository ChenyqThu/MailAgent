"""US-003 / US-004 / US-005 — email get / body / list / search / resync."""

from __future__ import annotations

import json
import re

_JSON_OBJ_RE = re.compile(r"\{.*\}", re.DOTALL)


def _invoke_email(cli_runner, *args, db_path):
    from src.cli.main import app

    return cli_runner.invoke(
        app, ["--db-path", str(db_path), "email", *args],
    )


def _extract_last_json_object(text: str) -> dict:
    """从混合输出中抓最后一个 JSON object (含 success / error wrapper).

    CliRunner mix_stderr=True 时 emit_error 的 stderr JSON 会和 stdout 合并,
    可能前后夹杂 loguru log。
    """
    if not text:
        raise ValueError("empty output")
    # 找最后一行符合 wrapper 形态的 JSON
    candidates = []
    for line in text.strip().splitlines():
        line = line.strip()
        if not line.startswith("{") or not line.endswith("}"):
            continue
        try:
            candidates.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    if not candidates:
        # fallback: 全文匹配 (单行 dict 时)
        m = _JSON_OBJ_RE.search(text)
        if m:
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError as e:
                raise ValueError(f"could not parse JSON from output: {text[:300]!r}") from e
        raise ValueError(f"no JSON object in output: {text[:300]!r}")
    return candidates[-1]


class TestEmailGet:
    def test_get_happy_text(self, cli_runner, cli_env, seeded_db):
        result = _invoke_email(cli_runner, "get", "12345", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        assert "Hello Test" in result.output
        assert "alice@example.com" in result.output

    def test_get_happy_json(self, cli_runner, cli_env, seeded_db):
        result = _invoke_email(cli_runner, "get", "12345", "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _extract_last_json_object(result.output)
        assert payload["status"] == "success"
        assert payload["schema_version"] == 1
        assert payload["data"]["internal_id"] == 12345
        assert payload["data"]["subject"] == "Hello Test"
        assert payload["data"]["is_read"] is True

    def test_get_not_found(self, cli_runner, cli_env, seeded_db):
        result = _invoke_email(cli_runner, "get", "99999", "-o", "json", db_path=seeded_db)
        assert result.exit_code == 1
        # error wrapper 在 stderr
        payload = _extract_last_json_object(result.output)
        assert payload["status"] == "error"
        assert payload["error"]["code"] == "E_NOT_FOUND"

    def test_get_include_all(self, cli_runner, cli_env, seeded_db):
        result = _invoke_email(
            cli_runner, "get", "12345", "--include", "all",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        data = json.loads(result.stdout)["data"]
        assert data["body"] is not None
        assert data["body"]["format"] == "html"
        assert len(data["attachments"]) == 1
        assert data["attachments"][0]["filename"] == "report.pdf"

    def test_get_include_invalid(self, cli_runner, cli_env, seeded_db):
        result = _invoke_email(
            cli_runner, "get", "12345", "--include", "foo",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 2  # E_INVALID_ARG
        payload = _extract_last_json_object(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"


class TestEmailBody:
    def test_body_markdown_text(self, cli_runner, cli_env, seeded_db):
        result = _invoke_email(cli_runner, "body", "12345", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        assert "body markdown" in result.output

    def test_body_html_json(self, cli_runner, cli_env, seeded_db):
        result = _invoke_email(
            cli_runner, "body", "12345", "--format", "html",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _extract_last_json_object(result.output)
        assert payload["data"]["format"] == "html"
        assert "<p>" in payload["data"]["content"]

    def test_body_not_found(self, cli_runner, empty_cli_env, empty_db):
        result = _invoke_email(
            cli_runner, "body", "12345", "-o", "json", db_path=empty_db,
        )
        assert result.exit_code == 1
        payload = _extract_last_json_object(result.output)
        assert payload["error"]["code"] == "E_NOT_FOUND"


class TestEmailList:
    def test_list_json_wrapper(self, cli_runner, cli_env, seeded_db):
        result = _invoke_email(
            cli_runner, "list", "--limit", "10", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _extract_last_json_object(result.output)
        assert payload["status"] == "success"
        assert isinstance(payload["data"], list)
        assert payload["meta"]["total"] >= 1
        assert payload["meta"]["count"] >= 1
        assert payload["data"][0]["internal_id"] == 12345

    def test_list_ndjson_meta_footer(self, cli_runner, cli_env, seeded_db):
        result = _invoke_email(
            cli_runner, "list", "--limit", "3", "-o", "ndjson", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        lines = [line for line in result.output.splitlines() if line.strip()]
        assert lines, "ndjson empty"
        last = json.loads(lines[-1])
        assert "_meta" in last
        assert last["_meta"]["count"] >= 1

    def test_list_source_mail_rejected(self, cli_runner, cli_env, seeded_db):
        result = _invoke_email(
            cli_runner, "list", "--source", "mail", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 2
        payload = _extract_last_json_object(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"

    def test_list_status_filter_returns_failed(self, cli_runner, cli_env, seeded_db):
        """PR-2 critic fix #1: --status failed 必须命中 (修前 sync_store 锁 synced/pending)."""
        result = _invoke_email(
            cli_runner, "list", "--status", "failed", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _extract_last_json_object(result.output)
        ids = [row["internal_id"] for row in payload["data"]]
        assert 12346 in ids, f"expected failed email 12346 in {ids}"
        assert 12345 not in ids
        # data 中含 sync_status + thread_id (修前 SELECT 缺这俩字段)
        first = payload["data"][0]
        assert first["sync_status"] == "failed"
        assert "thread_id" in first

    def test_list_limit_high_not_capped_to_50(self, cli_runner, cli_env, seeded_db):
        """PR-2 critic fix #1: --limit 500 应被接受 (修前 sync_store 硬 cap 50)."""
        result = _invoke_email(
            cli_runner, "list", "--limit", "200", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _extract_last_json_object(result.output)
        assert payload["meta"]["limit"] == 200


class TestEmailSearch:
    def test_search_happy(self, cli_runner, cli_env, seeded_db):
        result = _invoke_email(
            cli_runner, "search", "redis", "--limit", "5",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _extract_last_json_object(result.output)
        assert payload["status"] == "success"
        assert payload["meta"]["query"] == "redis"
        # 至少命中 seeded body 中的 "redis timeout"
        if payload["data"]:
            assert "snippet" in payload["data"][0]

    def test_search_no_hits(self, cli_runner, cli_env, seeded_db):
        result = _invoke_email(
            cli_runner, "search", "xyznotamatchabc", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _extract_last_json_object(result.output)
        assert payload["data"] == []
        assert payload["meta"]["total_hits"] == 0

    def test_search_invalid_limit(self, cli_runner, cli_env, seeded_db):
        result = _invoke_email(
            cli_runner, "search", "redis", "--limit", "0",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 2
        payload = _extract_last_json_object(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"


class TestEmailResync:
    def test_resync_dry_run(self, cli_runner, cli_env, seeded_db):
        result = _invoke_email(
            cli_runner, "resync", "12345", "--dry-run",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _extract_last_json_object(result.output)
        assert payload["data"]["dry_run"] is True
        assert payload["data"]["internal_id"] == 12345

    def test_resync_pr4_batch_flag_rejected(self, cli_runner, cli_env, seeded_db):
        result = _invoke_email(
            cli_runner, "resync", "12345", "--range", "1-10",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 2
        payload = _extract_last_json_object(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"

    def test_resync_auth_required(self, cli_runner, cli_env, seeded_db):
        # 无 token + 无 unsafe-flag-opt-in → exit 4
        result = _invoke_email(
            cli_runner, "resync", "12345", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 4
        payload = _extract_last_json_object(result.output)
        assert payload["error"]["code"] == "E_AUTH_FAILED"


class TestInvalidOutput:
    """PR-2 critic fix #5: --output xyz 应拒绝, 不能 silent fallback to text."""

    def test_unknown_output_global_rejected(self, cli_runner, cli_env, seeded_db):
        from src.cli.main import app

        result = cli_runner.invoke(
            app, ["--db-path", str(seeded_db), "-o", "xml",
                  "email", "get", "12345"],
        )
        assert result.exit_code == 2, result.output

    def test_unknown_output_leaf_rejected(self, cli_runner, cli_env, seeded_db):
        result = _invoke_email(
            cli_runner, "get", "12345", "-o", "xml", db_path=seeded_db,
        )
        assert result.exit_code == 2, result.output
