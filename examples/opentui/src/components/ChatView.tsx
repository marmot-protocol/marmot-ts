import type { ChatMessage } from "../marmot/controller.js";
import { groupEpoch, groupMemberCount, groupName } from "../marmot/format.js";
import { useChat } from "../hooks/use-marmot.js";
import { useNavigation } from "../hooks/use-navigation.js";
import { useDisplayName } from "../hooks/use-profile.js";
import { InputBar } from "./InputBar.js";

/**
 * The main timeline for the active group, with the message composer docked at
 * the bottom (the input only ever sends to the active group, so it lives here).
 * Messages come from the controller snapshot (decrypted via the `group.ingest`
 * async generator and the `applicationMessage` event), and the scrollbox sticks
 * to the bottom so new messages stay in view.
 */
export function ChatView() {
  const { messages, pagination } = useChat();
  const nav = useNavigation();
  const focusInput = () => nav.setFocus("chat");
  const group = nav.activeGroup;
  const list = group ? (messages[group.idStr] ?? []) : [];
  const pager = group ? pagination[group.idStr] : undefined;
  const title = group
    ? ` ${groupName(group)} · epoch ${groupEpoch(group)} · ${groupMemberCount(group)} members `
    : " no active group ";

  return (
    <box
      flexGrow={1}
      flexDirection="column"
      border
      borderColor={nav.focus === "chat" ? "#FFD700" : "#444"}
      title={title}
      onMouseDown={focusInput}
    >
      <scrollbox flexGrow={1} paddingX={1} stickyScroll stickyStart="bottom">
        {!group ? (
          <text fg="#666">
            no active group — press n to create one, or accept an invite from
            the invites panel.
          </text>
        ) : list.length === 0 ? (
          <text fg="#666">no messages yet — press n to compose.</text>
        ) : (
          <>
            <text fg="#555">
              {pager?.loadingOlder
                ? "loading older messages…"
                : pager?.exhausted
                  ? "— start of history —"
                  : "↑ press u to load older messages"}
            </text>
            {list.map((message) => (
              <MessageRow key={message.id} message={message} />
            ))}
          </>
        )}
      </scrollbox>
      <InputBar focused={nav.composing} onFocus={focusInput} />
    </box>
  );
}

function MessageRow(props: { message: ChatMessage }) {
  const { message } = props;
  const time = new Date(message.createdAt * 1000).toLocaleTimeString();
  // Resolve the author's kind 0 display name reactively, falling back to the
  // short-npub label the controller precomputed while it loads. Own messages
  // keep the "you" label.
  const resolved = useDisplayName(message.authorPubkey, message.authorLabel);
  const author = message.mine ? message.authorLabel : resolved;
  return (
    <text>
      <span fg="#444">{time} </span>
      <span fg={message.mine ? "#7CFC00" : "#5FAFFF"}>{author}</span>
      <span fg="#555">: </span>
      {message.content}
    </text>
  );
}
