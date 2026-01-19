import { relaySet } from "applesauce-core/helpers";
import { BehaviorSubject, combineLatest, map } from "rxjs";

// save and load settings from localStorage
function persist<T>(key: string, subject: BehaviorSubject<T>) {
  try {
    if (localStorage.getItem(key))
      subject.next(JSON.parse(localStorage.getItem(key)!));
  } catch {}
  subject.subscribe((value) => {
    localStorage.setItem(key, JSON.stringify(value));
  });
}

// Default relay configurations
const DEFAULT_LOOKUP_RELAYS = [
  "wss://purplepag.es/",
  "wss://index.hzrd149.com/",
];

const DEFAULT_EXTRA_RELAYS = relaySet([
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://nostr.wine",
  "wss://relay.snort.social",
]);

export const extraRelays$ = new BehaviorSubject<string[]>(DEFAULT_EXTRA_RELAYS);
persist("extra-relays", extraRelays$);

export const lookupRelays$ = new BehaviorSubject<string[]>(
  DEFAULT_LOOKUP_RELAYS,
);
persist("lookup-relays", lookupRelays$);

// Manual relays (empty by default, can be extended in the future)
export const manualRelays$ = new BehaviorSubject<string[]>([]);

// Combined relay configuration observable
export const relayConfig$ = combineLatest([
  lookupRelays$,
  extraRelays$,
  manualRelays$,
]).pipe(
  map(([lookupRelays, extraRelays, manualRelays]) => ({
    lookupRelays,
    extraRelays,
    manualRelays,
    // Keep commonRelays for backward compatibility during transition
    commonRelays: extraRelays,
  })),
);
