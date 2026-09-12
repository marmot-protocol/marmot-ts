// Type-level consumer contract for @internet-privacy/marmot-ts. Compiled (not run) under
// both nodenext and bundler module resolution to prove the packed tarball's declaration
// files resolve correctly and are not silently degraded to `any`.

import { MarmotClient } from "@internet-privacy/marmot-ts";
import { createSimpleGroup } from "@internet-privacy/marmot-ts/core";
import {
  encode,
  groupContextEncoder,
  type ClientState,
  type GroupContext,
} from "@internet-privacy/marmot-ts/mls";

export function encodeGroupContext(gc: GroupContext): Uint8Array {
  return encode(groupContextEncoder, gc);
}

// `/core` and `/mls` must resolve to the exact same vendored ClientState declaration.
// CoreState is derived from `/core`'s createSimpleGroup return type; the two identity
// functions below only type-check if CoreState and ClientState are the same type.
export type CoreState = Awaited<
  ReturnType<typeof createSimpleGroup>
>["clientState"];

export function coreStateToClientState(state: CoreState): ClientState {
  return state;
}

export function clientStateToCoreState(state: ClientState): CoreState {
  return state;
}

// Non-any guards: if any of these types silently degrade to `any` under skipLibCheck,
// assigning a bare number to them stops being an error, the `@ts-expect-error` directive
// above it becomes unused, and tsc fails on "Unused '@ts-expect-error' directive".

// @ts-expect-error - ClientState is not `any`; a number is not assignable to it.
export const clientStateGuard: ClientState = 42;

// @ts-expect-error - GroupContext is not `any`; a number is not assignable to it.
export const groupContextGuard: GroupContext = 42;

// @ts-expect-error - MarmotClient is not `any`; a number is not assignable to it.
export const marmotClientGuard: MarmotClient = 42;
