import subprocess
from typing import List, Dict, Any
from loguru import logger

class AppleScriptExecutor:
    """AppleScript 执行器"""

    @staticmethod
    def execute(script: str) -> str:
        """执行 AppleScript"""
        try:
            result = subprocess.run(
                ["osascript", "-e", script],
                capture_output=True,
                text=True,
                timeout=120  # 增加超时时间到120秒
            )

            if result.returncode != 0:
                logger.error(f"AppleScript error: {result.stderr}")
                raise RuntimeError(f"AppleScript failed: {result.stderr}")

            return result.stdout.strip()

        except subprocess.TimeoutExpired:
            logger.error("AppleScript execution timed out")
            raise
        except Exception as e:
            logger.error(f"AppleScript execution failed: {e}")
            raise

class MailAppScripts:
    """Mail.app 相关的 AppleScript 脚本"""

    @staticmethod
    def get_unread_count(account: str = "Exchange", inbox: str = "收件箱") -> int:
        """获取未读邮件数量"""
        script = f'''
        tell application "Mail"
            tell account "{account}"
                tell mailbox "{inbox}"
                    return count of (messages whose read status is false)
                end tell
            end tell
        end tell
        '''
        result = AppleScriptExecutor.execute(script)
        return int(result) if result.isdigit() else 0

    @staticmethod
    def get_unread_message_ids(account: str = "Exchange", inbox: str = "收件箱", limit: int = 10) -> List[str]:
        """获取未读邮件的 Message ID 列表"""
        script = f'''
        tell application "Mail"
            tell account "{account}"
                tell mailbox "{inbox}"
                    set unreadMessages to (messages whose read status is false)
                    set messageIds to {{}}

                    repeat with i from 1 to (count of unreadMessages)
                        if i > {limit} then exit repeat
                        set theMessage to item i of unreadMessages
                        set messageId to message id of theMessage
                        set end of messageIds to messageId
                    end repeat

                    return messageIds
                end tell
            end tell
        end tell
        '''
        result = AppleScriptExecutor.execute(script)
        if not result:
            return []

        # AppleScript 返回的是逗号分隔的字符串
        return [mid.strip() for mid in result.split(",") if mid.strip()]

    @staticmethod
    def get_email_details(message_id: str, account: str = "Exchange", inbox: str = "收件箱") -> Dict[str, Any]:
        """获取邮件详细信息"""
        script = f'''
        tell application "Mail"
            tell account "{account}"
                tell mailbox "{inbox}"
                    set theMessage to first message whose message id is "{message_id}"

                    set emailSubject to subject of theMessage
                    set emailSender to sender of theMessage
                    set emailDate to date received of theMessage
                    set emailContent to content of theMessage
                    set emailIsRead to read status of theMessage
                    set emailIsFlagged to flagged status of theMessage
                    set emailTo to ""
                    set emailCC to ""

                    -- 获取收件人
                    try
                        set toRecipients to to recipients of theMessage
                        set recipientList to {{}}
                        repeat with recip in toRecipients
                            set end of recipientList to (address of recip)
                        end repeat
                        set AppleScript's text item delimiters to ", "
                        set emailTo to recipientList as string
                        set AppleScript's text item delimiters to ""
                    end try

                    -- 获取抄送人
                    try
                        set ccRecipients to cc recipients of theMessage
                        set ccList to {{}}
                        repeat with recip in ccRecipients
                            set end of ccList to (address of recip)
                        end repeat
                        set AppleScript's text item delimiters to ", "
                        set emailCC to ccList as string
                        set AppleScript's text item delimiters to ""
                    end try

                    -- 获取附件数量
                    set emailAttachmentCount to count of mail attachments of theMessage

                    -- 返回结果（使用特殊分隔符）
                    return emailSubject & "|||" & emailSender & "|||" & (emailDate as string) & "|||" & emailContent & "|||" & emailIsRead & "|||" & emailIsFlagged & "|||" & emailTo & "|||" & emailCC & "|||" & emailAttachmentCount
                end tell
            end tell
        end tell
        '''

        result = AppleScriptExecutor.execute(script)
        parts = result.split("|||")

        if len(parts) < 9:
            raise ValueError(f"Invalid email details format: {result}")

        return {
            "subject": parts[0],
            "sender": parts[1],
            "date": parts[2],
            "content": parts[3],
            "is_read": parts[4].lower() == "true",
            "is_flagged": parts[5].lower() == "true",
            "to": parts[6],
            "cc": parts[7],
            "attachment_count": int(parts[8])
        }

    @staticmethod
    def save_attachments(message_id: str, save_dir: str, account: str = "Exchange", inbox: str = "收件箱") -> List[str]:
        """保存邮件附件"""
        script = f'''
        tell application "Mail"
            tell account "{account}"
                tell mailbox "{inbox}"
                    set theMessage to first message whose message id is "{message_id}"
                    set theAttachments to mail attachments of theMessage
                    set savedPaths to {{}}

                    repeat with theAttachment in theAttachments
                        set attachmentName to name of theAttachment
                        set savePath to "{save_dir}/" & attachmentName

                        try
                            save theAttachment in POSIX file savePath
                            set end of savedPaths to savePath
                        on error errMsg
                            log "Failed to save attachment: " & errMsg
                        end try
                    end repeat

                    return savedPaths
                end tell
            end tell
        end tell
        '''

        result = AppleScriptExecutor.execute(script)
        if not result:
            return []

        return [path.strip() for path in result.split(",") if path.strip()]

    @staticmethod
    def get_email_source(message_id: str, account: str = "Exchange", inbox: str = "收件箱") -> str:
        """获取邮件原始源码（用于生成 .eml）"""
        script = f'''
        tell application "Mail"
            tell account "{account}"
                tell mailbox "{inbox}"
                    set theMessage to first message whose message id is "{message_id}"
                    return source of theMessage
                end tell
            end tell
        end tell
        '''
        return AppleScriptExecutor.execute(script)
