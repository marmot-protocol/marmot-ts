import { useEffect, useRef, useState } from "react";
import { use$ } from "applesauce-react/hooks";
import { castUser, type User } from "applesauce-common/casts";
import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import {
  createApplicationMessageIntent,
  createChatRumor,
  createInviteIntent,
  type AnnotatedInvite,
  type MarmotGroup,
} from "@internet-privacy/marmot-ts/client";
import { evaluateKeyPackageForGroup } from "@internet-privacy/marmot-ts/core";
import { useAccount } from "../../accounts.js";
import { useGroupSnapshot, useWatch } from "../../lib/hooks.js";
import { LOOKUP_RELAYS } from "../../lib/live-transport.js";
import { Action, Panel, short } from "../../lib/ui.js";
import { useDemoServices } from "../../services.js";

export default function ClockDemo() {
  const { session } = useDemoServices();
  const [mode, setMode] = useState<"host" | "receive">();
  const [controller] = useState(() => new AbortController());
  const owned = useRef(new Set<MarmotGroup>());
  useEffect(
    () => () => {
      controller.abort();
      for (const group of owned.current)
        void session.client.groups.unload(group.id).catch(console.error);
    },
    [controller, session],
  );
  const adopt = (group: MarmotGroup) => {
    if (controller.signal.aborted)
      void session.client.groups.unload(group.id).catch(console.error);
    else owned.current.add(group);
  };
  if (mode === "host") return <Host signal={controller.signal} adopt={adopt} />;
  if (mode === "receive")
    return <Receiver signal={controller.signal} adopt={adopt} />;
  return (
    <Panel title="Clock feed">
      <div className="join">
        {(["host", "receive"] as const).map((value) => (
          <button
            key={value}
            className="btn btn-sm join-item"
            onClick={() => setMode(value)}
          >
            {value === "host" ? "Host clock" : "Receive clock"}
          </button>
        ))}
      </div>
    </Panel>
  );
}

type GroupActions = {
  signal: AbortSignal;
  adopt: (group: MarmotGroup) => void;
};

