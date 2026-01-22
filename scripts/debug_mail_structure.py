import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.mail.applescript import AppleScriptExecutor

def main():
    """调试 Mail.app 结构"""
    print("=" * 60)
    print("Mail.app 结构调试工具")
    print("=" * 60)
    print()

    # 1. 获取所有账户名称
    print("1️⃣  获取所有账户...")
    script = '''
    tell application "Mail"
        set accountNames to {}
        repeat with theAccount in accounts
            set end of accountNames to name of theAccount
        end repeat
        return accountNames
    end tell
    '''
    try:
        result = AppleScriptExecutor.execute(script)
        accounts = [name.strip() for name in result.split(",") if name.strip()]
        print(f"   找到 {len(accounts)} 个账户:")
        for i, account in enumerate(accounts, 1):
            print(f"   {i}. {account}")
        print()

        # 2. 对每个账户，获取其邮箱列表
        for account_name in accounts:
            print(f"2️⃣  账户 '{account_name}' 的邮箱列表:")
            script = f'''
            tell application "Mail"
                tell account "{account_name}"
                    set mailboxNames to {{}}
                    repeat with theMailbox in mailboxes
                        set end of mailboxNames to name of theMailbox
                    end repeat
                    return mailboxNames
                end tell
            end tell
            '''
            try:
                result = AppleScriptExecutor.execute(script)
                mailboxes = [name.strip() for name in result.split(",") if name.strip()]
                print(f"   找到 {len(mailboxes)} 个邮箱:")
                for i, mailbox in enumerate(mailboxes, 1):
                    print(f"   {i}. {mailbox}")
                print()

                # 3. 尝试获取未读邮件数量
                print(f"3️⃣  尝试获取各邮箱的未读邮件数...")
                for mailbox_name in mailboxes[:5]:  # 只检查前5个邮箱
                    try:
                        script = f'''
                        tell application "Mail"
                            tell account "{account_name}"
                                tell mailbox "{mailbox_name}"
                                    return count of (messages whose read status is false)
                                end tell
                            end tell
                        end tell
                        '''
                        count = AppleScriptExecutor.execute(script)
                        if count.isdigit() and int(count) > 0:
                            print(f"   ✅ '{mailbox_name}': {count} 封未读邮件")
                    except Exception as e:
                        print(f"   ❌ '{mailbox_name}': 无法访问 ({str(e)[:50]}...)")
                print()

            except Exception as e:
                print(f"   ❌ 无法获取邮箱列表: {e}")
                print()

    except Exception as e:
        print(f"❌ 无法获取账户列表: {e}")

    print("=" * 60)
    print("调试完成!")
    print()
    print("💡 提示:")
    print("1. 记下你的实际账户名称")
    print("2. 记下包含未读邮件的邮箱名称")
    print("3. 更新 .env 文件中的 MAIL_ACCOUNT_NAME")
    print("=" * 60)

if __name__ == "__main__":
    main()
