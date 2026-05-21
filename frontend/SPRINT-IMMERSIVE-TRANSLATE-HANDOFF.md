# Handoff — 沉浸式翻译重构 + 持久化缓存

> 给下个 session 接手用。本 session 不实现，本 session 已修复路径 / 默认 / 独立配置等基础设施;实际重构在下个 session 单独做。

---

## Context

当前邮件翻译路径用 markdown 整篇 → LLM 单次调用 → markdown 渲染 panel。三个真实痛点:

1. **慢** — 实测 3835 字符英文 + Haiku 4.5,**总耗时 21.8 秒**(`~/Library/Logs/MailAgent/translate.log`)。Haiku 已经是 Claude 系最快,单次 RTT 不可压缩。
2. **样式丢失** — `TranslatedBody.tsx` 是 markdown → HTML → `<div>` 路径,而原邮件渲染在 sandboxed `EmailBodyFrame` iframe 内,保留完整 HTML 样式(按钮 / 表格 / 字体颜色 / 内联图)。切到译文相当于"换了张白纸读译文",视觉断裂大。
3. **无缓存** — 切走邮件再切回,React Query staleTime 仍命中但全应用退出后丢失。每天打开邮件多次,重复翻译浪费 token + 时间。

下个 session 做**沉浸式翻译**(参考 immersive-translate 插件做法):提取 HTML 文本节点 → 小批并发翻译 → 译文 inject 到原节点下方斜体灰色,**保留原邮件视觉,同时双语对照**。叠加 SQLite 缓存,LLM 邮件分类时(若主语言=英文)顺手做一次,用户打开就能立刻看到译文。

---

## 用户已确认决策

| 项 | 决策 | 理由 |
|---|---|---|
| 翻译单元粒度 | 块级元素(`<p>`/`<li>`/`<h*>`/`<td>`/`<blockquote>`) | 上下文完整、质量稳;immersive-translate 也是这粒度 |
| 并排方式 | 译文紧贴原节点下方,斜体 + `text-ink-fg-2` 灰色 | 沉浸式核心 UI,不要 toggle,不要双列 |
| 批量大小 | **10 段/批,2 批并发** | 单批 1-3k 字符 Haiku ~4-6s,2 批并发 → 20 段邮件总耗时 ~6s |
| 持久化 | SQLite 缓存 + LLM 分类时顺手翻 | 切走再回不重翻;用户可手动「重新翻译」覆盖 |

---

## 架构设计

### 数据流总览

```
                                          ┌───────────────────┐
              ┌──── 顺手翻译路径 ─────────►│  email_translation │
              │   (lang=en 时,异步)        │     SQLite 表      │
              │                            └─────────┬─────────┘
              │                                      │
  ┌───────────┴────────────┐                         │
  │ src/llm_agent/processor│                         │ 命中
  │   .py                  │                         │
  │ (分类完后 fire-and-forget                        │
  │  起 batch translate IPC)                         │
  └────────────────────────┘                         │
                                                     ▼
  用户打开邮件 ──► EmailDetail useQuery['translation', id]
                                  │
                                  ▼
                  ┌─── 命中 ─── inject iframe 节点 (立即)
                  │
                  └─── 未命中 ─── 用户点「翻译」 ── 跑 batch ── 落 SQLite + inject
```

### 1. 持久化层

**新表**(在 `src/mail/sync_store.py` 加 + DB_VERSION bump):

```sql
CREATE TABLE email_translation (
  internal_id   INTEGER PRIMARY KEY REFERENCES email_metadata(internal_id) ON DELETE CASCADE,
  target_lang   TEXT NOT NULL DEFAULT 'zh',
  -- JSON: [{id: "h-3f2a", src: "原文", tgt: "译文"}, ...]
  -- id 在节点提取阶段生成(基于 DOM path 的稳定哈希),inject 时按 id 配对
  segments_json TEXT NOT NULL,
  model         TEXT,           -- 实际跑的 model 名 (来自 LLM 返回的 model 字段)
  source        TEXT NOT NULL,  -- 'llm_agent' | 'on_demand' (按按钮触发)
  created_at    REAL NOT NULL,
  updated_at    REAL NOT NULL
);
```

**Repository 接口**(扩 `src/repository/__init__.py` 或新加 module):

