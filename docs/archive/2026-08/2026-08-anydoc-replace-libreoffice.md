# 用 Firecrawl anydoc 替换 LibreOffice + 暴露为 Agent 工具（2026-08-10 调研）

> 过程产物（research），非常青参考。代码侧结论基于 main 分支当前代码 + 本机活库实测；anydoc 侧结论全部带 URL，未查证的项已显式标注。

---

## 0. 结论先行

**三条硬结论：**

1. **anydoc 能完全本地运行、零 API key、零 ML 模型、MIT 许可、macOS arm64 预编译 wheel 仅 3.2 MB。** 不需要 Docker，不需要 Firecrawl 云端。这一点对桌面 App 分发是决定性的好消息。
   来源：<https://www.firecrawl.dev/blog/anydoc-and-pdf-inspector> 原文 "No API key. No system dependencies. Nothing to install alongside it."；<https://pypi.org/project/firecrawl-anydoc/> 各平台 wheel 体积。

2. **但「用 anydoc 替换 LibreOffice」这个命题的前提在本仓不成立** —— 先摸清现状后发现：**LibreOffice 在本项目里根本不负责主流附件的文本提取**。docx/pptx/xlsx/pdf 的文本提取走的是纯 Python 原生库（python-docx / python-pptx / python-calamine / pypdf），LibreOffice 只剩两个边缘用途：
   - **Notion 派生附件**（docx/pptx→PDF、xlsx→CSV 上传到 Notion 供预览）—— anydoc **只出 Markdown，不出 PDF，结构上替代不了**；
   - **老二进制格式桥**（.doc/.ppt/.xls → docx/pptx/xlsx 后复用现成 extractor）—— 生产实测**总共只有 45 条**。

   所以准确的问法不是「能不能替换 LibreOffice」，而是「**要不要用 anydoc 换掉现有的 Python 提取器栈**」。答案见 §4。

3. **anydoc 现在不该进生产**：仓库创建于 **2026-08-03，7 天前**，版本 v0.1.7，4 天内发了 7 个版本；且有一条**未修复的开放安全 issue #67 —— 恶意 PDF 可致进程栈溢出崩溃**（<https://github.com/firecrawl/anydoc/issues/67>）。邮件附件恰恰是不可信输入。建议：**放 Labs / 灰度 flag，先只在 `.doc/.ppt/.xls` 这条 45 行的窄路上做 A/B 对账，PDF 路径完全不碰**，等它出稳定 0.2.x 再评估扩面。

---

## 1. 现状摸底（已验证事实）

### 1.1 LibreOffice 的**全部**消费点 —— 只有两处

```
src/converter/office_converter.py
  ├─ convert_office_attachment / is_convertible / convert_to_pdf / convert_to_csv
  │    ├─ src/notion/pages.py:15,111,126  (_convert_office_attachments, :90-130)
  │    │    └─ src/notion/sync.py facade → src/mail/new_watcher.py
  │    └─ src/sync/backfill_builders.py:261,267,375,398,456,478
  │         用途 = docx/pptx → PDF、xlsx → CSV，作为**额外附件上传到 Notion**
  │
  └─ _run_soffice_convert(format=...)
       └─ src/converter/attachment_text.py:279-311 (_extract_legacy_office)
            用途 = .doc/.ppt/.xls → docx/pptx/xlsx，转完喂给现成 extractor
            extractor 标记 = 'soffice_bridge'
```

`src/mail/attachment_text_worker.py:184-191` 另有一处 `check_soffice_available()`，**只打启动诊断日志、不做门控**。

### 1.2 主流格式的文本提取**不经过 LibreOffice**

`src/converter/attachment_text.py:1-16` 的模块 docstring 就是权威清单：

