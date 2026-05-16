#!/usr/bin/env python3
"""检查邮件的内联图片引用"""

import re
from src.mail.reader import EmailReader
from loguru import logger

def main():
    reader = EmailReader()

    # 获取未读邮件
    emails = reader.get_unread_emails(limit=10)

    # 找到目标邮件
    target = None
    for email in emails:
        if 'Omada EAP Memory Usage' in email.subject:
            target = email
            break

    if not target:
        print('❌ Email not found')
        return

    print(f'📧 Subject: {target.subject}')
    print(f'\n📎 Attachments ({len(target.attachments)}):')
    for att in target.attachments:
        print(f'  - {att.filename} ({att.content_type})')

    # 检查 HTML 中的 cid 引用
    if target.content_type == 'text/html':
        cid_pattern = r'cid:([^"\'\s>]+)'
        cid_matches = re.findall(cid_pattern, target.content, re.IGNORECASE)

        print(f'\n🔍 Found {len(cid_matches)} cid references in HTML:')
        unique_cids = set(cid_matches)
        for cid in sorted(unique_cids):
            print(f'  - cid:{cid}')

        # 匹配 cid 到附件
        print(f'\n🔗 Matching cid to attachments:')
        for cid in sorted(unique_cids):
            matched = False
            for att in target.attachments:
                if att.content_type.startswith('image/'):
                    filename = att.filename
                    filename_without_ext = filename.rsplit('.', 1)[0] if '.' in filename else filename
                    cid_clean = cid.split('@')[0] if '@' in cid else cid

                    if (cid in filename or
                        filename in cid or
                        cid_clean in filename or
                        filename_without_ext in cid):
                        print(f'  ✅ cid:{cid} -> {filename}')
                        matched = True
                        break

            if not matched:
                print(f'  ❌ cid:{cid} -> NO MATCH')

        # 检查哪些图片不是内联的
        print(f'\n📷 Non-inline image attachments:')
        inline_matched = set()
        for cid in unique_cids:
            for att in target.attachments:
                if att.content_type.startswith('image/'):
                    filename = att.filename
                    filename_without_ext = filename.rsplit('.', 1)[0] if '.' in filename else filename
                    cid_clean = cid.split('@')[0] if '@' in cid else cid

                    if (cid in filename or
                        filename in cid or
                        cid_clean in filename or
                        filename_without_ext in cid):
                        inline_matched.add(filename)

        for att in target.attachments:
            if att.content_type.startswith('image/') and att.filename not in inline_matched:
                print(f'  - {att.filename} (regular attachment)')

    else:
        print(f'\n⚠️  Email is not HTML format: {target.content_type}')

if __name__ == '__main__':
    main()
