# Handoff:把邮件正文作为一等数据存进 SQLite

> 发起方:MailAgent-Web(`KevinWangQQ/MailAgent-Web`)
> 接收方:MailAgent 主仓库(本仓库)
> 创建日期:2026-05-15
> 状态:**待主仓库评估 / 立项**
> 关联:MailAgent-Web 架构评审报告(commit `d39389f`,见 web repo `architect.md`)

---

## 1. 背景:web 端的痛点

MailAgent-Web 是基于本仓库 `sync_store.db` 的只读 Web 工作台。在做完一轮架构评审后,发现 **"邮件正文显示"** 这条 hot path 性能与可靠性都不达标,根因是 **body 不在 SQLite 而只在 Notion**。

### 1.1 当前数据流(从 web 视角)

```
用户点开一封邮件
     │
     ▼
GET /api/emails/:id/body
     │
     ▼
api/services/notion_service.py:26  await client.blocks.children.list(page_id, ...)
     │
     ├──► Notion API 单页 100 blocks,带分页(get_page_body line 36-49 while loop)
     │
     ├──► 每页 200-800 ms 网络 RTT(取决于 Notion API 地理位置)
     │
     ├──► 逐 block 转 HTML(_block_to_html line 100-152)
     │
     ▼
返回 HTML → 浏览器渲染
```

实测 P50 ~1-3 秒,P95 5 秒+(Notion API 偶发 429 / 503 直接 502)。对于"工作台"型应用,这是 **每次点击都阻塞** 的体验。

### 1.2 想做的优化曾经停在主仓库门口

Web 项目最初的本能反应是 **"在 web 这边自己加个 SQLite body cache 表,lazy 拉一次落本地,后续 < 1 ms"**——这套思路是可行的(`api/config.py:22-24` 已预留 `web_body_cache_db` 配置项)。

**但这是错位的修法**,理由:

1. **重复存储**:Mail.app 本地已有 emlx,Notion 也存了,web 再存一份 —— 三份。
2. **first read 仍慢**:首次访问任何邮件还是 1-3 秒。
3. **失效策略复杂**:邮件修改/重新分类后,什么时机让 web cache 失效?web 不在 sync 链路里,要么轮询要么靠 Redis 通知。
4. **方向错**:web 是 sync_store.db 的**消费者**,不应该成为另一个事实源。SQLite 应该是**数据中心**,Notion / Mail.app / web 都是周边。

所以 **正确的修法是在主仓库做** —— 这份文档就是把需求 hand off 过来。

---

## 2. 现状:主仓库的 body 路径

(基于 `README.md` 和 `docs/new_architecture_design.md` 的公开信息;细节以源码为准)

```
Mail.app ──► AppleScript fetch_email_by_message_id()
                │
                ├──► 返回 Email 对象(含 html / text body)
                │
                ▼
        ┌───────┴────────┐
        │                │
        ▼                ▼
  llm_agent/processor:_plaintext_body()   notion sync (HTML 转 blocks 上传)
        │                │
        │                ▼
        │          Notion Page (持久化)
        │                ▲
        │                │
        ▼                │
   labels_json           │
   (SQLite)              │
                         │
                  web 拉 body 走这条 ◄── 慢 + 不稳
```

**SQLite 当前状态**(`PRAGMA table_info(email_metadata)`,22 列):

| 已有 | metadata(message_id / thread_id / subject / sender / to_addr / cc_addr / date_received / mailbox / is_read / is_flagged / has_attachments / notion_page_id / notion_thread_id …) |
|------|---|
| **未有** | **body_html / body_text / body_size / body_etag** |
| 关联表 | `llm_processing` (labels_json) / `thread_head_cache` / `sync_state` / `sync_failures` —— **均不存正文** |

**结论**:在当前架构里,如果不通过 AppleScript 重新抽一次,**唯一能拿到正文的地方就是 Notion**。这就是 web 现在被迫绕远的原因。

---

## 3. 提议:body 作为一等公民进 SQLite

### 3.1 目标

