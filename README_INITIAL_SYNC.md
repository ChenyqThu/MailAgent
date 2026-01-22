# 启动时同步未读邮件功能说明

## 📋 功能概述

系统启动时会自动同步所有现有的未读邮件到Notion，而不仅仅是启动后新收到的邮件。

## ⚙️ 配置

在`.env`文件中配置：

```bash
# 是否在启动时同步现有未读邮件
SYNC_EXISTING_UNREAD=true  # true: 同步, false: 跳过

# 每次最多同步多少封邮件
MAX_BATCH_SIZE=10
```

## 🚀 工作流程

### 启用时（SYNC_EXISTING_UNREAD=true）

```
启动程序
  ↓
读取所有未读邮件（最多MAX_BATCH_SIZE封）
  ↓
逐个同步到Notion
  ├─ 如果邮件已存在 → 跳过
  ├─ 如果邮件是新的 → 同步
  └─ 如果同步失败 → 记录错误继续
  ↓
显示统计信息
  ├─ ✅ 成功: X封
  ├─ ⏭  跳过: X封
  └─ ❌ 失败: X封
  ↓
开始监听新邮件
```

### 禁用时（SYNC_EXISTING_UNREAD=false）

```
启动程序
  ↓
标记所有当前未读邮件为"已知"
  ↓
开始监听新邮件
```

## 📊 日志示例

### 启动时同步

```
============================================================
Email to Notion Sync Service
============================================================
User: lucien.chen@tp-link.com
Check interval: 60 seconds
Sync existing unread: true
Log level: INFO
============================================================
============================================================
Syncing existing unread emails...
============================================================
Found 10 unread emails
[1/10] Processing: 回复: v6.3需求池确认
  ✅ Synced successfully
[2/10] Processing: Re: Small question
  → Skipped (already synced)
[3/10] Processing: battery for RV30+
  ✅ Synced successfully
...
============================================================
Initial sync completed:
  ✅ Synced: 5
  ⏭  Skipped: 4
  ❌ Failed: 1
============================================================
Mail watcher started
Check interval: 60 seconds
```

## 🔍 测试脚本

使用测试脚本预览同步效果：

```bash
python3 scripts/test_initial_sync.py
```

这个脚本会：
1. 列出所有未读邮件
2. 询问是否继续
3. 逐个同步并显示进度
4. 最后显示统计结果

## 💡 使用建议

### 第一次使用

1. **设置较小的批量大小**
   ```bash
   MAX_BATCH_SIZE=5  # 先同步5封测试
   ```

2. **启用详细日志**
   ```bash
   LOG_LEVEL=DEBUG
   ```

3. **运行测试脚本**
   ```bash
   python3 scripts/test_initial_sync.py
   ```

4. **检查Notion中的结果**
   - 邮件是否正确同步
   - 附件是否正常显示
   - 格式是否正确

5. **确认无误后增加批量大小**
   ```bash
   MAX_BATCH_SIZE=20  # 增加到20封
   ```

### 日常使用

**场景1：每天第一次启动**
```bash
SYNC_EXISTING_UNREAD=true   # 同步昨天晚上收到的邮件
MAX_BATCH_SIZE=50           # 可以设置更大
```

**场景2：系统持续运行**
```bash
SYNC_EXISTING_UNREAD=false  # 不需要，因为已经在实时同步
```

**场景3：重新启动/重装系统**
```bash
SYNC_EXISTING_UNREAD=true   # 同步所有历史未读邮件
MAX_BATCH_SIZE=100          # 设置较大的值
```

## ⚠️ 注意事项

1. **大量未读邮件**
   - 如果有很多未读邮件（>100封），分批同步
   - 第一次设置`MAX_BATCH_SIZE=10`
   - 确认成功后再增加

2. **同步时间**
   - 每封邮件大约需要10-30秒（取决于附件大小）
   - 10封邮件大约2-5分钟
   - 启动时会等待同步完成后才开始监听新邮件

3. **网络问题**
   - 如果网络不稳定，可能导致部分邮件失败
   - 失败的邮件不会被标记为已同步
   - 下次启动时会重试

4. **去重机制**
   - 基于`Message ID`去重
   - 已同步的邮件会自动跳过
   - 不会重复上传

## 🔧 故障排查

### 问题：启动时没有同步邮件

**检查：**
```bash
# 1. 确认配置
grep SYNC_EXISTING_UNREAD .env

# 2. 确认有未读邮件
python3 -c "
from src.mail.reader import EmailReader
r = EmailReader()
emails = r.get_unread_emails(limit=5)
print(f'Found {len(emails)} unread emails')
"
```

### 问题：同步太慢

**解决：**
```bash
# 减少批量大小
MAX_BATCH_SIZE=5

# 或者禁用附件上传（临时）
# 修改 sync.py 跳过附件上传步骤
```

### 问题：某些邮件总是失败

**排查：**
1. 查看日志文件 `logs/sync.log`
2. 检查邮件大小（是否有超大附件）
3. 检查邮件格式（是否有特殊字符）
4. 手动测试单封邮件

## 📈 性能优化

### 当前性能

- 单封邮件（无附件）：~5秒
- 单封邮件（1个小附件）：~10秒
- 单封邮件（多个大附件）：~30秒

### 批量同步时间估算

```
邮件数 × 平均时间 = 总时间
10封 × 10秒 = ~2分钟
50封 × 10秒 = ~8分钟
100封 × 10秒 = ~16分钟
```

### 优化建议

1. **分时段同步**
   - 早上同步昨晚的邮件
   - 避免高峰时段

2. **筛选同步**
   - 只同步重要邮件
   - 可以修改代码添加过滤条件

3. **并行处理**（未来优化）
   - 同时同步多封邮件
   - 需要注意Notion API限流
