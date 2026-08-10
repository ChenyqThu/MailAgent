# 邮件正文翻译「内容漏提取」调研（2026-08-10）

> 过程产物（research），非常青参考。基于 **main 分支当前代码 + 本机活库 + 本机 `translate.log` 生产日志**，不依赖任何历史交接文档的描述。
> 活库 = `~/Library/Application Support/mailagent-frontend/data/sync_store.db`（3.0 GB，10282 封有 body_html）。

---

## 0. 结论先行

**owner 感受到的「总有不少内容漏提取」不是提取器的过滤规则太严，而是「用户看到的译文 97.4% 来自 Path A（LLM 分类顺带产出），而 Path A 的段落覆盖率只有 9.5%」。**

实测（对活库中 `updated_at` 最新的 300 条译文缓存，用**仓库里真实的** `collectRuns` / `isTranslatableText` / `normalizeForMatch` 逐封重算）：

| 来源 | 邮件数 | 可译 run 合计 | 有译文的 run | **段落覆盖率** | 平均 segments/封 |
|---|---|---|---|---|---|
| `llm_agent`（Path A） | 293 | 19998 | 1908 | **9.5%** | 8.54 |
| `on_demand`（Path B） | 7 | 622 | 533 | **85.7%** | 68.9 |

每封覆盖率分布（n=299）：**<50% 的有 258 封（86.3%）**，50–70% 26 封，70–90% 7 封，≥99% 仅 8 封。

全表口径同向：`email_translation` 共 774 行 —— **`llm_agent` 754 行（平均 8.54 段/封）vs `on_demand` 20 行（平均 68.9 段/封）**。

```
sqlite> SELECT source, COUNT(*), AVG(json_array_length(segments_json)) FROM email_translation GROUP BY source;
llm_agent|754|8.54111405835544
on_demand|20|68.9
```

即：**97.4% 的邮件，用户看到的是一个「只翻了 8 段」的缓存**。这就是「漏提取」的主因，且它与 DOM 提取器无关 —— Path A 根本不跑 DOM 提取器。

次要但真实的三类机制（下文逐条给证据）：
1. **Path B 整批静默丢失**：生产日志 240 批里 **54 批（22.5%）返回零 segment 且不重试**，32 次翻译里 21 次（65.6%）至少丢一整批（≈10 段）。
2. **Outlook 引用链被压成一个巨型 run**：`<span style="mso-bookmark:_MailOriginalBody">` 是 inline 标签，`collectRuns` 把它内部 **598 个 block、26454 字符**吞进**同一个 run**，译文全部堆成底部一个 `<div>`。
3. **Path A→B 自动升级的门开得太窄**：只认 `language === 'English'`，而活库 10332 条标签里 **3782 条（36.6%）根本没有 `language` 键**，German/French/Japanese/… 一律不升级。

提取器的**过滤规则本身不是主因**：实测被过滤掉的字符占比只有 1%–10%，且绝大多数是分隔线、纯 URL、纯邮箱、中文签名行——该丢的。

---

## 1. 链路全貌（已验证事实）

### 1.1 两条写入路径共用一张缓存表

```
Path A  src/llm_agent/processor.py  ──(LLM 分类 tool_use 顺带返回 translation_segments)──┐
        src/llm_agent/runner.py:282-296                                                  ├─→ email_translation
Path B  frontend/src/electron/main/handlers/translate.ts:670-797 (translateBatch)  ──────┘     (segments_json)
                                                                                              │
渲染    EmailDetail.tsx:320-326 (translation:get) → EmailBodyFrame.tsx:667-690 →              │
        emailTranslationInjection.ts:49-118 (在 iframe.contentDocument 上按文本 fuzzy 配对注入) ←┘
```

- 表定义（活库实测 `.schema`）：`email_translation(internal_id INTEGER PRIMARY KEY, target_lang, segments_json, model, source, created_at, updated_at)`，`CHECK (source IN ('llm_agent','on_demand'))`。
- Path A 写入：`src/repository/translation.py:107-152`（`save_segments`）。
- Path B 写入：`frontend/src/electron/main/handlers/translate.ts:198-231`（`writeCache`）+ `:233-263`（`writeCacheGuarded` 防降级）。

