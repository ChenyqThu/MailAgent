# MailAgent 更新日志

## 2026-01-06 (v3) - 图片位置和表格转换优化

### ✨ 新功能

1. **HTML表格真实转换**
   - HTML表格现在转换为真正的 Notion table block
   - 自动检测表头（`<th>` 标签）
   - 支持最多100行×20列（超出自动截断）
   - 转换失败时降级为 code block

### 🐛 Bug修复

1. **图片位置优化**
   - **内联图片**：只在邮件正文对应位置显示，不再重复出现在底部
   - **非内联图片附件**：在顶部"附件"区域显示
   - **非图片附件**：统一在顶部"附件"区域显示（类似邮件客户端的表现）

### 📝 技术细节

**附件显示逻辑**：
```
顶部:
  📎 附件
  - [非图片附件 1.pdf]
  - [非图片附件 2.docx]
  - [非内联图片 3.jpg]  # 未在正文引用的图片
  ───────────────────

正文:
  📧 邮件内容
  文字...
  [内联图片 image001.png]  # 在HTML中通过cid引用
  更多文字...
  [内联图片 image002.jpg]
  ...
```

**Notion Table Block 结构**：
```json
{
  "type": "table",
  "table": {
    "table_width": 3,
    "has_column_header": true,
    "children": [
      {
        "type": "table_row",
        "table_row": {
          "cells": [
            [{"text": {"content": "Header 1"}}],
            [{"text": {"content": "Header 2"}}],
            [{"text": {"content": "Header 3"}}]
          ]
        }
      }
    ]
  }
}
```

---

## 2026-01-06 (v2) - 附件处理优化

### 🐛 Bug修复

1. **扩展附件类型支持**
   - 新增支持：`.csv`, `.gif`, `.webp`, `.bmp`, `.svg`, `.rar`, `.7z`, `.mp4`, `.mov`, `.avi`
   - 允许无扩展名文件（内联图片）自动通过
   - 增强 Content-Type 判断：通过文件头（magic number）识别无扩展名图片

2. **修复文件名过长问题**
   - Teams 邮件的 message-id 超长导致临时目录创建失败
   - 使用 MD5 hash 缩短目录名（避免超过文件系统255字符限制）
   - 错误："[Errno 63] File name too long" 已解决

3. **附件大小限制提升**
   - 从 10MB 提升到 20MB（匹配 Notion API 限制）

### 📝 技术细节

**Content-Type 自动识别**（无扩展名文件）：
```python
# PNG: \x89PNG
# JPEG: \xff\xd8\xff
# GIF: GIF87a / GIF89a
```

**目录命名优化**：
```python
# 旧: /tmp/email-notion-sync/<message_id>  # 可能超过255字符
# 新: /tmp/email-notion-sync/<md5_hash[:16]>  # 固定16字符
```

---

## 2026-01-06 - 完整的附件和图片支持

### ✨ 新功能

0. **启动时同步所有未读邮件**
   - 新增配置项`SYNC_EXISTING_UNREAD`（默认：true）
   - 启动时自动同步所有现有未读邮件
   - 可配置批量大小`MAX_BATCH_SIZE`（默认：10封）
   - 显示详细的同步进度和统计

1. **附件自动上传**
   - 所有邮件附件自动上传到Notion
   - 智能识别图片和文件类型
   - 图片附件使用image block显示
   - 文件附件使用file block显示

2. **HTML内联图片嵌入**
   - 支持`cid:`引用的内联图片（通过文件名智能匹配）
   - 支持外部URL图片（`http://`, `https://`）
   - 图片会在邮件正文的正确位置显示
   - 最大程度还原邮件原貌

3. **UTF-16文本长度处理**
   - 修复Notion API使用UTF-16计算文本长度的问题
   - 所有文本块严格控制在2000字符以内
   - 使用二分查找优化性能

4. **文件上传API完整实现**
   - 实现Notion三步文件上传流程
   - Create → Send → Attach
   - 支持所有Notion允许的文件类型
   - .eml文件转为.txt格式上传

### 🐛 Bug修复

1. 修复邮箱名本地化问题（支持中文"收件箱"）
2. 修复AppleScript变量名冲突
3. 修复AppleScript超时问题（30s → 120s）
4. 修复文本长度超出2000字符的问题

### 📝 使用说明

#### 邮件同步效果

在Notion中，每封邮件会显示为：

```
📧 邮件内容
[邮件正文，包含文字、格式、内联图片]

📎 附件
[图片1 - 以图片形式显示]
[图片2 - 以图片形式显示]
[文件1.pdf - 以文件形式显示]
[文件2.docx - 以文件形式显示]

💾 完整的原始邮件(.eml)已保存在 Original EML 字段中
```

#### 内联图片处理

- **内联图片**（`cid:image001.png`）→ 自动在正文中显示
- **外部图片**（`https://example.com/image.jpg`）→ 自动嵌入显示
- **图片附件** → 同时在正文和附件区域显示

### 🔧 技术细节

#### 文件上传流程

1. Step 1: `POST /v1/file_uploads` - 创建upload对象
2. Step 2: `POST /v1/file_uploads/{id}/send` - 上传文件内容
3. Step 3: 在`create_page`时使用file_upload_id

#### 图片映射机制

```python
image_map = {
    'image001.png': 'file_upload_id_1',
    'image002.jpg': 'file_upload_id_2',
    # ...
}
```

HTML converter使用此映射将`<img src="cid:image001.png">`转换为Notion image block

### 📊 性能优化

- 并行上传多个附件
- 二分查找优化UTF-16长度计算
- 缓存机制避免重复上传

### 🚀 下一步计划

1. 支持更大文件（>20MB）的多部分上传
2. 批量下载外部图片并上传（避免外部链接失效）
3. 视频和音频附件的专门处理
4. 附件缩略图优化
