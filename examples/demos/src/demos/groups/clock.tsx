import { useEffect, useRef, useState } from "react";
import { use$ } from "applesauce-react/hooks";
import type { User } from "applesauce-common/casts";
import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import {
  createApplicationMessageIntent,
  createChatRumor,
  createInviteIntent,
  Proposals,
  type AnnotatedInvite,
  type MarmotGroup,
} from "@internet-privacy/marmot-ts/client";
import { catchError, defer, filter, firstValueFrom, of, timeout } from "rxjs";
import { evaluateKeyPackageForGroup } from "@internet-privacy/marmot-ts/core";
import { Action, Panel, short } from "../../components/ui.js";
import { account$ } from "../../services/accounts.js";
import { client$ } from "../../services/client.js";
import { contacts$, profile$ } from "../../services/contacts.js";
import { mode$ } from "../../services/mode.js";
import { relays$, lookupRelays$, ready$ } from "../../services/transport.js";
import { useAsyncLatest } from "../../hooks/use-async-latest.js";

export default function ClockDemo() {
  const client = use$(client$)!;
  const [mode, setMode] = useState<"host" | "receive">();
  const [controller] = useState(() => new AbortController());
  const owned = useRef(new Set<MarmotGroup>());
  useEffect(
    () => () => {
      controller.abort();
      for (const group of owned.current)
        void client.groups.unload(group.id).catch(console.error);
    },
    [controller, client],
  );
  const adopt = (group: MarmotGroup) => {
    if (controller.signal.aborted)
      void client.groups.unload(group.id).catch(console.error);
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
  const client = use$(client$)!;
  const account = use$(account$)!;
  const relays = use$(relays$) ?? [];
  const transportReady = use$(ready$) ?? false;
  const [name, setName] = useState("Clock feed");
  const [group, setGroup] = useState<MarmotGroup>();
  const snapshot = useAsyncLatest(
    (signal) => (group ? group.watch({ signal }) : emptySnapshot()),
    [group],
  );
  const [running, setRunning] = useState(true);
  const [sent, setSent] = useState<Rumor[]>([]);
  const [error, setError] = useState<string>();
  const sending = useRef(false);

  async function create() {
    signal.throwIfAborted();
    const group = await client.groups.create(name.trim() || "Clock feed", {
      relays,
      adminPubkeys: [account.pubkey],
    });
    adopt(group);
    signal.throwIfAborted();
    await client.groups.connect(group.id, { signal });
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
        const results = await client.groups.send(
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
  }, [group, running, account.pubkey, client, signal]);

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
            <Action run={create} disabled={!transportReady}>
              Start clock feed
            </Action>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{snapshot?.groupData?.name}</span>
            {snapshot && (
              <span className="badge">Epoch {snapshot.epoch.toString()}</span>
            )}
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
      {group && <Members group={group} signal={signal} />}
      {group && <InviteContacts group={group} signal={signal} />}
      <Clock messages={sent} direction="Sent" />
    </div>
  );
}

function Members({
  group,
  signal,
}: {
  group: MarmotGroup;
  signal: AbortSignal;
}) {
  const client = use$(client$)!;
  const account = use$(account$)!;
  const snapshot = useAsyncLatest((signal) => group.watch({ signal }), [group]);
  const [banning, setBanning] = useState(false);

  async function ban(pubkey: string) {
    setBanning(true);
    try {
      const responses = await client.groups.commit(group.id, {
        extraProposals: [Proposals.proposeRemoveUser(pubkey)],
        signal,
      });
      if (!Object.values(responses).some((response) => response.ok))
        throw new Error("No relay accepted the removal");
    } finally {
      setBanning(false);
    }
  }

  return (
    <Panel title={`Members (${snapshot?.members.length ?? 0})`}>
      <ul>
        {snapshot?.members.map((pubkey) => (
          <li
            key={pubkey}
            className="flex items-center justify-between gap-2 border-b border-base-300 py-2"
          >
            <Identity pubkey={pubkey} />
            {pubkey === account.pubkey ? (
              <span className="badge">Host</span>
            ) : (
              <span title="Removes this member from the group. You can invite them again.">
                <Action
                  run={() => ban(pubkey)}
                  disabled={banning || snapshot.status !== "active"}
                >
                  Ban
                </Action>
              </span>
            )}
          </li>
        ))}
      </ul>
      {!snapshot && <p>Loading members…</p>}
    </Panel>
  );
}