1. **SQLite 是 body 的事实持久化源**,Notion 退为"人类可读 + 富文本展示 + 跨端共享"的镜像。
2. **web / agent / future-clients 一律本地查**,P50 < 5 ms,P99 < 20 ms。
3. **不破坏现有 Notion 同步** —— Notion 上的页面继续渲染,只是改成 "从 SQLite 取 body 转 blocks 上传",而不是"从 AppleScript 抽完直接上传 Notion"。
4. **AppleScript 仍是源头抽取手段**,但产物先 commit 到 SQLite,再由 sync 流水线下游消费(LLM / Notion / web 全部下游)。

### 3.2 概念数据流(改造后)

```
Mail.app ──► AppleScript fetch ───► (in-memory Email)
                                          │
                                          ▼
                          ┌─── SQLite TX ───────────────────────┐
                          │ INSERT INTO email_metadata (...)     │
                          │ INSERT INTO email_body  (...)        │  ← 新表,见 §3.3
                          │ INSERT INTO email_attachment (...)?  │  ← 可选,见 §6
                          └───────────────┬──────────────────────┘
                                          │ commit
                                          ▼
                              ┌───────────┴────────────┐
                              │                        │
                              ▼                        ▼
                       LLM Processor              Notion Uploader
                       (读 SQLite body)           (读 SQLite body 转 blocks)
                              │                        │
                              ▼                        ▼
                       labels_json 写回 SQLite    Notion page

           web / agent (本仓库外消费者) ◄─── 直接读 SQLite body
```

### 3.3 推荐 schema(主仓库可自由调整)

我**强烈倾向**单独建一张 `email_body` 表,而不是给 `email_metadata` 加列。理由见 §4.1。

```sql
CREATE TABLE email_body (
    internal_id        INTEGER PRIMARY KEY,    -- FK → email_metadata.internal_id
    message_id         TEXT    NOT NULL UNIQUE,
    body_html          TEXT,                   -- 原始 HTML(经 _escape 后),可空
    body_text          TEXT,                   -- 纯文本兜底(html2text 产物),可空
    body_format        TEXT,                   -- 'html' | 'text' | 'mixed' | 'empty'
    body_size_bytes    INTEGER,                -- 便于挑大邮件做特殊处理
    has_inline_images  INTEGER DEFAULT 0,      -- 是否含 cid: 引用
    fetched_at         REAL    NOT NULL,       -- 抽取时间(epoch)
    fetched_source     TEXT    NOT NULL,       -- 'applescript' | 'emlx' | 'imap' | 'notion-backfill'
    schema_version     INTEGER DEFAULT 1
);

CREATE INDEX idx_body_message_id ON email_body(message_id);
-- 全文检索(可选,但极推荐——给 agent 的 search_emails 提供秒级正文检索)
CREATE VIRTUAL TABLE email_body_fts USING fts5(
    body_text,
    content='email_body',
    content_rowid='internal_id'
);
```

**关键决策点(请评估)**:

- **是否要存附件二进制?** 我倾向 **不要**(SQLite 文件膨胀,WAL 增长)。建议只存 attachment 元数据(filename / mime / notion_block_id / local_path),正文里的 inline 图片转成本地 / Notion CDN URL。详见 §6。
- **是否要 FTS5?** 强推荐 —— 现在 web agent `search_emails` 工具(`api/agent/tools/search.py:67-88`)只在 `subject / sender / labels_json.ai_summary` 里 LIKE 模糊匹配,**完全搜不到正文**。FTS5 一行配置就能让 agent 拥有"按内容找邮件"的能力,这对 LLM 工作台是核心特性。
- **HTML / Text 都存,还是只存 HTML?** 建议都存:LLM 处理用 text 省 token,web 显示用 html。当前 `llm_agent/processor.py:243` `_plaintext_body` 已经在做 html→text 转换 —— 把这一步的产物存下来,LLM pipeline 也能省一次转换。

### 3.4 同步流程改造点

我不写主仓库的实现,只列出**必须改的契约**:

1. **AppleScript 抽完后,事务里同时写 `email_metadata` + `email_body`**。
   - 原子性:两者要么都成功要么都失败,避免"metadata 有了 body 没有"的鬼态。
   - 失败重试不需要重抽 metadata,只重抽 body 即可(`sync_failures` 表可加 `failure_stage` 区分)。

