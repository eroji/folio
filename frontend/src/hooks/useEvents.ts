import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { EventFrame } from "../api/types";

/** One EventSource for the authenticated shell (mounted by AppShell).
 * Frames only invalidate queries; TanStack refetches what is mounted.
 * Reconnect is the browser's default. */
export function useEvents(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const source = new EventSource("/api/v1/events");
    const onFrame = (event: MessageEvent<string>) => {
      let frame: EventFrame;
      try {
        frame = JSON.parse(event.data) as EventFrame;
      } catch {
        return; // Keepalive comment or malformed frame: nothing to invalidate.
      }
      queryClient.invalidateQueries({ queryKey: ["books"] });
      if (frame.book_id) {
        queryClient.invalidateQueries({ queryKey: ["book", frame.book_id] });
      }
    };
    source.addEventListener("job", onFrame);
    source.addEventListener("book", onFrame);
    return () => source.close();
  }, [queryClient]);
}
