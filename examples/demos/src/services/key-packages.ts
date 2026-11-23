import {
  Observable,
  concatMap,
  firstValueFrom,
  of,
  shareReplay,
  switchMap,
  withLatestFrom,
} from "rxjs";
import { client$ } from "./client.js";
import { account$ } from "./accounts.js";
import { mode$ } from "./mode.js";
import { relays$ } from "./relays.js";
import { takeInitialKeyPackagePublication } from "./internal/development-identity.js";
import {
  KeyPackagePublication,
  type SessionKeyState,
} from "./internal/key-package-publication.js";

export type { SessionKeyState } from "./internal/key-package-publication.js";

/** Publication is a leaf of the real client, not its owner or a replacement for its API. */
const publication$ = client$.pipe(
  withLatestFrom(account$, mode$, relays$),
  switchMap(([client, account, mode, relays]) => {
    if (!client || !account) return of(undefined);
    return new Observable<KeyPackagePublication>((subscriber) => {
      const publication = new KeyPackagePublication(
        client,
        relays,
        account.pubkey,
      );
      const newlyCreated = takeInitialKeyPackagePublication(account);
      subscriber.next(publication);
      void publication.start(newlyCreated && mode === "local").catch(() => {
        // The publication's state stream carries the actionable error.
      });
      return () => publication.close();
    });
  }),
  shareReplay({ bufferSize: 1, refCount: true }),
);

export const state$ = publication$.pipe(
  switchMap(
    (publication) =>
      publication?.state$.asObservable() ??
      of<SessionKeyState>({ busy: false, enabled: false }),
  ),
  shareReplay({ bufferSize: 1, refCount: true }),
);

export async function publish(): Promise<void> {
  await firstValueFrom(
    publication$.pipe(
      concatMap(async (publication) => {
        if (!publication) throw new Error("Client is not ready");
        await publication.publish();
      }),
    ),
  );
}

export async function rotate(): Promise<void> {
  await firstValueFrom(
    publication$.pipe(
      concatMap(async (publication) => {
        if (!publication) throw new Error("Client is not ready");
        await publication.rotate();
      }),
    ),
  );
}
