"""T6 — 凭据类 env 豁免必须**对用户可见**（issue #64 方向 4）。

问题：`env_only_reads_allowlist.txt` 豁免的是「允许裸 `os.getenv`、不进 pydantic
config」。对凭据来说这个豁免完全合理 —— 凭据不该进配置对象。**但它一并豁免掉了
「用户如何知道要配它」**：这两件事在原机制里是耦合的，而只有前者被评审看着。

issue #64 就是这个耦合的产物：v1.19.1 新引入的 `MAILAGENT_BULK_CLIENT_ID` / `_SECRET`
登记进了豁免清单、写进了 `.env.example`（注释行），然后 —— `.env.example` **只对新装
用户有效**。已有用户的 `.env` 是历史累积的真文件，不会因示例更新而同步。于是每个从
≤v1.19.0 升上来且开了 KOS 入库的用户都必然缺这两个键、必然看不到新看板，且没有任何
线索指向原因（gate 不满足时整区 `return null`）。

对照组说明了差别在哪：`KOS_OAUTH_CLIENT_ID` / `_SECRET` 同样在这份豁免清单里，但用户
几乎不会漏配 —— 因为 设置 → 集成 → 知识大脑 那一区有 `EnvField` 摆着。**差别不在治理
机制，只在有没有 UI 入口。**

本测试把那条缺失的约束机器化：**「D. credential」小节里的键，必须在 `.env.example`
（未注释）或 Settings UI（`MANAGED_ENV_KEYS`）中至少可见其一。**

为什么只管 D 小节：其余小节按定义就不该对用户可见 —— A 是父进程 spawn 时注入的、
B 是部署路径覆盖、C 是 dev/安全旁路、E/F/G 是子系统内部约定与诊断开关。对它们要求
「摆进设置面」是反的。

为什么「未注释」才算数：注释掉的示例行对已有安装等于不存在（正是上面那条链）。
反过来，凭据行**不该**取消注释 —— `# KOS_OAUTH_CLIENT_ID=gbrain_cl_xxxx` 这种占位值
一旦生效，存在性判据会判成「已配置」，gate 说 active 而实际推送全数鉴权失败，比缺席
更糟。所以凭据的正确出路就是 UI 入口这一支。
"""

from pathlib import Path
from typing import Set

from . import _parsers as p

_HERE = Path(__file__).resolve().parent
_EXEMPT_BASELINE = _HERE / "env_visibility_exempt_baseline.txt"

# 豁免清单里「凭据」小节的字母（见 env_only_reads_allowlist.txt 的小节标题）。
_CREDENTIAL_SECTION = "D"


def _load_baseline(path: Path) -> Set[str]:
    keys: Set[str] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            keys.add(line)
    return keys


def test_credential_env_keys_are_visible_somewhere():
    sections = p.parse_allowlist_sections()
    credentials = sections.get(_CREDENTIAL_SECTION, [])
    # canary：小节解析坏了 → 无对象可比 → 平凡绿。
    assert len(credentials) > 5, (
        f"「{_CREDENTIAL_SECTION}. credential」小节只解析到 {len(credentials)} 个键"
        "（预期 >5）—— 小节标题格式变了, 解析器需更新"
    )

    managed = p.parse_managed_env_keys()
    assert len(managed) > 50, (
        f"MANAGED_ENV_KEYS 只解析到 {len(managed)} 个键（预期 >50）—— TS 解析器坏了"
    )
    env_active = p.parse_env_example_active_keys()
    assert len(env_active) > 10, (
        f".env.example 未注释键只解析到 {len(env_active)} 个（预期 >10）—— 正则坏了"
    )

    baseline = _load_baseline(_EXEMPT_BASELINE)
    invisible = sorted(
        key for key in credentials
        if key not in managed and key not in env_active and key not in baseline
    )
    assert not invisible, (
        "以下凭据键登记了 env-direct 豁免, 但用户在任何地方都看不到它需要被配置：\n"
        + "\n".join(f"  {k}" for k in invisible)
        + "\n→ 首选: 给它 UI 入口（frontend/.../env-keys.ts 的 MANAGED_ENV_KEYS + 对应 "
        "Settings Tab 的 <EnvField>），这是 issue #64 的正解。\n"
        "  次选: 在 .env.example 里**未注释**地列出（仅适用于非凭据 —— 占位凭据值会让"
        "存在性判据误判成已配置）。\n"
        "  确属外部注入 / 用户不该配的, 评审后登记进 "
        "tests/config/env_visibility_exempt_baseline.txt（附理由）。"
    )


def test_visibility_baseline_is_ratchet():
    """baseline 只减不增：键一旦有了可见入口, 该从这里删行。"""
    baseline = _load_baseline(_EXEMPT_BASELINE)
    managed = p.parse_managed_env_keys()
    env_active = p.parse_env_example_active_keys()

    stale = sorted(baseline & (managed | env_active))
    assert not stale, (
        "visibility-baseline 里这些键其实已经可见（UI 或未注释的 .env.example），"
        "应删行（ratchet 收缩）：\n" + "\n".join(f"  {k}" for k in stale)
    )

    sections = p.parse_allowlist_sections()
    credentials = set(sections.get(_CREDENTIAL_SECTION, []))
    orphan = sorted(baseline - credentials)
    assert not orphan, (
        "visibility-baseline 里这些键已不在豁免清单的凭据小节里（可能已收编 pydantic），"
        "应删行：\n" + "\n".join(f"  {k}" for k in orphan)
    )


def test_issue_64_keys_are_covered():
    """🔴 回归钉子：issue #64 的两个正主必须真的可见。

    没有这条, 上面那个测试在「谁把它们从豁免清单删了」时会平凡绿 —— 而键仍在被直读、
    用户仍然看不见。
    """
    managed = p.parse_managed_env_keys()
    for key in ("MAILAGENT_BULK_CLIENT_ID", "MAILAGENT_BULK_CLIENT_SECRET"):
        assert key in managed, (
            f"{key} 不在 MANAGED_ENV_KEYS —— issue #64 的 UI 入口没了, "
            "升级用户又会回到「看板整区消失且零线索」"
        )