| 格式 | 提取器 | 依赖 |
|---|---|---|
| `.pdf` | `pypdf.PdfReader`；无文本层级联 Vision OCR | `pypdf==6.14.2` |
| `.docx` | `python-docx` Document，paragraphs + tables → markdown | `python-docx==1.2.0` |
| `.pptx` | `python-pptx`，按 slide 抽 title + body shapes | `python-pptx==1.0.2` |
| `.xlsx` | `python-calamine` 拼 markdown table（fallback pandas+openpyxl） | `python-calamine==0.7.0` |
| 图片 / 扫描件 PDF | macOS Vision OCR，**本地识别无网络出口** | `pyobjc-framework-Vision==12.2.1` |
| `.doc/.ppt/.xls` | **soffice 桥** → 新格式 → 复用上面的 extractor | LibreOffice（系统装） |
| `.txt/.md/.csv/.log` | `read_text()` | — |

派发在 `attachment_text.py:106-127`。输出上限 `ATTACHMENT_TEXT_MAX_BYTES = 256 * 1024`（`:67`）。

### 1.3 产物被谁消费

- **文本** → `email_attachment_text` 表 → `email_attachment_fts` / `email_attachment_fts_trigram`（FTS5 搜索）→ 以及 gateway 工具 `email_attachment_text` / `email_search_attachments`（`frontend/src/ai-gateway/tools/email.ts:205,261`）供 Agent 读。
- **PDF/CSV 派生件** → 只上传 Notion，供 Notion 页面里预览。**不进本地 FTS、不进前端预览、不进 Agent**。

### 1.4 失败 / 超时 / 兜底

- `_run_soffice_convert`（`office_converter.py:50-103`）：独立 `UserInstallation` 临时 profile 避并发锁冲突；`timeout=120` 秒；`TimeoutExpired` / `FileNotFoundError` / 通用 `Exception` 全部 catch，**返回 False 不抛**。
- 找不到 soffice：`_find_soffice()`（`:37-47`）先 `shutil.which`，再试 4 个固定路径，全空则 `logger.warning` 后返回 None → 转换静默跳过。
- 老格式桥失败：`attachment_text.py:286-300` 返回 `status='unsupported'`，带明确 `error_message`（"requires LibreOffice/soffice"）。**graceful，不进重试队列**。
- 抽取失败的重试退避由 repo 层负责（1m/5m/15m/1h/2h，见 `attachment_text_worker.py:16-19` 注释）。

### 1.5 打包：LibreOffice **不在 .app 里**，是系统依赖

- `_SOFFICE_PATHS`（`office_converter.py:29-34`）= `/Applications/LibreOffice.app/Contents/MacOS/soffice`、`/opt/homebrew/bin/soffice`、`/usr/local/bin/soffice`、`/usr/bin/soffice`。
- `frontend/scripts/build-python-venv.sh` 中 **零** LibreOffice / soffice 引用（grep 空）。
- 本机装了 `/Applications/LibreOffice.app`，所以 owner 看到的行为是「能用」；**没装 LibreOffice 的终端用户，这两条路径一直是静默降级状态**。
- 提示信息也只有日志一行：`"Install with: brew install --cask libreoffice"`（`office_converter.py:224`）。

### 1.6 生产实况（活库实测）

```
-- 附件文本抽取 extractor 分布
plaintext|extracted|1625     pypdf|extracted|572      xlsx|extracted|446
docx|extracted|266           vision_ocr|extracted|257  none|unsupported|182
pptx|extracted|55            soffice_bridge|extracted|45
vision_ocr|unsupported|33    pdf_ocr|extracted|24      pending|failed|16

-- 附件扩展名 top
png 22043 / jpg 5423 / csv 960 / xlsx 366 / pdf 361 / gif 154 / docx 147 / eml 65 / doc 43 / pptx 32
```

**`soffice_bridge` 一共 45 条，占全部 3543 条抽取的 1.3%；全库 `.doc` 附件只有 43 个。**

---

## 2. anydoc 调研结果

> 本节全部来自外部检索，逐项带 URL。未能核实的项已显式标注「未查证」。

### 2.1 身份确认

| 项 | 值 |
|---|---|
| 仓库 | <https://github.com/firecrawl/anydoc>（在 `firecrawl` 官方组织下） |
| 描述 | "Convert Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, and PDF to clean Markdown. Built in Rust, with Node.js and Python bindings." |
| Stars / Forks | 13391 / 675 |
| 主语言 | Rust |
| 创建时间 | **2026-08-03T16:36:14Z**（7 天前） |
| 最后 push | 2026-08-07T09:20:18Z |
| 文档站 | <https://firecrawl.github.io/anydoc/> |
| 发布博客 | <https://www.firecrawl.dev/blog/anydoc-and-pdf-inspector> |
| 官方推文 | <https://x.com/firecrawl/status/2084670366803218774> |

