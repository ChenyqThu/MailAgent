import { clsx } from "clsx";
import { useNavigate } from "react-router";
import type { DashboardRange } from "@/hooks/useDashboard";
import { useAttentionEmails } from "@/hooks/useDashboard";
import { PRIORITY_CONFIG, extractSenderName, formatTime } from "@/lib/constants";

interface Props {
  range: DashboardRange;
}

export function AttentionList({ range }: Props) {
  const { data: emails } = useAttentionEmails(range);
  const navigate = useNavigate();

  return (
    <div className="bg-bg-secondary rounded-xl border border-border overflow-hidden h-full">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-fg-primary">需要关注</span>
          {emails?.length ? (
            <span className="text-[10px] text-fg-faint bg-bg-tertiary px-1.5 py-0.5 rounded-full tabular-nums">
              {emails.length}
            </span>
          ) : null}
        </div>
        <button
          onClick={() => navigate("/inbox")}
          className="text-[11px] text-accent hover:text-accent/80 font-medium transition-colors"
        >
          进入工作台 →
        </button>
      </div>
      <div className="max-h-[340px] overflow-y-auto divide-y divide-border/50">
        {!emails?.length ? (
          <div className="px-4 py-10 text-center">
            <div className="text-2xl mb-2">✨</div>
            <div className="text-xs text-fg-faint">没有紧急或重要邮件</div>
          </div>
        ) : (
          emails.map((email) => {
            const pc = PRIORITY_CONFIG[email.priority || ""] ?? {
              label: "—", color: "text-fg-faint", bg: "bg-fg-muted/10", order: 99,
            };
            return (
              <div
                key={email.internal_id}
                onClick={() => navigate(`/inbox?id=${email.internal_id}`)}
                className="px-4 py-3 cursor-pointer hover:bg-bg-hover transition-colors group"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className={clsx(
                    "text-[10px] font-bold px-1.5 py-0.5 rounded-md uppercase tracking-wide",
                    pc.bg, pc.color,
                  )}>
                    {pc.label}
                  </span>
                  {email.action_type && (
                    <span className="text-[10px] text-fg-muted bg-bg-tertiary px-1.5 py-0.5 rounded">
                      {email.action_type}
                    </span>
                  )}
                  {email.category && (
                    <span className="text-[10px] text-fg-faint hidden sm:inline">
                      {email.category}
                    </span>
                  )}
                  <span className="text-[10px] text-fg-faint ml-auto flex-shrink-0 tabular-nums">
                    {formatTime(email.date_received)}
                  </span>
                </div>
                <div className="text-xs text-fg-primary truncate font-medium group-hover:text-accent transition-colors">
                  {email.subject || "(无主题)"}
                </div>
                <div className="text-[11px] text-fg-faint truncate mt-0.5">
                  {extractSenderName(email.sender)}
                  {email.ai_summary ? ` · ${email.ai_summary}` : ""}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