function Host({ signal, adopt }: GroupActions) {
  const account = useAccount();
  const { session, transport } = useDemoServices();
  const [name, setName] = useState("Clock feed");
  const [group, setGroup] = useState<MarmotGroup>();
  const [running, setRunning] = useState(true);
  const [sent, setSent] = useState<Rumor[]>([]);
  const [error, setError] = useState<string>();
  const sending = useRef(false);

  async function create() {
    await transport.ready;
    signal.throwIfAborted();
    const group = await session.client.groups.create(
      name.trim() || "Clock feed",
      {
        relays: transport.relays,
        adminPubkeys: [account.pubkey],
      },
    );
    adopt(group);
    signal.throwIfAborted();
    await session.client.groups.connect(group.id, { signal });
    signal.throwIfAborted();
    setGroup(group);
  }

  useEffect(() => {
    if (!group || !running) return;
    let stopped = false;
    setError(undefined);
    const timer = setInterval(async () => {
      if (sending.current || stopped || signal.aborted) return;
      sending.current = true;
      try {
        const rumor = createChatRumor({
          pubkey: account.pubkey,
          content: new Date().toISOString(),
        });
        const results = await session.client.groups.send(
          group.id,
          createApplicationMessageIntent(rumor),
        );
        if (
          !results.some((result) =>
            Object.values(result.response).some((response) => response.ok),
          )
        )
          throw new Error("No relay accepted the clock tick");
        if (!signal.aborted)
          setSent((recent) => [rumor, ...recent].slice(0, 30));
      } catch (cause) {
        if (!stopped && !signal.aborted) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setRunning(false);
        }
      } finally {
        sending.current = false;
      }
    }, 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [group, running, account.pubkey, session, signal]);

  return (
    <div className="space-y-4">
      <Panel title="Host clock">
        {!group ? (
          <div className="flex flex-wrap items-center gap-2">
            <input
              aria-label="Group name"
              className="input input-sm"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <Action run={create}>Start clock feed</Action>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{group.snapshot.groupData?.name}</span>
            <button
              className="btn btn-sm"
              onClick={() => setRunning((value) => !value)}
            >
              {running ? "Pause" : "Resume"}
            </button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-error">
            {error}
          </p>
        )}
      </Panel>
      {group && <InviteContacts group={group} signal={signal} />}
      <Clock messages={sent} direction="Sent" />
    </div>
  );
}

function InviteContacts({
  group,
  signal,
}: {
  group: MarmotGroup;
  signal: AbortSignal;
}) {
  const { contacts, session, transport, mode, store } = useDemoServices();
  const users = use$(contacts.contacts$) ?? [];
  const snapshot = useGroupSnapshot(group);

  async function invite(user: User) {
    const client = session.client;
    let relays = transport.relays;
    if (mode === "live") {
      await client.network.request(LOOKUP_RELAYS, {
        kinds: [10002],
        authors: [user.pubkey],
      });
      const outboxes = await castUser(user.pubkey, store).outboxes$.$first(
        1500,
        [],
      );
      relays = [...new Set([...outboxes, ...transport.relays])];
    }
    signal.throwIfAborted();
    const events = await client.network.request(relays, {
      kinds: [30443],
      authors: [user.pubkey],
    });
    signal.throwIfAborted();
    const candidates = events
      .filter((event) => {
        try {
          createInviteIntent({
            keyPackageEvent: event,
            actorPubkey: session.pubkey,
          });
          return evaluateKeyPackageForGroup(group.state, event).eligible;
        } catch {
          return false;
        }
      })
      .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
    if (!candidates.length)
      throw new Error(
        "No compatible key package. Ask this contact to publish one.",
      );
    await client.groups.invite(group.id, candidates[0]);
  }

  return (
    <Panel title="Invite contacts">
      <ul className="max-h-64 space-y-2 overflow-auto">
        {users.map((user) => (
          <li
            key={user.pubkey}
            className="flex items-center justify-between gap-2"
          >
            <Identity user={user} />
            <Action
              run={() => invite(user)}
              disabled={snapshot.members.includes(user.pubkey)}
            >
              {snapshot.members.includes(user.pubkey) ? "Invited" : "Invite"}
            </Action>
          </li>
        ))}
      </ul>
      {!users.length && <p className="text-base-content/50">No contacts</p>}
    </Panel>
  );
}

function Receiver({ signal, adopt }: GroupActions) {
  const { session } = useDemoServices();
  const invites =
    useWatch((signal) => session.client.watchInvites({ signal }), [session]) ??
    [];
  const [group, setGroup] = useState<MarmotGroup>();
  const [error, setError] = useState<string>();
  const [needsUpdate, setNeedsUpdate] = useState(false);
  const messages =
    useWatch(
      (signal) =>
        group
          ? group.history.subscribe({ kinds: [9], limit: 60 }, { signal })
          : emptyMessages(),
      [group],
    ) ?? [];

  async function selfUpdate(group: MarmotGroup) {
    await group.selfUpdate();
    signal.throwIfAborted();
    setNeedsUpdate(false);
    setError(undefined);
  }

  async function accept({ invite }: AnnotatedInvite) {
    setError(undefined);
    const { group } = await session.client.joinGroupFromWelcome({
      welcomeRumor: invite,
    });
    adopt(group);
    signal.throwIfAborted();
    await session.client.groups.connect(group.id, { signal });
    signal.throwIfAborted();
    await session.client.invites.markAsRead(invite.id);
    setGroup(group);
    setNeedsUpdate(true);
    try {
      // protocol-core/joining.md: catch up, then rotate the joining leaf.
      await selfUpdate(group);
    } catch (cause) {
      if (!signal.aborted)
        setError(cause instanceof Error ? cause.message : String(cause));
    }
    void session.publish().catch(() => {});
  }

  return (
    <div className="space-y-4">
      <Panel title="Receive clock">
        {group ? (
          <span>{group.snapshot.groupData?.name || short(group.idStr)}</span>
        ) : (
          <>
            <ul className="space-y-2">
              {invites.map((invite) => (
                <Invite
                  key={invite.invite.id}
                  invite={invite}
                  accept={() => accept(invite)}
                />
              ))}
            </ul>
            {!invites.length && (
              <p className="text-base-content/50">Waiting for an invite…</p>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="text-error">
            {error}
          </p>
        )}
        {group && needsUpdate && (
          <Action run={() => selfUpdate(group)}>Retry leaf update</Action>
        )}
      </Panel>
      <Clock messages={messages} direction="Received" />
    </div>
  );
}

async function* emptyMessages(): AsyncGenerator<Rumor[]> {
  yield [];
}

function Invite({
  invite,
  accept,
}: {
  invite: AnnotatedInvite;
  accept: () => Promise<void>;
}) {
  const { session, store } = useDemoServices();
  const [name, setName] = useState("Group invite");
  useEffect(() => {
    let live = true;
    void session.client
      .previewWelcome(invite.invite)
      .then((preview) => {
        if (live && preview.group) setName(preview.group.name);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [session, invite.invite]);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <div>{name}</div>
        <Identity user={castUser(invite.invite.pubkey, store)} />
      </div>
      <Action run={accept} disabled={!invite.joinable}>
        {invite.joinable ? "Accept invite" : "Key unavailable"}
      </Action>
    </li>
  );
}

function Identity({ user }: { user: User }) {
  const profile = use$(() => user.profile$, [user]);
  return (
    <span title={user.npub}>{profile?.displayName || short(user.pubkey)}</span>
  );
}

function Clock({
  messages,
  direction,
}: {
  messages: Rumor[];
  direction: "Sent" | "Received";
}) {
  const recent = messages
    .filter(
      (message) =>
        /^\d{4}-\d{2}-\d{2}T/.test(message.content) &&
        Number.isFinite(Date.parse(message.content)),
    )
    .sort((a, b) => Date.parse(b.content) - Date.parse(a.content))
    .slice(0, 30);
  const latest = recent[0]?.content;
  return (
    <Panel title={`${direction} times`}>
      <div className="py-6 text-center" aria-live="off">
        <time
          dateTime={latest}
          className="font-mono text-6xl font-semibold tabular-nums sm:text-8xl"
        >
          {latest ? new Date(latest).toISOString().slice(11, 19) : "--:--:--"}
        </time>
        <div className="mt-2 text-sm text-base-content/50">UTC</div>
      </div>
      <ol className="max-h-64 overflow-auto font-mono text-sm">
        {recent.map((message) => (
          <li key={message.id} className="border-t border-base-300 py-1">
            <time dateTime={message.content}>{message.content}</time>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
