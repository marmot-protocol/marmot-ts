import type {
  MarmotClient,
  MarmotGroup,
} from "@internet-privacy/marmot-ts/client";
import type { NostrEvent } from "applesauce-core/helpers/event";
import { evaluateKeyPackageForGroup } from "@internet-privacy/marmot-ts/core";
import { catchError, defer, map, of, shareReplay, takeUntil } from "rxjs";
import { aborted$, stateObservable, watchObservable } from "./observable.js";

/** Demo-only RxJS adapters; commands remain the original Marmot APIs. */
export function reactiveClient(client: MarmotClient, lifetime: AbortSignal) {
  const observed = new WeakMap<MarmotGroup, ReturnType<typeof observeGroup>>();
  type Invite = Parameters<MarmotClient["previewWelcome"]>[0];
  const preview = (invite: Invite) =>
    defer(() => client.previewWelcome(invite)).pipe(
      // An unavailable preview must not prevent displaying or accepting an invite.
      catchError(() => of(undefined)),
      takeUntil(aborted$(lifetime)),
      shareReplay({ bufferSize: 1, refCount: true }),
    );
  const previews = new Map<string, ReturnType<typeof preview>>();
  const groups = {
    create: client.groups.create.bind(client.groups),
    connect: client.groups.connect.bind(client.groups),
    invite: client.groups.invite.bind(client.groups),
    send: client.groups.send.bind(client.groups),
    unload: client.groups.unload.bind(client.groups),
    state$: stateObservable(
      () => client.groups.snapshot,
      (changed) => {
        client.groups.on("changed", changed);
        return () => {
          client.groups.off("changed", changed);
        };
      },
      lifetime,
    ),
    observe(group: MarmotGroup) {
      let value = observed.get(group);
      if (!value) {
        value = observeGroup(group, lifetime);
        observed.set(group, value);
      }
      return value;
    },
  } as const;
  const invites = {
    markAsRead: client.invites.markAsRead.bind(client.invites),
    preview$(invite: Invite) {
      let stream = previews.get(invite.id);
      if (!stream) {
        stream = preview(invite);
        previews.set(invite.id, stream);
      }
      return stream;
    },
    state$: watchObservable(
      (signal) => client.watchInvites({ signal }),
      lifetime,
    ),
    unread$: watchObservable(
      (signal) => client.invites.watchUnread({ signal }),
      lifetime,
    ),
    received$: watchObservable(
      (signal) => client.invites.watchReceived({ signal }),
      lifetime,
    ),
  } as const;
  const keyPackages = {
    create: client.keyPackages.create.bind(client.keyPackages),
    remove: client.keyPackages.remove.bind(client.keyPackages),
    state$: watchObservable(
      (signal) => client.keyPackages.watchKeyPackages({ signal }),
      lifetime,
    ),
  } as const;
  return {
    groups,
    invites,
    keyPackages,
    network: {
      request: client.network.request.bind(client.network),
      publish: client.network.publish.bind(client.network),
    },
    joinGroupFromWelcome: client.joinGroupFromWelcome.bind(client),
  } as const;
}

export type ReactiveClient = ReturnType<typeof reactiveClient>;

function observeGroup(group: MarmotGroup, lifetime: AbortSignal) {
  type Filters = Parameters<MarmotGroup["history"]["subscribe"]>[0];
  const timelines = new Map<string, ReturnType<typeof timeline>>();
  const controller = new AbortController();
  const close = () => {
    controller.abort();
    timelines.clear();
    group.off("disposed", close);
    lifetime.removeEventListener("abort", close);
  };
  if (lifetime.aborted) close();
  else {
    group.once("disposed", close);
    lifetime.addEventListener("abort", close, { once: true });
  }
  const timeline = (filters: Filters) =>
    watchObservable(
      (signal) => group.history.subscribe(filters, { signal }),
      controller.signal,
    );
  const state$ = watchObservable(
    (signal) => group.watch({ signal }),
    controller.signal,
  );
  return {
    state$,
    eligibleKeyPackages$(events: NostrEvent[]) {
      return state$.pipe(
        map(() =>
          events.filter((event) => {
            try {
              return evaluateKeyPackageForGroup(group.state, event).eligible;
            } catch {
              return false;
            }
          }),
        ),
      );
    },
    history$(filters: Filters) {
      const key = JSON.stringify(filters);
      let stream = timelines.get(key);
      if (!stream) {
        stream = timeline(filters);
        timelines.set(key, stream);
      }
      return stream;
    },
  } as const;
}
