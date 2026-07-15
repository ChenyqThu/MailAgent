# AI 拟稿 / 草稿线程链路调查（2026-07-15，explore lane 产出）

> 行号为调查时快照，动手前请就地复核。

## 核心结论

三条「创建答复草稿」写路径行为不一致：

| 路径 | 入口 | threading 头 | 引用块 |
|---|---|---|---|
| A. Webhook davmail | src/events/handlers.py:659 `_create_draft_via_imap` | ✅ In-Reply-To/References（:723-752） | **完全不含引用**（只放 AI 建议，:711-721） |
| B. Webhook applescript | handlers.py:546-657 → scripts/create_reply_draft.sh | Mail.app GUI 自带 | GUI 注入 |
| C. Service compose_draft | src/services/mail_write.py:1643 | ✅（reply/reply-all :424-448；mode='new' :342-360 不设） | **建议+引用合并单一 body**（split_quote=False :1652） |

AI 自动拟稿（gateway `email_draft_reply` 工具 / 灵动岛 `mailagent email draft`）走**路径 C**。

## 1. 入口明细

- webhook create_draft：handlers.py:497，注册 service.py:220；触发源 feishu.py:304 / island_dispatch.py:992。
- 灵动岛/Feishu → CLI：island_response.py:300 `_create_draft` → `mailagent email draft <id>`（默认 --mode reply-all）→ 路径 C。
- gateway 工具 `email_draft_reply`：agent_runs.py:65,119（domain_write，DEFAULT_CUSTOM_AGENT_ALLOWED_TOOLS 之一）→ POST /api/email/draft → email.py:1068 compose_draft → _compose_request_from_body（:990，quote_original=:1005；注释 :1002-1004「只给纯回复正文、服务端拼引用」）。
- service compose_draft：mail_write.py:1643 → _prepare_draft(split_quote=False) :1652 → _compose_reply_draft :296。

## 2. 草稿落盘（MIME 健康）

- davmail IMAP APPEND：davmail_backend.py:738 append_draft → imap.append(folder, "(\\Draft \\Seen)", ...) :758。
- MIME 单一构造源：append_draft/send_email 都走 _build_mime :951（别名 _build_reply_mime :963）→ sender.py:113 build_outgoing_mime。
- threading 头草稿创建时**已带上**且共用 `_ThreadingHeader`（sender.py:57-94，永不 RFC2047 编码）+ _OUTGOING_POLICY（:110）；forward 有意省略（:145,178）。测试 tests/mail/backend/test_build_mime.py:36。
- **结论：Bug A 不在草稿创建的 MIME 层。**
- imap_folder_reader.py:534/:556 的 create_draft/update_draft 在 src/ 内无活跃调用方；compose 保存草稿 = 每次 APPEND 新（davmail_backend.py:1392 注释）。

## 3. 草稿→发送（Bug A 根因链）

1. Exchange 草稿 MIME 有正确 In-Reply-To/References ✅
2. 发送时后端**从头重建 MIME**（send :1823 → _prepare_draft :1833，与 compose_draft 同源），只用 internal_id+mode 现算 threading，**不读回草稿已有头**。
3. 草稿本地行丢 linkage：
   - _mirror_draft_locally :1680 落库 `thread_id=None` 硬编码 :1715；message_id 存**草稿自己的** :1705。
   - email_metadata 无 in_reply_to/references 列（sync_store.py:544-545 只有 message_id/thread_id）；reconcile 算出的 references_raw/in_reply_to_raw 是「死字段无消费者」（davmail_backend.py:1832-1835），未持久化。
4. 从草稿行发送：mode='new' → :342-360 完全不写 threading → 丢线程；若误用 reply → in_reply_to 取到草稿自己 msgid（自引用）+ thread_id=None，同样脱线。

**修法方向：草稿行持久化原邮件 linkage（source internal_id / in_reply_to / references），send/compose 优先复用。**

## 4. split_quote 契约现状

- _prepare_draft(split_quote) :1494，3-tuple :1500：True→引用单独第 3 返回值 :1568-1578；False→并进 reply_html/reply_text :1580-1581。
- 消费面：compose_plan :1606（dry-run，split_quote=True :1615；CLI email draft --dry-run + POST /api/email/{id}/draft-plan email.py:1311）；compose_draft :1643 与 send :1823 **都 False**（:1653,:1834）。
- **分离契约只在预览兑现，写路径落盘时被合并**（Bug B 直接根因）。
- ComposeRequest.quote_original 默认 False（:192）；AI 工具传 True → 强制拼引用合并（:1554-1556）。

## 5. 草稿正文读取

- 草稿同步进 email_metadata mailbox='草稿箱'（:1712；reconcile_drafts davmail_backend.py:1377）。
- 正文 SQLite SSoT：_mirror_draft_locally :1732-1752 commit_email_with_body 落**合并后 HTML**（:1727 注释）。前端 GET /api/email/{id}/body 拿整块，无分隔。
- **无机器 marker**：引用块 _build_reply_quote :483 生成 `<div>...在 {date}，{sender} 写道：</div><blockquote style="...border-left:2px solid #ccc...">…`（:498-508）。
- reply_suggestion_md 单独存于 llm_processing.labels_json（llm_agent/store.py:364），键=**原邮件** internal_id；草稿行是新 internal_id 不回指 → 读草稿时无法回捞。

## 6. 相关测试

tests/events/test_handlers_davmail_draft.py · tests/cli/test_email_draft.py（test_compose_in_reply_to_and_references:186）· tests/mail/backend/test_build_mime.py · tests/mail/test_drafts_reconcile.py · tests/mail/backend/test_davmail_backend.py · tests/api/test_email_write_service.py · tests/cli/test_service_parity.py · tests/services/test_compose_attachments.py · tests/api/test_compose_attachment.py · tests/notify/test_island_*.py · tests/llm_agent/test_processor.py

## 综合修复建议

（1）草稿行保存 source-internal-id / in_reply_to / references；（2）send-from-draft 复用 linkage 而非重建；（3）写路径引入引用分离 marker（或读取时用 linkage 回捞 reply_suggestion_md + 原文重建）。同一个 linkage 改动同时修 Bug A 与 Bug B。
