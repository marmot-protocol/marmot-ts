import { useEffect, useState } from "react";
import type { MarmotGroup } from "@internet-privacy/marmot-ts";
import {
  createApplicationMessageIntent,
  createChatRumor,
} from "@internet-privacy/marmot-ts/client";
import { castUser } from "applesauce-common/casts";
import { use$ } from "applesauce-react/hooks";
import { useAccount } from "../../accounts.js";
import { useGroupSnapshot, useWatch } from "../../lib/hooks.js";
import { Action, Panel, short } from "../../lib/ui.js";
import { useContacts, useDemoServices, useTransport } from "../../services.js";

export default function ChatDemo() {
  const { session } = useDemoServices();
  const relay = useTransport();
  const account = useAccount();
  const client = session.client;
  const invites = useWatch(
    (signal) => client.invites.watchUnread({ signal }),
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
          Join invite ({invites?.length ?? 0})
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
              await relay.ready;
              session.signal.throwIfAborted();
              const group = await client.groups.create(name.trim(), {
                relays: relay.relays,
                adminPubkeys: [account.pubkey],
              });
              if (!session.signal.aborted) setActive({ group });
            }}
          >
            Create
          </Action>
        </div>
      ) : (
        <>
          {!invites?.length && (
            <p>
              No invites yet. Publish a key package in the sidebar to receive
              invites.
            </p>
          )}
          {invites?.map((invite) => (
            <div key={invite.id} className="flex flex-wrap items-center gap-2">
              <span>
                From <Name pubkey={invite.pubkey} />
              </span>
              <code className="text-xs" title={invite.id}>
                {short(invite.id)}
              </code>
              <Action
                run={async () => {
                  const { group } = await client.joinGroupFromWelcome({
                    welcomeRumor: invite,
                  });
                  if (!session.signal.aborted)
                    setActive({ group, inviteId: invite.id });
                }}
              >
                Join
              </Action>
            </div>
          ))}
        </>
      )}
    </Panel>
  );
}

function Chat({ group, inviteId }: { group: MarmotGroup; inviteId?: string }) {
  const { session } = useDemoServices();
  const relay = useTransport();
  const account = useAccount();
  const contacts = use$(useContacts().contacts$) ?? [];
  const snapshot = useGroupSnapshot(group);
  const messages = useWatch(
    (signal) => group.history.subscribe({ kinds: [9], limit: 100 }, { signal }),
    [group],
  );
  const [recipient, setRecipient] = useState("");
  const [text, setText] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const isAdmin = snapshot.groupData?.adminPubkeys.includes(account.pubkey);

  useEffect(() => {
    const controller = new AbortController();
    setReady(false);
    setError(undefined);
    void (async () => {
      try {
        await session.client.groups.connect(group.id, {
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        // protocol-core/joining.md: catch up before rotating the joiner's leaf.
        if (inviteId) {
          await group.selfUpdate();
          await session.client.invites.markAsRead(inviteId);
        }
        if (!controller.signal.aborted) setReady(true);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => controller.abort();
  }, [group, inviteId, session, attempt]);

  return (
    <>
      <Panel title={snapshot.groupData?.name || "Chat group"}>
        <code className="text-xs" title={group.idStr}>
          {short(group.idStr)}
        </code>
        <p className="text-sm">
          {ready ? "Connected" : "Connecting…"} · {relay.transport} ·{" "}
          {snapshot.members.length} members
        </p>
        <div className="flex flex-wrap gap-2 text-sm">
          {snapshot.members.map((pubkey) => (
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
                .filter((user) => !snapshot.members.includes(user.pubkey))
                .map((user) => (
                  <ContactOption key={user.pubkey} pubkey={user.pubkey} />
                ))}
            </select>
            <Action
              disabled={!ready || !recipient}
              run={async () => {
                const packages = await session.client.network.request(
                  relay.relays,
                  {
                    kinds: [30443],
                    authors: [recipient],
                  },
                );
                const keyPackage = packages.sort(
                  (a, b) => b.created_at - a.created_at,
                )[0];
                if (!keyPackage)
                  throw new Error(
                    "No key package found. Ask this contact to publish one.",
                  );
                await session.client.groups.invite(group.id, keyPackage);
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
        {!messages?.length && <p>No messages yet.</p>}
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
              await session.client.groups.send(
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
  const { store } = useDemoServices();
  const profile = use$(() => castUser(pubkey, store).profile$, [pubkey, store]);
  return profile?.displayName || short(pubkey);
}

function Name({ pubkey }: { pubkey: string }) {
  return <span title={pubkey}>{useName(pubkey)}</span>;
}

function ContactOption({ pubkey }: { pubkey: string }) {
  return <option value={pubkey}>{useName(pubkey)}</option>;
}