确认是 Firecrawl 的项目（官方组织 + 官方博客 + 官方推特三重印证），且 Firecrawl 自家 `/parse` 端点在用它。姊妹项目 pdf-inspector（<https://github.com/firecrawl/pdf-inspector>，MIT）被 anydoc 内嵌用于 PDF 路径。

### 2.2 是否真的本地 —— **是**

- **不需要 Firecrawl API key**：博客原文 "No API key. No system dependencies. Nothing to install alongside it."
- **不需要 LLM / VLM key**：README 原文 "Pure Rust, no ML models, no external services. Median conversion time is under 5ms per document." —— 转换是**确定性 parser-based**，不是 LLM/VLM 路线。
- **结构性佐证**：仓库顶层无 `server` / `http` / `api` 目录、无 Dockerfile；文档站明确 "No API keys, servers, HTTP endpoints, or network calls are documented for the core library."
- ⚠️ **唯一的云关联**：扫描件/图片型 PDF 需要 OCR，anydoc **不做 OCR**，官方在此处引导去用付费的 Firecrawl Parse 托管服务。但这是**功能缺口，不是运行时依赖**——本地路径不会因此发起任何网络调用。Agent Skill 文档原文："Scanned and image-only PDFs need OCR, which anydoc does not do; they fail as unsupported."（<https://github.com/firecrawl/anydoc/blob/main/skills/convert-documents-to-markdown/SKILL.md>）
  > 这个缺口对本项目**已被覆盖**：`MAILAGENT_ATTACHMENT_OCR_ENABLED` 的 macOS Vision 本地 OCR 正好补位。

### 2.3 输入格式（14 种）

`.doc` `.docx` `.docm` / `.ppt` `.pps` `.pot` `.pptx` `.pptm` `.ppsx` `.ppsm` / `.xls` `.xlsx` `.xlsm` `.xlsb` / `.odt` `.ods` `.odp` / `.rtf` / `.epub` / `.csv` / `.pdf`（仅文本型）。

- ✅ **原生支持 legacy `.doc/.ppt/.xls`** —— 这正好命中本项目 soffice 桥的唯一用途。
- **按字节内容嗅探格式**（CSV 除外，无 magic marker 需显式 `--format csv`）—— 对扩展名经常写错的邮件附件是实打实的优点。
- ❌ 不支持：HTML/MHTML（开放 issue #52）、RST（#38）、图片、音频。

### 2.4 输出

**唯一输出 = GitHub-Flavored Markdown。没有 PDF、没有 CSV、没有 HTML 输出。**

- 保留：标题（带 anchor）、粗斜体删除线、行内/块代码、链接与交叉引用、有序/无序/嵌套/任务列表、**含合并单元格与表头行的表格**、块引用、脚注尾注、演讲者备注。
- 图片：Markdown 里只出 alt text，**原始字节留在 `document.assets`**（带 media type 与来源 part）。
- 也可以 `to_document()` 拿结构化 document model（blocks / inlines / tables / footnotes / assets），绕开 Markdown。

### 2.5 License

**MIT**（GitHub API `license.spdx_id = "MIT"`；PyPI / npm 包声明一致）。商业使用与桌面端闭源再分发无障碍，只需保留版权声明。

### 2.6 依赖体量 —— 最强的一点

**不依赖**：LibreOffice ❌ / pandoc ❌ / chromium/playwright ❌ / torch/transformers ❌ / 任何系统级二进制 ❌。

PyPI wheel 体积（<https://pypi.org/project/firecrawl-anydoc/>）：

| 平台 | 大小 |
|---|---|
| **macOS ARM64 (11.0+)** | **3.2 MB** |
| macOS x86-64 | 3.3 MB |
| Linux x86-64 / aarch64 | 3.4 / 3.2 MB |
| Windows x86-64 | 3.5 MB |

