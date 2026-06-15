> ⚠️ **已归档存史（2026-01）**：本文描述基于 AppleScript 主力 + Notion 为 SSoT 的旧初始化流程，已被 **v4 SQLite-SSoT + DavMail** 取代。当前架构见 `docs/reference/architecture/`。

# Initial Sync 使用与设计说明

## 概述

`initial_sync.py` 是 MailAgent 的初始化同步脚本，用于将 Mail.app 中的历史邮件同步到 Notion，并建立完整的邮件线程关系（Parent Item）。

**核心功能：**
1. 从 Mail.app 获取邮件元数据到本地缓存（SyncStore）
2. 与 Notion 数据库进行详细对比分析
3. 执行增量同步和修复操作
4. 建立和修复邮件线程的 Parent Item 关联

## 架构设计

### 整体流程

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Initial Sync 流程                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Phase 1: 缓存预热                                                       │
│  ┌─────────────┐     ┌─────────────────┐                               │
│  │  Mail.app   │────▶│    SyncStore    │                               │
│  │ (AppleScript)│     │   (SQLite DB)   │                               │
│  └─────────────┘     └─────────────────┘                               │
│                              │                                          │
│  Phase 2: 分析对比           ▼                                          │
│  ┌─────────────────────────────────────────────────────┐               │
│  │              SyncStore vs Notion 对比                │               │
│  │  ┌─────────┐  ┌─────────────┐  ┌─────────────────┐  │               │
│  │  │ matched │  │ mismatch    │  │ store_only/     │  │               │
│  │  │ (已同步) │  │ (属性/关键) │  │ notion_only     │  │               │
│  │  └─────────┘  └─────────────┘  └─────────────────┘  │               │
│  └─────────────────────────────────────────────────────┘               │
│                              │                                          │
│  Phase 3: 修复操作           ▼                                          │
│  ┌─────────────────────────────────────────────────────┐               │
│  │  fix-properties │ fix-critical │ sync-new │ etc.   │               │
│  └─────────────────────────────────────────────────────┘               │
│                              │                                          │
│  Phase 4: Parent Item 更新   ▼                                          │
│  ┌─────────────────────────────────────────────────────┐               │
│  │           update-all-parents                        │               │
│  │  新架构：最新邮件为母节点，设置 Sub-item 自动重建    │               │
│  └─────────────────────────────────────────────────────┘               │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 分离式执行设计

采用 **分析-报告-执行** 的分离式架构：

```
analyze (生成 JSON 报告) ──▶ 人工审查 ──▶ 基于报告执行 (快速执行)
         │                                      │
         ▼                                      ▼
    data/analysis.json                   无需再次查询
```

**优点：**
- 分析阶段可独立运行，生成完整报告供审查
- 执行阶段基于报告，无需重新查询 Notion/Mail.app
- 支持断点续传：报告保存后可随时恢复执行

## 核心组件

### InitialSync 类

主要属性：
- `sync_store`: SyncStore 实例，管理本地邮件元数据缓存
- `arm`: AppleScriptArm 实例，与 Mail.app 交互
- `notion_sync`: NotionSync 实例，与 Notion API 交互
- `report`: AnalysisReport 实例，存储分析结果

### AnalysisReport 数据结构

```python
{
    "created_at": "2026-01-26T10:00:00",
    "comparison": {
        "matched": [...],              # 完全匹配（已同步）
        "property_mismatch": [...],    # date/thread_id 不同
        "critical_mismatch": [...],    # subject/sender 不同（需重建）
        "store_only": [...],           # 仅在 SyncStore（待同步）
        "store_only_before_date": [...], # 早于 sync_start_date（仅缓存）
        "notion_only": [...],          # 仅在 Notion（不处理）
    },
    "parent_analysis": {
        "total": 1234,                 # 总邮件数
        "threads": {                   # 按 thread_id 分组的线程分析
            "thread_id_1": {
                "thread_id": "thread_id_1",
                "latest_page_id": "xxx",           # 最新邮件的 page_id
                "latest_message_id": "xxx",
                "latest_subject": "Re: ...",
                "latest_date": "2026-01-26T10:00:00+08:00",
                "latest_current_parent": null,     # 最新邮件当前的 Parent（应为空）
                "other_emails": [                  # 同线程其他邮件
                    {
                        "page_id": "yyy",
                        "message_id": "yyy",
                        "current_parent": "zzz",   # 当前 Parent（应指向最新）
                        "need_update": true        # 是否需要更新
                    }
                ],
                "need_update_latest": false,       # 最新邮件是否需要清空 Parent
                "sub_items_to_set": ["yyy", ...]   # 需要设置为 Sub-item 的 page_id
            }
        },
        "summary": {
            "total_threads": 500,          # 总线程数
            "single_email_threads": 300,   # 只有一封邮件的线程
            "multi_email_threads": 200,    # 多封邮件的线程
            "correct": 1000,               # 关系正确的邮件数
            "need_update": 234             # 需要更新的邮件数
        }
    },
    "stats": {...}
}
```