2. **Notion uploader 改为从 SQLite 读 body**,而不是直接消费 in-memory Email 对象。
   - 这一步可以分阶段做:
     - **Phase A**:Notion uploader 双源 —— 优先读 SQLite,SQLite miss 时 fallback 当前 in-memory(灰度期)
     - **Phase B**:确认覆盖率后,Notion uploader 只读 SQLite,AppleScript 抽完即 commit、不再传 in-memory body
   - 好处:Notion 重传 / 修复历史邮件 时不再需要重新跑 AppleScript。

3. **LLM processor 同样改为从 SQLite 读**(`processor.py:243` `_plaintext_body` 的入口替换)。
   - 已经是 SQLite-Driven,顺理成章。

4. **保留 emlx / imap 兜底通道**(详见 §5),`fetched_source` 列就是为追踪不同来源用的。

### 3.5 历史邮件 backfill

存量邮件不会自动有 body —— 需要一次性 backfill。两种路径:

**A. 从 Notion 反向 backfill(快,但有损)**
- 遍历 `email_metadata` 拿到所有 `notion_page_id`
- 对每个 page 调 `blocks.children.list`,把 blocks 反向转回 HTML(或者直接存 markdown)
- 写入 `email_body`,`fetched_source='notion-backfill'`
- **问题**:Notion blocks 已丢失部分 HTML 细节(class / style / 复杂嵌套表格),反向 HTML 不等于原始
- **适用**:历史只读邮件,反正用户只看不再加工

**B. 从 Mail.app 重新抽(慢,但完整)**
- 走 AppleScript 或 emlx 直读,重新拿原 HTML
- 速度:大约 1 封/秒(AppleScript)或 100 封/秒(emlx,见 §5),6-7 万封需 17 小时 vs 11 分钟
- **适用**:重视 fidelity 的用户

建议:**默认 A(后台跑)+ 用户主动触发 B(单封 / 整邮箱)**,UI 上给个"重新抽取原始正文"按钮。

---

## 4. 性能与正确性论证

### 4.1 为什么单独建表,而不是给 email_metadata 加 body 列

| 维度 | 加列方案 | 独立 email_body 表 |
|------|---------|-------------------|
| 行宽 | `email_metadata` 单行从 ~500B 涨到 50KB-2MB | metadata 维持小行,body 单独大行 |
| 列表查询 | `SELECT * FROM email_metadata` 自动带 body,IO 爆炸(web `EMAIL_BASE_SELECT` `email_queries.py:12-18` 就是这种全列拉法) | 列表查询无需读 body,行宽不变 |
| 索引重建成本 | 任何加列都要 ALTER TABLE,大表慢 | 独立表 schema 演化自由 |
| FTS5 | 在主表加 FTS5 contentless 会复杂化触发器 | 独立表 FTS5 一行 USING fts5 搞定 |
| 备份 / vacuum | 主表必须含 body 一起 vacuum | 可以单独 vacuum body 表(MB 级 vs GB 级差异) |

**强烈建议独立表**。这也是 PostgreSQL / MySQL 工程实践里对"主元数据 + 大对象内容"的标准切分手法(参见 `pg_largeobject` / `mediumtext column out-of-row storage`)。

### 4.2 SQLite 存 body 的性能验证

这是用户最关心的问题。直接给数字:

- **SQLite TEXT/BLOB 单列 1MB**:read 平均 0.3-1 ms(本地 SSD,WAL on,page cache 命中)
- **6-7 万封邮件,平均 body 100 KB**:总 body 约 6-7 GB。SQLite 完全 OK(单库支持 281 TB)。建议 `PRAGMA page_size=8192` + `PRAGMA cache_size=-32000`(32MB cache)进一步提速。
- **FTS5 全文检索**:6-7 万封建索引约 2-5 分钟一次性成本;query 命中速度 < 10 ms(典型 1-3 ms)。
- **对比 Notion API**:同样取一封邮件,Notion P50 1-3 秒,SQLite P50 < 5 ms。**3 个数量级差距**。

唯一需要小心的点:**单行 > 1 MB 时 SQLite 的 sqlite3_blob_open / streaming read API 比一次性 SELECT 字符串更优**。但 99% 邮件 body < 200 KB,不需要走 BLOB streaming;长邮件(投资简报、newsletter)上 MB 也仍然 OK。

