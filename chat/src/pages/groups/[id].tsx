import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { withSignIn } from "@/components/with-signIn";
import accountManager from "@/lib/accounts";
import { marmotClient$ } from "@/lib/marmot-client";
import { Rumor } from "applesauce-common/helpers/gift-wrap";
import { use$ } from "applesauce-react/hooks";
import { Loader2, XCircle } from "lucide-react";
import { extractMarmotGroupData, MarmotGroup, unixNow } from "marmot-ts";
import { getEventHash } from "nostr-tools";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { from, of, switchMap } from "rxjs";

// ============================================================================
// Component: MessageItem
// ============================================================================

interface MessageItemProps {
  rumor: Rumor;
  isOwnMessage: boolean;
}

function MessageItem({ rumor, isOwnMessage }: MessageItemProps) {
  const formatTimestamp = (timestamp: number) => {
    const date = new Date(timestamp * 1000);
    return date.toLocaleTimeString();
  };

  const truncatePubkey = (pubkey: string) => {
    return `${pubkey.slice(0, 8)}...${pubkey.slice(-8)}`;
  };

  return (
    <div
      className={`flex flex-col gap-1 ${
        isOwnMessage ? "items-end" : "items-start"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-mono text-muted-foreground">
          {truncatePubkey(rumor.pubkey)}
        </span>
        <span className="text-xs text-muted-foreground/70">
          {formatTimestamp(rumor.created_at)}
        </span>
      </div>
      <div
        className={`p-3 max-w-[80%] rounded-lg ${
          isOwnMessage
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-foreground"
        }`}
      >
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
  currentUserPubkey: string | null;
}

function MessageList({ messages, currentUserPubkey }: MessageListProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <p>No messages yet. Start the conversation!</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {messages.map((rumor, index) => (
        <MessageItem
          key={`${rumor.id}-${index}`}
          rumor={rumor}
          isOwnMessage={rumor.pubkey === currentUserPubkey}
        />
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
    <div className="flex gap-2">
      <Input
        type="text"
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
        className="flex-1"
      />
      <Button onClick={onSend} disabled={isSending || !messageText.trim()}>
        {isSending ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Sending...
          </>
        ) : (
          "Send"
        )}
      </Button>
    </div>
  );
}

// ============================================================================
// Hook: useMessageSender
// ============================================================================

function useMessageSender(group: MarmotGroup | null) {
  const account = accountManager.active;
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendMessage = async (messageText: string): Promise<Rumor | null> => {
    if (!group || !account || !messageText.trim()) return null;

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

      return rumor;
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
// Main Component
// ============================================================================

function GroupDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [messages, setMessages] = useState<Array<Rumor>>([]);
  const [messageText, setMessageText] = useState("");
  const [currentUserPubkey, setCurrentUserPubkey] = useState<string | null>(
    null,
  );

  // Get the selected group from marmotClient$
  const group = use$(
    marmotClient$.pipe(
      switchMap((client) => {
        if (!client || !id) {
          return of<MarmotGroup | null>(null);
        }
        return from(client.getGroup(id));
      }),
    ),
  );

  // Get current user pubkey
  const account = accountManager.active;
  useEffect(() => {
    const getPubkey = async () => {
      if (account) {
        const pubkey = await account.signer.getPublicKey();
        setCurrentUserPubkey(pubkey);
      } else {
        setCurrentUserPubkey(null);
      }
    };
    getPubkey();
  }, [account]);

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

  // TODO: Register callback with subscription manager to receive application messages
  // This will need the GroupSubscriptionManager implementation from examples
  useEffect(() => {
    if (!group) return;

    // For now, just clear messages when group changes
    setMessages([]);

    // TODO: Subscribe to group messages
    // const groupIdHex = getNostrGroupIdHex(group.state);
    // const subscriptionManager = getSubscriptionManager();
    // if (subscriptionManager) {
    //   const unsubscribe = subscriptionManager.onApplicationMessage(
    //     groupIdHex,
    //     handleMessagesReceived,
    //   );
    //   return unsubscribe;
    // }
  }, [group]);

  // Message sender
  const {
    sendMessage,
    isSending,
    error: sendError,
  } = useMessageSender(group ?? null);

  // Handle sending messages
  const handleSendMessage = async () => {
    if (!messageText.trim()) return;

    try {
      const sentRumor = await sendMessage(messageText);
      setMessageText("");

      // Optimistically append the sent message to the UI for immediate feedback
      if (sentRumor) {
        handleMessagesReceived([sentRumor]);
      }
    } catch (err) {
      // Error is already set by useMessageSender
    }
  };

  // Get group name
  const groupName = group
    ? extractMarmotGroupData(group.state)?.name || "Unnamed Group"
    : "Loading...";

  if (!id) {
    return (
      <>
        <PageHeader
          items={[
            { label: "Home", to: "/" },
            { label: "Groups", to: "/groups" },
            { label: "Invalid Group" },
          ]}
        />
        <div className="flex items-center justify-center h-full p-4">
          <Alert variant="destructive">
            <XCircle className="h-4 w-4" />
            <AlertDescription>Invalid group ID</AlertDescription>
          </Alert>
        </div>
      </>
    );
  }

  if (!group) {
    return (
      <>
        <PageHeader
          items={[
            { label: "Home", to: "/" },
            { label: "Groups", to: "/groups" },
            { label: "Loading..." },
          ]}
        />
        <div className="flex items-center justify-center h-full p-4">
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Loading group...</span>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        items={[
          { label: "Home", to: "/" },
          { label: "Groups", to: "/groups" },
          { label: groupName },
        ]}
      />

      {/* Main chat container */}
      <div className="flex flex-col h-[calc(100vh-65px)]">
        {/* Error Display */}
        {sendError && (
          <div className="p-4">
            <Alert variant="destructive">
              <XCircle className="h-4 w-4" />
              <AlertDescription>Error: {sendError}</AlertDescription>
            </Alert>
          </div>
        )}

        {/* Messages - flex-col-reverse for scroll-to-bottom behavior */}
        <div className="flex-1 overflow-y-auto p-4">
          <div className="flex flex-col-reverse h-full">
            <div className="flex flex-col">
              <MessageList
                messages={messages}
                currentUserPubkey={currentUserPubkey}
              />
            </div>
          </div>
        </div>

        {/* Message Input - sticky at bottom */}
        <div className="border-t p-4 bg-background">
          <MessageInput
            messageText={messageText}
            isSending={isSending}
            onMessageChange={setMessageText}
            onSend={handleSendMessage}
          />
        </div>
      </div>
    </>
  );
}

export default withSignIn(GroupDetailPage);
