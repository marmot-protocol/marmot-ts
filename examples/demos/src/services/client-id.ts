import { bytesToHex as hex } from "applesauce-core/helpers/event";
import {
  BehaviorSubject,
  distinctUntilChanged,
  fromEvent,
  takeUntil,
} from "rxjs";

const CLIENT_ID_KEY = "marmot-demos:client-id";

function generateClientId(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

function restoreClientId(): string {
  const saved = localStorage.getItem(CLIENT_ID_KEY);
  if (saved && /^[0-9a-f]{64}$/.test(saved)) return saved;
  const id = generateClientId();
  localStorage.setItem(CLIENT_ID_KEY, id);
  return id;
}

const current = new BehaviorSubject(restoreClientId());

/** One browser identity shared by all accounts; rotation starts a new storage namespace. */
export const clientId$ = current.pipe(distinctUntilChanged());

export async function rotateClientId(): Promise<void> {
  const id = generateClientId();
  // Do not replace the active identity unless it can survive a reload.
  localStorage.setItem(CLIENT_ID_KEY, id);
  current.next(id);
}

// Other tabs must abandon the old identity as well.
fromEvent<StorageEvent>(globalThis, "storage")
  .pipe(takeUntil(fromEvent(globalThis, "pagehide")))
  .subscribe((event) => {
    if (
      event.storageArea === localStorage &&
      (event.key === CLIENT_ID_KEY || event.key === null)
    )
      current.next(restoreClientId());
  });
