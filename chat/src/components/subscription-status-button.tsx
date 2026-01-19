import { use$ } from "applesauce-react/hooks";
import type { Relay } from "applesauce-relay";
import { LockIcon, WifiHighIcon, WifiOffIcon } from "lucide-react";
import { combineLatest, isObservable, map, of, type Observable } from "rxjs";
import { isFromRelay, type NostrEvent } from "applesauce-core/helpers";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { pool } from "@/lib/nostr";

function RelayStatus({
  relay,
  events,
}: {
  relay: Relay;
  events?: NostrEvent[];
}) {
  const icon = use$(relay.icon$);
  const connected = use$(relay.connected$);
  const authenticated = use$(relay.authenticated$);

  return (
    <div className="flex items-center gap-2 py-1">
      <img src={icon} className="w-4 h-4" />
      <div
        className={`w-2 h-2 rounded-full ${
          connected ? "bg-green-500" : "bg-red-500"
        }`}
        title={connected ? "Connected" : "Disconnected"}
      />
      <code className="flex-1 text-xs font-mono truncate select-all">
        {relay.url}
      </code>
      {events && events.length > 0 && <span>({events.length})</span>}
      {authenticated && (
        <span title="Authenticated">
          <LockIcon className="w-3 h-3 text-green-500 shrink-0" />
        </span>
      )}
    </div>
  );
}

export function SubscriptionStatusButton({
  relays,
  events,
}: {
  relays: string[] | Observable<string[]>;
  events?: NostrEvent[];
}) {
  const instances = use$(
    () =>
      (isObservable(relays) ? relays : of(relays)).pipe(
        map((urls) => urls.map((url) => pool.relay(url))),
      ),
    [relays],
  );

  const connected = use$(
    () =>
      instances &&
      combineLatest(instances.map((r) => r.connected$)).pipe(
        map((arr) => arr.reduce((acc, curr) => (curr ? acc + 1 : acc), 0)),
      ),
    [instances],
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost">
          {connected ? (
            <WifiHighIcon className="w-4 h-4" />
          ) : (
            <WifiOffIcon className="w-4 h-4 text-red-500" />
          )}
          {connected && (
            <span className="text-xs text-muted-foreground">
              {connected}/{instances?.length ?? 0}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80">
        <div className="space-y-1">
          {!instances || instances.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No relays configured
            </p>
          ) : (
            instances.map((relay) => (
              <RelayStatus
                key={relay.url}
                relay={relay}
                events={
                  events
                    ? events.filter((e) => isFromRelay(e, relay.url))
                    : undefined
                }
              />
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
