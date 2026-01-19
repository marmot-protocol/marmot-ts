import { getSeenRelays, type NostrEvent } from "applesauce-core/helpers";
import { use$ } from "applesauce-react/hooks";
import { CodeIcon } from "lucide-react";
import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { pool } from "@/lib/nostr";

function RelayStatus({ relay }: { relay: string }) {
  const inst = useMemo(() => pool.relay(relay), [relay]);
  const icon = use$(inst.icon$);

  return (
    <div className="flex items-center gap-2 py-1">
      <img src={icon} className="w-4 h-4" />
      <code className="flex-1 text-xs font-mono truncate select-all">
        {inst.url}
      </code>
    </div>
  );
}

export function EventStatusButton({ event }: { event: NostrEvent }) {
  // Get relays from the event using getSeenRelays
  const seenRelays = getSeenRelays(event);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2">
          <CodeIcon className="w-4 h-4" />
          <code className="text-xs font-mono">{event.id.slice(0, 8)}</code>
          <span className="text-xs text-muted-foreground">
            {new Date(event.created_at * 1000).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "numeric",
            })}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80">
        <div className="space-y-3">
          <div>
            <h4 className="text-sm font-semibold mb-1">Event Details</h4>
            <div className="space-y-1 text-xs">
              <div>
                <span className="text-muted-foreground">ID: </span>
                <code className="font-mono select-all">{event.id}</code>
              </div>
              <div>
                <span className="text-muted-foreground">Created: </span>
                <span>
                  {new Date(event.created_at * 1000).toLocaleString(undefined, {
                    month: "long",
                    day: "numeric",
                    hour: "numeric",
                    minute: "numeric",
                  })}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Kind: </span>
                <span>{event.kind}</span>
              </div>
            </div>
          </div>
          <div>
            <h4 className="text-sm font-semibold mb-1">Found on Relays</h4>
            <div className="space-y-1">
              {!seenRelays || seenRelays.size === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No relays found with this event
                </p>
              ) : (
                Array.from(seenRelays).map((relay) => (
                  <RelayStatus key={relay} relay={relay} />
                ))
              )}
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
