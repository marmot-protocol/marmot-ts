import { Rumor } from "applesauce-common/helpers/gift-wrap";
import { NostrEvent } from "applesauce-core/helpers";
import { getEventHash } from "nostr-tools";
import { useEffect, useRef, useState } from "react";
import { Subscription } from "rxjs";
import { ClientState } from "ts-mls/clientState.js";
import {
  deserializeApplicationRumor,
  extractMarmotGroupData,
  getEpoch,
  getGroupIdHex,
  getMemberCount,
  getNostrGroupIdHex,
  GROUP_EVENT_KIND,
} from "../../../../src";
import { MarmotGroup } from "../../../../src/client/group/marmot-group";
import { unixNow } from "../../../../src/utils/nostr";
import { withSignIn } from "../../components/with-signIn";
import { useObservable, useObservableMemo } from "../../hooks/use-observable";
import accounts from "../../lib/accounts";
import {
  groupCount$,
  groupStore$,
  selectedGroupId$,
} from "../../lib/group-store";
import { selectedGroup$ } from "../../lib/marmot-client";
import { pool } from "../../lib/nostr";

// ============================================================================
// Component: ErrorAlert
// ============================================================================

interface ErrorAlertProps {
  error: string | null;
}

function ErrorAlert({ error }: ErrorAlertProps) {
  if (!error) return null;

  return (
    <div className="text-error">
      <span>Error: {error}</span>
    </div>
  );
}

// ============================================================================
// Component: GroupSelector
// ============================================================================

interface GroupSelectorProps {
  groups: ClientState[];
  selectedGroupId: string | null;
  isLoading: boolean;
}

function GroupSelector({
  groups,
  selectedGroupId,
  isLoading,
}: GroupSelectorProps) {
  return (
    <div>
      <h2>Select Group</h2>
      {isLoading ? (
        <div className="flex items-center gap-2">
          <span className="loading loading-spinner loading-sm"></span>
          <span>Loading groups...</span>
        </div>
      ) : groups.length === 0 ? (
        <p className="text-base-content/70">No groups found</p>
      ) : (
        <select
          className="select w-full"
          value={selectedGroupId || ""}
          onChange={(e) => selectedGroupId$.next(e.target.value || null)}
        >
          <option value="">-- Select a group --</option>
          {groups.map((group) => {
            const groupIdHex = getGroupIdHex(group);
            const marmotData = extractMarmotGroupData(group);
            const name = marmotData?.name || "Unnamed Group";
            const epoch = getEpoch(group);
            const memberCount = getMemberCount(group);
            return (
              <option key={groupIdHex} value={groupIdHex}>
                {name} (Epoch: {epoch}, Members: {memberCount})
              </option>
            );
          })}
        </select>
      )}
    </div>
  );
}

// ============================================================================
// Component: MessageItem
// ============================================================================

interface MessageItemProps {
  rumor: Rumor;
}

function MessageItem({ rumor }: MessageItemProps) {
  const formatTimestamp = (timestamp: number) => {
    const date = new Date(timestamp * 1000);
    return date.toLocaleTimeString();
  };

  const truncatePubkey = (pubkey: string) => {
    return `${pubkey.slice(0, 8)}...${pubkey.slice(-8)}`;
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="text-xs font-mono text-base-content/70">
          {truncatePubkey(rumor.pubkey)}
        </span>
        <span className="text-xs text-base-content/50">
          {formatTimestamp(rumor.created_at)}
        </span>
      </div>
      <div className="p-3">
        <p className="text-sm whitespace-pre-wrap">{rumor.content}</p>
      </div>
    </div>
  );
}

// ============================================================================
// Component: MessageList
// ============================================================================

interface MessageListProps {
  messages: Rumor[];
}

function MessageList({ messages }: MessageListProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-base-content/50">
        <p>No messages yet. Start the conversation!</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {messages.map((rumor, index) => (
        <MessageItem key={`${rumor.id}-${index}`} rumor={rumor} />
      ))}
      <div ref={messagesEndRef} />
    </div>
  );
}

// ============================================================================
// Component: MessageInput
// ============================================================================

interface MessageInputProps {
  messageText: string;
  isSending: boolean;
  onMessageChange: (text: string) => void;
  onSend: () => void;
}

function MessageInput({
  messageText,
  isSending,
  onMessageChange,
  onSend,
}: MessageInputProps) {
  return (
    <div className="flex gap-2 mt-4">
      <input
        type="text"
        className="input flex-1"
        placeholder="Type your message..."
        value={messageText}
        onChange={(e) => onMessageChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
          }
        }}
        disabled={isSending}
      />
      <button
        className="btn btn-primary"
        onClick={onSend}
        disabled={isSending || !messageText.trim()}
      >
        {isSending ? (
          <>
            <span className="loading loading-spinner loading-sm"></span>
            Sending...
          </>
        ) : (
          "Send"
        )}
      </button>
    </div>
  );
}

