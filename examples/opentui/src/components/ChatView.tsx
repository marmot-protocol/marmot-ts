import type { MarmotGroup } from "@internet-privacy/marmot-ts/client";

import type { ChatMessage } from "../marmot/controller.js";
import { groupEpoch, groupMemberCount, groupName } from "../marmot/format.js";
import { useChat } from "../hooks/use-marmot.js";
import { InputBar } from "./InputBar.js";

/**
 * The main timeline for the active group, with the message composer docked at
 * the bottom (the input only ever sends to the active group, so it lives here).
 * Messages come from the controller snapshot (decrypted via the `group.ingest`
 * async generator and the `applicationMessage` event), and the scrollbox sticks
 * to the bottom so new messages stay in view.
 */
export function ChatView(props: {
  activeGroup?: MarmotGroup;
  inputFocused: boolean;
  onFocusInput: () => void;
}) {
  const { messages } = useChat();
  const group = props.activeGroup;
  const list = group ? (messages[group.idStr] ?? []) : [];
  const title = group
    ? ` ${groupName(group)} · epoch ${groupEpoch(group)} · ${groupMemberCount(group)} members `
    : " no active group ";

  return (
    <box
      flexGrow={1}
      flexDirection="column"
      border
      borderColor="#444"
      title={title}
    >
      <scrollbox flexGrow={1} paddingX={1} stickyScroll stickyStart="bottom">
        {!group ? (
          <text fg="#666">
            no active group — use “New group” below, or accept an invite from
            the sidebar.
          </text>
        ) : list.length === 0 ? (
          <text fg="#666">no messages yet — say hello.</text>
        ) : (
          list.map((message) => (
            <MessageRow key={message.id} message={message} />
          ))
        )}
      </scrollbox>
      <InputBar focused={props.inputFocused} onFocus={props.onFocusInput} />
    </box>
  );
}

function MessageRow(props: { message: ChatMessage }) {
  const { message } = props;
  const time = new Date(message.createdAt * 1000).toLocaleTimeString();
  return (
    <text>
      <span fg="#444">{time} </span>
      <span fg={message.mine ? "#7CFC00" : "#5FAFFF"}>
        {message.authorLabel}
      </span>
      <span fg="#555">: </span>
      {message.content}
    </text>
  );
}
