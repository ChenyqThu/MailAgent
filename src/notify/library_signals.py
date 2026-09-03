"""资料库无人值守写入的通知信源 (task 09-03-library-p2-write-and-links, design
09-02-library-knowledge-base §9.4/§9.5「通知中心」行)。

F3（owner 09-03 拍板）：一切「进了资料库」的回执恒带一个「打开」动作。本模块是其中一条
回执——agent **无人值守**（cron_headless / untrusted_trigger，见 P2-L3 的 `agent-docs/`
auto_allow 规则）写完 `agent-docs/` 下的文件后发一条通知，否则「写了没人知道」；交互式
（manual chat）写入用户本来就盯着屏幕，不重复发。

放在 `src/notify/` 而不是 `src/library/service.py`（本该更自然的位置，仿
`contacts/governance.py::notify_pending_suggestion` 的先例）——因为本 task 不持有那个
文件的写权限（并行 lane 归属）。这里把「构造哪个 dedupe_key / payload / 文案」封成一个
现成函数，调用方只传 file_id / rel_path，降低两侧手写字面量漂移的风险（跨语言闸
`tests/config/test_notification_enum_parity.py::NOTIFICATION_LINK_TYPE_VALUES` 已经在
锁 `"library"` 这个判别值本身，但锁不住 payload 其余键，仍需调用点用这个函数而不是
自己拼 dict）。

🔴 **调用时机纪律**（与 `notify_pending_suggestion` 头注同一条戒律，见
docs/reference/notify-center/notification-center.md §9 决策①）：`NotifyCenter.publish()`
per-call 开独立连接、自己 `BEGIN IMMEDIATE`；若在调用方尚未提交的写事务内调用会与那把
锁循环等待——不是「窗口小所以问题不大」，是结构性死锁。调用方必须在 `library_append` /
`library_write` 的写事务 **commit 之后**再调用本函数。通知路径绝不影响写入结果，本函数
整段吞异常 + warning。
"""

from __future__ import annotations

from loguru import logger

from src.notify.center import NotifyCenter


def notify_library_file_written(db_path: str, *, file_id: int, rel_path: str) -> None:
    """无人值守写完一个资料库文件后发一条 results/info 通知。

    dedupe_key 固定为 ``library_file:{file_id}``——同一文件被同一 run 或后续 run 反复
    追加/覆写时聚合计次到同一活跃行（NotifyCenter 的 recurrence_no 承担「第几次」），
    不刷屏。payload 的 `link` 形状是 `{"type": "library", "fileId": file_id}`——
    `fileId` 对应 TS 侧 `NotificationLink` 判别 union 的 `library` 型（design §9.5
    深链：`/library?file={id}`）。

    title 文案沿用 `.library-epic/i18n-keys.md` 保留的 ``library.notify.libraryTitle``
    的 zh-CN 值（「Agent 写了资料库文件」）——但这里仍是 Python 硬编码字符串，不是
    `t()` 调用：通知 title/body 从进库那一刻起就是后端产出的定型文本（`NotifyCenter`
    现有 8 个信源无一例外，见 notification-center.md §6），前端只原样展示 `item.title`，
    没有按 `source` 换 `t()` key 的投影层。是否要为 library 型另建一层前端 i18n
    投影是本函数职责之外的决定，已记在 `.library-epic/i18n-requests-notify.md`，
    留给 i18n lane 判断。
    """
    try:
        NotifyCenter(db_path).publish(
            category="results",
            source="library",
            severity="info",
            title="Agent 写了资料库文件",
            body=f"已写入 {rel_path}",
            dedupe_key=f"library_file:{file_id}",
            payload={"link": {"type": "library", "fileId": file_id}},
        )
    except Exception as e:  # noqa: BLE001 — 通知路径绝不影响写入结果
        logger.warning(f"[library] notify_center publish failed: {e}")
