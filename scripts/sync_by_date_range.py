import sys
import asyncio
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.mail.applescript_arm import AppleScriptArm
from src.mail.reader import EmailReader
from src.notion.sync import NotionSync
from src.mail.sync_store import SyncStore
from src.config import config
from loguru import logger

async def main():
    logger.info("Starting manual sync for date range 2026-03-13 to 2026-03-15 via AppleScript")
    
    arm = AppleScriptArm(account_name=config.mail_account_name, inbox_name=config.mail_inbox_name)
    email_reader = EmailReader()
    notion_sync = NotionSync()
    sync_store = SyncStore(config.sync_store_db_path)
    
    start_date = datetime(2026, 3, 13)
    end_date = datetime(2026, 3, 15, 23, 59, 59)
    
    success_count = 0
    mailboxes = ["收件箱", "发件箱"]
    
    for mailbox in mailboxes:
        logger.info(f"Fetching latest emails from {mailbox} in batches...")
        
        target_emails = []
        limit = 500
        batch_size = 50
        offset = 0
        
        mailbox_name = arm._get_mailbox_name(mailbox)
        
        while offset < limit:
            logger.info(f"Fetching batch offset {offset} (size {batch_size})...")
            emails = arm._fetch_emails_from_applescript(count=batch_size, mailbox_name=mailbox_name, offset=offset)
            if not emails:
                break
                
            for em in emails:
                date_str = em.get("date_received")
                if not date_str:
                    continue
                try:
                    dt = datetime.fromisoformat(date_str)
                    dt = dt.replace(tzinfo=None)
                    if start_date <= dt <= end_date:
                        target_emails.append(em)
                except Exception as e:
                    pass
            
            offset += len(emails)
            if len(emails) < batch_size:
                break
                
        logger.info(f"Found {len(target_emails)} emails in the target date range in {mailbox}.")
        
        for meta in target_emails:
            internal_id = meta["id"]
            subject = meta["subject"]
            
            logger.info(f"Processing ID: {internal_id}, Subject: {subject}")
            
            # Check if synced
            existing = sync_store.get(internal_id)
            if existing and existing.get("sync_status") == "synced":
                logger.info(f"Email {internal_id} is already synced. Skipping.")
                continue
                
            full_email = arm.fetch_email_content_by_id(internal_id, mailbox)
            if not full_email:
                logger.warning(f"Failed to fetch content for ID {internal_id}")
                continue
                
            message_id = full_email.get("message_id")
            thread_id = full_email.get("thread_id")
            
            if not existing:
                sync_store.save_email({
                    'internal_id': internal_id,
                    'message_id': message_id,
                    'thread_id': thread_id,
                    'subject': full_email.get('subject', ''),
                    'sender': full_email.get('sender', ''),
                    'date_received': full_email.get('date', ''),
                    'mailbox': mailbox,
                    'is_read': full_email.get('is_read', False),
                    'is_flagged': full_email.get('is_flagged', False),
                    'sync_status': 'pending'
                })
            else:
                 sync_store.update_after_fetch(internal_id, {
                    'message_id': message_id,
                    'thread_id': thread_id,
                    'subject': full_email.get('subject', ''),
                    'sender': full_email.get('sender', '')
                })
                
            source = full_email.get('source', '')
            if not source:
                continue
                
            email_obj = email_reader.parse_email_source(
                source=source,
                message_id=message_id,
                is_read=full_email.get('is_read', False),
                is_flagged=full_email.get('is_flagged', False)
            )
            
            if not email_obj:
                continue
                
            email_obj.mailbox = mailbox
            email_obj.thread_id = thread_id
            email_obj.internal_id = internal_id
            if full_email.get('subject'):
                email_obj.subject = full_email.get('subject')
                
            try:
                page_id = await notion_sync.create_email_page_v2(email_obj)
                if page_id:
                    sync_store.mark_synced_v3(internal_id, page_id)
                    logger.info(f"Successfully synced {internal_id} -> {page_id}")
                    success_count += 1
            except Exception as e:
                logger.error(f"Error syncing {internal_id}: {e}")

    logger.info(f"Sync complete. Successfully synced {success_count} emails.")

if __name__ == "__main__":
    asyncio.run(main())