### 1.2 Path B 的提取 / 分批 / 调用 / 回填

| 阶段 | 位置 | 要点 |
|---|---|---|
| 读正文 | `translate.ts:145-157` | 直读 SQLite `email_body.body_html`（**全量，不截断**）；无 html 时用 `plaintextToHtml(body_markdown)` |
| 切 run | `frontend/src/shared/lib/translation_blocks.ts:214-281` `collectRuns` | 容器按 childNodes 切；block 子元素断 run；**2+ 连续 `<br>` 断段**；`script/style/noscript/pre` 与显式隐藏子树剪掉 |
| 过滤 | `translation_blocks.ts:97-106` `isTranslatableText` | `MIN_LEN=4` / `isSingleCodeElement` / `isCjkHeavy(≥50%)` / 必须含 `[A-Za-z]{2}` / 纯 URL / 纯 email |
| 长段拆分 | `translation_blocks.ts:108-164` `splitLongText` | `MAX_LEN=800`，按句边界 `[.!?;。；！？…]\s+` 切，单句仍超长则硬切 |
| 去重 + 生成 id | `frontend/src/electron/main/lib/html-extractor.ts:114-127` | `seen` Set 按文本去重；id = sha1(DOM path + runIdx + chunkIdx) 前 8 位 |
| 分批 | `translate.ts:627-645` + `:276-278` | `BATCH_SIZE=10`、`BATCH_TEXT_CHAR_BUDGET=3000`、`CONCURRENCY=2`、`FETCH_TIMEOUT_MS=240000` |
| 调 LLM | `translate.ts:455-526`（AI SDK provider）/ `:528-625`（裸 fetch legacy） | 输入 `[{id,text}]`，要求输出 `[{id,tgt}]` |
| 解析 | `translate.ts:351-433` `parseBatchJson` | 三级：严格 JSON → 正则切 `[...]` → 逐项宽松扫描 |
| 回填 | `translate.ts:497-503` / `:602-610` | 按 id 配对；**LLM 没返回的 id 静默丢弃** |

### 1.3 注入端（渲染）

`emailTranslationInjection.ts:49-118`：
- 先 `clearInjectedTranslations`（删 `.mailagent-translation`），再对 **iframe 活 DOM** 重新跑一遍 `collectRuns`（同一份 `translation_blocks.ts`，只是换了 `browserAdapter`）。
- 每个 segment 依次尝试：全等匹配（可命中多个 run）→ `findIndex` 找**第一个包含它的** run → `findIndex` 找**第一个被它包含的** run。
- 同一个 run 命中的多个 segment，译文**合并进一个 `<div class="mailagent-translation">`，用 `<br>` 连接**，插在 `run.endNode.nextSibling` 前（`:109-113`）。

⚠️ 提取端与注入端的 DOM **不是同一棵树**：
- 提取端 = SQLite 原始 `body_html` + `node-html-parser`（`html-extractor.ts:105-112`）
- 注入端 = `mailApi.email.body(mode:'preview')`（**可能被截断**，`frontend/src/electron/main/handlers/email.ts:419-457`）→ `DOMPurify.sanitize`（`EmailBodyFrame.tsx:354`）→ cid 重写 → 暗色模式改写（`:413-415`）→ 浏览器 HTML parser → 运行时把每个 `<table>` 包进 `.mailagent-table-scroll`（`:606-613`）

方向上提取端 ⊇ 注入端，所以这条**不会**让「可见文本丢译文」；但它意味着两边的 run 划分与索引不保证一致，模糊匹配的稳定性完全依赖文本本身。

---

## 2. 确认的 bug（有生产数据 / 代码行证据）

### A-1 🔴 主因：97.4% 的译文来自 Path A，而 Path A 结构上只能覆盖约 10% 段落

**根因（三重叠加，全部是结构性上限，不是 LLM 发挥问题）：**

1. **正文先被截断到 12000 字符再进 LLM**
   `src/config.py:469-472` `llm_body_max_chars: int = Field(default=12000, env="LLM_BODY_MAX_CHARS")`
   `src/llm_agent/processor.py:400-401`：
   ```python
   if len(body) > cfg.llm_body_max_chars:
       body = body[: cfg.llm_body_max_chars] + "\n...[truncated]"
   ```
   → 12000 字符之后的段落**不可能**产生 translation_segment。实测里最长的一封正文有 26454 字符（`internal_id=1000010766` 单个 run），一半以上根本没进模型。

