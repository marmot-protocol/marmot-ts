import type { NostrEvent } from "applesauce-core/helpers/event";
import type { Welcome } from "ts-mls";
import { describe, expect, it, vi } from "vitest";

import type { MarmotGroupView } from "../../../core/client-state.js";
import type { PendingState } from "../../../engine/types.js";
import type {
  NostrNetworkInterface,
  PublishResponse,
} from "../../nostr-interface.js";
import type { GroupPublishWork } from "../../session/group-effects.js";
import type {
  NostrWelcomeDelivery,
  WelcomeRecipient,
} from "../../transport/nostr/welcome-delivery.js";
import { GroupRuntime, type GroupRuntimeOptions } from "../group-runtime.js";

const RELAYS = ["wss://relay.test"];

/** A fake envelope; the runtime only forwards it to the network. */
const envelope = { id: "evt-1", kind: 445 } as unknown as NostrEvent;

/** Opaque pending markers; the runtime only hands them back to the session. */
const pending = { tag: "pending" } as unknown as PendingState;

function ackResponse(): Record<string, PublishResponse> {
  return { [RELAYS[0]]: { from: RELAYS[0], ok: true } };
}

function noAckResponse(): Record<string, PublishResponse> {
  return { [RELAYS[0]]: { from: RELAYS[0], ok: false, message: "rejected" } };
}

function makeNetwork(
  publish: NostrNetworkInterface["publish"],
): NostrNetworkInterface {
  return {
    publish,
    request: async () => {
      throw new Error("not used");
    },
    subscription: () => {
      throw new Error("not used");
    },
    getUserInboxRelays: async () => {
      throw new Error("not used");
    },
  };
}

function makeRuntime(overrides: Partial<GroupRuntimeOptions> = {}) {
  const confirmPublished = vi.fn();
  const publishFailed = vi.fn();
  const save = vi.fn(async () => {});
  const deliver = vi.fn(async () => ackResponse());
  const groupData = { relays: RELAYS } as MarmotGroupView;

  const options: GroupRuntimeOptions = {
    welcomeDelivery: { deliver } as unknown as NostrWelcomeDelivery,
    getNetwork: () => makeNetwork(async () => ackResponse()),
    getRelays: () => RELAYS,
    getGroupData: () => groupData,
    confirmPublished,
    publishFailed,
    save,
    ...overrides,
  };

  return {
    runtime: new GroupRuntime(options),
    confirmPublished,
    publishFailed,
    save,
    deliver,
  };
}

const recipient: WelcomeRecipient = {
  pubkey: "f".repeat(64),
  keyPackageEventId: "kp-1",
  keyPackageEvent: {} as NostrEvent,
};

function commitWork(
  extra: Partial<Extract<GroupPublishWork, { kind: "groupEvolution" }>> = {},
): GroupPublishWork {
  return {
    kind: "groupEvolution",
    envelope,
    pending,
    actorPubkey: "a".repeat(64),
    ...extra,
  };
}

describe("GroupRuntime publish acknowledgement", () => {
  it("confirms and saves a proposal once a relay acks", async () => {
    const { runtime, confirmPublished, publishFailed, save } = makeRuntime();

    const response = await runtime.publishWork({
      kind: "proposal",
      envelope,
      pending,
    });

    expect(response).toEqual(ackResponse());
    expect(confirmPublished).toHaveBeenCalledWith(pending);
    expect(save).toHaveBeenCalledOnce();
    expect(publishFailed).not.toHaveBeenCalled();
  });

  it("confirms and saves a self-update once a relay acks", async () => {
    const { runtime, confirmPublished, save } = makeRuntime();

    await runtime.publishWork({ kind: "selfUpdate", envelope, pending });

    expect(confirmPublished).toHaveBeenCalledWith(pending);
    expect(save).toHaveBeenCalledOnce();
  });

  it("publishes an application message without confirming pending state", async () => {
    const { runtime, confirmPublished, publishFailed, save } = makeRuntime();

    const response = await runtime.publishWork({
      kind: "applicationMessage",
      envelope,
    });

    expect(response).toEqual(ackResponse());
    expect(confirmPublished).not.toHaveBeenCalled();
    expect(publishFailed).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("publishes each effect in order via publishEffects", async () => {
    const { runtime, confirmPublished } = makeRuntime();

    const results = await runtime.publishEffects({
      publish: [
        { kind: "applicationMessage", envelope },
        { kind: "proposal", envelope, pending },
      ],
    });

    expect(results).toHaveLength(2);
    expect(results[0].work.kind).toBe("applicationMessage");
    expect(results[1].work.kind).toBe("proposal");
    expect(confirmPublished).toHaveBeenCalledOnce();
  });
});

describe("GroupRuntime publish failure", () => {
  it("throws when no relay acknowledges a proposal and never confirms", async () => {
    const { runtime, confirmPublished, save } = makeRuntime({
      getNetwork: () => makeNetwork(async () => noAckResponse()),
    });

    await expect(
      runtime.publishWork({ kind: "proposal", envelope, pending }),
    ).rejects.toThrow(/Failed to publish proposal event/);
    expect(confirmPublished).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("throws when the group has no relays", async () => {
    const { runtime } = makeRuntime({ getRelays: () => undefined });

    await expect(
      runtime.publishWork({ kind: "applicationMessage", envelope }),
    ).rejects.toThrow(/no relays available/);
  });
});

describe("GroupRuntime commit rollback", () => {
  it("rolls back pending state when the commit fails to publish", async () => {
    const { runtime, confirmPublished, publishFailed, save } = makeRuntime({
      getNetwork: () => makeNetwork(async () => noAckResponse()),
    });

    await expect(runtime.publishWork(commitWork())).rejects.toThrow(
      /Failed to publish commit/,
    );
    expect(publishFailed).toHaveBeenCalledWith(pending);
    expect(confirmPublished).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("confirms and saves the commit when a relay acks", async () => {
    const { runtime, confirmPublished, publishFailed, save } = makeRuntime();

    await runtime.publishWork(commitWork());

    expect(confirmPublished).toHaveBeenCalledWith(pending);
    expect(save).toHaveBeenCalledOnce();
    expect(publishFailed).not.toHaveBeenCalled();
  });
});

describe("GroupRuntime Welcome delivery", () => {
  const welcome = { welcome: {} as Welcome };

  it("delivers a Welcome to each recipient after a successful commit", async () => {
    const { runtime, deliver } = makeRuntime();

    await runtime.publishWork(
      commitWork({ welcome, welcomeRecipients: [recipient] }),
    );

    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ recipient, groupRelays: RELAYS }),
    );
  });

  it("does not deliver Welcomes when there are no recipients", async () => {
    const { runtime, deliver } = makeRuntime();

    await runtime.publishWork(commitWork({ welcome, welcomeRecipients: [] }));

    expect(deliver).not.toHaveBeenCalled();
  });

  it("aggregates partial Welcome delivery failures into one error", async () => {
    const deliver = vi
      .fn()
      .mockResolvedValueOnce(ackResponse())
      .mockRejectedValueOnce(new Error("inbox unreachable"));
    const { runtime } = makeRuntime({
      welcomeDelivery: { deliver } as unknown as NostrWelcomeDelivery,
    });

    const second: WelcomeRecipient = { ...recipient, pubkey: "e".repeat(64) };

    await expect(
      runtime.publishWork(
        commitWork({ welcome, welcomeRecipients: [recipient, second] }),
      ),
    ).rejects.toThrow(/Failed to deliver 1\/2 Welcome message\(s\)/);
    expect(deliver).toHaveBeenCalledTimes(2);
  });
});
