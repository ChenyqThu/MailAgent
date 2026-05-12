import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

export function useSSE() {
  const queryClient = useQueryClient();
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    function connect() {
      const token = localStorage.getItem("mailagent_token") || "";
      const url = `/api/events${token ? `?token=${token}` : ""}`;
      const es = new EventSource(url);
      esRef.current = es;

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "email_updated" || data.type === "email_new") {
            queryClient.invalidateQueries({ queryKey: ["emails"] });
            queryClient.invalidateQueries({ queryKey: ["email-detail"] });
            queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
            queryClient.invalidateQueries({ queryKey: ["dashboard-attention"] });
            queryClient.invalidateQueries({ queryKey: ["dashboard-digest"] });
            queryClient.invalidateQueries({ queryKey: ["dashboard-system"] });
          }
        } catch {
          // ignore parse errors
        }
      };

      es.onerror = () => {
        es.close();
        // 3 秒后重连
        setTimeout(connect, 3000);
      };
    }

    connect();
    return () => {
      esRef.current?.close();
    };
  }, [queryClient]);
}
