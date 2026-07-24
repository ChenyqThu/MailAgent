"""reader.parse_email_source 的 In-Reply-To 提取 (task 07-23, KOS Thread 链接)。

In-Reply-To 头以前解析后即丢弃 (只作 thread_id fallback)。现在独立抽成
``Email.in_reply_to`` (直接父邮件 message_id, 无尖括号), 与 thread_id (线程根,
优先 References[0]) 分开, 供 KOS payload 的 ## Thread 节反查链接用。
"""
from src.mail.reader import EmailReader


def _source(headers: str) -> str:
    """最小纯文本邮件 MIME (无附件, 不触发落盘)。"""
    return (
        "MIME-Version: 1.0\r\n"
        "Message-ID: <reply@example.com>\r\n"
        "Subject: Re: Plan\r\n"
        "From: sender@example.com\r\n"
        "To: me@example.com\r\n"
        "Date: Wed, 23 Jul 2026 10:00:00 +0800\r\n"
        f"{headers}"
        'Content-Type: text/plain; charset="utf-8"\r\n'
        "\r\n"
        "body\r\n"
    )


def test_in_reply_to_extracted_without_brackets():
    """回复邮件: In-Reply-To 头 → in_reply_to (去尖括号); References[0] → thread_id。"""
    src = _source(
        "References: <root@example.com> <parent@example.com>\r\n"
        "In-Reply-To: <parent@example.com>\r\n"
    )
    email_obj = EmailReader().parse_email_source(src, "<reply@example.com>")
    assert email_obj is not None
    assert email_obj.in_reply_to == "parent@example.com"
    # thread_id 仍取 References[0]=线程根, 与 in_reply_to (直接父) 分开
    assert email_obj.thread_id == "root@example.com"


def test_thread_first_email_has_no_in_reply_to():
    """线程首封 (无 In-Reply-To 头) → in_reply_to None (forward-only 语义源头)。"""
    email_obj = EmailReader().parse_email_source(_source(""), "<reply@example.com>")
    assert email_obj is not None
    assert email_obj.in_reply_to is None


def test_multi_value_in_reply_to_takes_first():
    """罕见: In-Reply-To 含多个 message-id → 取第一个 token。"""
    src = _source("In-Reply-To: <first@example.com> <second@example.com>\r\n")
    email_obj = EmailReader().parse_email_source(src, "<reply@example.com>")
    assert email_obj is not None
    assert email_obj.in_reply_to == "first@example.com"