### 4.3 为什么不靠 Notion 缓存自己慢

有人可能会说:"在 notion_service 里加 LRU cache 不就好了?"

不好。原因:
1. 第一次访问每封邮件还是 1-3 秒——这是用户**最常踩的体验**(收件箱 50 封新邮件,逐个点)。
2. Cache invalidation:Notion 上邮件元信息可能被更新(thread 关联、AI 字段)。Cache 该不该失效?判断条件复杂。
3. 进程重启 cache 没了。
4. 这只解决 web 的痛,不解决 agent / 未来其他 client。

**根治方法只有"把 body 放在数据中心"**。

---

## 5. AppleScript 是否必须?(用户问到的另一个问题)

简短答案:**短期内仍是最稳的抽取手段,但不是唯一选择**。

### 5.1 三种 body 抽取方式对比

| 方式 | 速度 | 稳定性 | 完整性 | 复杂度 |
|------|------|--------|--------|--------|
| **AppleScript** (现状) | ~1 封/秒(Mail.app 主线程序列化) | Mail.app 偶尔卡 / sandbox 弹窗 | ✅ 完整(走 Mail.app 自身解析) | 已实现 |
| **emlx 直读** (`~/Library/Mail/V*/`) | ~100 封/秒(本地文件 + Python email 库解析) | ✅ 不依赖 Mail.app 进程 | ⚠️ 编码 / 多部分 / inline image 自己解析,边界 case 多(quoted-printable、PGP/MIME) | 中等(~300 行 + 一堆 fixture) |
| **IMAP** (走账户) | 网络 RTT 受限,~10 封/秒 | ⚠️ 账户 throttle / 凭证 | ✅ 完整 | 高(凭证管理、多账户、OAuth) |

### 5.2 建议

**保留 AppleScript 作为主抽取通道**(它已经在 v3 SQLite-First 里证明能跑且 100% message_id 准确),但在 **§3.4 改造时把抽取产物落 SQLite,不再让 body 只活在 Notion**。

**未来演进**:Phase C 引入 emlx 兜底通道,用于:
- Mail.app 不在前台时(避免唤醒)
- 大邮箱批量 backfill(emlx 100 封/秒 vs AppleScript 1 封/秒,17h → 11min)
- AppleScript 失败重试

这是优化,不是阻塞 §3 落地的前提。

---

## 6. 附件该不该一起进 SQLite?

主仓库定调,以下是我的建议:

