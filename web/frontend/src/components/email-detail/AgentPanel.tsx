import { useState, useRef, useEffect, useCallback } from "react";
import { clsx } from "clsx";

interface Props {
  emailId: number | null;
  body: string | null;
  subject: string | null;
  sender?: string;
  senderName?: string;
  date?: string;
  mailbox?: string;
  threadId?: string;
  onClose: () => void;
}

interface ToolCall {
  tool: string;
  toolUseId: string;
  summary?: string;
  pending: boolean;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCall[];
}

const QUICK_ACTIONS = [
  { id: "translate", label: "翻译", prompt: "翻译这封邮件" },
  { id: "summarize", label: "总结", prompt: "总结这封邮件的关键要点" },
  { id: "draft_reply", label: "起草回复", prompt: "帮我起草一封回复" },
] as const;

const TOOL_LABELS: Record<string, string> = {
  search_emails: "搜索邮件",
  read_email_body: "读取正文",
  get_thread_context: "获取线程",
  get_sender_stats: "发件人统计",
  search_by_date: "日期搜索",
  get_email_ai_labels: "AI 标签",
};

export function AgentPanel({
  emailId,
  body,
  subject,
  sender,
  senderName,
  date,
  mailbox,
  threadId,
  onClose,
}: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const prevEmailIdRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 切换邮件时清空对话
  useEffect(() => {
    if (emailId !== prevEmailIdRef.current) {
      prevEmailIdRef.current = emailId;
      setMessages([]);
      setSessionId(null);
      abortRef.current?.abort();
    }
  }, [emailId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = useCallback(
    async (text: string) => {
      if (loading || !text.trim()) return;

      setMessages((prev) => [...prev, { role: "user", content: text }]);
      setLoading(true);

      const controller = new AbortController();
      abortRef.current = controller;

      // Build request
      const payload: Record<string, unknown> = {
        message: text,
        session_id: sessionId,
      };

      // 有选中邮件时附带上下文
      if (emailId !== null) {
        payload.email_context = {
          internal_id: emailId,
          subject: subject || "",
          sender: sender || "",
          sender_name: senderName || "",
          date: date || "",
          mailbox: mailbox || "",
          body: body?.slice(0, 3000) || "",
          thread_id: threadId || "",
        };
      }

      // 添加空 assistant message 占位
      const assistantIdx = messages.length + 1; // +1 for user msg just added
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "", toolCalls: [] },
      ]);

      try {
        const token = localStorage.getItem("mailagent_token") || "";
        const res = await fetch("/api/agent/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`API ${res.status}: ${errText}`);
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const jsonStr = line.slice(6).trim();
            if (!jsonStr) continue;

            try {
              const evt = JSON.parse(jsonStr);
              handleSSEEvent(evt, assistantIdx);
            } catch {
              // ignore malformed JSON
            }
          }
        }

        // Process remaining buffer
        if (buffer.startsWith("data: ")) {
          try {
            const evt = JSON.parse(buffer.slice(6).trim());
            handleSSEEvent(evt, assistantIdx);
          } catch {
            // ignore
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === "assistant") {
            updated[updated.length - 1] = {
              ...last,
              content: last.content || "请求失败，请稍后重试",
            };
          }
          return updated;
        });
      } finally {
        setLoading(false);
        abortRef.current = null;
      }
    },
    [loading, sessionId, emailId, subject, sender, senderName, date, mailbox, body, threadId, messages.length],
  );

  function handleSSEEvent(evt: Record<string, unknown>, _idx: number) {
    const type = evt.type as string;

    if (type === "session") {
      setSessionId(evt.session_id as string);
      return;
    }

    if (type === "text_delta") {
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === "assistant") {
          updated[updated.length - 1] = {
            ...last,
            content: last.content + (evt.text as string),
          };
        }
        return updated;
      });
      return;
    }

    if (type === "tool_start") {
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === "assistant") {
          const toolCalls = [
            ...(last.toolCalls || []),
            {
              tool: evt.tool as string,
              toolUseId: evt.tool_use_id as string,
              pending: true,
            },
          ];
          updated[updated.length - 1] = { ...last, toolCalls };
        }
        return updated;
      });
      return;
    }

    if (type === "tool_result") {
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === "assistant" && last.toolCalls) {
          const toolCalls = last.toolCalls.map((tc) =>
            tc.toolUseId === (evt.tool_use_id as string)
              ? { ...tc, summary: evt.summary as string, pending: false }
              : tc,
          );
          updated[updated.length - 1] = { ...last, toolCalls };
        }
        return updated;
      });
      return;
    }

    if (type === "error") {
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === "assistant") {
          updated[updated.length - 1] = {
            ...last,
            content: last.content || (evt.message as string) || "发生错误",
          };
        }
        return updated;
      });
    }
  }

  function handleSubmit() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    sendMessage(text);
  }

  function handleNewSession() {
    setMessages([]);
    setSessionId(null);
    abortRef.current?.abort();
  }

  const hasEmail = emailId !== null;

  return (
    <div className="h-full flex flex-col bg-bg-primary">
      {/* 头部 */}
      <div className="flex-shrink-0 px-3 py-2 border-b border-border flex items-center gap-2">
        <span className="text-xs font-medium text-fg-secondary">AI 助手</span>
        <div className="flex-1" />

        {messages.length > 0 && (
          <button
            onClick={handleNewSession}
            className="px-2 py-0.5 rounded text-[10px] text-fg-muted hover:text-fg-secondary hover:bg-bg-tertiary transition-colors"
            title="新建对话"
          >
            + 新对话
          </button>
        )}

        <button
          onClick={onClose}
          className="text-fg-faint hover:text-fg-secondary text-sm ml-1"
        >
          &times;
        </button>
      </div>

      {/* 上下文提示 */}
      <div className="flex-shrink-0 px-3 py-1.5 border-b border-border bg-bg-secondary">
        {hasEmail ? (
          <div className="text-[10px] text-fg-muted truncate">
            上下文: <span className="text-fg-tertiary">{subject || "(无主题)"}</span>
          </div>
        ) : (
          <div className="text-[10px] text-fg-muted">
            全局模式 — 可搜索和分析所有邮件
          </div>
        )}
      </div>

      {/* 邮件模式快捷操作 */}
      {hasEmail && messages.length === 0 && (
        <div className="flex-shrink-0 px-3 py-2 border-b border-border flex gap-1.5 flex-wrap">
          {QUICK_ACTIONS.map((a) => (
            <button
              key={a.id}
              onClick={() => sendMessage(a.prompt)}
              disabled={loading}
              className={clsx(
                "px-2 py-1 rounded text-[11px] transition-colors",
                loading
                  ? "opacity-50 cursor-wait"
                  : "bg-bg-tertiary text-fg-secondary hover:bg-accent-dim hover:text-accent",
              )}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}

      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto px-3 py-3 min-h-0 space-y-3">
        {messages.length === 0 && !loading && (
          <div className="text-[11px] text-fg-faint text-center mt-8 space-y-2">
            {hasEmail ? (
              <>
                <p>点击上方快捷按钮或输入问题</p>
                <p className="text-fg-faint">支持翻译、总结、起草回复、线程分析等</p>
              </>
            ) : (
              <>
                <p>输入问题进行邮件搜索和分析</p>
                <p className="text-fg-faint">例: &ldquo;最近关于项目延期的邮件有哪些&rdquo;</p>
              </>
            )}
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={clsx("text-[13px] leading-relaxed", msg.role === "user" && "text-right")}>
            {msg.role === "user" ? (
              <span className="inline-block bg-accent/20 text-accent px-3 py-1.5 rounded-lg text-xs max-w-[85%] text-left">
                {msg.content}
              </span>
            ) : (
              <div className="space-y-2">
                {/* 工具调用卡片 */}
                {msg.toolCalls?.map((tc) => (
                  <div
                    key={tc.toolUseId}
                    className={clsx(
                      "flex items-center gap-2 px-2.5 py-1.5 rounded text-[11px] border",
                      tc.pending
                        ? "border-accent/30 bg-accent/5 text-accent"
                        : "border-border bg-bg-tertiary text-fg-muted",
                    )}
                  >
                    <span className={clsx("w-1.5 h-1.5 rounded-full flex-shrink-0", tc.pending ? "bg-accent animate-pulse" : "bg-fg-faint")} />
                    <span className="font-medium">{TOOL_LABELS[tc.tool] || tc.tool}</span>
                    {tc.summary && <span className="text-fg-faint ml-1">— {tc.summary}</span>}
                    {tc.pending && <span className="animate-pulse ml-auto">...</span>}
                  </div>
                ))}
                {/* 文本内容 */}
                {msg.content && (
                  <div className="bg-bg-secondary border border-border rounded-lg px-3 py-2">
                    <pre className="text-[13px] text-fg-secondary whitespace-pre-wrap font-sans leading-relaxed">
                      {msg.content}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {loading && messages[messages.length - 1]?.role === "assistant" && !messages[messages.length - 1]?.content && !messages[messages.length - 1]?.toolCalls?.length && (
          <div className="bg-bg-secondary border border-border rounded-lg px-3 py-2">
            <span className="text-xs text-fg-muted animate-pulse">AI 思考中...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* 输入区 */}
      <div className="flex-shrink-0 px-3 py-2 border-t border-border">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder={hasEmail ? "输入指令..." : "搜索或提问..."}
            className="flex-1 bg-bg-tertiary rounded px-2.5 py-1.5 text-xs text-fg-primary placeholder:text-fg-faint outline-none focus:ring-1 focus:ring-accent/50"
          />
          <button
            onClick={handleSubmit}
            disabled={loading || !input.trim()}
            className="px-3 py-1.5 rounded text-[11px] bg-accent text-white disabled:opacity-40 flex-shrink-0"
          >
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