2. **prompt 要的是「定位锚」，不是「全量段落」**
   `src/llm_agent/schema.py:231-248`：
   > "每个 segment.src 必须是邮件正文中该段落的 verbatim 子串（plaintext, 不含 markdown 标记, **长度 30-300 字符；过长段落取首句作为定位锚**）"

   `prompts/email_inbox.md:84-126` 同口径。这套契约里没有「必须逐段枚举、不得遗漏」的硬约束，模型自然只挑它认为重要的几段 —— 实测平均 **8.54 段/封**，且与邮件长度基本无关（最差样例 `1000010035`：488 个可译 run，只有 1 个有译文）。

3. **写入侧还有 200 段硬上限**
   `src/repository/translation.py:31` `MAX_SEGMENTS_PER_EMAIL = 200`（当前未成为瓶颈，但要知道它在）。

**修复方案（分档见 §4）。**

---

### A-2 🔴 Path A→B 自动升级的门开得太窄，实际几乎不触发

`frontend/src/shared/components/email/EmailDetail.tsx:420-438` 已经承认「Path A 的 llm_agent 译文覆盖率偏低」并做了后台升级：

```ts
useEffect(() => {
  if (internalId === null || !langIsEn) return          // ← 门 1
  const cache = translationCacheQ.data
  if (!cache || cache.source !== 'llm_agent') return
  if (llmAgentUpgradeFired.has(internalId)) return       // ← 门 2（模块级 Set，:206）
  llmAgentUpgradeFired.add(internalId)
  void (async () => { await mailApi.ai.translateBatch(internalId, 'zh'); ... })()
}, [...])
```

三个独立缺陷：

1. **`langIsEn` 只认四个字面量。** `frontend/src/shared/lib/ai_mapping.ts` `mapLanguage`：
   ```ts
   if (s === 'english' || s === 'en' || s === 'en-us' || s === 'en-gb') return 'en'
   return 'unknown'
   ```
   而 prompt 的 language 枚举是 `{English, Japanese, Korean, Spanish, French, German, Russian, Other}`（`prompts/email_inbox.md:86`）—— **8 个非中文取值里有 7 个永远不升级**。活库实证：`German` 2 封、`French` 1 封，永久停在 Path A。

2. **36.6% 的邮件压根没有 `language` 标签。** 活库实测：
   ```
   llm_processing 有 labels_json 的行 = 10332，其中含 language 键的 = 6550
   language 值分布：中文 4881 / English 1666 / German 2 / French 1
   ```
   3782 条（36.6%）`labels_json` 里没有 `language` 键 → `ai?.labels_raw?.language` 为 undefined → `langIsEn=false` → **不升级**。

3. **升级只在「用户打开该邮件」时触发，且每个 app session 每封只试一次**（`llmAgentUpgradeFired` 是模块级 `Set`，`EmailDetail.tsx:206`）。若那一次 Path B 部分失败（见 A-3），本 session 内不再重试。

**旁证**：`~/Library/Logs/MailAgent/translate.log` 从 2026-05-22 到 2026-08-06 **总共只有 32 次 `translate.batch_start`**，而缓存表里有 774 行。也就是说 Path B（含手点「翻译」和自动升级）在三个半月里总共只跑了 32 次。

---

### A-3 🔴 Path B 整批失败 = 静默丢 10 段，且不重试

`translate.ts:563-576`（HTTP 非 2xx）与 `:592-596`（解析失败）都返回 `{ segments: [], modelReturned, ok: false }`，`translateBatch` 只把它计进 `failedBatches`（`:751-757`），**没有任何重试**。

生产日志聚合（`~/Library/Logs/MailAgent/translate.log`，131 行，2026-05-22 → 2026-08-06）：

```json
{ "runs": 32, "totalBatches": 240, "failedBatches": 54, "runsWithLoss": 21, "totalSegments": 1652 }
```

