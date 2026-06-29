import { useState } from "react";

import type { ChatMessage } from "../marmot/controller.js";
import { npubShort } from "../marmot/format.js";
import { useController } from "../hooks/use-marmot.js";
import { useNavigation } from "../hooks/use-navigation.js";
import { useDisplayName } from "../hooks/use-profile.js";

/**
 * The message composer. It only sends chat messages to the active group — all
 * other actions live in the action bar and the sidebar lists. After each submit
 * the input is remounted (via a changing `key`) to clear it but stays focused,
 * so several messages can be sent in a row; Esc exits composing (handled in
 * {@link App}).
 *
 * When the navigation has a `replyTarget` set (the user pressed `r` on a
 * message), the send carries a NIP-C7 `q` tag and a banner shows the target;
 * the target is cleared after the message is sent.
 *
 * Files are sent from the keyboard (`a` to attach), not from this composer, so
 * a plain submit is always a chat message.
 */
export function InputBar(props: { focused: boolean; onFocus: () => void }) {
  const controller = useController();
  const nav = useNavigation();
  const [resetKey, setResetKey] = useState(0);
  const replyTarget = nav.replyTarget;

  const handleSubmit = async (value: string) => {
    const text = value.trim();
    // Clear the field by remounting; keep `focused` so the user can keep typing.
    setResetKey((k) => k + 1);
    if (!text) return;
    try {
      await controller.sendText(text, replyTarget);
      // The reply was a one-shot; subsequent messages are top-level again.
      nav.setReplyTarget(undefined);
    } catch (err) {
      controller.logError(err);
    }
  };

  return (
    <box flexDirection="column">
      {replyTarget && <ReplyBanner target={replyTarget} />}
      <box
        height={3}
        border
        borderColor={props.focused ? "#FFD700" : "#444"}
        paddingX={1}
        onMouseDown={() => props.onFocus()}
      >
        <input
          key={resetKey}
          focused={props.focused}
          placeholder={props.focused ? "type a message" : "press n to compose"}
          // OpenTUI's <input> type intersects the renderable onSubmit(event) with
          // the React onSubmit(value: string); at runtime we get the string.
          onSubmit={handleSubmit as any}
        />
      </box>
    </box>
  );
}

/** A one-line banner above the composer naming the message being replied to. */
function ReplyBanner(props: { target: ChatMessage }) {
  const { target } = props;
  const name = useDisplayName(
    target.authorPubkey,
    target.mine ? target.authorLabel : npubShort(target.authorPubkey),
  );
  const preview = target.content.replace(/\s+/g, " ").trim().slice(0, 50);
  return (
    <box paddingX={1}>
      <text fg="#888">
        <span fg="#FFD700">↳ replying to </span>
        <span fg="#5FAFFF">{name}</span>
        <span fg="#555">: {preview} </span>
        <span fg="#666">(esc to cancel)</span>
      </text>
    </box>
  );
}