## 使用指南

### 环境准备

```bash
# 1. 激活虚拟环境
source venv/bin/activate

# 2. 确保配置正确
# .env 文件中设置：
#   - NOTION_TOKEN
#   - NOTION_EMAIL_DB_ID
#   - MAIL_ACCOUNT_NAME
#   - SYNC_START_DATE (可选，格式: YYYY-MM-DD)
```

### 推荐工作流程

#### Step 1: 缓存预热

获取历史邮件元数据到 SyncStore：

```bash
# 获取收件箱最新 3000 封 + 发件箱最新 500 封
python scripts/initial_sync.py --action fetch-cache \
    --inbox-count 3000 \
    --sent-count 500
```

**说明：**
- 邮件元数据存入 `data/sync_store.db`
- 包含 message_id、thread_id、subject、sender、date 等
- 用于后续 Parent Item 查找和去重

#### Step 2: 分析对比

分析 SyncStore 与 Notion 的差异：

```bash
# 分析并保存报告
python scripts/initial_sync.py --action analyze \
    --output data/analysis.json \
    --skip-fetch  # 跳过获取（使用已有缓存）
```

**输出示例：**

```
  ┌─────────────────────────────────────────────────────────────────┐
  │                        分析结果                                 │
  ├─────────────────────────────────────────────────────────────────┤
  │ 【SyncStore vs Notion 对比】                                    │
  │   ✅ 完全匹配（已同步）:              1200 封                │
  │   ⚠️  属性不同（date/thread_id）:       50 封                │
  │   ❌ 关键信息不同（需重新同步）:         5 封                │
  │   📤 待同步（仅在 SyncStore）:         300 封                │
  │   📅 早于同步日期（仅缓存）:          2000 封                │
  │   ❓ 仅在 Notion:                      10 封                │
  ├─────────────────────────────────────────────────────────────────┤
  │ 【Parent Item 状态】新架构：最新邮件为母节点                    │
  │   总邮件数: 1205 封                                        │
  │   总线程数:  500 个                                        │
  │     - 单邮件线程: 300 个                                │
  │     - 多邮件线程: 200 个                                │
  │   关系状态:                                                     │
  │     ✅ 已正确: 1000 封                                        │
  │     ⚠️  需更新:  205 封                                        │
  └─────────────────────────────────────────────────────────────────┘
```

#### Step 3: 执行修复和同步

基于分析报告执行操作：

```bash
# 修复属性（date/thread_id）
python scripts/initial_sync.py --action fix-properties \
    --input data/analysis.json --yes

# 重新同步关键信息不同的邮件
python scripts/initial_sync.py --action fix-critical \
    --input data/analysis.json --yes

# 同步新邮件（可限制数量）
python scripts/initial_sync.py --action sync-new \
    --input data/analysis.json --limit 100 --yes

# 更新所有 Parent Item（新架构：最新邮件为母节点）
python scripts/initial_sync.py --action update-all-parents \
    --input data/analysis.json --yes
```

或者一次性执行所有操作：

```bash
python scripts/initial_sync.py --action all \
    --input data/analysis.json --yes
```

### 可用的 Actions