- **54 / 240 = 22.5% 的批次返回零 segment**；每批最多 10 段 ⇒ 单次翻译最多丢几十段。
- **21 / 32 = 65.6% 的翻译至少丢一整批。**
- 极端例：`{"id":1000005554,"seg":0,"fail":12,"tot":12}` —— 12 批全灭，整封零译文。

失败构成：
- `translate.batch_http_error` ×14：500 `{"error":"Relay service error","message":"Group Raina - Claude has no members"}` ×12（上游中转配置问题）、524 Cloudflare 超时 ×2。
- `translate.batch_parse_failed` ×11（详见 A-4）。
- `translate.batch_fetch_failed` ×2。

---

### A-4 🔴 模型「回声输入」导致整批解析失败，三级 parser 全部兜不住

最近两次 `batch_parse_failed`（2026-07-24、2026-08-06）的原始输出：

```
[{"id":"f7d32cbd","text":"Jiangui Sun <sunjiangui@tp-link.com.hk>；Chunhui Hu ...
[{"id":"e1378185","text":"发件人: 罗奥锋 <luoaofeng@tp-link.com.hk>\n日期: 2026年8月5日 ...
```

注意键名是 **`text` 而不是 `tgt`** —— 模型把**输入数组原样回声**了（输入用 `text`，见 `translate.ts:462` `batch.map((b) => ({ id: b.id, text: b.text }))`）。后果：

- Stage 1 `JSON.parse` **成功**（它是合法 JSON），但 `shapeCheckArray`（`:375-387`）要求每项有 string 型 `tgt`，全部 `continue` → `out.length === 0` → 返回 `null`。
- Stage 2 同理。
- Stage 3 `parseLeniently`（`:393-433`）在 segment 里 `search(/"tgt"\s*:\s*"/)` 找不到 → 每项 `continue` → `out.length === 0` → `null`。

⇒ 整批 10 段丢失。触发条件很明确：**这两批的内容都是「已经是中文的引用头/收件人列表」**（`发件人: … 日期: … 收件人:`），模型面对「几乎无需翻译」的一批时倾向直接回声。而 prompt 里恰好写了「If a paragraph is already in the target language, output it verbatim as tgt」（`:330`），进一步鼓励了这个行为。

另一个证据链：`translate.ts:331-333` 的注释已经描述过 `"tgt":""Cisco PCI Compliance""`（未转义引号）这一类失败，日志里也确实有：
```
[{"id":"d749cb1b","tgt":""思科 PCI 合规解决方案""}, ...
```
这类现在能被 stage 3 救回来；`text` 回声这一类救不回来。

---

### A-5 🔴 Outlook 引用链被 inline 标签吞成单个巨型 run

`translation_blocks.ts:1-37` 的 `INLINE_TAGS` 包含 `span` / `font` / `a` / `b` / `i` …。`collectRuns` 对 inline 子元素的处理是 **`current.push(child)` 后继续**（`:264-268`），而 `flush` 用 `visibleText`（`:187-195`）**递归整棵子树**取文本——所以只要一个 inline 元素里嵌了 block，整棵子树就被压成一个 run。

Outlook / OWA 的引用链正是这个形状。实测 `internal_id=1000010766`（227 KB body_html）：

```
最大的「inline 元素里包着 block 子树」:
{ tag: 'span', blocks: 598, len: 26454, attrs: 'style="mso-bookmark:_MailOriginalBody"' }
```

`collectRuns` 对这封的输出是 **7 个 run**，其中 run#6 一个人占 26454 字符 / 598 个 block：

```
 run#0 container=<div> len=7      "Hi Ben,"
 run#1 container=<div> len=223
 run#2 container=<div> len=224
 run#3 container=<p>   len=11     "———————————"
 run#4 container=<p>   len=12     "Best Regards"
 run#5 container=<p>   len=10     "Wesley Gan"
 run#6 container=<div> len=26454  chunks=43   ← 整条引用链
```

连锁后果三条：

