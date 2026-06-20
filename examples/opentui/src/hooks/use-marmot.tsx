import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { MarmotGroup } from "@internet-privacy/marmot-ts/client";

import type {
  ChatSnapshot,
  InviteEntry,
  MarmotController,
} from "../marmot/controller.js";
import { useAsyncIterable } from "./use-async-iterable.js";

const ControllerContext = createContext<MarmotController | null>(null);

export function MarmotProvider(props: {
  controller: MarmotController;
  children: ReactNode;
}) {
  return (
    <ControllerContext.Provider value={props.controller}>
      {props.children}
    </ControllerContext.Provider>
  );
}

/** The imperative controller — used to dispatch actions (send, invite, join). */
export function useController(): MarmotController {
  const controller = useContext(ControllerContext);
  if (!controller) throw new Error("useController used outside MarmotProvider");
  return controller;
}

/**
 * Reactive view of the controller's snapshot (messages, status, active group).
 * Backed by `useSyncExternalStore`, so React re-renders on every mutation.
 */
export function useChat(): ChatSnapshot {
  const controller = useController();
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot);
}

/**
 * The live group list, driven directly by the library's `groups.watch()` async
 * generator. This is the React/async-generator integration in its purest form.
 */
export function useWatchedGroups(): MarmotGroup[] {
  const controller = useController();
  return useAsyncIterable<MarmotGroup[]>(
    () => controller.client.groups.watch(),
    [],
  );
}

/**
 * The live unread-invite list, each entry annotated with whether it's
 * `joinable` (we still hold its target KeyPackage). Driven by the controller's
 * `watchInvites()`. The panel filters on `joinable` itself so the user can
 * toggle non-joinable invites into view.
 */
export function useWatchedInvites(): InviteEntry[] {
  const controller = useController();
  return useAsyncIterable<InviteEntry[]>(() => controller.watchInvites(), []);
}