**Python 包无任何声明依赖**，要求 **Python ≥ 3.10**（本项目嵌入式 CPython 是 3.11，满足）。**所有平台有预编译 wheel，装机不需要 Rust 工具链。**

npm 包 `@firecrawl/anydoc`：`dependencies: {}`，主包 unpackedSize 49239 字节，7 个平台预编译原生 optionalDependencies，`engines.node >= 20`。

### 2.7 接口

**没有 HTTP server，没有官方 Docker 镜像。它是「库 + CLI」。**（社区已提需求：issue #11 Docker、#24 Rust CLI binary）

> ⚠️ 搜索时会撞到「Firecrawl 自托管需要 Docker Compose + Playwright + Redis + RabbitMQ + Postgres + 8GB RAM」——那是**主 Firecrawl 爬虫**，与 anydoc 无关，别混淆。

```bash
pip install firecrawl-anydoc            # Python
npm install @firecrawl/anydoc           # Node
npx @firecrawl/anydoc report.docx       # CLI，退出码 0成功/1转换失败/2用法错
```

```python
import anydoc
markdown = anydoc.to_markdown("report.docx")
markdown = anydoc.to_markdown_bytes(data)     # format=None 可选
document  = anydoc.to_document(data)
anydoc.format_from_bytes(data)                # 内容嗅探
```

错误类型：`UnsupportedError` / `MalformedError` / `EncryptedError` / `ResourceLimitError` / `MissingPartError` / `ConvertError`（基类）/ `OSError`。语义是「只有在不可能产出有意义 Markdown 时才失败」。
🟢 **Python 绑定转换时释放 GIL**（<https://github.com/firecrawl/anydoc/blob/main/python/README.md>），且自带 type stubs。

官方还发布了 Agent Skill：`npx skills add firecrawl/anydoc`，定义见 <https://github.com/firecrawl/anydoc/blob/main/skills/convert-documents-to-markdown/SKILL.md>。里面有一条对本项目直接相关的建议：**"When working within Node, Python, or Rust projects, use the native library instead of CLI invocation"**，以及 **"For large documents, write output to a file rather than streaming entire contents into context"**。

### 2.8 成熟度 —— 最大风险

| 信号 | 事实 |
|---|---|
| 项目年龄 | **7 天** |
| 版本 | **v0.1.7**（0.x，语义上无稳定性承诺） |
| 发布节奏 | v0.1.1 → v0.1.7，**7 个 release 挤在 4 天内** |
| 开放 issue | 23 个（GitHub Search API；注意 API 的 `open_issues_count=49` 含 26 个 PR） |
| README 措辞 | 无 "experimental/alpha/beta" 字样，但也无稳定性承诺 |

**13.4k stars 是 7 天内积累的发布造势，不是生产验证信号。**

#### 🔴 未修复的安全 issue，直接命中本项目威胁模型

**issue #67**（open，2026-08-08）"transitive DoS via pdf-inspector → lopdf 0.41.0 (RUSTSEC-2026-0187)"
<https://github.com/firecrawl/anydoc/issues/67>

一个 ~21 KB 的深层嵌套恶意 PDF 即可触发栈溢出、**终止进程**。原文措辞："remote DoS on any service that converts untrusted PDFs through anydoc"。上游 pdf-inspector 已有修复但**尚未发版**。

> 邮件附件 = 不可信输入。若在 serve-api / worker 常驻进程内同步调用 anydoc 解析 PDF，一封构造过的邮件就能打崩进程。

#### 已知正确性缺陷（按对本项目影响排序）

- **#9** XLSX 隐藏行/列被**静默**当作可见 → 会把不该索引的内容灌进 FTS。**这是行为变更，不是纯性能优化。**
- **#31** PPTX 幻灯片之间**无分隔**，全部拼在一起 → 比现有 `python-pptx` 按 slide 抽取更差。
- **#37** **macOS 自带 textutil 产出的 `.doc` 打不开**（"cfb reports 'Malformed MiniFAT'"）—— 这条直接命中「用 anydoc 替换 soffice 桥」的那 45 条 `.doc`。
- **#8** XLSX 合并单元格 span 被裁到有数据范围；**#27** 数字格式丢失；**#10** 拿不到工作表标识。
- **#14** 嵌套表格被压平进单个单元格；**#41/#45** DOCX markdown 转义瑕疵。
- **#43** 一个 35 KB 文件耗时 ~30s（与「中位 4.4ms」宣传形成对照，存在病理输入）。
- **#58**（closed as **not planned**）PDF 里的 RTL 文字按视觉顺序输出导致**每个词都反向**，pypdf 处理同一 PDF 是正确的。把正确性 bug 标 not planned 本身也是成熟度信号。

