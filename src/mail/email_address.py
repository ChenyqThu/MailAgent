"""邮件地址归一 —— 零依赖叶子模块 (task 08-14 WP-5 阶段 1)。

本模块是**唯一**的地址解析/归一点。存在的理由是 WP-5 查明的根因: 同一个
``email_metadata.sender`` 列被四个消费者按四种不同假设读, 而其中三个假设错了 ——
活库 13014 行里 8850 行 (68%, 全部 ``backend_origin='applescript'``) 存的是整个
From 头 ``Gary W <gary.w@…>``, 其余是裸地址::

    scanner._add(row['sender'])   假设裸地址 → normalize_email 返 None → 8850 行的发件人被丢弃
    service._sent_predicate       假设裸地址 (精确 IN) → 出向漏 87% (1471 真值只认出 188)
    isBotSender (TS)              假设裸地址 → 判据读到发件人自己填的显示名
    scanner 的 to/cc              走 getaddresses ✅ 四者中唯一正确的

修法 = 加派生列 ``email_metadata.sender_email`` (归一裸小写地址), 在**持久化边界**
统一算 (同 ``_storage_message_id`` / ``_normalize_date_received_iso`` 纪律), 消费者
读列不再各自解析。本模块就是那个"统一算"的实现。

🔴 解析器单源: 一律 ``email.utils.getaddresses``。禁止在 SQL 里用 ``substr``/``instr``
再写一套 —— 那正是本 WP 要消灭的「第 N 个真源」。

放在 ``src/mail/`` 而非 ``src/contacts/``: 地址是 mail 层概念, 且 contacts → mail 是
既有依赖方向 (``scanner`` → ``mail.mailbox_semantics``); 反过来会让 ``sync_store``
依赖下游域。本模块**只依赖标准库**, 任何层都能 import。
"""

from __future__ import annotations

import re
from email.utils import getaddresses
from typing import Any, Optional

#: 地址形状判据。原 ``src/contacts/service.py::CONTACT_EMAIL_RE``, 下沉到本叶子模块
#: 后成为全仓唯一一份 (contacts 侧改为再导出)。
EMAIL_SHAPE_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def normalize_email(raw: Any) -> Optional[str]:
    """trim+lower 归一; 非法形状返回 None。

    🔴 **不解析** ``Name <addr>`` —— 那是 :func:`derive_sender_email` 的职责。本函数
    对完整 From 头一律返回 None (正是 WP-5 之前 scanner 丢掉 68% 发件人的机制)。
    """
    email = str(raw or "").strip().lower()
    if not email or not EMAIL_SHAPE_RE.match(email):
        return None
    return email


def derive_sender_email(raw: Any) -> Optional[str]:
    """From 头 (或裸地址) → 归一裸小写地址; 取不到返回 None。

    ``email_metadata.sender_email`` 列的**唯一**派生点: 三条写入边界
    (``_save_email_v3`` / ``save_emails_batch`` / ``update_after_fetch``) 与 v58
    迁移回填共用本函数。

    形状 (实测)::

        'Gary W <gary.w@x.com>'       → 'gary.w@x.com'
        'gary.w@X.COM'                → 'gary.w@x.com'
        '"徐静雅 (Jira)" <a@x.com>'    → 'a@x.com'      (显示名不参与)
        'Doe, John <j@x.com>'         → 'j@x.com'       (未加引号的逗号被 getaddresses
                                                         切成 [('','Doe'), ('John','j@x.com')]
                                                         ⇒ 必须取**第一个合法项**而非第一项)
        'a@x.com, b@y.com'            → 'a@x.com'       (多地址取第一个合法项)
        '' / None / 'not-an-email'    → None

    None 是有意义的值 (「这行没有可用的发件人地址」), 不是待补的空洞 —— 三个消费者
    对 None 的行为与本 WP 之前一致: 不建档 / 不计出向 / 不判机器人。

    ⚠️ 无 try/except: ``getaddresses`` 是纯字符串解析, 对上表全部畸形输入 (含
    ``'weird <<a@x.com>>'`` / ``'a"@b@c.com'``) 都只是返回空/垃圾项, 实测不抛。
    """
    text = str(raw or "").strip()
    if not text:
        return None
    for _name, addr in getaddresses([text]):
        email = normalize_email(addr)
        if email is not None:
            return email
    return None
