import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.mail.applescript import MailAppScripts
from src.config import config

print("=" * 60)
print("简单测试 - 获取未读邮件ID列表")
print("=" * 60)
print(f"账户: {config.mail_account_name}")
print(f"邮箱: {config.mail_inbox_name}")
print()

scripts = MailAppScripts()

try:
    print("1️⃣  获取未读邮件数量...")
    count = scripts.get_unread_count(config.mail_account_name, config.mail_inbox_name)
    print(f"   ✅ 未读邮件数: {count}")
    print()

    if count > 0:
        print("2️⃣  获取未读邮件ID列表（最多5封）...")
        message_ids = scripts.get_unread_message_ids(config.mail_account_name, config.mail_inbox_name, limit=5)
        print(f"   ✅ 找到 {len(message_ids)} 封邮件")
        for i, mid in enumerate(message_ids, 1):
            print(f"   {i}. {mid}")
        print()

        if message_ids:
            print("3️⃣  尝试获取第一封邮件的详情...")
            first_id = message_ids[0]
            print(f"   Message ID: {first_id}")
            try:
                details = scripts.get_email_details(first_id, config.mail_account_name, config.mail_inbox_name)
                print(f"   ✅ 成功!")
                print(f"   主题: {details.get('subject', 'N/A')}")
                print(f"   发件人: {details.get('sender', 'N/A')}")
                print(f"   内容长度: {len(details.get('content', ''))} 字符")
            except Exception as e:
                print(f"   ❌ 失败: {str(e)[:200]}")
    else:
        print("⚠️  没有未读邮件,无法测试邮件详情读取")

except Exception as e:
    print(f"❌ 错误: {e}")

print()
print("=" * 60)