```python
def get_translation_segments(internal_id: int, target_lang: str = 'zh') -> list[dict] | None: ...
def save_translation_segments(internal_id: int, target_lang: str, segments: list[dict], *, model: str, source: str) -> None: ...
def delete_translation(internal_id: int, target_lang: str = 'zh') -> None: ...  # "重新翻译" 时用
```

### 2. 节点提取(主进程)

新文件 `frontend/src/electron/main/lib/html-extractor.ts`:

```ts
// jsdom 或 cheerio 解析 body_html
// 块级元素 selector: p, li, h1-h6, td, blockquote, dt, dd
// 跳过条件:
//   - 节点已是 ≥50% CJK 字符(已是中文,无需翻)
//   - 长度 < 4 字符(标点 / 空白)
//   - 父节点是 <code> / <pre> / <script> / <style>
// 输出: [{ id, text, path }] -- id = sha1(path).slice(0,8)
//   path = 自顶向下的 DOM 索引串,例如 "html/body/div[2]/p[1]"
//   path 仅用作 id 来源,后续 inject 时不用回查 DOM(直接用 id 配对)
```

> **依赖**: 项目内是否已有 HTML parser?先看 `src/converter/html_to_markdown.py` 用了 markdownify(Python),frontend 端要选 `cheerio` (轻量、无 jsdom dep)。**评估 jsdom vs cheerio bundle size** 再定。

### 3. 批量 LLM 调用

**新 IPC** `translate:batch` (替代 / 并存于现有 `email:translate`):

```ts
// translate.ts 中:
export interface TranslateBatchOpts {
  internalId: number
  targetLang: TargetLang
  segments: Array<{ id: string; text: string }>  // 一次 5-10 段
}
export interface TranslateBatchResult {
  segments: Array<{ id: string; tgt: string }>
  model: string
  latencyMs: number
}
```

**Prompt 设计**(返回 JSON 数组):

```
System: You translate email paragraphs into {target}. Output ONLY a JSON array
of {"id": "...", "tgt": "..."} - one element per input. Preserve URLs, code,
proper nouns verbatim. No commentary, no markdown fences.

User: <<<JSON>>> [{"id":"h-3f2a","text":"Hello..."},{"id":"h-7e1c","text":"Please..."}] <<<END>>>
```

**调用编排**(EmailDetail 层):

```ts
// 接到 segments 后切批
const batches = chunk(segments, 10)  // 10 段/批
// 并发跑 2 批,后续追加
const results = await pLimit(2)(batches, batch => mailApi.ai.translateBatch({...batch}))
// 失败重试: 单批 503/429 一次重试;EAGAIN 跳过该批继续 (其他段照常显示)
```

**JSON 解析容错**: LLM 偶尔会输出 markdown ```json 包裹 / 多余文本。用 `JSON.parse` 试,失败 → 正则提取首个 `[...]` 后再 parse → 还失败 → 单批标记 `E_PARSE_FAILED`,batch UI 显示「该段翻译失败,可重试」。

### 4. iframe inject

`EmailBodyFrame.tsx` 加 postMessage 协议:

```ts
// renderer → iframe (preload inject 一段 script 监听):
{ type: 'mailagent:inject_translations', segments: [{id, tgt}, ...] }

// iframe 内部脚本:
//   1. 用 querySelectorAll 找所有带 data-i18n-id="<id>" 的节点
//      → 这要求步骤 2 (节点提取) 时同步给 HTML 注入 data-i18n-id 属性
//   2. 每个匹配节点后插入 <div class="mailagent-translation">译文</div>
//   3. 应用 CSS: italic + opacity 0.75 + 左边一根灰色细线

