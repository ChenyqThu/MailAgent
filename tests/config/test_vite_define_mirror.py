"""T1 — vite define 双镜像守卫（E3 WP1）。

背景：cutover 期的 chat flag 曾用 `__MAILAGENT_*__` 编译常量注入 renderer，且
electron.vite.config.ts 与 vite.web.config.ts **各持一份手抄镜像**。漏改一份 → 两宿主
（Electron renderer / 远程 web）行为分叉。S3（07-02）已把这些 flag define 全删，两侧的
「flag 镜像」子集现都为空 —— 本测试今天平凡绿，守的是**将来有人往单侧复活 flag define**
的分叉（openness 家族按设计全走 main-env-only 无 vite define，任何 renderer flag define
都应两侧成对出现）。

构建标识 define（__GIT_HASH__ / __BUILD_TIME__ / VITE_BUILD_TARGET / NODE_ENV）本就是
per-host 的，不参与 flag 对账（见 _parsers.flag_define_keys）。
"""

import pytest

from . import _parsers as p


def _skip_if_absent():
    if not (p.ELECTRON_VITE.exists() and p.WEB_VITE.exists()):
        pytest.skip("frontend vite 配置缺失（无 frontend checkout）")


def test_flag_define_keys_mirrored():
    _skip_if_absent()
    electron_all = p.parse_vite_define_keys(p.ELECTRON_VITE)
    web_all = p.parse_vite_define_keys(p.WEB_VITE)

    # canary：解析器若失效返回空集，会让下面的对账平凡通过。断言两份都抽到了各自已知的
    # 构建标识 define —— 抽不到 = 解析器坏了，立刻红。
    assert "__GIT_HASH__" in electron_all, (
        "electron.vite.config.ts 没抽到 __GIT_HASH__ define —— _DEFINE_KEY_RE 需更新"
    )
    assert "import.meta.env.VITE_BUILD_TARGET" in web_all, (
        "vite.web.config.ts 没抽到 VITE_BUILD_TARGET define —— _DEFINE_KEY_RE 需更新"
    )

    electron_flags = p.flag_define_keys(electron_all)
    web_flags = p.flag_define_keys(web_all)

    assert electron_flags == web_flags, (
        "vite define 的 flag 镜像子集在两宿主间分叉：\n"
        f"  electron 独有：{sorted(electron_flags - web_flags)}\n"
        f"  web 独有：{sorted(web_flags - electron_flags)}\n"
        "任何注入 renderer 的 flag define 必须在 electron.vite.config.ts 与 "
        "vite.web.config.ts 两份里成对出现（否则两宿主行为分叉）。"
    )
