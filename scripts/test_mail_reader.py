"""
测试邮件读取 - 使用 id（整数）替代 message id（字符串）获取邮件

验证目的：
- 确认通过 AppleScript `id` 获取邮件内容的性能（预期 ~1 秒 vs 旧方法 ~100 秒）
- 用于在大邮箱环境（6-7 万封邮件）下测试是否能正常运行

关键发现：
- SQLite ROWID = AppleScript id（100% 匹配）
- whose id is <整数> 比 whose message id is <字符串> 快 ~127 倍
"""

import sys
import subprocess
import time
from pathlib import Path

# 添加项目根目录到路径
sys.path.insert(0, str(Path(__file__).parent.parent))

from src.config import config
from src.utils.logger import setup_logger


def fetch_emails_with_id(account_name: str, mailbox_name: str, count: int = 5):
    """
    获取最新 N 封邮件（包含内部 id）

    Returns:
        List[Dict] 包含 message_id, id, subject, sender, date_received, is_read, is_flagged
    """
    script = f'''
    tell application "Mail"
        set resultList to {{}}
        tell account "{account_name}"
            tell mailbox "{mailbox_name}"
                set msgCount to count of messages
                set endIdx to {count}
                if endIdx > msgCount then set endIdx to msgCount

                repeat with i from 1 to endIdx
                    try
                        set m to message i
                        set msgMessageId to message id of m
                        set msgInternalId to id of m
                        set msgSubject to subject of m
                        set msgSender to sender of m
                        set msgDate to date received of m
                        set msgRead to read status of m
                        set msgFlagged to flagged status of m

                        -- 格式化日期
                        set dateStr to (year of msgDate as string) & "-"
                        set monthNum to (month of msgDate as integer)
                        if monthNum < 10 then set dateStr to dateStr & "0"
                        set dateStr to dateStr & (monthNum as string) & "-"
                        set dayNum to (day of msgDate as integer)
                        if dayNum < 10 then set dateStr to dateStr & "0"
                        set dateStr to dateStr & (dayNum as string) & "T"
                        set hourNum to (hours of msgDate as integer)
                        if hourNum < 10 then set dateStr to dateStr & "0"
                        set dateStr to dateStr & (hourNum as string) & ":"
                        set minuteNum to (minutes of msgDate as integer)
                        if minuteNum < 10 then set dateStr to dateStr & "0"
                        set dateStr to dateStr & (minuteNum as string) & ":"
                        set secondNum to (seconds of msgDate as integer)
                        if secondNum < 10 then set dateStr to dateStr & "0"
                        set dateStr to dateStr & (secondNum as string)

                        set info to msgMessageId & "{{{{SEP}}}}" & (msgInternalId as string) & "{{{{SEP}}}}" & msgSubject & "{{{{SEP}}}}" & msgSender & "{{{{SEP}}}}" & dateStr & "{{{{SEP}}}}" & (msgRead as string) & "{{{{SEP}}}}" & (msgFlagged as string)
                        set end of resultList to info
                    end try
                end repeat
            end tell
        end tell

        set AppleScript's text item delimiters to "{{{{REC}}}}"
        set resultStr to resultList as string
        set AppleScript's text item delimiters to ""
        return resultStr
    end tell
    '''

    result = subprocess.run(['osascript', '-e', script], capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        print(f"AppleScript error: {result.stderr}")
        return []

    output = result.stdout.strip()
    if not output:
        return []

    emails = []
    for record in output.split("{{REC}}"):
        if not record.strip():
            continue
        parts = record.split("{{SEP}}")
        if len(parts) >= 7:
            emails.append({
                'message_id': parts[0],
                'id': int(parts[1]),  # 内部 id（整数）
                'subject': parts[2],
                'sender': parts[3],
                'date_received': parts[4],
                'is_read': parts[5].lower() == 'true',
                'is_flagged': parts[6].lower() == 'true',
            })

    return emails


def fetch_email_content_by_id(account_name: str, internal_id: int):
    """
    通过内部 id（整数）获取邮件完整内容

    这是新方法，使用 `whose id is <整数>` 替代 `whose message id is <字符串>`
    性能提升约 127 倍（~1 秒 vs ~100 秒）

    Args:
        account_name: 账户名称
        internal_id: 邮件内部 id（整数，等于 SQLite ROWID）

    Returns:
        Dict 包含 subject, sender, date, content, source, is_read, is_flagged
    """
    script = f'''
    tell application "Mail"
        try
            -- 在所有邮箱中查找指定 id 的邮件
            set foundMsg to null
            tell account "{account_name}"
                repeat with mbox in mailboxes
                    try
                        set foundMsg to first message of mbox whose id is {internal_id}
                        exit repeat
                    end try
                end repeat
            end tell

            if foundMsg is null then
                return "ERROR{{{{SEP}}}}Email not found with id {internal_id}"
            end if

            set msgSubject to subject of foundMsg
            set msgSender to sender of foundMsg
            set msgDate to date received of foundMsg
            set msgContent to content of foundMsg
            set msgSource to source of foundMsg
            set msgRead to read status of foundMsg
            set msgFlagged to flagged status of foundMsg

            -- 格式化日期
            set dateStr to (year of msgDate as string) & "-"
            set monthNum to (month of msgDate as integer)
            if monthNum < 10 then set dateStr to dateStr & "0"
            set dateStr to dateStr & (monthNum as string) & "-"
            set dayNum to (day of msgDate as integer)
            if dayNum < 10 then set dateStr to dateStr & "0"
            set dateStr to dateStr & (dayNum as string) & "T"
            set hourNum to (hours of msgDate as integer)
            if hourNum < 10 then set dateStr to dateStr & "0"
            set dateStr to dateStr & (hourNum as string) & ":"
            set minuteNum to (minutes of msgDate as integer)
            if minuteNum < 10 then set dateStr to dateStr & "0"
            set dateStr to dateStr & (minuteNum as string) & ":"
            set secondNum to (seconds of msgDate as integer)
            if secondNum < 10 then set dateStr to dateStr & "0"
            set dateStr to dateStr & (secondNum as string)

            return "OK{{{{SEP}}}}" & msgSubject & "{{{{SEP}}}}" & msgSender & "{{{{SEP}}}}" & dateStr & "{{{{SEP}}}}" & msgContent & "{{{{SEP}}}}" & msgSource & "{{{{SEP}}}}" & (msgRead as string) & "{{{{SEP}}}}" & (msgFlagged as string)
        on error errMsg
            return "ERROR{{{{SEP}}}}" & errMsg
        end try
    end tell
    '''

    result = subprocess.run(['osascript', '-e', script], capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        print(f"AppleScript error: {result.stderr}")
        return None

    output = result.stdout.strip()
    if output.startswith("ERROR{{SEP}}"):
        print(f"Error: {output[11:]}")
        return None

    if not output.startswith("OK{{SEP}}"):
        print(f"Unexpected output: {output[:100]}")
        return None

    parts = output[8:].split("{{SEP}}")
    if len(parts) < 7:
        print(f"Invalid response format, got {len(parts)} parts")
        return None

    return {
        'subject': parts[0],
        'sender': parts[1],
        'date': parts[2],
        'content': parts[3],
        'source': parts[4],
        'is_read': parts[5].lower() == 'true',
        'is_flagged': parts[6].lower() == 'true',
    }


def main():
    """测试邮件读取 - 使用 id 替代 message id"""
    setup_logger("DEBUG")

    print("=" * 60)
    print("Testing Mail Reader (使用 id 替代 message id)")
    print("=" * 60)

    account_name = config.mail_account_name
    mailbox_name = config.mail_inbox_name

    print(f"\n账户: {account_name}")
    print(f"邮箱: {mailbox_name}")
    print("\n正在获取最新 5 封邮件（包含内部 id）...")

    # 获取最新 5 封邮件（包含内部 id）
    start_time = time.time()
    emails = fetch_emails_with_id(account_name, mailbox_name, count=5)
    fetch_time = time.time() - start_time

    print(f"\n找到 {len(emails)} 封邮件 (耗时 {fetch_time:.2f} 秒):\n")

    for i, email in enumerate(emails, 1):
        print(f"{i}. {email['subject']}")
        print(f"   发件人: {email['sender']}")
        print(f"   日期: {email['date_received']}")
        print(f"   内部 ID: {email['id']}")  # 关键：显示内部 id
        print(f"   Message ID: {email['message_id'][:50]}...")
        print(f"   已读: {email['is_read']}")
        print(f"   已标记: {email['is_flagged']}")
        print()

    # 测试通过 id 获取完整邮件内容
    if emails:
        print("-" * 60)
        print("测试通过内部 id 获取完整邮件内容（第一封邮件）:")
        print("-" * 60)

        first_email = emails[0]
        internal_id = first_email['id']

        print(f"\n使用 id={internal_id} 获取邮件...")

        start_time = time.time()
        full_email = fetch_email_content_by_id(account_name, internal_id)
        content_time = time.time() - start_time

        if full_email:
            print(f"\n✅ 获取成功！耗时 {content_time:.2f} 秒")
            print(f"主题: {full_email['subject']}")
            print(f"发件人: {full_email['sender']}")
            print(f"日期: {full_email['date']}")
            print(f"内容长度: {len(full_email['content'])} 字符")
            print(f"源码长度: {len(full_email['source'])} 字符")
            print(f"已读: {full_email['is_read']}")
            print(f"已标记: {full_email['is_flagged']}")

            # 显示内容预览
            content_preview = full_email['content'][:200].replace('\n', ' ')
            print(f"\n内容预览: {content_preview}...")
        else:
            print(f"\n❌ 获取失败")

        print("\n" + "=" * 60)
        print("测试完成！")
        print("=" * 60)
        print(f"\n性能摘要:")
        print(f"  - 获取 5 封邮件元数据: {fetch_time:.2f} 秒")
        print(f"  - 通过 id 获取完整内容: {content_time:.2f} 秒")
        print(f"\n如果旧方法（whose message id is）需要 ~100 秒，")
        print(f"新方法（whose id is）只需 ~{content_time:.1f} 秒，提升约 {100/max(content_time, 0.1):.0f} 倍")


if __name__ == "__main__":
    main()
