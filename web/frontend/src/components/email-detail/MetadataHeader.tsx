import type { EmailDetail } from "@/lib/types";
import { formatTime } from "@/lib/constants";

interface Props {
  email: EmailDetail;
}

function notionUrl(pageId: string): string {
  return `https://notion.so/${pageId.replace(/-/g, "")}`;
}

export function MetadataHeader({ email }: Props) {
  return (
    <div className="px-4 py-2">
      <div className="space-y-1.5 text-xs">
        <div className="flex gap-2">
          <span className="text-gray-500 w-12 flex-shrink-0">发件人</span>
          <span className="text-gray-300">{email.sender}</span>
        </div>
        {email.to_addr && (
          <div className="flex gap-2">
            <span className="text-gray-500 w-12 flex-shrink-0">收件人</span>
            <span className="text-gray-400 truncate">{email.to_addr}</span>
          </div>
        )}
        {email.cc_addr && (
          <div className="flex gap-2">
            <span className="text-gray-500 w-12 flex-shrink-0">抄送</span>
            <span className="text-gray-400 truncate">{email.cc_addr}</span>
          </div>
        )}
        <div className="flex gap-2">
          <span className="text-gray-500 w-12 flex-shrink-0">时间</span>
          <span className="text-gray-400">{formatTime(email.date_received)}</span>
        </div>
        {email.mailbox && (
          <div className="flex gap-2">
            <span className="text-gray-500 w-12 flex-shrink-0">邮箱</span>
            <span className="text-gray-400">{email.mailbox}</span>
          </div>
        )}
        {email.notion_page_id && (
          <div className="flex gap-2">
            <span className="text-gray-500 w-12 flex-shrink-0">链接</span>
            <a
              href={notionUrl(email.notion_page_id)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              在 Notion 中打开
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
