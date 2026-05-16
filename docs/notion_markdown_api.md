# Notion Markdown API (探测记录)

基于 `ntn_` 前缀的 integration token，`Notion-Version: 2025-09-03` 可用。2026-04-22 验证。

## GET /v1/pages/{page_id}/markdown

读取页面正文为 Notion 扩展 markdown 字符串。

```
curl -H "Authorization: Bearer $NOTION_TOKEN" \
     -H "Notion-Version: 2025-09-03" \
     "https://api.notion.com/v1/pages/{page_id}/markdown"
```

返回：

```json
{
  "object": "page_markdown",
  "id": "<uuid>",
  "markdown": "...",
  "truncated": false,
  "unknown_block_ids": []
}
```

说明：
- Notion-Version 用 `2022-06-28` 同样工作（向后兼容）
- markdown 可能包含 Notion 专有扩展标签：`<callout icon="📝">...`, `<mention-date start="YYYY-MM-DD"/>`, `<table_of_contents color="..."/>`, `---` 分隔符等——读回写回是无损的
- `database_id` 上**不支持** `/markdown` 路径（`HTTP 400 invalid_request_url`）

## PATCH /v1/pages/{page_id}/markdown

支持 4 种操作类型（discriminated union）：

| type | 子 key | 必填字段 | 语义 |
|---|---|---|---|
| `replace_content` | `replace_content` | `new_str: string` | 整页替换 |
| `insert_content` | `insert_content` | `content: string` | **追加到页面末尾**（不支持 prepend；`position`/`prepend`/`placement` 等字段被忽略） |
| `update_content` | `update_content` | `content_updates: [{old_str, new_str}]` | find-and-replace（多条） |
| `replace_content_range` | `replace_content_range` | `content`, `content_range: ?` | 替换指定 range（`content_range` 形状待探测） |

### 示例：整页替换

```bash
curl -X PATCH \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2025-09-03" \
  -H "Content-Type: application/json" \
  -d '{"type":"replace_content","replace_content":{"new_str":"## hello\n\nbody"}}' \
  "https://api.notion.com/v1/pages/{page_id}/markdown"
```

### 示例：find-and-replace

```bash
curl -X PATCH ... \
  -d '{"type":"update_content","update_content":{"content_updates":[
        {"old_str":"old block title","new_str":"new block content"}
      ]}}'
```

空 `content_updates: []` 返回 200 no-op。

## Prepend 模式（MailAgent 使用）

`insert_content` 只能 append。`replace_content_range.content_range` shape 未探测清楚。目前采用 **read-modify-write**：

```
1. GET /v1/pages/{id}/markdown         → 拿到当前 md 字符串
2. 客户端侧 new_md = week_block + "\n\n" + old_md
3. PATCH replace_content new_str=new_md
```

每项目 2 次 API 调用；226 项目 ≈ 452 次/周。Notion API 3 req/s 限流下约 2.5 分钟纯写入。

幂等检查：GET 时若现有 md 前若干字符已等于本周 week_block 开头字符串 → 跳过 PATCH。

## 错误提示一览（可用于本地 validation）

- Invalid type：`body.type should be "insert_content", "replace_content_range", "update_content", or "replace_content"`
- `replace_content` 缺 new_str：`body.replace_content.new_str should be defined`
- `insert_content` 缺 content：`body.insert_content.content should be defined`
- `update_content` 缺 content_updates：`body.update_content.content_updates should be defined`
- `replace_content_range` 缺 content_range：`body.replace_content_range.content_range should be defined`

---

## file_upload 引用限制（2026-05-16 PoC，T-01 取消依据）

为评估 T-01「邮件 Notion sync 从 children API 迁到 Markdown API」是否可行，2026-05-16
用 sandbox page 实测 markdown 能否承载 file_upload_id 引用。**结论：不可行**。

### 测试脚本

`scripts/poc_markdown_api.py` — 3 phase 探测：

1. **反向探测**：children API 创建带 file_upload image block 的 page → GET markdown
   看 Notion 怎么序列化 file_upload image
2. **正向验证**：把 phase 1 拿到的 markdown 形式 PATCH 回新 page，看 round-trip
3. **真邮件 dry-run**：用 `internal_id=53667`（含 6 张内联图的硬 case）的
   `body_markdown` PATCH 到 sandbox page，肉眼对比 Notion 老 page

补充 11 个 variant 测试（用 `ntn cli` + REST 双路径验证）覆盖所有可能的
file_upload markdown 引用语法。

### 关键发现

#### 1. file_upload image GET 出来是 1h 过期的 S3 预签名 URL

`![](https://prod-files-secure.s3.us-west-2.amazonaws.com/...?X-Amz-Expires=3600&X-Amz-Signature=...)`

不是 `file_upload://id` 也不是任何稳定引用形式。

#### 2. 把这个 S3 URL 写回 markdown → Notion 主动 strip

PATCH replace_content 写入 phase 1 拿到的 markdown：
- block_type 仍是 `image` ✓
- `image.type == "external"`（不是 file_upload）
- **`image.external.url == ""`** —— Notion 识别出是自己的 S3 临时 URL 后过滤掉，防止跨页盗链
- `roundtrip_form: stripped` —— 再次 GET 时 markdown 里图节点直接消失

#### 3. 测试 11 种 markdown 语法引用 file_upload_id —— 全部失败

| # | 写入 markdown | block 类型 | `external.url` |
|---|---|---|---|
| v1 | `![v1](file_upload://FU_ID)` | image | `""` |
| v2 | `![v2](FU_ID)` | image | `""` |
| v3 | `![v3](attachments://FU_ID)` | image | `""` |
| v4 | `<image src="file_upload://FU_ID">v4</image>` | image | `""` |
| v5 | `<file src="file_upload://FU_PDF">v5</file>` | file | `""` |
| v6 | `<pdf src="file_upload://FU_PDF">v6</pdf>` | pdf | `""` |
| v7 | `<image file_upload_id="FU_ID">v7</image>` | image | `""` |
| v8 | `<image file_upload="FU_ID">v8</image>` | image | `""` |
| v9 | `![v9](https://upload.wikimedia.org/.../cat.jpg)` | image | ✅ 外链保留 |
| v10 | `<pdf src="https://w3.org/.../dummy.pdf">v10</pdf>` | pdf | ✅ 外链保留 |
| v11 | `<image src="https://upload.wikimedia.org/.../cat.jpg">v11</image>` | image | ✅ 外链保留 |

**结论**：
- markdown parser silently 创建对应 block 类型 + caption，但任何 file_upload reference 都被忽略
- 只有**合法公网外链 URL**能稳定 round-trip（v9-v11）
- ntn cli 走的是同一个公共 API endpoint，换工具不改结果

### 对邮件场景的影响

邮件场景所有内联图 / 附件源自 MIME 的 cid + bytes，**不存在外链 URL**。要让 Notion
显示必须 upload 拿 file_upload_id → 用 children API 的 image / file block 引用。
markdown API 无法承载这条链路。

即使做混合方案（正文 markdown + 附件 children API），正文里 cid 引用的内联图仍然
得通过 children API 安插，markdown 部分对邮件场景无叠加价值。

→ **T-01 不实施**。`html_converter.py` + `_build_children` + `_build_image_map`
现有链路保留。

### 项目周报样板（`src/project_progress/notion_sync.py`）为什么 work？

因为项目周报的 markdown 正文**纯文本** + headings + lists + tables + 普通链接，
没有任何图 / 附件 / 嵌入资源。markdown API 在「无 file_upload」的场景下毫无障碍。

---
