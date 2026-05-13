import { useState } from "react";
import { useEmailDetail } from "@/hooks/useEmailDetail";
import { useEmailBody } from "@/hooks/useEmailBody";
import { MetadataHeader } from "./MetadataHeader";
import { AIFieldsCard } from "./AIFieldsCard";
import { ActionBar } from "./ActionBar";
import { apiFetch } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";

import type { EmailView } from "@/lib/types";

interface Props {
  emailId: number;
  view?: EmailView;
}

export function DetailPanel({ emailId, view }: Props) {
  const { data: email, isLoading, error } = useEmailDetail(emailId);
  const { data: bodyData, isLoading: bodyLoading } = useEmailBody(emailId);
  const queryClient = useQueryClient();
  const [headerCollapsed, setHeaderCollapsed] = useState(false);

  async function handleAction(action: string) {
    try {
      await apiFetch(`/emails/${emailId}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      queryClient.invalidateQueries({ queryKey: ["emails"] });
      queryClient.invalidateQueries({ queryKey: ["email", emailId] });
    } catch {
      // TODO: toast
    }
  }

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-fg-faint text-sm">
        加载中...
      </div>
    );
  }

  if (error || !email) {
    return (
      <div className="flex-1 flex items-center justify-center text-fg-faint text-sm">
        加载失败
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 可折叠头部 */}
      <div className="flex-shrink-0 border-b border-border">
        <div
          className="flex items-center justify-between px-4 py-1.5 cursor-pointer hover:bg-bg-hover"
          onClick={() => setHeaderCollapsed(!headerCollapsed)}
        >
          <h2 className="text-sm font-medium text-fg-primary truncate flex-1 mr-4">
            {email.subject || "(无主题)"}
          </h2>
          <span className="text-[10px] text-fg-faint">
            {headerCollapsed ? "展开 ▼" : "收起 ▲"}
          </span>
        </div>

        {!headerCollapsed && (
          <>
            <MetadataHeader email={email} />
            <AIFieldsCard email={email} />
          </>
        )}

        <ActionBar
          isFlagged={email.is_flagged}
          isRead={email.is_read}
          isDone={!email.is_flagged && email.llm_status === "success"}
          view={view}
          onAction={handleAction}
        />
      </div>

      {/* 正文区域 — 占满剩余空间 */}
      <div className="flex-1 overflow-y-auto px-5 py-3 min-h-0">
        {bodyLoading ? (
          <div className="text-xs text-fg-faint animate-pulse">
            正在从 Notion 加载正文...
          </div>
        ) : bodyData?.body ? (
          <pre className="text-[13px] text-fg-secondary whitespace-pre-wrap font-sans leading-relaxed">
            {bodyData.body}
          </pre>
        ) : (
          <div className="text-xs text-fg-faint">
            {email.notion_page_id ? "正文为空" : "该邮件未同步到 Notion"}
          </div>
        )}
      </div>
    </div>
  );
}
