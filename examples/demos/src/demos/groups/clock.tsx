import { useEffect, useRef, useState } from "react";
import type { MarmotGroup } from "@internet-privacy/marmot-ts";
import {
  createApplicationMessageIntent,
  createChatRumor,
} from "@internet-privacy/marmot-ts/client";
import { unlockGiftWrap } from "applesauce-common/helpers";
import { useAccount } from "../../accounts.js";
import {
  createPeerActor,
  createUserActor,
  type Actor,
} from "../../lib/actor.js";
import { useWatch } from "../../lib/hooks.js";
import { useTransport } from "../../services.js";
import { Action, hex, Panel } from "../../lib/ui.js";

type Session = {
  you: Actor;
  clock: Actor;
  group: MarmotGroup;
  clockGroup: MarmotGroup;
};

export default function ClockDemo() {
  const account = useAccount();
  const relay = useTransport();
  const relays = relay.relays;
  const [name, setName] = useState("Clock group");
  const [session, setSession] = useState<Session>();
  const [running, setRunning] = useState(true);
  const [error, setError] = useState<string>();
  const lifetime = useRef<AbortController | undefined>(undefined);
  const sending = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  async function create() {
    const signal = lifetime.current!.signal;
    const clientId = () => hex(crypto.getRandomValues(new Uint8Array(32)));
    const you = createUserActor(account, relay, clientId());
    const clock = createPeerActor("clock", relay, clientId());
    let group: MarmotGroup | undefined;
    let clockGroup: MarmotGroup | undefined;
    try {
      await relay.ready;
      signal.throwIfAborted();
      await clock.client.keyPackages.create({ relays });
      signal.throwIfAborted();
      const [keyPackage] = await relay.network("you").request(relays, {
        kinds: [30443],
        authors: [clock.pubkey],
      });
      if (!keyPackage) throw new Error("Clock key package not found");
      group = await you.client.groups.create(name.trim() || "Clock group", {
        relays,
        adminPubkeys: [you.pubkey],
      });
      signal.throwIfAborted();
      await you.client.groups.invite(group.id, keyPackage);
      signal.throwIfAborted();
      const [welcome] = await relay.network("clock").request(relays, {
        kinds: [1059],
        "#p": [clock.pubkey],
      });
      if (!welcome) throw new Error("Clock welcome not found");
      const welcomeRumor = await unlockGiftWrap(welcome, clock.client.signer);
      ({ group: clockGroup } = await clock.client.joinGroupFromWelcome({
        welcomeRumor,
      }));
      signal.throwIfAborted();

      // Connect before the required post-Welcome leaf rotation, so the user
      // ingests it before receiving the clock's application messages.
      await you.client.groups.connect(group.id, { signal });
      await clock.client.groups.connect(clockGroup.id, { signal });
      await clockGroup.selfUpdate();
      if (signal.aborted) {
        group.dispose();
        clockGroup.dispose();
        return;
      }
      setSession({ you, clock, group, clockGroup });
    } catch (cause) {
      group?.dispose();
      clockGroup?.dispose();
      throw cause;
    }
  }

  useEffect(() => {
    if (!session) return;
    return () => {
      session.group.dispose();
      session.clockGroup.dispose();
    };
  }, [session]);

  useEffect(() => {
    if (!session || !running) return;
    let stopped = false;
    setError(undefined);
    const timer = setInterval(async () => {
      // Never overlap MLS sends or build up a queue when a send is slow.
      if (sending.current || stopped) return;
      sending.current = true;
      try {
        const rumor = createChatRumor({
          pubkey: session.clock.pubkey,
          content: new Date().toISOString(),
        });
        await session.clock.client.groups.send(
          session.clockGroup.id,
          createApplicationMessageIntent(rumor),
        );
      } catch (cause) {
        if (!stopped) {
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
  }, [session, running]);

  return (
    <>
      <Panel title="Clock group">
        {!session ? (
          <div className="flex flex-wrap items-center gap-2">
            <input
              aria-label="Group name"
              className="input input-sm"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <Action run={create}>Create group & start clock</Action>
          </div>
        ) : (
          <>
            <p className="break-all font-mono text-xs">
              Group: {session.group.idStr}
            </p>
            <button
              className="btn btn-sm self-start"
              onClick={() => setRunning((value) => !value)}
            >
              {running ? "Pause clock" : "Resume clock"}
            </button>
          </>
        )}
        <span className="badge badge-outline">{relay.transport} relay</span>
        {error && (
          <p role="alert" className="text-error">
            {error}
          </p>
        )}
      </Panel>
      {session ? (
        <Messages group={session.group} />
      ) : (
        <Panel title="Time">Create a group to start the clock.</Panel>
      )}
    </>
  );
}

function Messages({ group }: { group: MarmotGroup }) {
  const messages = useWatch(
    (signal) => group.history.subscribe({ kinds: [9], limit: 60 }, { signal }),
    [group],
  );
  return (
    <Panel title="Received messages (latest 60)">
      <ol className="max-h-80 overflow-auto font-mono">
        {messages?.map((message) => (
          <li key={message.id}>{message.content}</li>
        ))}
      </ol>
      {!messages?.length && <p>Waiting for the first tick…</p>}
    </Panel>
  );
}
