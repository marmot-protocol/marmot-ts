import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import { type MarmotGroup, type GroupRumorHistory } from "marmot-ts";
import { useCallback, useEffect, useMemo, useState } from "react";

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
  group: MarmotGroup<GroupRumorHistory> | null,
): {
  messages: Rumor[];
  loadMoreMessages: () => Promise<void>;
  loadingMore: boolean;
  loadingDone: boolean;
} {
  const [messages, setMessages] = useState<Rumor[]>([]);
  const [loadingDone, setLoadingDone] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const paginatedLoader = useMemo(() => {
    if (!group?.history) return null;
    return group.history.createPaginatedLoader({ limit: 50 });
  }, [group]);

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
    if (!paginatedLoader) return;
    setLoadingMore(true);
    const page = await paginatedLoader.next();
    addNewMessages(page.value);
    if (page.done) setLoadingDone(page.done);
    setLoadingMore(false);
  }, [paginatedLoader, addNewMessages]);

  // Clear messages and reset loading state when group changes
  useEffect(() => {
    setMessages([]);
    setLoadingDone(false);
    setLoadingMore(false);
  }, [group]);

  // Load initial messages
  useEffect(() => {
    loadMoreMessages();
  }, [loadMoreMessages]);

  // Subscribe to new rumors
  useEffect(() => {
    if (!group?.history) return;
    const listener = (rumor: Rumor) => addNewMessages([rumor]);
    group.history.addListener("rumor", listener);
    return () => {
      group?.history?.removeListener("rumor", listener);
    };
  }, [group, addNewMessages]);

  return {
    messages,
    loadMoreMessages,
    loadingMore,
    loadingDone,
  };
}
