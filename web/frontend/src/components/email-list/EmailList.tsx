import { useRef, useEffect, useState, useMemo, useCallback } from "react";
import type { EmailListItem } from "@/lib/types";
import { EmailRow } from "./EmailRow";
import { ThreadChildRow } from "./ThreadChildRow";
import { useThreadEmails } from "@/hooks/useThreadEmails";

interface Props {
  emails: EmailListItem[];
  activeId: number | null;
  onSelect: (id: number) => void;
  selectMode?: boolean;
  selectedIds?: Set<number>;
  onToggleSelect?: (id: number) => void;
}

interface ThreadGroup {
  representative: EmailListItem;
  threadId: string | null;
  count: number;
}

export function EmailList({
  emails,
  activeId,
  onSelect,
  selectMode = false,
  selectedIds,
  onToggleSelect,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (activeId === null || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-id="${activeId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  // 按 thread_id 分组：同 thread 只显示最新一封（internal_id 最大）
  const groups = useMemo<ThreadGroup[]>(() => {
    const seen = new Map<string, ThreadGroup>();
    const result: ThreadGroup[] = [];

    for (const email of emails) {
      const tid = email.thread_id;
      if (!tid || email.thread_count <= 1) {
        // 独立邮件
        result.push({ representative: email, threadId: null, count: 1 });
        continue;
      }

      if (seen.has(tid)) {
        // 同线程已有代表 — 跳过（emails 已按 internal_id DESC 排序，第一个就是最新）
        continue;
      }

      const group: ThreadGroup = {
        representative: email,
        threadId: tid,
        count: email.thread_count,
      };
      seen.set(tid, group);
      result.push(group);
    }

    return result;
  }, [emails]);

  const toggleThread = useCallback((threadId: string) => {
    setExpandedThreads((prev) => {
      const next = new Set(prev);
      if (next.has(threadId)) {
        next.delete(threadId);
      } else {
        next.add(threadId);
      }
      return next;
    });
  }, []);

  if (emails.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-fg-faint text-sm">
        没有邮件
      </div>
    );
  }

  return (
    <div ref={listRef} className="flex-1 overflow-y-auto">
      {groups.map((group) => (
        <ThreadGroupRow
          key={group.representative.internal_id}
          group={group}
          activeId={activeId}
          onSelect={onSelect}
          selectMode={selectMode}
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
          expanded={group.threadId ? expandedThreads.has(group.threadId) : false}
          onToggleThread={
            group.threadId ? () => toggleThread(group.threadId!) : undefined
          }
        />
      ))}
    </div>
  );
}

// --- Thread group row with lazy-loaded children ---

interface ThreadGroupRowProps {
  group: ThreadGroup;
  activeId: number | null;
  onSelect: (id: number) => void;
  selectMode: boolean;
  selectedIds?: Set<number>;
  onToggleSelect?: (id: number) => void;
  expanded: boolean;
  onToggleThread?: () => void;
}

function ThreadGroupRow({
  group,
  activeId,
  onSelect,
  selectMode,
  selectedIds,
  onToggleSelect,
  expanded,
  onToggleThread,
}: ThreadGroupRowProps) {
  const { data: threadEmails } = useThreadEmails(
    group.threadId,
    expanded,
  );

  // 子邮件 = 线程内除代表邮件外的邮件（按时间正序）
  const children = useMemo(() => {
    if (!threadEmails) return [];
    return threadEmails.filter(
      (e) => e.internal_id !== group.representative.internal_id,
    );
  }, [threadEmails, group.representative.internal_id]);

  const email = group.representative;

  return (
    <>
      <div data-id={email.internal_id}>
        <EmailRow
          email={email}
          isActive={email.internal_id === activeId}
          onClick={() => {
            if (selectMode && onToggleSelect) {
              onToggleSelect(email.internal_id);
            } else {
              onSelect(email.internal_id);
            }
          }}
          selected={selectMode && !!selectedIds?.has(email.internal_id)}
          selectMode={selectMode}
          threadCount={group.count}
          threadExpanded={expanded}
          onToggleThread={onToggleThread}
        />
      </div>

      {/* 展开的子邮件 */}
      {expanded &&
        children.map((child, idx) => (
          <div key={child.internal_id} data-id={child.internal_id}>
            <ThreadChildRow
              email={child}
              isActive={child.internal_id === activeId}
              onClick={() => onSelect(child.internal_id)}
              isLast={idx === children.length - 1}
            />
          </div>
        ))}
    </>
  );
}