// 反向 (用户点「显示原文」):
{ type: 'mailagent:clear_translations' }
//   1. 删除所有 .mailagent-translation 节点
```

**关键**: 节点提取阶段必须**给 HTML 注入 `data-i18n-id` 属性** + 把改写后的 HTML 写回 SQLite(或者临时存 in-memory),让 EmailBodyFrame 渲染时拿到带 id 的版本。这样 inject 时不用 path lookup,直接 `[data-i18n-id="..."]`。

**安全**: postMessage `event.origin` 检查 + sanitize 译文(译文里不应有 HTML,但防御)。

### 5. LLM 邮件分类顺手翻

`src/llm_agent/processor.py` 改造点:

```python
# 现状: LLM 分类返回 AILabels (priority/action/category/...)
# 加: 若 detected_language == 'en' 且 LLM_AUTO_TRANSLATE_ENABLED:
#   asyncio.create_task(_background_translate(internal_id))
#
# _background_translate(internal_id):
#   1. 从 SQLite 取 body_html
#   2. 走节点提取 (需要 main 进程 helper,或者 Python 端独立实现一份 — 更倾向后者,
#      因为 LLM agent 是 Python 跑;复用 BeautifulSoup)
#   3. 调 LLM 同一个网关 (LLM_API_BASE),分批
#   4. 写 email_translation 表
#   5. 失败静默 (不影响主分类流程)
```

**新 env**:
- `LLM_AUTO_TRANSLATE_ENABLED` (默认 `false` 保守上线)
- `LLM_AUTO_TRANSLATE_LANGS` (默认 `en` — 仅英文邮件自动翻)

### 6. UI 状态机

`EmailDetail.tsx`:

```ts
// 当前: useState showTranslation + useQuery translation
// 新: useQuery cached translation (从 SQLite 取)
//
// state:
//   - hasCache: boolean (打开邮件即查)
//   - injected: boolean (iframe 是否已注入)
//   - retranslating: boolean
//
// CTA:
//   - 邮件 lang=en 且 hasCache → 自动 inject (用户偏好可开关)
//   - 「翻译」按钮 (lang=en && !hasCache) → 跑 batch + 落 SQLite + inject
//   - 「重新翻译」按钮 (hasCache) → delete cache + 跑 batch + 覆盖
//   - 「显示原文」按钮 (injected) → postMessage clear
```

---

## 文件影响清单

### 新增
- `src/mail/sync_store.py` — DB_VERSION + 1, 加 `email_translation` 表 + migration
- `src/repository/translation.py`(新) — get/save/delete 接口
- `src/llm_agent/translator.py`(新) — 后台批翻译协程
- `frontend/src/electron/main/lib/html-extractor.ts`(新) — 节点提取 + data-i18n-id 注入
- `frontend/src/electron/main/handlers/translate.ts` — 加 `translate:batch` IPC,保留旧 `email:translate` 作 deprecated

### 修改
- `frontend/src/shared/components/email/EmailBodyFrame.tsx` — postMessage 协议 + inject CSS
- `frontend/src/shared/components/email/EmailDetail.tsx` — useQuery 改读缓存,CTA 状态机
- `frontend/src/shared/api/types.ts` — 新 `TranslateBatchOpts/Result` + `ai.translateBatch`
- `frontend/src/shared/api/ElectronApi.ts` + `HttpApi.ts` — 暴露 batch API
- `src/llm_agent/processor.py` — fire-and-forget 起后台翻译

### 删除 / 退役
- `frontend/src/shared/components/email/TranslatedBody.tsx` — 删,markdown 渲染层不再需要
- `frontend/src/electron/main/handlers/translate.ts` 旧 `email:translate` IPC + 双语 ⟦S⟧⟦T⟧⟦E⟧ 解析 — 保留 1 个 release 作向后兼容,然后删
- `LLM_TRANSLATE_BILINGUAL` env — 删(沉浸式默认就是双语,不需要 toggle)

---

## 与本 session 的衔接

### 本 session 已做(下 session 保留)

✅ `LLM_API_BASE` 读取路径修正(`getLlmBaseUrl()` 优先读 `LLM_API_BASE`,fallback `LLM_BASE_URL`,default `https://crs.chenge.ink/api`)
✅ `LLM_TRANSLATE_BASE_URL` / `LLM_TRANSLATE_API_KEY` / `LLM_TRANSLATE_MODEL` env + getter(独立翻译配置,默认跟随主 LLM)
✅ `getLlmTranslateApiKey()` keychain slot `llm-translate-api-key`
✅ Settings → AI Agent 三 Section 拆分(Agent / Prompt / 翻译)
✅ Prompt 文件读写 IPC(`prompts:list/read/write`) + dialog
✅ 翻译日志埋点(`~/Library/Logs/MailAgent/translate.log`)
✅ `rowHeight` 修复 `isNew` → ai-strip 漏算
✅ default translate model: `claude-haiku-4-5`(去掉日期戳)

