"""Tests for src.converter.vision_ocr (批次4 PR-G).

覆盖:
    - 懒 import 软着陆 (缺 pyobjc → (None,None,None) + 一次性 warning, 不崩)
    - ocr_available / ocr_image_file / ocr_pdf_file 在 Vision 不可用时返 None
    - 护栏: _compute_render_scale (4096px 长边上限) + PDF 页数上限截断 (mock 页级 OCR)
    - 真 Vision 冒烟 (skipif Vision 不可用): 生成中英文图片 → OCR → 断言文本

CI (macos-14) 装 pyobjc 但不保证 Vision 识别可用 (无 GUI session), 真识别测试
自动 skip 不红; mock 层测试恒跑。
"""

from __future__ import annotations

import builtins
from pathlib import Path

import pytest

from src.converter import vision_ocr


# ---- 真 Vision 可用性探测 (真识别冒烟用) ----------------------------------

def _vision_recognizes() -> bool:
    """探测系统 Vision 能否真识别 (import 通 + 一张小图能出文字)。

    CI macos-14 VM 通常无 GUI session, 可能 import 通但识别恒空 → 这里返 False
    让真冒烟测试自动 skip 不红。
    """
    if not vision_ocr.ocr_available():
        return False
    try:
        from PIL import Image, ImageDraw
    except Exception:
        return False
    import tempfile

    img = Image.new("RGB", (400, 120), "white")
    ImageDraw.Draw(img).text((10, 40), "OCR probe 12345", fill="black")
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as fh:
        img.save(fh.name)
        probe_path = fh.name
    try:
        text = vision_ocr.ocr_image_file(probe_path)
        return bool(text and text.strip())
    finally:
        Path(probe_path).unlink(missing_ok=True)


_VISION_OK = _vision_recognizes()


# ---- 懒 import 软着陆 -----------------------------------------------------

class TestLazyImport:
    def test_load_vision_importerror_soft_lands(self, monkeypatch):
        """缺 pyobjc → _load_vision 返 (None,None,None) + 一次性 warning, 不抛。"""
        real_import = builtins.__import__

        def fake_import(name, *args, **kwargs):
            if name in ("Vision", "Quartz", "Foundation"):
                raise ImportError("simulated missing pyobjc")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", fake_import)
        monkeypatch.setattr(vision_ocr, "_warned_unavailable", False)

        v, q, n = vision_ocr._load_vision()
        assert (v, q, n) == (None, None, None)
        assert vision_ocr._warned_unavailable is True

    def test_ocr_available_false_when_unavailable(self, monkeypatch):
        monkeypatch.setattr(vision_ocr, "_load_vision", lambda: (None, None, None))
        assert vision_ocr.ocr_available() is False

    def test_ocr_image_file_none_when_unavailable(self, monkeypatch):
        monkeypatch.setattr(vision_ocr, "_load_vision", lambda: (None, None, None))
        assert vision_ocr.ocr_image_file("/nonexistent.png") is None

    def test_ocr_pdf_file_none_when_unavailable(self, monkeypatch):
        monkeypatch.setattr(vision_ocr, "_load_vision", lambda: (None, None, None))
        assert vision_ocr.ocr_pdf_file("/nonexistent.pdf") is None


# ---- 护栏: 渲染缩放 (4096px 长边上限) --------------------------------------

class TestRenderScale:
    def test_scale_under_cap_uses_default(self):
        # 500x400 * 2.0 = 1000 长边 <= 4096 → 默认 2.0
        assert vision_ocr._compute_render_scale(500, 400) == pytest.approx(2.0)

    def test_scale_clamped_to_max_dim(self):
        # 3000 长边 * 2.0 = 6000 > 4096 → 收缩到 4096/3000
        scale = vision_ocr._compute_render_scale(3000, 2000)
        assert scale == pytest.approx(vision_ocr.OCR_RENDER_MAX_DIM / 3000)
        # 收缩后长边恰为上限
        assert 3000 * scale == pytest.approx(vision_ocr.OCR_RENDER_MAX_DIM)

    def test_scale_zero_dim_safe(self):
        assert vision_ocr._compute_render_scale(0, 0) == pytest.approx(2.0)


