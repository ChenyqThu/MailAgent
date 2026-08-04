"""CHAT_DB 行 → UIMessage 历史重建 + 预算裁剪（src/im/history.py）。"""

from __future__ import annotations

import json

from src.im.history import build_history, rebuild_ui_message


def _row(
    row_id: int,
    role: str,
    content: str = "",
    ui_message_json: str | None = None,
) -> dict:
    return {
        "id": row_id,
        "role": role,
        "content": content,
        "ui_message_json": ui_message_json,
    }


class TestRebuild:
    def test_canonical_ui_message_json_is_used_verbatim(self):
        msg = {
            "id": "asst-1",
            "role": "assistant",
            "parts": [
                {"type": "text", "text": "查到了"},
                {
                    "type": "tool-email_search",
                    "toolCallId": "t1",
                    "state": "output-available",
                    "input": {"q": "x"},
                    "output": {"hits": 1},
                },
            ],
        }
        out = rebuild_ui_message(_row(5, "assistant", "查到了", json.dumps(msg)))
        assert out == msg  # 工具 part 原样保留（renderer resume 重放同款）

    def test_legacy_row_synthesizes_text_part(self):
        out = rebuild_ui_message(_row(7, "user", "你好"))
        assert out == {
            "id": "db-7",
            "role": "user",
            "parts": [{"type": "text", "text": "你好"}],
        }

    def test_bad_json_falls_back_to_content(self):
        out = rebuild_ui_message(_row(9, "assistant", "备胎文本", "{not json"))
        assert out is not None
        assert out["parts"] == [{"type": "text", "text": "备胎文本"}]

    def test_non_chat_roles_and_empty_rows_are_dropped(self):
        assert rebuild_ui_message(_row(1, "system", "prompt")) is None
        assert rebuild_ui_message(_row(2, "user", "   ")) is None

    def test_missing_id_in_json_gets_stamped(self):
        raw = json.dumps({"role": "user", "parts": [{"type": "text", "text": "hi"}]})
        out = rebuild_ui_message(_row(3, "user", "hi", raw))
        assert out is not None
        assert out["id"] == "db-3"


class TestBuildHistory:
    def test_appends_new_user_message_last(self):
        rows = [_row(1, "user", "第一轮"), _row(2, "assistant", "第一轮回复")]
        msgs = build_history(rows, "第二轮", "im-evt2")
        assert [m["role"] for m in msgs] == ["user", "assistant", "user"]
        assert msgs[-1] == {
            "id": "im-evt2",
            "role": "user",
            "parts": [{"type": "text", "text": "第二轮"}],
        }

    def test_no_history_is_just_the_new_message(self):
        msgs = build_history([], "你好", "im-evt1")
        assert len(msgs) == 1
        assert msgs[0]["role"] == "user"

    def test_budget_trims_oldest_whole_messages(self):
        rows = []
        for i in range(10):
            rows.append(_row(i * 2, "user", f"问 {i} " + "x" * 100))
            rows.append(_row(i * 2 + 1, "assistant", f"答 {i} " + "y" * 100))
        msgs = build_history(rows, "新问题", "im-new", char_budget=800)
        # 新消息永在，且从最旧开始整条丢
        assert msgs[-1]["parts"][0]["text"] == "新问题"
        assert len(msgs) < 21
        total = sum(len(json.dumps(m, ensure_ascii=False)) for m in msgs)
        assert total <= 800

    def test_max_messages_cap(self):
        rows = []
        for i in range(50):
            rows.append(_row(i * 2, "user", f"u{i}"))
            rows.append(_row(i * 2 + 1, "assistant", f"a{i}"))
        msgs = build_history(rows, "new", "im-new", max_messages=10)
        assert len(msgs) <= 10
        assert msgs[-1]["parts"][0]["text"] == "new"

    def test_trimmed_history_never_starts_with_assistant(self):
        """裁剪落点在 assistant 上时要继续丢到 user —— 上游 API 拒 assistant 开头。"""
        rows = [
            _row(1, "user", "u1" + "x" * 200),
            _row(2, "assistant", "a1" + "y" * 200),
            _row(3, "user", "u2"),
            _row(4, "assistant", "a2"),
        ]
        # 预算刚好只挤掉第一条 user → 裁剪落点是 assistant → 必须继续丢到 user
        msgs = build_history(rows, "new", "im-new", char_budget=500)
        assert msgs[0]["role"] == "user"
        assert msgs[0]["parts"][0]["text"].startswith("u2")
        assert msgs[-1]["parts"][0]["text"] == "new"

    def test_new_message_alone_survives_any_budget(self):
        msgs = build_history(
            [_row(1, "user", "old")], "很长的新消息" * 100, "im-new", char_budget=10
        )
        assert len(msgs) == 1
        assert msgs[0]["id"] == "im-new"
