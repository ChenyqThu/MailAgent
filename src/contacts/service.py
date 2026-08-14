"""通讯录写面单源 (task 08-13 WP1)。

🔴 contact / contact_email / contact_email_link 三表的**写侧单源在本模块** ——
matters 侧 (`src/matters/service.py::_upsert_contact`) 保留薄包装、底层调这里;
将来 REST / gateway 工具 / 治理台全部走同一组函数, 不许各写一份 UPDATE。

设计要点 (PRD §3.1/§3.7):
- 身份判据只有归一 email; 永不按名字自动合并。
- 合并 = 账本零搬动 (改 ``contact_email.contact_id`` 指 winner + loser 落
  ``merged_into`` 墓碑), stakeholder 与 manager 引用改指 winner。
- 🔒 「主邮箱永不为曾用」收在**一个守卫函数** ``_email_status_guard`` 里:
  set_primary 顺带清空目标地址的 former_at; mark_former 对主邮箱直接拒绝。
  人工菜单与 agent 建议都必须走它。
- 聚合缓存 (mail_count 等) 恒可从账本重算 (``recalc_contact_aggregates``),
  不是第二真源。
"""

from __future__ import annotations

import json
import re
import sqlite3
from typing import Any, Dict, FrozenSet, Iterable, Mapping, Optional

from src.contacts.taxonomy import (
    CONTACT_FUNCTION_VALUES,
    CONTACT_KIND_VALUES,
    CONTACT_LOCKABLE_FIELDS,
    CONTACT_MANAGER_SRC_VALUES,
    CONTACT_SENIORITY_VALUES,
    derive_function,
    derive_seniority,
)

# 与 matters `_CONTACT_EMAIL_RE` 同判据 (那份随 WP3 退役后本处成为唯一)。
CONTACT_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