# ---- 护栏: PDF 页数上限截断 (mock 页级渲染/OCR, 不真跑 Vision) --------------

class _FakeQuartz:
    def __init__(self, pages: int):
        self._pages = pages

    def CGPDFDocumentCreateWithURL(self, url):
        return object()  # 非 None fake doc

    def CGPDFDocumentGetNumberOfPages(self, doc):
        return self._pages


class _FakeNSURL:
    def fileURLWithPath_(self, p):
        return p


class TestPdfPageGuardrail:
    def test_page_count_truncated_at_limit(self, monkeypatch):
        # 25 页, 上限拨到 3 → 只 OCR 前 3 页, truncated=True
        monkeypatch.setattr(
            vision_ocr, "_load_vision",
            lambda: (object(), _FakeQuartz(25), _FakeNSURL()),
        )
        monkeypatch.setattr(vision_ocr, "OCR_PDF_MAX_PAGES", 3)

        seen: list[int] = []

        def fake_render(quartz, doc, page_number):
            seen.append(page_number)
            return object()

        monkeypatch.setattr(vision_ocr, "_render_pdf_page", fake_render)
        monkeypatch.setattr(vision_ocr, "_ocr_cgimage", lambda v, img: f"page {len(seen)}")

        out = vision_ocr.ocr_pdf_file("/fake.pdf")
        assert out is not None
        text, truncated = out
        assert truncated is True
        assert seen == [1, 2, 3]  # 只渲染前 3 页
        assert "page 1" in text and "page 3" in text

    def test_all_pages_when_under_limit(self, monkeypatch):
        monkeypatch.setattr(
            vision_ocr, "_load_vision",
            lambda: (object(), _FakeQuartz(2), _FakeNSURL()),
        )
        monkeypatch.setattr(vision_ocr, "OCR_PDF_MAX_PAGES", 20)
        monkeypatch.setattr(vision_ocr, "_render_pdf_page", lambda q, d, n: object())
        monkeypatch.setattr(vision_ocr, "_ocr_cgimage", lambda v, img: "text")

        out = vision_ocr.ocr_pdf_file("/fake.pdf")
        assert out is not None
        _text, truncated = out
        assert truncated is False

    def test_pdf_open_failure_returns_none(self, monkeypatch):
        class _NullDocQuartz:
            def CGPDFDocumentCreateWithURL(self, url):
                return None

        monkeypatch.setattr(
            vision_ocr, "_load_vision",
            lambda: (object(), _NullDocQuartz(), _FakeNSURL()),
        )
        assert vision_ocr.ocr_pdf_file("/bad.pdf") is None


# ---- 真 Vision 冒烟 (skipif 不可用) ---------------------------------------

@pytest.mark.skipif(not _VISION_OK, reason="Vision OCR unavailable (headless CI?)")
class TestRealVisionSmoke:
    def test_image_ocr_chinese_english(self, tmp_path: Path):
        from PIL import Image, ImageDraw, ImageFont

        img = Image.new("RGB", (900, 240), "white")
        draw = ImageDraw.Draw(img)
        font = None
        for fp in ("/System/Library/Fonts/PingFang.ttc",
                   "/System/Library/Fonts/STHeiti Medium.ttc"):
            if Path(fp).exists():
                font = ImageFont.truetype(fp, 44)
                break
        draw.text((30, 40), "合同条款 Redis timeout", fill="black", font=font)
        draw.text((30, 130), "Hello World", fill="black", font=font)
        f = tmp_path / "probe.png"
        img.save(f)

        text = vision_ocr.ocr_image_file(f)
        if not text or not text.strip():
            pytest.skip("Vision returned no text (unstable env)")
        assert "Redis" in text or "redis" in text.lower()
        assert "合同" in text