- **附件元数据(filename / size / mime / inline_cid / notion_block_id)** → SQLite,极强推荐(`email_attachment` 表)。
- **附件二进制** → **不入 SQLite**:
  - 邮件附件常 5-50 MB,SQLite 单库塞 6-7 GB 邮件正文已经够,再叠 100+ GB 附件会触发 WAL 巨大、备份慢、vacuum 慢
  - 推荐:`~/Library/Application Support/MailAgent/attachments/{message_id}/{filename}` 落本地文件系统,SQLite 只存路径
  - inline image:同上落本地,正文 HTML 里把 `cid:xxx` 改写成 `file:///...` 或一个轻量本地 HTTP 路由(防 file:// 跨域)

---

## 7. 给 MailAgent-Web 的接口契约预期

如果 §3 落地,web 端做以下改动(零侵入,仅改 routes 层):

```python
# api/routes/emails.py:116-134 改造前
@router.get("/{email_id}/body")
async def get_email_body(...):
    page_id = ... # from SQLite
    return await notion_service.get_page_body(page_id)  # 1-3s

# 改造后
@router.get("/{email_id}/body")
async def get_email_body(...):
    with get_db() as conn:
        row = conn.execute(
            "SELECT body_html, body_text FROM email_body WHERE internal_id=?",
            (email_id,)
        ).fetchone()
    if not row:
        # fallback:body 还没 backfill,临时走 Notion(灰度过渡期)
        return await notion_service.get_page_body(...)
    return {"html": row["body_html"], "text": row["body_text"]}  # <5ms
```

**web 这边的工作量**:< 20 行改动,加一个 e2e 测试。配合 §3.5 backfill 完成度,可以**完全停掉 Notion 调用**。

**agent 这边的能力扩展**:
- 新 tool `search_email_bodies(query)` 走 FTS5,LLM 可以做内容级搜索(目前只能搜 subject / sender / ai_summary)
- 新 tool `read_email_full_text(email_id)` 返回 plain text 而非 HTML,**LLM 处理省 30-60% token**

这两个能力会让 agent 工作台的实用性上一个量级。

---

## 8. 不在本提议范围内的事

为了避免吓退主仓库,明确**不要求**:

- ❌ 不要求停掉 Notion 同步 —— Notion 仍是"人类视角"的归档/搜索/分享层
- ❌ 不要求换 emlx 抽取通道 —— AppleScript 现状保留
- ❌ 不要求改 LLM agent 的现有 prompt / 流程 —— 只是输入源从 in-memory 改为 SQLite
- ❌ 不要求一次性 backfill 全量历史 —— 可以纯增量(新邮件进 SQLite body),历史按需 backfill
- ❌ 不要求改 web 的 schema 自演化逻辑(`api/services/db.py:64-90 ensure_web_columns`) —— web 仍然 `ALTER TABLE` 加自己的 `processing_status` / `web_action_at` 列;`email_body` 是主仓库的 schema,web 只读

---

## 9. 风险与回滚

| 风险 | 影响 | 缓解 |
|------|------|------|
| SQLite 库膨胀至 10+ GB,vacuum 慢 | 同步抖动 | 独立 `email_body` 表 + 单独 vacuum;开启 auto_vacuum=INCREMENTAL |
| Phase A 双源期间 body 不一致 | web 偶尔看到旧版 | 双源时以 SQLite 为准,Notion 当 fallback;迁移完成立刻关 fallback |
| FTS5 重建索引期间 IO 占用 | 同步暂时变慢 | 在低峰期跑 backfill;FTS5 可后置(Phase B 或之后) |
| AppleScript 抽取失败但 metadata 已写 | body 长期缺失 | `sync_failures` 表加 `failure_stage='body_fetch'`,重试任务专门处理 |
| 加密邮件(S/MIME / PGP) | body 是密文 | 当前 LLM 流程已经处理过,沿用即可;SQLite 存密文 OK |

**回滚路径**:Phase A 双源期间任何时候都可以"关 SQLite body 读、继续走 Notion",零数据丢失。Phase B 之后回滚需要重启双源,但 web 端代码就是个开关。

---

## 10. 落地优先级建议

如果同意大方向,推荐顺序:

| Phase | 内容 | 工作量估算 | 价值 |
|-------|------|-----------|------|
| **0** | 主仓库 review 这份文档,决定是否立项 | — | — |
| **1** | 加 `email_body` schema + AppleScript 抽完写一份(增量,不动 Notion uploader) | 2-3 天 | 新邮件 body 双写,web 端 fallback 可用 |
| **2** | web 端改 `/emails/:id/body` 读 SQLite 优先 + fallback Notion | 半天 | 用户感知:新邮件秒开 |
| **3** | 从 Notion / Mail.app backfill 历史邮件 | 1-2 天(含工具)+ N 小时跑 | 全量秒开 |
| **4** | Notion uploader / LLM processor 改为读 SQLite,去掉 in-memory body 传递 | 2-3 天 | 架构归一,减少重抽 |
| **5** | FTS5 + agent 新工具 `search_email_bodies` | 1 天 | LLM 工作台能力跃升 |
| **6** | (可选)emlx 直读通道,加速 backfill / Mail.app 不在线场景 | 5-7 天 | 长期演进,非必需 |

**Phase 1-3 是 MVP**,做完用户就立刻拿到 1000× 性能提升。Phase 4-5 是架构归一。

---

## 11. 对接

- web 端架构评审完整报告:`MailAgent-Web/architect.md`(尤其第 4、6、8 节涉及 body 的部分)
- web 端 11 个待修 issue:`github.com/KevinWangQQ/MailAgent-Web/issues`(本提案不在其中,因为 body 改动需要主仓库协作)
- 对接人:web 端 owner / Claude review session(本文档作者)

如有疑问 / 不同方案,欢迎在主仓库开 RFC issue,web 端会跟进调整接口预期。