class ContactError(Exception):
    """通讯录域错误 (code + message, 镜像 MatterError 的形状)。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def normalize_email(raw: Any) -> Optional[str]:
    """trim+lower 归一; 非法形状返回 None (与 matters 提取同判据)。"""
    email = str(raw or "").strip().lower()
    if not email or not CONTACT_EMAIL_RE.match(email):
        return None
    return email


def parse_self_emails(raw: Any) -> FrozenSet[str]:
    """`MAILAGENT_SELF_EMAILS` (逗号分隔) → 归一地址集; 非法项静默丢弃。"""
    out = set()
    for part in str(raw or "").split(","):
        email = normalize_email(part)
        if email:
            out.add(email)
    return frozenset(out)


def resolve_self_addresses(
    conn: sqlite3.Connection, *,
    user_email: Optional[str] = None, extra_raw: Optional[str] = None,
) -> FrozenSet[str]:
    """owner 自有地址集 = USER_EMAIL + MAILAGENT_SELF_EMAILS + 库内 is_self=1
    联系人的全部锚点。参数不传时才读全局 settings (测试可注入)。"""
    if user_email is None or extra_raw is None:
        from src.config import config as _settings

        if user_email is None:
            user_email = getattr(_settings, "user_email", "")
        if extra_raw is None:
            extra_raw = getattr(_settings, "self_emails", "")
    out = set(parse_self_emails(extra_raw))
    own = normalize_email(user_email)
    if own:
        out.add(own)
    for row in conn.execute(
        "SELECT ce.email_normalized FROM contact_email ce "
        "JOIN contact c ON c.id = ce.contact_id WHERE c.is_self = 1"
    ):
        out.add(str(row[0]))
    return frozenset(out)


# ==================== upsert (matters 写穿的底座) ====================

def get_contact_id_for_email(conn: sqlite3.Connection, email: str) -> Optional[int]:
    row = conn.execute(
        "SELECT contact_id FROM contact_email WHERE email_normalized=?", (email,)
    ).fetchone()
    return int(row[0]) if row else None


def upsert_contact_for_email(
    conn: sqlite3.Connection, *, email: str, now: int,
    display_name: Optional[str] = None, organization: Optional[str] = None,
    fallback_display_name: Optional[str] = None,
    fallback_organization: Optional[str] = None,
) -> int:
    """按归一 email 找人→写人, 返回 contact_id (v52 `_upsert_contact` 的等价语义,
    只把「一邮箱一行」升级为「经 contact_email 锚点找人」——多邮箱下也命中同一人)。

    提供的非空姓名/组织 = 最后写者赢 (全局一份: 改名就是全局改名); 传 None = 不动
    既有值。``fallback_*`` = **只在新建这条联系人时**顶上的值 —— 🔴 有意不进已存在
    分支: 目标邮箱可能已经是另一个人的全局联系人, 拿本行的名字盖上去 = 悄悄把
    别人改名了 (v52 红字原样继承)。
    """
    contact_id = get_contact_id_for_email(conn, email)
    if contact_id is not None:
        conn.execute(
            "UPDATE contact SET "
            "display_name = COALESCE(?, display_name), "
            "organization = COALESCE(?, organization), "
            "updated_at = ? WHERE id = ?",
            (display_name, organization, now, contact_id),
        )
        return contact_id
    cursor = conn.execute(
        "INSERT INTO contact (display_name, organization, created_at, updated_at) "
        "VALUES (?, ?, ?, ?)",
        (
            display_name or fallback_display_name,
            organization or fallback_organization,
            now, now,
        ),
    )
    contact_id = int(cursor.lastrowid)
    conn.execute(
        "INSERT INTO contact_email (contact_id, email_normalized, is_primary, created_at) "
        "VALUES (?, ?, 1, ?)",
        (contact_id, email, now),
    )
    return contact_id


# ==================== 治理写面 (WP1: service 层, 无 REST/UI) ====================

def _require_contact(conn: sqlite3.Connection, contact_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM contact WHERE id=?", (contact_id,)).fetchone()
    if row is None:
        raise ContactError("E_CONTACT_NOT_FOUND", f"contact {contact_id} not found")
    return row


def _require_live_contact(conn: sqlite3.Connection, contact_id: int) -> sqlite3.Row:
    row = _require_contact(conn, contact_id)
    if row["merged_into"] is not None:
        raise ContactError(
            "E_CONTACT_MERGED",
            f"contact {contact_id} was merged into {row['merged_into']}",
        )
    return row


def hide_contact(
    conn: sqlite3.Connection, contact_id: int, *, hidden: bool, now: int,
) -> None:
    """隐藏/取消隐藏 (不删数据, 读侧默认过滤; 可逆)。"""
    _require_live_contact(conn, contact_id)
    conn.execute(
        "UPDATE contact SET hidden_at=?, updated_at=? WHERE id=?",
        (now if hidden else None, now, contact_id),
    )


def set_kind(conn: sqlite3.Connection, contact_id: int, kind: str, *, now: int) -> None:
    """owner 改判 kind。置 ``kind_locked_at`` —— 此后 L0 启发式不再翻转
    (锁定机制, 对应 PRD §3.4「可被 owner 手动改判」+ 改判不被自动打标冲掉)。"""
    if kind not in CONTACT_KIND_VALUES:
        raise ContactError("E_INVALID_KIND", f"kind must be one of {CONTACT_KIND_VALUES}")
    _require_live_contact(conn, contact_id)
    conn.execute(
        "UPDATE contact SET kind=?, kind_locked_at=?, updated_at=? WHERE id=?",
        (kind, now, now, contact_id),
    )


def set_is_self(
    conn: sqlite3.Connection, contact_id: int, *, is_self: bool, now: int,
) -> None:
    """标/去标 owner 自有地址。is_self=1 的联系人从列表与画像队列排除 (§3.4),
    其锚点进 ``resolve_self_addresses`` 的自有地址集 (后续扫描按 self 处理);
    既有账本行保留 (数据不删), 聚合口径由下次校准收敛。"""
    _require_live_contact(conn, contact_id)
    conn.execute(
        "UPDATE contact SET is_self=?, updated_at=? WHERE id=?",
        (1 if is_self else 0, now, contact_id),
    )


# ==================== 字段级锁定 + 身份字段编辑 (WP2, v55) ====================

#: 直落 contact 表列的可锁字段 (phone 落 contact_info_json.phone, 单独处理)。
_IDENTITY_COLUMN_FIELDS = (
    "display_name", "name_en", "organization", "department", "role_title",
)


def parse_identity_locks(raw: Any) -> Dict[str, int]:
    """``contact.identity_locks_json`` → {field: epoch_ms}。容错解析: 非法形状 /
    词表外键 / 非整数值全部丢弃 (锁是便利语义, 坏数据按无锁, 不炸读路径)。"""
    if not raw:
        return {}
    try:
        data = json.loads(raw) if isinstance(raw, str) else dict(raw)
    except (TypeError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    out: Dict[str, int] = {}
    for key, value in data.items():
        if key in CONTACT_LOCKABLE_FIELDS:
            try:
                out[str(key)] = int(value)
            except (TypeError, ValueError):
                continue
    return out


def _write_identity_locks(
    conn: sqlite3.Connection, contact_id: int, locks: Dict[str, int], *, now: int,
) -> None:
    """锁映射的**唯一写径** (v55): ``identity_locks_json`` 是真源;
    ``identity_locked_at`` 降级为聚合派生 (= 锁映射 MAX, 无锁 NULL), 只供老读侧
    (scanner fallback / 历史查询) 兼容, 不许旁路 UPDATE。"""
    payload = (
        json.dumps({k: int(v) for k, v in sorted(locks.items())})
        if locks else None
    )
    aggregate = max(locks.values()) if locks else None
    conn.execute(
        "UPDATE contact SET identity_locks_json=?, identity_locked_at=?, "
        "updated_at=? WHERE id=?",
        (payload, aggregate, now, contact_id),
    )


def set_field_lock(
    conn: sqlite3.Connection, contact_id: int, field: str, *,
    locked: bool, now: int,
) -> Dict[str, int]:
    """显式加锁/解锁一个字段 (档案页锁 pill 的写面)。解锁 = 删映射键。"""
    if field not in CONTACT_LOCKABLE_FIELDS:
        raise ContactError(
            "E_INVALID_FIELD", f"field must be one of {CONTACT_LOCKABLE_FIELDS}",
        )
    row = _require_live_contact(conn, contact_id)
    locks = parse_identity_locks(row["identity_locks_json"])
    if locked:
        locks[field] = now
    else:
        locks.pop(field, None)
    _write_identity_locks(conn, contact_id, locks, now=now)
    return locks


def _normalize_field_value(value: Any) -> Optional[str]:
    text = str(value).strip() if value is not None else ""
    return text or None


def update_identity_fields(
    conn: sqlite3.Connection, contact_id: int, fields: Mapping[str, Any], *,
    now: int,
) -> Dict[str, Any]:
    """身份字段编辑 (REST PATCH 的写面, 设计 §2.2「点击即改, 改后锁定」)。

    - 除 ``notes`` 外, 本次提供的字段**保存即落锁** (含清空 —— 清空 + 锁 =
      「别再自动填回来」)。
    - ``function`` / ``seniority`` 校验枚举 (None/空 = 清空)。
    - ``phone`` 物理落 ``contact_info_json.phone``。
    - ``role_title`` 变更时对**未锁且本次未显式提供**的 function/seniority 做
      词表派生 (派生是自动来源: 不落锁, 锁着的不碰 —— 主 session 裁决项 4)。
    """
    unknown = set(fields) - set(CONTACT_LOCKABLE_FIELDS) - {"notes"}
    if unknown:
        raise ContactError(
            "E_INVALID_FIELD", f"unknown fields: {sorted(unknown)}",
        )
    row = _require_live_contact(conn, contact_id)
    locks = parse_identity_locks(row["identity_locks_json"])

    sets: list = []
    params: list = []
    changed: Dict[str, Any] = {}

    for field in _IDENTITY_COLUMN_FIELDS:
        if field in fields:
            value = _normalize_field_value(fields[field])
            sets.append(f"{field} = ?")
            params.append(value)
            changed[field] = value
            locks[field] = now

    for field, values in (
        ("function", CONTACT_FUNCTION_VALUES),
        ("seniority", CONTACT_SENIORITY_VALUES),
    ):
        if field in fields:
            value = _normalize_field_value(fields[field])
            if value is not None and value not in values:
                raise ContactError(
                    "E_INVALID_ARG", f"{field} must be one of {values}",
                )
            sets.append(f"{field} = ?")
            params.append(value)
            changed[field] = value
            locks[field] = now

    if "phone" in fields:
        value = _normalize_field_value(fields["phone"])
        try:
            info = (
                json.loads(row["contact_info_json"])
                if row["contact_info_json"] else {}
            )
        except (TypeError, ValueError):
            info = {}
        if not isinstance(info, dict):
            info = {}
        if value is None:
            info.pop("phone", None)
        else:
            info["phone"] = value
        sets.append("contact_info_json = ?")
        params.append(json.dumps(info, ensure_ascii=False) if info else None)
        changed["phone"] = value
        locks["phone"] = now

    if "notes" in fields:
        raw_notes = fields["notes"]
        notes = str(raw_notes) if raw_notes is not None else None
        if notes is not None and not notes.strip():
            notes = None
        sets.append("notes = ?")
        params.append(notes)
        changed["notes"] = notes  # 手记无锁 (词表外, 自动提取从不写它)

    if "role_title" in fields:
        title = changed.get("role_title")
        if "function" not in fields and "function" not in locks:
            derived = derive_function(title)
            sets.append("function = ?")
            params.append(derived)
            changed["function"] = derived
        if "seniority" not in fields and "seniority" not in locks:
            derived = derive_seniority(title)
            sets.append("seniority = ?")
            params.append(derived)
            changed["seniority"] = derived

    if sets:
        sets.append("updated_at = ?")
        params.append(now)
        conn.execute(
            f"UPDATE contact SET {', '.join(sets)} WHERE id = ?",
            (*params, contact_id),
        )
    _write_identity_locks(conn, contact_id, locks, now=now)
    return {"fields": changed, "locks": locks}


def _email_status_guard(
    conn: sqlite3.Connection, contact_id: int, email: str, action: str, now: int,
) -> None:
    """🔒 曾用邮箱不变量的**唯一守卫** (PRD §3.7): 主邮箱永不为曾用。

    - ``set_primary``: 换主邮箱, **顺带清空目标地址的 former_at** (菜单文案
      「设为主邮箱 (并恢复在用)」的双重效果), 其余锚点降级非主。
    - ``mark_former``: 对主邮箱**直接拒绝** (先换主邮箱); 其余置 former_at。
    - ``unmark_former``: 恢复在用 (可逆)。
    人工菜单与 agent 建议 (WP7) 都必须走这里, 不许旁路 UPDATE。
    """
    normalized = normalize_email(email)
    if normalized is None:
        raise ContactError("E_INVALID_EMAIL", f"invalid email: {email!r}")
    _require_live_contact(conn, contact_id)
    row = conn.execute(
        "SELECT id, is_primary FROM contact_email "
        "WHERE contact_id=? AND email_normalized=?",
        (contact_id, normalized),
    ).fetchone()
    if row is None:
        raise ContactError(
            "E_CONTACT_EMAIL_NOT_FOUND",
            f"{normalized} is not an anchor of contact {contact_id}",
        )
    if action == "set_primary":
        conn.execute(
            "UPDATE contact_email SET is_primary=0 WHERE contact_id=? AND id<>?",
            (contact_id, row["id"]),
        )
        conn.execute(
            "UPDATE contact_email SET is_primary=1, former_at=NULL WHERE id=?",
            (row["id"],),
        )
    elif action == "mark_former":
        if row["is_primary"]:
            raise ContactError(
                "E_PRIMARY_EMAIL_CANNOT_BE_FORMER",
                "主邮箱不能标为曾用 —— 先把主邮箱换到其它地址",
            )
        conn.execute(
            "UPDATE contact_email SET former_at=? WHERE id=?", (now, row["id"]),
        )
    elif action == "unmark_former":
        conn.execute(
            "UPDATE contact_email SET former_at=NULL WHERE id=?", (row["id"],),
        )
    else:  # pragma: no cover - 内部枚举, 不可达
        raise ContactError("E_INVALID_ACTION", f"unknown email action {action!r}")
    conn.execute(
        "UPDATE contact SET updated_at=? WHERE id=?", (now, contact_id),
    )


def set_primary_email(
    conn: sqlite3.Connection, contact_id: int, email: str, *, now: int,
) -> None:
    _email_status_guard(conn, contact_id, email, "set_primary", now)


def mark_email_former(
    conn: sqlite3.Connection, contact_id: int, email: str, *, now: int,
) -> None:
    _email_status_guard(conn, contact_id, email, "mark_former", now)


def unmark_email_former(
    conn: sqlite3.Connection, contact_id: int, email: str, *, now: int,
) -> None:
    _email_status_guard(conn, contact_id, email, "unmark_former", now)


# ==================== 组织关系 (WP5: manager 一侧存储) ====================

#: 环检测上溯步数上限 —— 正常链远小于此; 脏数据成环时防死循环 (防御的是库内
#: 既有坏数据, 不是本函数自己的写入)。
MANAGER_CHAIN_HOP_CAP = 1000


def set_manager(
    conn: sqlite3.Connection,
    contact_id: int,
    manager_contact_id: Optional[int],
    *,
    src: str,
    now_ms: int,
) -> None:
    """设置/解除上级 (设计 §2.2.1: 🔒 只存一侧, 下级用 WHERE manager_contact_id=?
    反查, 不双写、不建中间表)。「添加下级」= 对下级那行调本函数。

    - ``manager_contact_id=None`` = 解除 (``manager_src`` 一并清 NULL)。
    - 守卫: ① 自指拒绝; ② **完整链路环检测** —— 沿新上级的 manager 链上溯,
      撞到 contact_id 即拒 (hop 上限防脏数据死循环); ③ 两侧都必须是在册
      非墓碑联系人; ④ src ∈ CONTACT_MANAGER_SRC_VALUES。
    - manager 不进锁词表: ``manager_src='manual'`` 即锁语义 (WP6 的 auto 建议
      对 manual 行不覆写)。不走 update_identity_fields。
    """
    if src not in CONTACT_MANAGER_SRC_VALUES:
        raise ContactError(
            "E_INVALID_ARG",
            f"manager src must be one of {CONTACT_MANAGER_SRC_VALUES}",
        )
    _require_live_contact(conn, contact_id)
    if manager_contact_id is None:
        conn.execute(
            "UPDATE contact SET manager_contact_id=NULL, manager_src=NULL, "
            "updated_at=? WHERE id=?",
            (now_ms, contact_id),
        )
        return
    if manager_contact_id == contact_id:
        raise ContactError(
            "E_MANAGER_SELF", "a contact cannot be their own manager"
        )
    _require_live_contact(conn, manager_contact_id)
    # 环检测: 从新上级沿 manager 链上溯, 撞到 contact_id = 成环。
    cursor: Optional[int] = manager_contact_id
    for _ in range(MANAGER_CHAIN_HOP_CAP):
        if cursor is None:
            break
        if cursor == contact_id:
            raise ContactError(
                "E_MANAGER_CYCLE",
                f"setting manager {manager_contact_id} on contact "
                f"{contact_id} would create a reporting cycle",
            )
        row = conn.execute(
            "SELECT manager_contact_id FROM contact WHERE id=?", (cursor,)
        ).fetchone()
        cursor = (
            int(row["manager_contact_id"])
            if row is not None and row["manager_contact_id"] is not None
            else None
        )
    else:
        # 上限内没走到链头 = 库里已有环/超深脏链, 保守拒绝 (不写入新边)。
        raise ContactError(
            "E_MANAGER_CYCLE",
            f"manager chain of {manager_contact_id} exceeds "
            f"{MANAGER_CHAIN_HOP_CAP} hops (existing bad data?)",
        )
    conn.execute(
        "UPDATE contact SET manager_contact_id=?, manager_src=?, updated_at=? "
        "WHERE id=?",
        (manager_contact_id, src, now_ms, contact_id),
    )


def merge_contacts(
    conn: sqlite3.Connection, winner_id: int, loser_id: int, *, now: int,
    primary_email: Optional[str] = None,
    former_emails: Iterable[str] = (),
    self_addresses: Optional[FrozenSet[str]] = None,
) -> None:
    """人级合并 (换邮箱主场景)。🔴 账本零搬动: 只改 ``contact_email.contact_id``
    指 winner; ``contact_email_link`` 一行不动 (账本挂 contact_email 的设计红利)。

    主邮箱/曾用**按入参写** (预览页勾选结果; 默认值推导是 UI 层职责 §3.7 ——
    服务端不由「来源于被并方」推断), 全部走 ``_email_status_guard`` 同一守卫。
    loser 落 ``merged_into`` 墓碑 (保留行以便审计/撤销, 读侧过滤); winner 聚合
    从账本重算 (缓存不是第二真源)。
    """
    if winner_id == loser_id:
        raise ContactError("E_MERGE_SELF", "cannot merge a contact into itself")
    _require_live_contact(conn, winner_id)
    _require_live_contact(conn, loser_id)
    # ① 邮箱锚点改指 winner; loser 侧的主邮箱标记清掉 (winner 的主邮箱保持权威,
    #    除非入参显式换)。账本 (contact_email_link) 一行不动。
    conn.execute(
        "UPDATE contact_email SET contact_id=?, is_primary=0 WHERE contact_id=?",
        (winner_id, loser_id),
    )
    # ② stakeholder 引用改指 winner (含软删行 —— 审计视角同一个人)。
    #    同一事项双行冲突的「二选一」提示是 UI 层职责 (WP3), 数据层不静默合并角色。
    conn.execute(
        "UPDATE matter_stakeholder SET contact_id=?, updated_at=? WHERE contact_id=?",
        (winner_id, now, loser_id),
    )
    # ③ manager 引用改指 winner (§3.7 与 stakeholder 引用改挂同一批); 若因此出现
    #    自指 (winner 的上级本来是 loser) → 清 NULL。
    conn.execute(
        "UPDATE contact SET manager_contact_id=?, updated_at=? WHERE manager_contact_id=?",
        (winner_id, now, loser_id),
    )
    conn.execute(
        "UPDATE contact SET manager_contact_id=NULL WHERE id=? AND manager_contact_id=?",
        (winner_id, winner_id),
    )
    # ④ loser 墓碑 (数据保留; 聚合快照留作审计, 读侧按 merged_into 过滤)。
    conn.execute(
        "UPDATE contact SET merged_into=?, updated_at=? WHERE id=?",
        (winner_id, now, loser_id),
    )
    # ⑤ 主邮箱/曾用按预览勾选写, 同一守卫。
    if primary_email:
        _email_status_guard(conn, winner_id, primary_email, "set_primary", now)
    for former in former_emails:
        _email_status_guard(conn, winner_id, former, "mark_former", now)
    # ⑥ winner 聚合缓存从账本重算。
    if self_addresses is None:
        self_addresses = resolve_self_addresses(conn)
    recalc_contact_aggregates(conn, winner_id, self_addresses=self_addresses, now=now)


# ==================== 聚合缓存校准 (账本恒可重算) ====================

def _sent_predicate(self_addresses: FrozenSet[str]) -> tuple[str, list]:
    """出向判据: 邮件 sender (裸地址, 归一后) ∈ 自有地址集。"""
    if not self_addresses:
        return "0", []
    placeholders = ", ".join("?" for _ in self_addresses)
    return (
        f"lower(trim(COALESCE(m.sender, ''))) IN ({placeholders})",
        sorted(self_addresses),
    )


def recalc_contact_aggregates(
    conn: sqlite3.Connection, contact_id: int, *,
    self_addresses: FrozenSet[str], now: int,
) -> None:
    """从账本重算一个联系人的聚合缓存 (锚点级 + 人级)。幂等, backfill/合并共用。"""
    conn.execute(
        "UPDATE contact_email SET "
        "mail_count = (SELECT COUNT(DISTINCT l.internal_id) "
        "  FROM contact_email_link l WHERE l.email_id = contact_email.id), "
        "first_seen_at = (SELECT MIN(l.seen_at) FROM contact_email_link l "
        "  WHERE l.email_id = contact_email.id AND l.seen_at IS NOT NULL), "
        "last_seen_at = (SELECT MAX(l.seen_at) FROM contact_email_link l "
        "  WHERE l.email_id = contact_email.id) "
        "WHERE contact_id = ?",
        (contact_id,),
    )
    sent_sql, sent_params = _sent_predicate(self_addresses)
    row = conn.execute(
        "SELECT COUNT(DISTINCT l.internal_id) AS mail_count, "
        "  MIN(l.seen_at) AS first_seen_at, MAX(l.seen_at) AS last_seen_at "
        "FROM contact_email_link l "
        "JOIN contact_email ce ON ce.id = l.email_id WHERE ce.contact_id = ?",
        (contact_id,),
    ).fetchone()
    sent_row = conn.execute(
        "SELECT COUNT(DISTINCT l.internal_id) AS sent_to_count "
        "FROM contact_email_link l "
        "JOIN contact_email ce ON ce.id = l.email_id "
        "JOIN email_metadata m ON m.internal_id = l.internal_id "
        f"WHERE ce.contact_id = ? AND l.role IN ('to', 'cc') AND {sent_sql}",
        (contact_id, *sent_params),
    ).fetchone()
    conn.execute(
        "UPDATE contact SET mail_count=?, sent_to_count=?, "
        "first_seen_at=?, last_seen_at=?, updated_at=? WHERE id=?",
        (
            int(row["mail_count"] or 0),
            int(sent_row["sent_to_count"] or 0),
            row["first_seen_at"], row["last_seen_at"], now, contact_id,
        ),
    )


def recalc_all_aggregates(
    conn: sqlite3.Connection, *,
    self_addresses: Optional[FrozenSet[str]] = None, now: int,
) -> int:
    """全量重算聚合缓存 (CLI `contact backfill` 的校准入口)。返回联系人数。"""
    if self_addresses is None:
        self_addresses = resolve_self_addresses(conn)
    contact_ids = [
        int(r[0]) for r in conn.execute("SELECT id FROM contact ORDER BY id")
    ]
    for contact_id in contact_ids:
        recalc_contact_aggregates(
            conn, contact_id, self_addresses=self_addresses, now=now,
        )
    return len(contact_ids)
