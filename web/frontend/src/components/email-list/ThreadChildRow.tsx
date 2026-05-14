import { clsx } from "clsx";
import type { EmailListItem } from "@/lib/types";
import { formatTime, extractSenderName } from "@/lib/constants";

interface Props {
  email: EmailListItem;
  isActive: boolean;
  onClick: () => void;
  isLast: boolean;
}

export function ThreadChildRow({ email, isActive, onClick, isLast }: Props) {
  return (
    <div
      onClick={onClick}
      className={clsx(
        "pl-6 pr-3 py-1.5 cursor-pointer transition-colors flex items-center gap-2",
        !isLast && "border-b border-border/50",
        isActive
          ? "bg-bg-active border-l-2 border-l-accent"
          : "hover:bg-bg-hover",
      )}
    >
      {/* 竖线指示器 */}
      <span className="w-px h-4 bg-border flex-shrink-0" />

      <span className="text-[11px] text-fg-muted flex-shrink-0 w-20 truncate">
        {extractSenderName(email.sender)}
      </span>
      <span className="text-[11px] text-fg-faint flex-1 truncate">
        {email.subject || "(无主题)"}
      </span>
      <span className="text-[10px] text-fg-faint flex-shrink-0">
        {formatTime(email.date_received)}
      </span>
    </div>
  );
}