1. `splitLongText` 把它切成 **43 个 700–800 字符的碎块**，边界与视觉段落完全无关。实测 chunk1 结尾正好切在收件人列表中间：`... <wesley.g@omadanetworks.com>;`。
2. 注入端把这 43 段译文**全部塞进同一个 `<div>`**（`emailTranslationInjection.ts:109-113`），插在 run#6 末尾 ⇒ 用户看到的是**整条引用链一个中文都没有，然后底部一坨两万多字的中文**。观感上等价于「全没翻」。
3. 这封实际只拿回 41 段（`{"id":1000010766,"seg":41,"fail":1,"tot":11}`），43 个 chunk 里少了 2 个，而它们藏在那坨里，用户既看不出少了什么，也无从定位。

**规模**：活库 10282 封里 336 封（3.3%）含 `mso-bookmark`；300 封抽样里 5 封（1.7%）存在「inline 元素吞 >500 字符 block 子树」。占比不高，但**每次命中都是灾难级观感**，且回复/转发链正是商务邮件最常读的部分。

---

### A-6 🟠 `splitLongText` 的句边界正则对中文标点失效

`translation_blocks.ts:114`：
```ts
const boundary = /[.!?;。；！？…]\s+/g
```
要求标点**后面跟空白**。中文排版里 `。` `！` `？` 后通常**没有空格**，所以中文长段落找不到任何句边界 → 整段被当成「一个超长句子」走 `hardPush`（`:129-136`），在第 800 字符处**硬切**，可能切在词中间。切碎的半句被单独送去翻译，译文质量下降且更容易触发 A-4 的解析异常。

---

### A-7 🟠 `writeCacheGuarded` 用「段数」判优劣，会把升级结果挡回去

`translate.ts:251-260`：
```ts
if (existing && segments.length < existing.segments.length) { /* 保留旧 cache */ return true }
```
日志里 4 次命中：
```
cache_kept internalId=1000005554 oldSegments=16 newSegments=0
cache_kept internalId=1000005548 oldSegments=17 newSegments=9
cache_kept internalId=1000000675 oldSegments=4  newSegments=0
```
第二条是真问题：Path B 拿回 9 段（部分失败），因为少于 Path A 的 17 段而被丢弃 —— 但 Path B 的 9 段是**逐段落**的，Path A 的 17 段是**锚点**，两者段数不可比。而且 `source` 仍留 `llm_agent`，下个 session 会再升级一次（幂等，不算致命，但持续烧 token）。

---

### A-8 🟡 `email_translation` 的唯一键与读键不一致，zh/en 互相覆盖

- 写：`ON CONFLICT(internal_id) DO UPDATE SET target_lang = excluded.target_lang, ...`（`translate.ts:217-222`，`src/repository/translation.py:136-141` 同）
- 表：`internal_id INTEGER PRIMARY KEY`（**只有 internal_id 唯一**）
- 读：`WHERE internal_id = ? AND target_lang = ?`（`translate.ts:166`）

⇒ 一封邮件同时只能缓存**一种**目标语言；切到另一种语言时读不到（返回 null）并把原来那份覆盖掉。当前 UI 只用 `'zh'`，暂未暴露；一旦开 en 目标就会表现为「翻过的又没了」。

---

### A-9 🟡 注入端 fuzzy 匹配只取第一个命中

`emailTranslationInjection.ts:78-91` 两个 fallback 分支都用 `findIndex`（只返回第一个）。全等分支会命中所有重复 run（`:70-74`），所以纯重复段落没问题；但「A 段包含 B 段文本」这种情况下，B 的译文只会挂到文档里第一个包含它的 run 上，后面的同形 run 得不到译文。抽样里 `1000012229` 出现 `unmatchedSegments=2`（Path A 的 `src` 是模型改写过的、不是 verbatim 子串，因此三级匹配全落空、译文彻底丢弃）。

---

## 3. 已验证「不是」原因的项（避免后续重复排查）

