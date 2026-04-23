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
