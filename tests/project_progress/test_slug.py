"""slug.py 单元测试"""

from src.project_progress.slug import MAX_SLUG_LEN, slugify


def test_pure_ascii():
    assert slugify("Omada SDN Controller V6.3") == "omada-sdn-controller-v6-3"
    assert slugify("Hello_World") == "hello-world"
    assert slugify("  Trim Me!  ") == "trim-me"
    assert slugify("A-B-C") == "a-b-c"


def test_case_insensitive():
    # 大小写被标准化，但内容保留
    assert slugify("ABC") == "abc"


def test_chinese_fallback_has_hash_suffix():
    # 中英混合：保留 ascii 部分 + 短 hash
    s = slugify("EAP725-Wall(EU)2.0-适配Controller 6.1")
    assert s.startswith("eap725-wall-eu-2-0-controller-6-1-")
    assert len(s.split("-")[-1]) == 6


def test_chinese_only_goes_proj_fallback():
    s = slugify("纯中文项目名")
    assert s.startswith("proj-")
    assert len(s) >= 10


def test_empty_input():
    s = slugify("")
    assert s.startswith("proj-")
    s2 = slugify("   ")
    assert s2.startswith("proj-")
    s3 = slugify(None)  # type: ignore[arg-type]
    assert s3.startswith("proj-")


def test_truncation():
    long = "A" * 200
    assert len(slugify(long)) <= MAX_SLUG_LEN
    long2 = "A" * 200 + "中文"
    assert len(slugify(long2)) <= MAX_SLUG_LEN


def test_stability():
    name = "EAP725-Wall(EU)2.0-适配Controller 6.1"
    assert slugify(name) == slugify(name)


def test_different_cjk_names_not_collide():
    # 两个相同 ascii 前缀但不同中文的项目名必须产生不同 slug
    a = slugify("EAP725-Wall(EU)2.0-适配Controller 6.1")
    b = slugify("EAP725-Wall(EU)2.0-适配Controller 6.3")
    assert a != b


def test_case_only_diff_collides_in_pure_ascii():
    # 纯 ASCII 情况下只有大小写差异 → slug 相同（合理）
    # 此时由 xlsx_parser._resolve_slug_collisions 补上 hash 后缀
    assert slugify("Gateway v6.2 Features") == slugify("Gateway V6.2 Features")