#### 性能宣称（厂商自测，第三方不可复现）

中位转换 4.4ms（替代品 52ms–1130ms，"LibreOffice sits at the slow end"）；LLM 评判质量分 anydoc 81 vs 次优 70。
⚠️ 基准语料 "is not redistributable and is not in the repo"（<https://github.com/firecrawl/anydoc/blob/main/bench/README.md>），**因此第三方无法复现**。

### 2.9 备选方案（简表）

| 项目 | License | 本地-only | 一句话 |
|---|---|---|---|
| **anydoc** <https://github.com/firecrawl/anydoc> | MIT | ✅ 纯本地、无 ML | Rust 解析器，14 格式，最轻（3.2MB），但只有 7 天大 |
| **MarkItDown** (Microsoft) <https://github.com/microsoft/markitdown> | MIT | ✅（可选接 LLM 描述图片） | 172.9k stars，Python，格式长尾最广，成熟度**远高于 anydoc** |
| **Docling** (IBM) <https://github.com/docling-project/docling> | MIT | ✅（需下载模型权重） | 布局检测模型 + 可选 VLM，表格/多栏最强，但重且慢 |
| **pandoc** <https://pandoc.org> | **GPL-2.0-or-later** | ✅ | 🔴 GPL 对闭源桌面端再分发有传染风险 |
| **unstructured.io** | Apache-2.0 | ✅（部分能力走托管 API） | ETL 导向，依赖重 |
| **marker** <https://github.com/datalab-to/marker> | Apache-2.0（历史换过 license，需自行核对 LICENSE 文件） | ⚠️ 需 GPU | 深度学习路线，PDF 高精度 |

> Docling / marker 是 ML 路线（模型权重 + 推理开销），对要打进 macOS `.app` 的桌面端体积和冷启动都不可接受；pandoc 的 GPL 是再分发红线。**真正的候选只有 anydoc 与 MarkItDown。**

---

## 3. 未查证 / 查不到（诚实标注）

- **anydoc 在 Electron 下的实证**：Node 绑定用 napi-rs（`@napi-rs/cli ^3.8.2`，`engines.node >= 20`，已从 <https://github.com/firecrawl/anydoc/blob/main/node/package.json> 确认）。N-API 的设计目标本就是跨 Node/Electron ABI 稳定，因此**理论上**不会重演 better-sqlite3 那种 ABI 陷阱——但 **anydoc 官方文档对 Electron 只字未提，未查证到任何 Electron 下实测**。这是基于机制的推断，不是已验证事实。走 Python 路径可完全绕开这个问题。
- **anydoc 在中文文档上的转换质量**：无任何测试数据或 issue 涉及，**完全未查证**。本项目附件大量为中文，这是上线前**必须自行实测**的一项。
- **benchmark 原始数据表**：语料不可再分发，per-tool / per-format 精确数字**查不到**。
- **LibreOffice 的精确安装体积**：本次未核实。
- **npm 包 weekly downloads**：npmjs.com 返回 403，未取到。

---

## 4. B1 —— 替换方案与风险评估

### 4.1 推荐：**不做「替换 LibreOffice」，做「新增一条 anydoc 提取 lane，只覆盖老格式，灰度对账」**

理由链：

1. **「完全替换 LibreOffice」不可能**：Notion 派生附件那条腿需要真 PDF / 真 CSV 文件（`src/notion/pages.py:126` 拿到路径后当附件上传），anydoc 只出 Markdown，结构上替代不了。除非 owner 决定**砍掉 Notion 派生附件功能**——考虑到 Notion 三键已经是可选的（`src/config.py` 的 `notion_enabled()`，本地-only 模式合法），这在产品上并非不可想象，但那是独立决策，不该被「换个转换器」这件事夹带。