### 本 session 已做(下 session 重构 / 删除)

⚠️ `LLM_TRANSLATE_BILINGUAL` + ⟦S⟧⟦T⟧⟦E⟧ 三元组解析(`translate.ts:parseBilingualSegments` + `bilingualSystemPromptFor`) — 沉浸式架构不再用 sentinel,**删**
⚠️ `TranslatedBody.tsx` — 完整删
⚠️ `email:translate` IPC 的整篇 markdown 路径 — **保留一个 release 作 fallback**(出问题能回退),下下 release 删

### 决策一致性检查

- 双语对照 toggle:本 session 是 env 开关(默认关闭) → 下 session 改成「沉浸式即双语」(没有 toggle,默认行为)。**用户偏好已表达**:这次问的「并排展示方式」答的是「译文紧贴原文下方斜体灰色(推荐)」,所以下 session 直接走沉浸式即可。
- 模型:本 session 默认 `claude-haiku-4-5`(curl 验证 200),下 session 沿用。
- 翻译 base URL:本 session 已支持独立 base URL,下 session batch IPC 也走同一个 getter,自动复用。

---

## 估时

| 阶段 | 估时 |
|---|---|
| SQLite 表 + repository + migration | 0.5 天 |
| frontend 节点提取 (cheerio + data-i18n-id 注入) | 1 天 |
| LLM batch IPC + prompt 设计 + JSON 容错解析 | 0.5 天 |
| iframe postMessage 协议 + inject CSS | 1 天 (含调试) |
| Python LLM agent fire-and-forget 翻译 | 0.5 天 |
| EmailDetail 状态机 + CTA + 「重新翻译」 | 0.5 天 |
| 单测(节点提取 / 批 prompt / postMessage / repository) | 1 天 |
| 端到端验证 + 视觉调优(行间距 / 颜色) | 0.5 天 |

**总计 5 天**(单人专注)。可拆 2-3 个 PR 推进:
1. SQLite 表 + Python 后台翻译(纯后端,可独立 ship)
2. frontend batch IPC + 节点提取(替换旧 `email:translate`)
3. iframe inject + UI 状态机(用户可见的视觉变化)

---

## 验证清单(下 session 结束前必须过)

1. **冷启动场景**: 新邮件到达 → LLM 分类完 → 翻译已落 SQLite → 用户打开 → 立即看到双语
2. **手动场景**: 已存在邮件未翻译过 → 用户点「翻译」 → batch 跑 → 译文逐批 inject(感知 4-6s 全部完成)
3. **重译场景**: 已有翻译 → 用户点「重新翻译」 → 删旧缓存 + 重跑 + 覆盖
4. **切走再回**: 切到另一封邮件再切回 → 立即显示缓存,无重新翻译请求(看 `translate.log` 验证)
5. **错误处理**: 单批 LLM 失败 → 其他批正常 inject + 失败批 UI 显示「该段翻译失败」可重试
6. **样式保真**: 翻译后原邮件表格 / 按钮 / 链接 / 内联图全部完好(对比同邮件未翻译截图)
7. **abort**: 翻译进行中切走邮件 → 所有 in-flight batch 取消(`AbortController` + `translate.log` 看 aborted 事件)
8. **iframe sandbox**: postMessage origin 校验,inject 内容 XSS-safe(译文里塞 `<script>` 不执行)
9. **CJK 跳过**: 中文段不被送翻(节点提取阶段 heuristic 过滤)
10. **DB migration**: 升级老 SQLite db 时,`email_translation` 表自动创建(看 `sync_store.py` 迁移序列)

---

## 下个 session 启动建议

```
# 1. 拉取本 session commit
git pull

# 2. 读这份 handoff
cat frontend/SPRINT-IMMERSIVE-TRANSLATE-HANDOFF.md

# 3. 跑现有翻译验证基础设施 OK
mailagent llm selftest    # 验主网关
# Settings → 翻译模型留空 + 翻译 base URL 留空 → 翻译一次
tail -5 ~/Library/Logs/MailAgent/translate.log
# 应该看到 translate.success + latencyMs ~20s

# 4. 然后按本 handoff "估时" 段分 PR 推进
```
