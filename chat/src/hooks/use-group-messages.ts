import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import { type MarmotGroup, type MarmotGroupHistoryStore } from "marmot-ts";
import { useCallback, useEffect, useState } from "react";

/**
 * Hook that loads and subscribes to group messages: paginated history from the
 * group history store and live rumors via the history "rumor" listener.
 *
 * @param group - The current group, or null when none is selected
 * @returns messages, loadMoreMessages, loadingMore, loadingDone, and
 *   addNewMessages for optimistic updates (e.g. after sending)
 *
 * @example
 * ```tsx
 * const { messages, loadMoreMessages, loadingMore, loadingDone, addNewMessages } =
 *   useGroupMessages(group);
 * // After send: addNewMessages([sentRumor]);
 * ```
 */
export function useGroupMessages(
  group: MarmotGroup<MarmotGroupHistoryStore> | null,
): {
  messages: Rumor[];
  loadMoreMessages: () => Promise<void>;
  loadingMore: boolean;
  loadingDone: boolean;
  addNewMessages: (newMessages: Rumor[]) => void;
} {
  const [messages, setMessages] = useState<Rumor[]>([]);
  const [loadingDone, setLoadingDone] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Cursor used for paging older messages.
  // NOTE: the library history contract paginates by *outer cursor*, but the
  // current UI only has rumor metadata. Using `(rumor.created_at, rumor.id)` is a
  // best-effort proxy until outer metadata is exposed to UI paging.
  const [untilCursor, setUntilCursor] = useState<
    { created_at: number; id: string } | undefined
  >(undefined);

  const addNewMessages = useCallback((newMessages: Rumor[]) => {
    setMessages((prev) => {
      const messageMap = new Map<string, Rumor>();
      prev.forEach((msg) => {
        if (msg.id) messageMap.set(msg.id, msg);
      });
      newMessages.forEach((msg) => {
        if (msg.id) messageMap.set(msg.id, msg);
      });
      const combined = Array.from(messageMap.values());
      return combined.sort((a, b) => a.created_at - b.created_at);
    });
  }, []);

  const loadMoreMessages = useCallback(async () => {
    if (!group?.history) return;
    setLoadingMore(true);

    const page = await group.history.queryRumors({
      until: untilCursor,
      limit: 50,
    });

    addNewMessages(page);

    if (page.length === 0) {
      setLoadingDone(true);
    } else {
      const last = page[page.length - 1];
      // Advance the cursor to the oldest rumor returned (exclusive).
      setUntilCursor({ created_at: last.created_at, id: last.id });
    }

    setLoadingMore(false);
  }, [group, untilCursor, addNewMessages]);

  // Clear messages and reset loading state when group changes
  useEffect(() => {
    setMessages([]);
    setLoadingDone(false);
    setLoadingMore(false);
    setUntilCursor(undefined);
  }, [group]);

  // Load initial messages once per group selection.
  // NOTE: do NOT depend on `loadMoreMessages` here — it changes identity when the
  // paging cursor updates, which would cause an infinite auto-pagination loop.
  useEffect(() => {
    if (!group?.history) return;
    loadMoreMessages().catch(() => {
      // ignore (best-effort)
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group]);

  // Subscribe to new rumors
  useEffect(() => {
    if (!group?.history) return;

    const sub = group.history.subscribe?.((rumor: Rumor) => {
      addNewMessages([rumor]);
    });

    // Back-compat: if the store is still an EventEmitter, fall back.
    if (!sub) {
      const listener = (rumor: Rumor) => addNewMessages([rumor]);
      const emitter = group.history as unknown as {
        addListener?: (event: "rumor", cb: (rumor: Rumor) => void) => void;
        removeListener?: (event: "rumor", cb: (rumor: Rumor) => void) => void;
      };
      emitter.addListener?.("rumor", listener);
      return () => emitter.removeListener?.("rumor", listener);
    }

    return () => sub.unsubscribe();
  }, [group, addNewMessages]);

  return {
    messages,
    loadMoreMessages,
    loadingMore,
    loadingDone,
    addNewMessages,
  };
}