| Action | 说明 | 依赖分析报告 |
|--------|------|-------------|
| `fetch-cache` | 预热缓存（获取邮件到 SyncStore） | ❌ |
| `analyze` | 分析对比 SyncStore vs Notion | ❌ |
| `fix-properties` | 修复 date/thread_id 属性 | ✅ |
| `fix-critical` | 重新同步 subject/sender 不同的邮件 | ✅ |
| `update-all-parents` | 遍历验证并修复所有 Parent Item | ✅ (可选) |
| `sync-new` | 同步新邮件 | ✅ |
| `all` | 执行所有修复和同步 | ✅ (自动分析) |

### 命令行参数

```
--action, -a      指定执行的操作
--yes, -y         跳过确认步骤
--limit, -l       限制同步数量
--output, -o      保存分析报告到 JSON 文件
--input, -i       从 JSON 文件加载分析报告
--skip-fetch      跳过从 Mail.app 获取邮件
--inbox-count     收件箱获取数量限制 (0=不限制)
--sent-count      发件箱获取数量限制 (0=不限制)
```

## Parent Item 关联逻辑（新架构）

### 核心设计原则

**新架构：最新邮件为母节点**

与传统的"线程头（最早邮件）为母节点"不同，新架构采用：
- 每个线程中**最新的邮件**作为母节点
- 通过设置母节点的 **Sub-item** 属性，Notion 会自动更新所有子邮件的 **Parent Item**

**优点：**
- 打开最新邮件时可以看到整个线程的历史
- 利用 Notion 双向关系自动维护，只需一次 API 调用
- 新邮件到达时自然成为新的母节点

### 线程关系概念

- **线程头（Thread Head）**：邮件线程的起始邮件，`thread_id == message_id`
- **回复邮件（Reply）**：`thread_id != message_id`，其 `thread_id` 指向线程头
- **母节点（Parent）**：线程中最新的邮件，其他邮件是它的 Sub-item
- **Parent Item**：Notion 中的关联属性，自动指向母节点

### 分类处理逻辑

```
                     ┌─────────────────────────┐
                     │   按 thread_id 分组      │
                     └───────────┬─────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │                         │
         ┌──────────▼──────────┐   ┌─────────▼─────────┐
         │  单邮件线程          │   │  多邮件线程        │
         │  (独立邮件)          │   │                   │
         └──────────┬──────────┘   └─────────┬─────────┘
                    │                         │
                    ▼                         ▼
         ┌──────────────────┐      ┌─────────────────────┐
         │ 不应有 Parent     │      │  按日期排序         │
         │ 如果有则需清空    │      │  确定最新邮件       │
         └──────────────────┘      └─────────┬───────────┘
                                             │
                    ┌────────────────────────┼────────────────────────┐
                    │                        │                        │
         ┌──────────▼──────────┐  ┌─────────▼─────────┐  ┌───────────▼───────────┐
         │  最新邮件           │  │  其他邮件          │  │  需要更新？            │
         │  应无 Parent Item   │  │  Parent 应指向最新 │  │                       │
         └──────────┬──────────┘  └─────────┬─────────┘  └───────────┬───────────┘
                    │                        │                        │
                    ▼                        ▼                        ▼
         ┌──────────────────┐      ┌─────────────────┐      ┌─────────────────┐
         │ 有 Parent?       │      │ Parent 正确?    │      │ 设置 Sub-item   │
         │ → need_update    │      │ → correct       │      │ 自动更新 Parent │
         │    _latest       │      │ 或 need_update  │      │                 │
         └──────────────────┘      └─────────────────┘      └─────────────────┘
```

### 更新机制

`update-all-parents` 执行以下操作：

1. **按 thread_id 分组** 所有 Notion 邮件
2. **按日期排序** 找到每个线程的最新邮件
3. **设置 Sub-item**：将最新邮件的 Sub-item 设置为同线程所有其他邮件
4. **Notion 自动处理**：所有被设置为 Sub-item 的邮件，其 Parent Item 自动指向最新邮件

```python
# 核心逻辑（伪代码）
for thread_id, emails in threads.items():
    # 按日期排序，最新在前
    sorted_emails = sort_by_date(emails, desc=True)
    latest = sorted_emails[0]
    others = sorted_emails[1:]

    # 设置最新邮件的 Sub-item（一次 API 调用）
    await notion.update_page(
        latest.page_id,
        properties={"Sub-item": {"relation": [{"id": e.page_id} for e in others]}}
    )
    # Notion 自动更新所有 others 的 Parent Item 指向 latest
```