2. **「anydoc 优先 + LibreOffice 兜底」在老格式这条腿上是伪命题**：老格式桥的产物是 **docx/pptx/xlsx 文件**（给下游 extractor 吃），anydoc 的产物是 **Markdown 文本**。两者不是同一个接口。正确的形态是「**anydoc 直出文本 vs soffice 桥转格式再抽文本**」这两条**平行 lane**，由 flag 选一条，而不是 fallback 链。好在 `ExtractResult`（`attachment_text.py:70-77`）已经有 `extractor` 字段，天然容得下 `'anydoc'` 这个新值。

3. **收益量化后很小**：老格式桥生产实测 45 条 / 1.3%。换掉它省的是「用户得装 LibreOffice」这个隐性依赖——但**只省一半**，Notion 那条腿仍然需要它。

4. **风险不小**：issue #37（macOS textutil 的 `.doc` 打不开）直接命中这条 lane 的输入；项目 7 天大。

**所以推荐的落地形态：**

- **阶段 1（低风险，可现在做）**：加 `MAILAGENT_ANYDOC_ENABLED`，**默认 off**。on 时 `attachment_text.py:122-123` 的 `LEGACY_OFFICE_EXTENSIONS` 分支改走 `anydoc.to_markdown()`，`extractor='anydoc'`；anydoc 抛任何异常 → **回落到现有 soffice 桥**（这里是真 fallback，因为两条 lane 的输出都是 `ExtractResult`）。off = 字节级现状。
- **阶段 2（对账）**：加一个 dev CLI，对存量 45 条 `soffice_bridge` 行双跑两条 lane，diff 提取文本长度与内容。**这一步是拍板扩面与否的唯一依据。**
- **阶段 3（可选扩面）**：若对账良好且 anydoc 出到稳定 0.2.x，再考虑把 `.docx/.pptx/.xlsx` 也切过去（收益是 Markdown 结构更好，供 Agent 读更可用）。**`.pdf` 永远最后考虑**，且必须等 #67 修复。

### 4.2 打包影响

| 项 | 评估 |
|---|---|
| **是否需要 Docker** | **不需要**。anydoc 无官方镜像、也不需要。（若需要，本方案直接否决——要求终端用户装 Docker 对桌面 App 不可接受） |
| `.app` 体积 | +3.2 MB（macOS arm64 wheel）。相对当前 `resources/python` ~425 MB 基线可忽略 |
| 嵌入式 venv | 需在 `requirements.lock.txt` 加 `firecrawl-anydoc==<pin>`，然后**必须重跑 `bash frontend/scripts/build-python-venv.sh`** 重新 provision——否则依赖改动不进包（E0 WP5 起 provision 只认 lock） |
| Python 版本 | anydoc 要求 ≥3.10，嵌入式是 3.11 ✅ |
| 原生扩展 / codesign | wheel 内含 Rust 编译的 `.so`。⚠️ 需验证 afterPack 签名链能正确签到它。**另注意既有红线：`.app` 签名后执行包内 python（哪怕 `-c import`）会重写 `.pyc` 当场破 codesign** —— 验证 anydoc 可用性必须在签名**之前**做 |
| Node 侧 | **不建议走 Node 绑定**。Electron ABI 未查证（§3），且执行权威本就在 Python 侧，无理由再开一条原生依赖 |

### 4.3 灰度开关设计（照项目惯例）

| 开关 | 代码默认 | 说明 |
|---|---|---|
| `MAILAGENT_ANYDOC_ENABLED` | `false` | 附件文本提取的 anydoc lane 总闸。on = `.doc/.ppt/.xls` 走 `anydoc.to_markdown()`（`extractor='anydoc'`），异常回落既有 soffice 桥；**off = 提取链路字节级回退到现状**（`_extract_legacy_office` 逐字不变）。**Python 单载体**（`src/config.py` pydantic，翻需重启 serve-api）——本 flag 没有任何 Node/gateway 消费点，不加 vite define，也不进 `MANAGED_ENV_KEYS`（除非要做 Settings 开关面，那时才加，见 `reference_mailagent_env_managed_keys_whitelist`）。**不覆盖 `.pdf`**（issue #67 未修复）与 Notion 派生附件（anydoc 不出 PDF/CSV，结构上无关）。 |

