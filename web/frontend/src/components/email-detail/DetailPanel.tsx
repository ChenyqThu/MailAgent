import { useCallback, useEffect, useRef, useState } from "react";
import { clsx } from "clsx";
import { useEmailDetail } from "@/hooks/useEmailDetail";
import { useEmailBody } from "@/hooks/useEmailBody";
import { useThreadEmails } from "@/hooks/useThreadEmails";
import { useThreadBodies, type ThreadEmailBody } from "@/hooks/useThreadBodies";
import { MetadataHeader } from "./MetadataHeader";
import { AIFieldsCard } from "./AIFieldsCard";
import { ActionBar } from "./ActionBar";
import { apiFetch } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { formatTime, extractSenderName } from "@/lib/constants";

import type { EmailView } from "@/lib/types";

interface Props {
  emailId: number;
  view?: EmailView;
}

export function DetailPanel({ emailId, view }: Props) {
  const { data: email, isLoading, error } = useEmailDetail(emailId);
  const queryClient = useQueryClient();
  const [headerCollapsed, setHeaderCollapsed] = useState(false);

  /* 上下分隔条：null 时头部按内容自适应高度；用户拖动后切到固定 px */
  const panelRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerHeight, setHeaderHeight] = useState<number | null>(null);

  const handleVerticalDrag = useCallback((dy: number) => {
    const panel = panelRef.current;
    const header = headerRef.current;
    if (!panel || !header) return;
    const total = panel.clientHeight;
    setHeaderHeight((prev) => {
      const cur = prev ?? header.offsetHeight;
      // 上限 = 总高 - 120（给正文留至少 120px）；下限 = 60（保留 ActionBar 一行）
      const next = Math.max(60, Math.min(total - 120, cur + dy));
      return next;
    });
  }, []);

  const resetHeaderHeight = useCallback(() => setHeaderHeight(null), []);

  // 切换邮件 / 折叠状态变化时回到自适应
  useEffect(() => {
    setHeaderHeight(null);
  }, [emailId, headerCollapsed]);

  const isThread = !!email?.thread_id && email.thread_count > 1;
  const { data: threadEmails } = useThreadEmails(
    email?.thread_id ?? null,
    isThread,
  );

  // 线程模式：批量加载所有正文；单封模式：只加载当前
  const { data: threadBodies, isLoading: threadBodiesLoading } = useThreadBodies(
    email?.thread_id ?? null,
    isThread,
  );
  const { data: bodyData, isLoading: bodyLoading } = useEmailBody(
    isThread ? null : emailId,
  );

  async function handleAction(action: string) {
    try {
      if (isThread && threadEmails && threadEmails.length > 1) {
        const ids = threadEmails.map((e) => e.internal_id);
        await apiFetch("/emails/batch-action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, email_ids: ids }),
        });
      } else {
        await apiFetch(`/emails/${emailId}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
      }
      queryClient.invalidateQueries({ queryKey: ["emails"] });
      queryClient.invalidateQueries({ queryKey: ["email-detail", emailId] });
      queryClient.invalidateQueries({ queryKey: ["view-counts"] });
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
    <div ref={panelRef} className="flex-1 flex flex-col overflow-hidden">
      {/* 可折叠头部 — 用户拖动后高度固定 + 内部滚动；否则按内容自适应 */}
      <div
        ref={headerRef}
        className={clsx(
          "border-b border-border",
          headerHeight === null
            ? "flex-shrink-0"
            : "flex-shrink-0 overflow-y-auto",
        )}
        style={headerHeight === null ? undefined : { height: headerHeight }}
      >
        <div
          className="flex items-center justify-between px-4 py-1.5 cursor-pointer hover:bg-bg-hover"
          onClick={() => setHeaderCollapsed(!headerCollapsed)}
        >
          <h2 className="text-sm font-medium text-fg-primary truncate flex-1 mr-4">
            {email.subject || "(无主题)"}
            {isThread && (
              <span className="text-[10px] text-fg-muted font-normal ml-2">
                {email.thread_count} 封对话
              </span>
            )}
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
          threadCount={isThread ? email.thread_count : undefined}
          onAction={handleAction}
        />
      </div>

      {/* 横向拖把柄 — 双击恢复自适应 */}
      <VerticalDragHandle onDrag={handleVerticalDrag} onDoubleClick={resetHeaderHeight} />

      {/* 正文区域 */}
      <div className="flex-1 overflow-y-auto px-5 py-3 min-h-0">
        {isThread ? (
          <ThreadConversation
            bodies={threadBodies}
            loading={threadBodiesLoading}
          />
        ) : (
          <SingleBody
            body={bodyData?.body}
            loading={bodyLoading}
            hasNotion={!!email.notion_page_id}
          />
        )}
      </div>
    </div>
  );
}

/* 横向拖把柄（detail 内部上下分隔） */
function VerticalDragHandle({
  onDrag,
  onDoubleClick,
}: {
  onDrag: (dy: number) => void;
  onDoubleClick: () => void;
}) {
  const dragging = useRef(false);
  const lastY = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    lastY.current = e.clientY;
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const dy = ev.clientY - lastY.current;
      lastY.current = ev.clientY;
      onDrag(dy);
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [onDrag]);

  return (
    <div
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      className="h-1 flex-shrink-0 cursor-row-resize group relative hover:bg-accent/30 active:bg-accent/50 transition-colors border-b border-border"
      title="拖动调整上下区域 · 双击恢复"
    >
      <div className="absolute inset-x-0 -top-1 -bottom-1" />
    </div>
  );
}

/* 单封邮件正文 */
function SingleBody({ body, loading, hasNotion }: { body?: string; loading: boolean; hasNotion: boolean }) {
  if (loading) {
    return <div className="text-xs text-fg-faint animate-pulse">正在加载正文...</div>;
  }
  if (body) {
    return (
      <div
        className="prose-email text-[13px] text-fg-secondary leading-relaxed"
        dangerouslySetInnerHTML={{ __html: body }}
      />
    );
  }
  return (
    <div className="text-xs text-fg-faint">
      {hasNotion ? "正文为空" : "该邮件未同步到 Notion"}
    </div>
  );
}

/* 线程对话视图：最新在上，默认展开；旧邮件默认收起，可逐条展开 */
function ThreadConversation({
  bodies,
  loading,
}: {
  bodies?: ThreadEmailBody[];
  loading: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const didInitRef = useRef(false);

  // 倒序：最新邮件在最上面
  const sorted = bodies ? [...bodies].reverse() : [];

  // 首次拿到 bodies 时把最新一封塞进 expanded（之后用户可自由 toggle）
  useEffect(() => {
    if (didInitRef.current || !sorted.length) return;
    const newestId = sorted[0]!.internal_id;
    setExpanded(new Set([newestId]));
    didInitRef.current = true;
  }, [sorted]);

  if (loading) {
    return <div className="text-xs text-fg-faint animate-pulse">正在加载对话...</div>;
  }

  if (!sorted.length) {
    return <div className="text-xs text-fg-faint">暂无正文</div>;
  }

  function toggle(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  return (
    <div className="space-y-2">
      {sorted.map((item) => {
        const isOpen = expanded.has(item.internal_id);
        const senderDisplay = item.sender_name
          ? item.sender_name
          : extractSenderName(item.sender || "");

        return (
          <div
            key={item.internal_id}
            className="border border-border rounded-lg overflow-hidden"
          >
            <div
              onClick={() => toggle(item.internal_id)}
              className={clsx(
                "flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors",
                isOpen ? "bg-bg-secondary" : "bg-bg-primary hover:bg-bg-hover",
              )}
            >
              <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 bg-bg-tertiary text-fg-muted">
                {(senderDisplay[0] || "?").toUpperCase()}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium truncate text-fg-primary">
                    {senderDisplay}
                  </span>
                  <span className="text-[10px] text-fg-faint flex-shrink-0 tabular-nums">
                    {formatTime(item.date_received)}
                  </span>
                </div>
                {!isOpen && item.body && (
                  <div className="text-[11px] text-fg-muted truncate mt-0.5">
                    {item.body.replace(/<[^>]*>/g, "").slice(0, 80)}
                  </div>
                )}
              </div>

              <span className="text-[10px] text-fg-faint flex-shrink-0">
                {isOpen ? "▲" : "▼"}
              </span>
            </div>

            {isOpen && (
              <div className="px-3 py-2 border-t border-border/50">
                {item.body ? (
                  <div
                    className="prose-email text-[13px] text-fg-secondary leading-relaxed"
                    dangerouslySetInnerHTML={{ __html: item.body }}
                  />
                ) : (
                  <div className="text-xs text-fg-faint">正文为空</div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