// ============================================================================
// Component: RelayStatusBar
// ============================================================================

interface RelayStatusBarProps {
  relays: string[];
}

function RelayStatusBar({ relays }: RelayStatusBarProps) {
  if (!relays || relays.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-base-content/70">Relays:</span>
      {relays.map((relay, index) => (
        <RelayStatusItem key={index} relay={relay} />
      ))}
    </div>
  );
}

// ============================================================================
// Component: RelayStatusItem
// ============================================================================

interface RelayStatusItemProps {
  relay: string;
}

function RelayStatusItem({ relay }: RelayStatusItemProps) {
  const info = useObservableMemo(() => pool.relay(relay).information$, [relay]);

  // If we have information, the relay is likely connected
  // We can also check for connection state if available
  const isConnected = info !== null && info !== undefined;

  // Extract domain from relay URL for display
  const getRelayDomain = (url: string) => {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch {
      return url;
    }
  };

  return (
    <div className="flex items-center gap-1">
      <span
        className={`w-2 h-2 rounded-full ${
          isConnected ? "bg-success" : "bg-error"
        }`}
        title={isConnected ? "Connected" : "Disconnected"}
      />
      <span className="text-base-content/70 font-mono">
        {getRelayDomain(relay)}
      </span>
    </div>
  );
}

// ============================================================================
// Component: ChatInterface
// ============================================================================

interface ChatInterfaceProps {
  group: MarmotGroup;
  messages: Rumor[];
  messageText: string;
  isSending: boolean;
  onMessageChange: (text: string) => void;
  onSend: () => void;
}

function ChatInterface({
  group,
  messages,
  messageText,
  isSending,
  onMessageChange,
  onSend,
}: ChatInterfaceProps) {
  const groupName =
    extractMarmotGroupData(group.state)?.name || "Unnamed Group";

  const relays = group.relays || [];

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2>{groupName}</h2>
        <RelayStatusBar relays={relays} />
      </div>

      {/* Messages Display */}
      <div className="p-4 h-96 overflow-y-auto">
        <MessageList messages={messages} />
      </div>

      {/* Message Input */}
      <MessageInput
        messageText={messageText}
        isSending={isSending}
        onMessageChange={onMessageChange}
        onSend={onSend}
      />
    </div>
  );
}

// ============================================================================
// Hook: useGroupLoader
// ============================================================================

function useGroupLoader() {
  const groupStore = useObservable(groupStore$);
  const groupCount = useObservable(groupCount$);
  const [groups, setGroups] = useState<ClientState[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!groupStore) {
      setIsLoading(false);
      return;
    }

    const loadGroups = async () => {
      try {
        setIsLoading(true);
        setError(null);
        const groupList = await groupStore.list();
        setGroups(groupList);
      } catch (err) {
        console.error("Failed to load groups:", err);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsLoading(false);
      }
    };

    loadGroups();
  }, [groupStore, groupCount]);

  return { groups, isLoading, error };
}

// ============================================================================
// Hook: useGroupSubscription
// ============================================================================

function useGroupSubscription(
  group: MarmotGroup | null,
  onMessagesReceived: (messages: Rumor[]) => void,
) {
  const account = accounts.active;
  const subscriptionRef = useRef<Subscription | null>(null);
  const processEventsRef = useRef<(events: NostrEvent[]) => Promise<void>>(
    async (_events: NostrEvent[]) => {},
  );

  // Set up message processing function
  useEffect(() => {
    if (!group) return;

    processEventsRef.current = async (events: NostrEvent[]) => {
      if (events.length === 0) return;

      try {
        const newMessages: Rumor[] = [];
        for await (const result of group.ingest(events)) {
          if (result.kind === "applicationMessage") {
            try {
              // Deserialize the application data to get the rumor
              const applicationData = result.message;
              const rumor = deserializeApplicationRumor(applicationData);
              newMessages.push(rumor);
            } catch (parseErr) {
              console.error("Failed to parse application message:", parseErr);
              // Continue processing other messages
            }
          }
        }

        if (newMessages.length > 0) {
          onMessagesReceived(newMessages);
        }
      } catch (err) {
        console.error("Failed to process events:", err);
      }
    };
  }, [group, onMessagesReceived]);

  // Set up subscription
  useEffect(() => {
    if (!group || !account) {
      // Clean up existing subscription
      if (subscriptionRef.current) {
        subscriptionRef.current.unsubscribe();
        subscriptionRef.current = null;
      }
      return;
    }

    const relays = group.relays;
    if (!relays || relays.length === 0) {
      return;
    }

    const nostrGroupIdHex = getNostrGroupIdHex(group.state);

    // Create subscription filter
    const filters = {
      kinds: [GROUP_EVENT_KIND],
      "#h": [nostrGroupIdHex],
    };

    // Local state for this subscription
    let localEoseReceived = false;
    const localBatchedEvents: NostrEvent[] = [];

    // Set up subscription using the pool directly
    const observable = pool.subscription(relays, filters);
    const subscription = observable.subscribe({
      next: (value: any) => {
        // Handle both single events and arrays
        const events: NostrEvent[] = Array.isArray(value) ? value : [value];

        if (localEoseReceived) {
          // After EOSE, process events immediately
          processEventsRef.current?.(events);
        } else {
          // Before EOSE, batch events locally
          localBatchedEvents.push(...events);
        }
      },
      error: (err) => {
        console.error("Subscription error:", err);
      },
      complete: () => {
        // Observable completion can be treated as EOSE
        if (!localEoseReceived) {
          localEoseReceived = true;
          // Process batched events
          if (localBatchedEvents.length > 0) {
            processEventsRef.current?.(localBatchedEvents);
          }
        }
      },
    });

    subscriptionRef.current = subscription;

    // Set a timeout to treat as EOSE after initial batch period
    const eoseTimeout = setTimeout(() => {
      if (!localEoseReceived) {
        localEoseReceived = true;
        // Process batched events
        if (localBatchedEvents.length > 0) {
          processEventsRef.current?.(localBatchedEvents);
        }
      }
    }, 2000); // 2 second timeout for initial batch

    return () => {
      subscription.unsubscribe();
      clearTimeout(eoseTimeout);
    };
  }, [group, account]);
}