若阶段 3 扩面到现代格式，建议**另开**一个 `MAILAGENT_ANYDOC_MODERN_FORMATS`，而不是把总闸的语义悄悄变宽——两个 flag 的风险面完全不同（老格式 lane 现在是 `unsupported` 兜底，扩面则是替换一条已经在跑的成熟路径）。

### 4.4 数据迁移 / 回填

- **不需要强制回填**。`extractor` 字段就是判据，新旧行可共存。
- 阶段 1 上线时**建议只重跑 `soffice_bridge` 的 45 行 + `unsupported` 里扩展名属于 `LEGACY_OFFICE_EXTENSIONS` 的行**。`attachment_text.py:52-54` 的注释明确说 `LEGACY_OFFICE_EXTENSIONS` 是**单源**、「存量 requeue CLI（PR-H）import 同一常量圈选待重跑行」——沿用它，不要另写一份扩展名列表。
- 若阶段 3 扩面，`.docx/.pptx/.xlsx` 共 545 行（147+32+366 附件量级）需重跑；FTS 索引随 `commit_attachment_text` 自动更新。
- ⚠️ **回填会改变 FTS 内容集合**（issue #9 隐藏行列、#31 幻灯片无分隔）。回填前应先跑几条已知邮件的搜索命中对比。

---

## 5. B2 —— 暴露为 Agent 工具的方案

### 5.1 核心建议：**不要新增 gateway 工具，升级现有 `email_attachment_text` 背后的 extractor**

理由：

1. **能力已经在了**。`frontend/src/ai-gateway/tools/email.ts:261-300` 的 `email_attachment_text` 已经能让 Agent 按 `attachment_id` 读附件提取文本，描述里明确列了 "PDF, docx, pptx, xlsx, txt, md, csv"，并且已经返回 `extractor` 字段告诉模型用了哪个引擎。owner 想要的「AI 能把 office 文档转成更可读的 markdown 直接读取」= **让这个工具背后的 extractor 产出更好的 markdown**，不是再加一个工具。
2. **零工具面扩张**。新增 gateway 工具要动 `tool_catalog.json`、`policy.ts` 的 `GATEWAY_TOOL_CLASSES`、审批档 UI（`/connectors` 配置台内置工具段）、`HEADLESS_TOOL_OPTIONS` 能力卡映射、以及 `tests/agent_eval` 的多道闸；收益却只是「同一份数据换个引擎」。
3. **避免开出一个「按路径转任意本地文件」的口子**。那是 `file_read` / `run_command`（`exec` class，恒 HITL）的领地，不该由一个 read-class 工具绕过去。

### 5.2 如果 owner 仍要一个独立工具 —— 设计建议

**分类判定（有明确依据）：**

参照现有同族条目在 `tests/agent_eval/tool_catalog.json` 里的形状：
```json
"email_attachment_text": {"domain":"attachment","tier":"silent","write":false,"gateway_only":true,"tool_class":"read"}
```

新工具应当**完全同形**：`tool_class: "read"` / `tier: "silent"` / `write: false`。

判定依据（三条都成立才配 silent read）：
- **纯本地**：anydoc 无网络出口（§2.2 已验证），不属 `outbound`；
- **无 App 外副作用**：产物只落本地 `email_attachment_text` 缓存行，不改任何用户可见状态（不发信、不改标志位、不动配置），不属 `domain_write`；
- **不改变能力面**：不安装、不授权、不改 skill/connector 状态，不属 `capability_change`。

⚠️ **但有一条硬性附加要求**：输入是**发件人控制的字节**，输出必须**沿用现有围栏**——`email.ts:277-284` 已经把结果套进 `fenceUntrusted('ATTACHMENT_TEXT', ...)`。新工具漏掉这一层 = 开一个二阶注入面。

**入参出参建议（对齐现有工具，不发明新形状）：**