### 执行优化

| 分类 | 操作 | 需要 Mail.app | 需要查 Notion |
|------|------|--------------|---------------|
| 最新邮件有错误 Parent | 清空 Parent | ❌ | ❌ |
| 其他邮件 Parent 不正确 | 设置 Sub-item | ❌ | ❌ |
| 单邮件线程有 Parent | 清空 Parent | ❌ | ❌ |

所有操作都可以直接执行，无需额外查询。

## 异常分类说明

### comparison 分类

| 分类 | 含义 | 处理方式 |
|------|------|----------|
| `matched` | 完全匹配 | 自动标记为 synced |
| `property_mismatch` | date/thread_id 不同 | `fix-properties` 更新属性 |
| `critical_mismatch` | subject/sender 不同 | `fix-critical` 删除重建 |
| `store_only` | 仅在 SyncStore | `sync-new` 同步到 Notion |
| `store_only_before_date` | 早于 sync_start_date | 仅缓存，不同步 |
| `notion_only` | 仅在 Notion | 不处理（可能已召回） |

### parent_analysis.summary 统计

| 字段 | 含义 |
|------|------|
| `total_threads` | 总线程数 |
| `single_email_threads` | 只有一封邮件的线程（独立邮件） |
| `multi_email_threads` | 多封邮件的线程（有回复关系） |
| `correct` | 关系正确的邮件数 |
| `need_update` | 需要更新的邮件数 |

## 配置项

在 `.env` 中配置：

```bash
# Notion 配置
NOTION_TOKEN=secret_xxx
NOTION_EMAIL_DB_ID=xxx

# Mail.app 配置
MAIL_ACCOUNT_NAME=Exchange
MAIL_INBOX_NAME=收件箱

# 同步配置
SYNC_MODE=hybrid
SYNC_START_DATE=2026-01-01  # 只同步此日期之后的邮件到 Notion
SYNC_STORE_DB_PATH=data/sync_store.db

# 批量获取配置
INIT_BATCH_SIZE=50  # 每批获取邮件数量
```

## 最佳实践

### 首次同步

```bash
# 1. 预热缓存（根据需要调整数量）
python scripts/initial_sync.py --action fetch-cache \
    --inbox-count 3000 --sent-count 500

# 2. 分析对比
python scripts/initial_sync.py --action analyze \
    --output data/analysis.json --skip-fetch

# 3. 审查报告，确认无误后执行
python scripts/initial_sync.py --action all \
    --input data/analysis.json --yes
```

### 日常维护

```bash
# 定期检查和修复 Parent Item
python scripts/initial_sync.py --action update-all-parents --yes

# 增量同步新邮件
python scripts/initial_sync.py --action sync-new --limit 50 --yes
```

### 故障排查

```bash
# 只分析不执行
python scripts/initial_sync.py --action analyze --skip-fetch

# 查看 SyncStore 状态
sqlite3 data/sync_store.db "SELECT sync_status, COUNT(*) FROM email_metadata GROUP BY sync_status"

# 查看失败的邮件
sqlite3 data/sync_store.db "SELECT message_id, error_message FROM email_metadata WHERE sync_status='failed' LIMIT 10"
```

## 实时同步中的线程关系

实时同步（`new_watcher.py`）也采用相同的"最新邮件为母节点"逻辑：

```
新邮件到达时:
  1. 同步新邮件到 Notion
  2. 查找同 thread_id 的所有已有邮件（按日期排序）
  3. 判断新邮件是否是最新的：
     - 是最新 → 设置 Sub-item 包含所有旧邮件
     - 不是最新 → 设置 Parent Item 指向最新邮件
```

这确保了无论是初始化同步还是实时同步，线程关系都保持一致。

## 相关文件

- `scripts/initial_sync.py` - 主脚本
- `src/mail/sync_store.py` - SyncStore 实现
- `src/mail/applescript_arm.py` - AppleScript 交互
- `src/notion/sync.py` - Notion 同步逻辑（包含 `_handle_thread_relations`）
- `src/mail/new_watcher.py` - 实时同步监听器
- `data/sync_store.db` - 本地缓存数据库
- `data/analysis.json` - 分析报告（生成）