| 怀疑项 | 结论 | 证据 |
|---|---|---|
| 提取过滤规则太严 | ❌ 不是主因 | 实测被过滤字符占比 1.0% / 0.0% / 7.1% / 10.1% / 2.0%，且样本全是 `———`、纯 URL、纯邮箱、中文签名行 |
| 只覆盖部分 DOM 子树 | ❌ | `collectRuns` 从 `doc.body ?? doc.documentElement` 全树遍历，无节点数/深度上限 |
| 有节点数 / 批次数上限截断 | ❌ | `buildBatches`（`:627-645`）无批数上限；`translateBatch` 全批跑完 |
| iframe 只翻了 preview 截断部分 | ❌ 方向相反 | 提取读**全量** `body_html`（`translate.ts:145-157`），iframe 读 `mode:'preview'`（`email.ts:427-435`）⇒ 提取 ⊇ 渲染 |
| 幂等标记导致二次渲染跳过 | ❌ | `injectTranslations` 每次先 `clearInjectedTranslations`（`:14-16, :50`）再全量重算 |
| id 哈希碰撞 | ❌ | id = sha1(`path#runIdx#chunkIdx`) 前 8 位，runIdx 参与，单封内碰撞概率可忽略 |
| shadow DOM | ❌ 不适用 | 邮件正文是 sanitize 过的静态 HTML，`sandbox="allow-same-origin"` 无脚本（`EmailBodyFrame.tsx:700`），不存在动态插入/shadow root |

**但确实未覆盖、属于「本来就没做」的面**（归入增强，见 §4-C）：
- `<img alt>` / `title` / `aria-label` / `placeholder` 等**属性文本**从不提取（`visibleText` 只走 text 节点，`:187-195`）。
- `<pre>` 整棵剪掉（`SKIP_TAGS`，`translation_blocks.ts:39`）—— 代码块不翻是合理默认。**已核实纯文本邮件不受影响**：`frontend/src/shared/lib/plaintext_html.ts:22` 产出的是 `<p>…<br>…</p>`，不是 `<pre>`。
- `MIN_LEN = 4` 会丢掉表头类短单元格（"Qty" / "Fee" / "No."）。抽样里 `MIN_LEN` 命中的都是 "Hi"、"谢谢。"，无害；但表格密集的邮件会有可见缺口。

---

## 4. 分级修复方案（只给方案，不含代码）

### C 档 · 确认的 bug —— 建议按此顺序做

#### C-1｜把「Path A 当成完整译文来展示」这件事停掉（最高收益，改动最小）
- **根因**：A-1 + A-2。
- **改哪里**：`frontend/src/shared/components/email/EmailDetail.tsx:420-438`。
  1. 去掉 `langIsEn` 这个门，改判「**不是中文**」：条件从 `mapLanguage(...) === 'en'` 改成 `!== 'zh'`（含 `unknown`）。理由：Path A 只在 `language !== '中文'` 时才会写出非空 segments（`src/llm_agent/processor.py:548-555` 对中文邮件显式清空），所以「缓存里有 llm_agent 非空 segments」本身就已经蕴含「这封不是中文」，再叠一个白名单语言门是纯粹的自我设限。
  2. `llmAgentUpgradeFired` 只在**升级成功且 `failedBatches === 0`** 时才 add；部分失败允许下次打开重试。
- **风险**：会显著增加 Path B 调用量（token + 延迟）。需要配套 C-2、C-3 先把 Path B 的成功率提上去，否则只是把「少译」换成「慢且仍少译」。建议加一个 env flag（如 `MAILAGENT_TRANSLATE_AUTO_UPGRADE`，照项目惯例默认 off → dogfood → cutover）。
- **验证**：跑一轮后重跑本文档 §0 的覆盖率脚本，`llm_agent` 行数应持续下降、平均覆盖率应向 85% 靠拢。

#### C-2｜失败批次重试（收益最直接：22.5% → 目标 <3%）
- **根因**：A-3。
- **改哪里**：`translate.ts:743-747`（`withConcurrency` 的结果处理之后）。加一轮 **仅针对 `ok === false` 批次的重跑**（建议 2 次，指数退避 1s/4s，复用同一个 `parentAc`）。若二次仍失败，**把该批拆成两半再试一次**——这同时对付 A-4（更小的批更不容易触发回声）与 524 超时。
- **风险**：延长总耗时。已有 `abortInternalId` 机制，用户切走会取消，可接受。日志已有 `failedBatches`，加个 `retriedBatches` 便于验证。
- **验证**：`translate.log` 聚合 `failedBatches / totalBatches`；改前基线 = 54/240。