```
入参:
  attachment_id: number        // 必填。**只接受 attachment_id，绝不接受文件路径**（防路径穿越 + 保持
                               //   与 email_thread_attachments / email_get 的发现链闭合）
  max_chars?: number           // 默认沿用 ATTACHMENT_TEXT_MAX_CHARS（12000）
  format?: 'markdown' | 'text' // 可选。markdown = anydoc 结构化输出；text = 现有 plaintext

出参: 与 email_attachment_text 完全同形，只多/改两项
  attachment_id, internal_id, filename, status, text_content(已 fence), truncated,
  extractor,           // 'anydoc' | 'docx' | 'pptx' | ...  ← 模型可据此判断结构可信度
  email_subject, sender, hint
```

**注册在哪：gateway TS，不是 Python skill。**
- 执行权威仍在 Python（serve-api `/api/...`），TS 侧只是薄 `tool()` 封装 —— 与 `email_attachment_text` 完全一致（`email.ts:275-278` 调 `domain.attachmentText(...)`）。
- 走 Python skill / `/api/skills/invoke` 只在「对外 scoped Bearer key 也要能调」时才有必要；附件读取没有这个需求，而且 skill 路径要额外处理 skill 启用态门控与 `confirmation_tier`，纯增负担。

### 5.3 🔴 必须提醒的闸

**新 gateway 工具漏登记 `tests/agent_eval/tool_catalog.json` 会让完整性闸变红。**

闸的位置与机制：`tests/agent_eval/runner/tests/test_gateway_catalog_completeness.py` —— 它**静态抽取** `frontend/src/ai-gateway/tools/*.ts` 里所有 `export const GATEWAY_*_TOOL_NAMES = [...]` 数组（正则 `export\s+const\s+GATEWAY_\w*TOOL_NAMES[^=]*=\s*\[(.*?)\]`，DOTALL）并 union `skill_gating.ts` 的三个集合，要求 ⊆ `tool_catalog.json` 的 tools map。**不是 ⊇，是 ⊆**：源码里有、catalog 里没有 = 红。

配套还要看：
- `frontend/src/ai-gateway/tools/policy.ts` 的 `GATEWAY_TOOL_CLASSES` —— `policy.test.ts` 断言它与 catalog 的 `tool_class` 逐名一致。
- `tests/config/test_agent_capability_parity.py` —— 工具词表与 `HEADLESS_TOOL_OPTIONS` 的相等闸。
- 改完必跑 `venv/bin/python -m pytest tests/agent_eval -q`（CLAUDE.md 已列为「改 chat agent 工具后必跑」）。

---

## 6. 需要 owner 拍板的问题

1. **Notion 派生附件（docx/pptx→PDF、xlsx→CSV 上传 Notion）还要不要？** 这是 LibreOffice 现在唯一无法被 anydoc 覆盖的用途。要 → LibreOffice 必然继续是系统依赖，「换掉 LibreOffice」这个目标本身达不成；不要 → 可以彻底删掉 `office_converter.convert_office_attachment` 及其两个调用点，LibreOffice 只剩老格式桥那 45 条，anydoc 换掉后就能真正退役。
2. **7 天大的项目，接受度如何？** 若倾向保守，**MarkItDown**（Microsoft，172.9k stars，MIT，Python，本地）是同类里成熟度高一个量级的选择，代价是不支持 legacy `.doc/.ppt/.xls`（也就是说它**换不掉** soffice 桥，只能提升现代格式的输出质量）。这两者的取舍取决于问题 1 的答案。
3. **`.pdf` 路径是否明确排除？** 本文建议明确排除（issue #67 未修复 DoS + #58 RTL 反向 + 与现有 pypdf+Vision OCR 级联链冲突）。需要 owner 确认这条边界写进 flag 语义。
4. **B2 走「升级现有 extractor」还是「新增独立工具」？** 本文强烈建议前者（§5.1）。
5. **中文附件质量未查证**：anydoc 在中文文档上的表现无任何公开数据。上线前是否安排一轮人工抽检（建议至少 10 个中文 docx/xlsx/pptx，对比现有 extractor 输出）？