// ============================================================================
// Hook: useMessageSender
// ============================================================================

function useMessageSender(group: MarmotGroup | null) {
  const account = accounts.active;
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendMessage = async (messageText: string) => {
    if (!group || !account || !messageText.trim()) return;

    try {
      setIsSending(true);
      setError(null);

      // Create rumor (unsigned Nostr event)
      const pubkey = await account.signer.getPublicKey();
      const rumor: Rumor = {
        id: "", // Will be computed
        kind: 9, // Chat message kind
        pubkey,
        created_at: unixNow(),
        content: messageText.trim(),
        tags: [],
      };

      // Compute event ID
      rumor.id = getEventHash(rumor);

      // Send via group
      await group.sendApplicationRumor(rumor);
    } catch (err) {
      console.error("Failed to send message:", err);
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setIsSending(false);
    }
  };

  return { sendMessage, isSending, error };
}

// ============================================================================
// Main Chat Component
// ============================================================================

function Chat() {
  const [messages, setMessages] = useState<Array<Rumor>>([]);
  const [messageText, setMessageText] = useState("");

  // Load groups
  const {
    groups,
    isLoading: groupsLoading,
    error: groupsError,
  } = useGroupLoader();

  // Get selected group ID and group from observables
  const selectedGroupId = useObservable(selectedGroupId$);
  const selectedGroup = useObservable(selectedGroup$) ?? null;

  // Handle messages from subscription
  const handleMessagesReceived = (newMessages: Rumor[]) => {
    setMessages((prev) => {
      // Create a map to avoid duplicates by rumor ID
      const messageMap = new Map<string, Rumor>();

      // Add existing messages
      prev.forEach((msg) => {
        if (msg.id) messageMap.set(msg.id, msg);
      });

      // Add new messages
      newMessages.forEach((msg) => {
        if (msg.id) messageMap.set(msg.id, msg);
      });

      // Convert back to array and sort by created_at timestamp
      const combined = Array.from(messageMap.values());
      return combined.sort((a, b) => a.created_at - b.created_at);
    });
  };

  // Set up subscription
  useGroupSubscription(selectedGroup, handleMessagesReceived);

  // Message sender
  const {
    sendMessage,
    isSending,
    error: sendError,
  } = useMessageSender(selectedGroup);

  // Reset messages when group changes
  useEffect(() => {
    setMessages([]);
  }, [selectedGroupId]);

  // Handle sending messages
  const handleSendMessage = async () => {
    if (!messageText.trim()) return;

    try {
      await sendMessage(messageText);
      setMessageText("");
    } catch (err) {
      // Error is already set by useMessageSender
    }
  };

  // Combine all errors
  const error = groupsError || sendError;

  return (
    <div className="container mx-auto p-6 space-y-6 max-w-4xl">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">Group Chat</h1>
        <p className="text-base-content/70">
          Select a group and start chatting with members
        </p>
      </div>

      {/* Error Display */}
      <ErrorAlert error={error} />

      {/* Group Selection */}
      <GroupSelector
        groups={groups}
        selectedGroupId={selectedGroupId}
        isLoading={groupsLoading}
      />

      {/* Chat Interface */}
      {selectedGroup && (
        <ChatInterface
          group={selectedGroup}
          messages={messages}
          messageText={messageText}
          isSending={isSending}
          onMessageChange={setMessageText}
          onSend={handleSendMessage}
        />
      )}
    </div>
  );
}

export default withSignIn(Chat);
