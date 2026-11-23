import { useEffect, useState } from "react";
import type { MarmotGroup } from "@internet-privacy/marmot-ts";
import {
  createApplicationMessageIntent,
  createChatRumor,
} from "@internet-privacy/marmot-ts/client";
import { use$ } from "applesauce-react/hooks";
import { Action, Panel, short } from "../../components/ui.js";
import { account$ } from "../../services/accounts.js";
import { client$ } from "../../services/client.js";
import { contacts$, profile$ } from "../../services/contacts.js";
import { relays$ } from "../../services/relays.js";
import { useAsyncLatest } from "../../hooks/use-async-latest.js";

export default function ChatDemo() {
  const client = use$(client$)!;
  const [controller] = useState(() => new AbortController());
  useEffect(() => () => controller.abort(), [controller]);
  const signal = controller.signal;
  const relays = use$(relays$) ?? [];
  const account = use$(account$)!;
  const invites = useAsyncLatest(
    (signal) => client.watchInvites({ signal }),
    [client],
  );
  const [mode, setMode] = useState("create");
  const [name, setName] = useState("Chat group");
  const [active, setActive] = useState<{
    group: MarmotGroup;
    inviteId?: string;
  }>();

  if (active) return <Chat key={active.group.idStr} {...active} />;
  return (
    <Panel title="Simple chat">
      <div className="flex gap-2">
        <button
          className="btn btn-sm"
          aria-pressed={mode === "create"}
          onClick={() => setMode("create")}
        >
          Create group
        </button>
        <button
          className="btn btn-sm"
          aria-pressed={mode === "join"}
          onClick={() => setMode("join")}
        >
          Join invite ({invites ? invites.length : "…"})
        </button>
      </div>
      {mode === "create" ? (
        <div className="flex flex-wrap gap-2">
          <input
            className="input input-sm"
            aria-label="Group name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Action
            disabled={!name.trim()}
            run={async () => {
              signal.throwIfAborted();
              const group = await client.groups.create(name.trim(), {
                relays,
                adminPubkeys: [account.pubkey],
              });
              if (!signal.aborted) setActive({ group });
            }}
          >
            Create
          </Action>
        </div>
      ) : (
        <>
          {invites === undefined && <p>Loading invites…</p>}
          {invites?.length === 0 && (
            <p>
              No invites yet. Publish a key package in the sidebar to receive
              invites.
            </p>
          )}
          {invites?.map(({ invite, joinable }) => (
            <div key={invite.id} className="flex flex-wrap items-center gap-2">
              <span>
                From <Name pubkey={invite.pubkey} />
              </span>
              <code className="text-xs" title={invite.id}>
                {short(invite.id)}
              </code>
              <Action
                disabled={!joinable}
                run={async () => {
                  signal.throwIfAborted();
                  const { group } = await client.joinGroupFromWelcome({
                    welcomeRumor: invite,
                  });
                  if (!signal.aborted)
                    setActive({ group, inviteId: invite.id });
                }}
              >
                {joinable ? "Join" : "Key unavailable"}
              </Action>
            </div>
          ))}
        </>
      )}
    </Panel>
  );
}

function Chat({ group, inviteId }: { group: MarmotGroup; inviteId?: string }) {
  const client = use$(client$)!;
  const relays = use$(relays$) ?? [];
  const account = use$(account$)!;
  const contacts = use$(contacts$) ?? [];
  const snapshot = useAsyncLatest((signal) => group.watch({ signal }), [group]);
  const messages = useAsyncLatest(
    (signal) => group.history.subscribe({ kinds: [9], limit: 100 }, { signal }),
    [group],
  );
  const [recipient, setRecipient] = useState("");
  const [text, setText] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const isAdmin = snapshot?.groupData?.adminPubkeys.includes(account.pubkey);

  useEffect(() => {
    const controller = new AbortController();
    setReady(false);
    setError(undefined);
    void (async () => {
      try {
        await client.groups.connect(group.id, {
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        // protocol-core/joining.md: catch up before rotating the joiner's leaf.
        if (inviteId) {
          await group.selfUpdate();
          await client.invites.markAsRead(inviteId);
        }
        if (!controller.signal.aborted) setReady(true);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => controller.abort();
  }, [group, inviteId, client, attempt]);

  return (
    <>
      <Panel title={snapshot?.groupData?.name || "Chat group"}>
        <code className="text-xs" title={group.idStr}>
          {short(group.idStr)}
        </code>
        <p className="text-sm">
          {ready ? "Connected" : "Connecting…"} ·{" "}
          {snapshot ? snapshot.members.length : "…"} members
        </p>
        <div className="flex flex-wrap gap-2 text-sm">
          {snapshot?.members.map((pubkey) => (
            <Name key={pubkey} pubkey={pubkey} />
          ))}
        </div>
        {error && (
          <div role="alert" className="text-error">
            {error}{" "}
            <button
              className="btn btn-xs"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Retry connection
            </button>
          </div>
        )}
        {isAdmin && (
          <div className="flex flex-wrap gap-2">
            <select
              className="select select-sm"
              aria-label="Contact to invite"
              value={recipient}
              onChange={(event) => setRecipient(event.target.value)}
            >
              <option value="">Choose contact</option>
              {contacts
                .filter((user) => !snapshot?.members.includes(user.pubkey))
                .map((user) => (
                  <ContactOption key={user.pubkey} pubkey={user.pubkey} />
                ))}
            </select>
            <Action
              disabled={!ready || !recipient}
              run={async () => {
                const packages = await client.network.request(relays, {
                  kinds: [30443],
                  authors: [recipient],
                });
                const keyPackage = packages.sort(
                  (a, b) => b.created_at - a.created_at,
                )[0];
                if (!keyPackage)
                  throw new Error(
                    "No key package found. Ask this contact to publish one.",
                  );
                await client.groups.invite(group.id, keyPackage);
                setRecipient("");
              }}
            >
              Invite
            </Action>
          </div>
        )}
      </Panel>
      <Panel title="Messages (latest 100)">
        <ol className="max-h-96 space-y-2 overflow-auto">
          {messages
            ?.slice()
            .reverse()
            .map((message) => (
              <li key={message.id}>
                <span className="text-xs font-semibold">
                  <Name pubkey={message.pubkey} />
                </span>
                <p className="whitespace-pre-wrap wrap-anywhere">
                  {message.content}
                </p>
              </li>
            ))}
        </ol>
        {messages === undefined && <p>Loading messages…</p>}
        {messages?.length === 0 && <p>No messages yet.</p>}
        <div className="flex gap-2">
          <input
            className="input input-sm flex-1"
            aria-label="Message"
            placeholder="Message"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <Action
            disabled={!ready || !text.trim()}
            run={async () => {
              const content = text.trim();
              await client.groups.send(
                group.id,
                createApplicationMessageIntent(
                  createChatRumor({ pubkey: account.pubkey, content }),
                ),
              );
              setText((current) => (current.trim() === content ? "" : current));
            }}
          >
            Send
          </Action>
        </div>
      </Panel>
    </>
  );
}

function useName(pubkey: string) {
  const profile = use$(() => profile$(pubkey), [pubkey, profile$]);
  return profile?.displayName || short(pubkey);
}

function Name({ pubkey }: { pubkey: string }) {
  return <span title={pubkey}>{useName(pubkey)}</span>;
}

function ContactOption({ pubkey }: { pubkey: string }) {
  return <option value={pubkey}>{useName(pubkey)}</option>;
}