#### C-3｜堵住「模型回声输入」这个解析黑洞
- **根因**：A-4。
- **改哪里**：两处，都要改。
  1. `translate.ts:375-387` `shapeCheckArray` + `:393-433` `parseLeniently`：当一项**没有 `tgt` 但有 `text`** 时，识别为「回声」并**显式报一个可区分的失败码**（如 `batch_echoed_input`），而不是与「垃圾输出」混成同一个 `parse_failed`。有了这个信号，C-2 的重试才能针对性地换策略（换措辞/拆批）而不是原样重打一次。
  2. `translate.ts:318-336` `batchSystemPromptFor`：把输入键名从 `text` 改成一个**不可能与输出键混淆**的名字（例如 `src`），并在 prompt 里显式写「输出对象**只能**有 `id` 和 `tgt` 两个键，出现 `text` 键即为错误」。改输入键名的同时要改 `:462` 和 `:537` 的 `batch.map`。
- **风险**：改 prompt 会影响所有翻译输出，需要至少手工验一遍中英混排邮件。改输入键名是纯内部契约（id 只在 batch 内用，不写 SSoT，见 `html-extractor.ts:22` 的注释），无持久化影响。
- **验证**：拿 `1000012075` 和 `1000010766` 重跑（这两封在日志里各有一次 `parse_failed`），断言 `failedBatches=0`。

#### C-4｜inline 标签不该吞 block（修 Outlook 引用链）
- **根因**：A-5。
- **改哪里**：`frontend/src/shared/lib/translation_blocks.ts:264-268`（`collectRuns` 里 `INLINE_TAGS.has(tag)` 那个分支）。判定改成「**inline 且其子树里没有 block 元素**才当 inline 合并；否则按 block 处理（flush 后 `walk(child)` 递归进去）」。
- **⚠️ 关键约束**：`translation_blocks.ts` 是**提取端与注入端共用的单一真源**（`html-extractor.ts:27-32` 与 `emailTranslationInjection.ts:2` 都 import 它）。改它会**同时**改变两端的 run 划分——这正是它被设计成共用模块的原因，但也意味着**存量 `on_demand` 缓存的 `src` 文本会与新的 run 划分对不上**。需要配套：要么给缓存加一个 extractor 版本号并在版本不符时视为 miss，要么接受一次性重翻。
- **风险**：中。会让引用链从 1 个 run 变成几百个 run ⇒ 批次数暴涨（这封会从 11 批变成几十批）。建议与 C-5 一起做。
- **验证**：对 `1000010766.html` 跑 `collectRuns`，run 数应从 7 变成数百，且最大 run 长度 < 3000；实际打开邮件应看到引用链逐段双语。

#### C-5｜引用区应该可以整体不翻（配合 C-4 控成本）
- 若 C-4 让引用链变成数百个 run，成本会成倍上升。建议同时识别引用区（`blockquote` / `mso-bookmark:_MailOriginalBody` / `gmail_quote` / `#divRplyFwdMsg` 等常见标记），默认**折叠不翻**，UI 上给一个「翻译引用内容」的显式入口。
- **风险**：owner 可能确实想读引用链的译文。属于产品决策，需拍板。

#### C-6｜`writeCacheGuarded` 换判据
- **根因**：A-7。
- **改哪里**：`translate.ts:233-263`。不要比段数。建议：只要新结果 `failedBatches === 0` 就无条件写；若 `failedBatches > 0`，比较**覆盖的字符总量**（`sum(seg.src.length)`）而不是段数。
- **验证**：构造 Path A 17 段 / Path B 9 段（但字符覆盖更多）的场景，断言写入新的。

### B 档 · 高度可疑（应修，但先量化）

#### B-1｜`splitLongText` 中文句边界
- 见 A-6。`translation_blocks.ts:114` 的正则改为「标点后跟空白**或**紧跟非空白（CJK 情形）」，即把 `\s+` 改成 `\s*` 并在切分后过滤空片段。
- **风险**：`\s*` 会让 `3.14`、`v1.2`、`e.g.` 这类被误切。需要对小数点/缩写做前瞻排除。**先写测试再改**。

#### B-2｜`email_translation` 唯一键
- 见 A-8。表约束应是 `UNIQUE(internal_id, target_lang)`。属 schema 变更，走 `/db-migration` skill（bump `DB_VERSION` + 同步 `frontend/src/electron/main/backend_lifecycle.ts` 的 `EXPECTED_DB_VERSION`）。当前只用 zh，可缓。

