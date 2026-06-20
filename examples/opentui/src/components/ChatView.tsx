import { useMemo } from "react";

import type { ChatMessage } from "../marmot/controller.js";
import {
  groupEpoch,
  groupMemberCount,
  groupName,
  npubShort,
} from "../marmot/format.js";
import { useChat } from "../hooks/use-marmot.js";
import { useNavigation } from "../hooks/use-navigation.js";
import { useDisplayName } from "../hooks/use-profile.js";
import { InputBar } from "./InputBar.js";

/** Collapse a multi-line message to a single short preview line. */
function previewText(text: string, max = 50): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

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
  // The timeline cursor only appears while picking a reply target (press `r`),
  // so it isn't noise during normal reading and composing.
  const cursorVisible = nav.replySelecting;
  // Resolve reply quotes against messages currently in the timeline.
  const byId = useMemo(
    () => new Map(list.map((message) => [message.id, message])),
    [list],
  );
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
            {list.map((message, index) => (
              <MessageRow
                key={message.id}
                message={message}
                parent={
                  message.replyToId ? byId.get(message.replyToId) : undefined
                }
                selected={cursorVisible && index === nav.selectedMessageIndex}
              />
            ))}
          </>
        )}
      </scrollbox>
      <InputBar focused={nav.composing} onFocus={focusInput} />
    </box>
  );
}

function MessageRow(props: {
  message: ChatMessage;
  parent?: ChatMessage;
  selected: boolean;
}) {
  const { message, parent, selected } = props;
  const time = new Date(message.createdAt * 1000).toLocaleTimeString();
  // Resolve the author's kind 0 display name reactively, falling back to the
  // short-npub label the controller precomputed while it loads. Own messages
  // keep the "you" label.
  const resolved = useDisplayName(message.authorPubkey, message.authorLabel);
  const author = message.mine ? message.authorLabel : resolved;
  // The pubkey to attribute the quote to: the loaded parent's, or the one the
  // `q` tag carried when the parent isn't in the current window.
  const quotePubkey = parent?.authorPubkey ?? message.replyToPubkey;
  return (
    <box flexDirection="column">
      {message.replyToId &&
        (quotePubkey ? (
          <QuotedLine
            pubkey={quotePubkey}
            fallbackLabel={parent?.authorLabel ?? npubShort(quotePubkey)}
            preview={parent?.content}
          />
        ) : (
          <text fg="#555">{"  ↳ replying to an earlier message"}</text>
        ))}
      <text>
        <span fg={selected ? "#FFD700" : "#444"}>{selected ? "› " : "  "}</span>
        <span fg="#444">{time} </span>
        <span fg={message.mine ? "#7CFC00" : "#5FAFFF"}>{author}</span>
        <span fg="#555">: </span>
        {message.content}
      </text>
    </box>
  );
}

/** The dim "↳ replying to …" line rendered above a reply's own text. */
function QuotedLine(props: {
  pubkey: string;
  fallbackLabel: string;
  preview?: string;
}) {
  const name = useDisplayName(props.pubkey, props.fallbackLabel);
  const body =
    props.preview !== undefined
      ? `${name}: ${previewText(props.preview)}`
      : `replying to ${name}`;
  return <text fg="#555">{`  ↳ ${body}`}</text>;
}