function InviteContacts({
  group,
  signal,
}: {
  group: MarmotGroup;
  signal: AbortSignal;
}) {
  const client = use$(client$)!;
  const mode = use$(mode$);
  const account = use$(account$)!;
  const transportRelays = use$(relays$) ?? [];
  const lookupRelays = use$(lookupRelays$) ?? [];
  const users = use$(contacts$) ?? [];
  const snapshot = useAsyncLatest((signal) => group.watch({ signal }), [group]);

  async function invite(user: User) {
    let relays = transportRelays;
    if (mode === "live") {
      await client.network.request(lookupRelays, {
        kinds: [10002],
        authors: [user.pubkey],
      });
      const outboxes = await firstValueFrom(
        user.outboxes$.pipe(
          filter((relays) => relays !== undefined),
          timeout({ first: 1500, with: () => of([]) }),
        ),
      );
      relays = [...new Set([...outboxes, ...transportRelays])];
    }
    signal.throwIfAborted();
    const events = await client.network.request(relays, {
      kinds: [30443],
      authors: [user.pubkey],
    });
    signal.throwIfAborted();
    const valid = events.filter((event) => {
      try {
        createInviteIntent({
          keyPackageEvent: event,
          actorPubkey: account.pubkey,
        });
        return evaluateKeyPackageForGroup(group.state, event).eligible;
      } catch {
        return false;
      }
    });
    const candidates = valid.sort(
      (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
    );
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
            <Identity pubkey={user.pubkey} />
            <Action
              run={() => invite(user)}
              disabled={!snapshot || snapshot.members.includes(user.pubkey)}
            >
              {snapshot?.members.includes(user.pubkey) ? "Invited" : "Invite"}
            </Action>
          </li>
        ))}
      </ul>
      {!users.length && <p className="text-base-content/50">No contacts</p>}
    </Panel>
  );
}

function Receiver({ signal, adopt }: GroupActions) {
  const client = use$(client$)!;
  const invites = useAsyncLatest(
    (signal) => client.watchInvites({ signal }),
    [client],
  );
  const [group, setGroup] = useState<MarmotGroup>();
  const snapshot = useAsyncLatest(
    (signal) => (group ? group.watch({ signal }) : emptySnapshot()),
    [group],
  );
  const [error, setError] = useState<string>();
  const [needsUpdate, setNeedsUpdate] = useState(false);
  const removed = snapshot?.status === "removed";
  const messages =
    useAsyncLatest(
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
    const { group } = await client.joinGroupFromWelcome({
      welcomeRumor: invite,
    });
    adopt(group);
    signal.throwIfAborted();
    await client.groups.connect(group.id, { signal });
    signal.throwIfAborted();
    await client.invites.markAsRead(invite.id);
    setGroup(group);
    setNeedsUpdate(true);
    try {
      // protocol-core/joining.md: catch up, then rotate the joining leaf.
      await selfUpdate(group);
    } catch (cause) {
      if (!signal.aborted)
        setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="space-y-4">
      <Panel title="Receive clock">
        {group ? (
          <span>{snapshot?.groupData?.name || short(group.idStr)}</span>
        ) : (
          <>
            <ul className="space-y-2">
              {invites?.map((invite) => (
                <Invite
                  key={invite.invite.id}
                  invite={invite}
                  accept={() => accept(invite)}
                />
              ))}
            </ul>
            {invites === undefined && <p>Loading invites…</p>}
            {invites?.length === 0 && (
              <p className="text-base-content/50">Waiting for an invite…</p>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="text-error">
            {error}
          </p>
        )}
        {removed && (
          <p role="alert" className="text-warning">
            Removed from group — you will not receive new clock ticks.
          </p>
        )}
        {group && needsUpdate && snapshot?.status === "active" && (
          <Action run={() => selfUpdate(group)}>Retry leaf update</Action>
        )}
      </Panel>
      <Clock messages={messages} direction="Received" />
    </div>
  );
}

function Invite({
  invite,
  accept,
}: {
  invite: AnnotatedInvite;
  accept: () => Promise<void>;
}) {
  const client = use$(client$)!;
  const preview = use$(
    () =>
      defer(() => client.previewWelcome(invite.invite)).pipe(
        catchError(() => of(undefined)),
      ),
    [client, invite.invite],
  );
  return (
    <li className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <div>{preview?.group?.name || "Group invite"}</div>
        <Identity pubkey={invite.invite.pubkey} />
      </div>
      <Action run={accept} disabled={!invite.joinable}>
        {invite.joinable ? "Accept invite" : "Key unavailable"}
      </Action>
    </li>
  );
}

function Identity({ pubkey }: { pubkey: string }) {
  const profile = use$(() => profile$(pubkey), [pubkey, profile$]);
  return <span title={pubkey}>{profile?.displayName || short(pubkey)}</span>;
}

async function* emptySnapshot(): AsyncGenerator<undefined> {
  yield undefined;
}

async function* emptyMessages(): AsyncGenerator<Rumor[]> {
  yield [];
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