#### B-3｜注入端 fuzzy 匹配
- 见 A-9。两个 fallback 从 `findIndex` 改成收集**全部**命中；同时对 Path A 那种「`src` 不是 verbatim 子串」的情况，可加一个归一化后的最长公共子串阈值兜底。
- **风险**：全部命中会造成同一译文重复插入多处。需要配「一个 run 只接受一个 fallback 命中」的约束。

#### B-4｜Path A 本身要不要留
- 如果 C-1 落地后 Path B 成为主路径，Path A 的价值就只剩「打开瞬间先给个粗译」。可以考虑：Path A 继续写，但**标记为 `partial`**，UI 明确显示「快速预览译文，正在加载完整译文…」，避免用户把 9.5% 覆盖率误认为最终结果。这是最小改动、最大预期管理收益的一条。
- 或者反过来：**取消 Path A 的 `translation_segments` 字段**，把那部分 token 省下来给 Path B。需要 owner 拍板（涉及 `src/llm_agent/schema.py`、两个 prompt 文件、`processor.py`、`runner.py`）。

### A 档 · 增强（可选）

- **A-a｜属性文本**：`img alt` / `title` / `aria-label`。收益低（邮件里 alt 多是 `image001.png`），成本中（注入端无处可插），**建议不做**。
- **A-b｜`MIN_LEN` 与表格**：把 `MIN_LEN` 从 4 降到 2，或对 `<td>/<th>` 容器豁免长度门。低风险，可顺手做。
- **A-c｜可观测性**：`translate.log` 已经很有用，但缺「本封共 N 个可译 run / 命中 M 个」。建议在 `injectTranslations` 返回值旁边加一个覆盖率统计，落到日志或 devtools，让「漏了多少」变成可直接读的数字，而不是每次都要跑本文档这套脚本。**这一条建议优先于所有 B 档**。

---

## 5. 复现 / 验证脚本

本文档所有数字可用以下方式复现（脚本在 scratchpad，未入库）：

```bash
# 1) 生产日志聚合
jq -s '[.[]|select(.event=="translate.batch_done")] |
  {runs:length, totalBatches:(map(.totalBatches)|add), failedBatches:(map(.failedBatches)|add),
   runsWithLoss:(map(select(.failedBatches>0))|length)}' ~/Library/Logs/MailAgent/translate.log

# 2) 缓存来源分布
sqlite3 -readonly "$HOME/Library/Application Support/mailagent-frontend/data/sync_store.db" \
  "SELECT source, COUNT(*), AVG(json_array_length(segments_json)) FROM email_translation GROUP BY source;"

# 3) language 标签缺失率
sqlite3 -readonly "$DB" "SELECT COUNT(*), SUM(json_extract(labels_json,'\$.language') IS NOT NULL)
  FROM llm_processing WHERE labels_json IS NOT NULL;"
```

覆盖率扫描脚本（导出 300 封 body_html + segments，用真实 `collectRuns` / `isTranslatableText` / `normalizeForMatch` 重算逐封覆盖率）建议在实施 C-1/C-2/C-3 时固化成 `frontend/tests/` 下的一条基线测试 —— 它是唯一能证明「改完真的不漏了」的判据。

---

## 6. 需要 owner 拍板的问题

1. **Path A 的定位**：保留为「快速粗译 + UI 明示 partial」，还是干脆取消 `translation_segments` 把 token 还给 Path B？（影响 §4 B-4 的取舍）
2. **引用链翻不翻**：C-4 修好后，Outlook 引用链会变成数百个可译段落，token 成本上一个量级。默认全翻，还是默认折叠 + 显式入口？（C-5）
3. **自动升级的成本上限**：C-1 打开后，每封非中文邮件首次打开都会触发一次 Path B（长邮件实测耗时最长 2 分钟、11 批）。是否需要限流 / 只在用户停留超过 N 秒时触发？
4. **存量缓存**：C-4 改变 run 划分后，754 行 `llm_agent` + 20 行 `on_demand` 的存量缓存要不要整体作废重翻？（一次性 token 成本 vs 存量译文错位）
