import { mapEventsToTimeline } from "applesauce-core";
import { kinds, relaySet } from "applesauce-core/helpers";
import { npubEncode } from "applesauce-core/helpers/pointers";
import { use$ } from "applesauce-react/hooks";
import { onlyEvents } from "applesauce-relay";
import { useMemo } from "react";
import { Link } from "react-router";
import {
  combineLatest,
  distinct,
  EMPTY,
  map,
  ReplaySubject,
  share,
  switchMap,
  timer,
} from "rxjs";

import { UserAvatar, UserName } from "@/components/nostr-user";
import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
import { user$ } from "@/lib/accounts";
import { pool } from "@/lib/nostr";
import { extraRelays$ } from "@/lib/settings";
import { formatTimeAgo } from "@/lib/time";

function FollowerItem({
  pubkey,
  created_at,
}: {
  pubkey: string;
  created_at: number;
}) {
  const npub = npubEncode(pubkey);

  return (
    <Link
      to={`/contacts/${npub}`}
      className="flex items-center gap-3 p-3 rounded-lg hover:bg-accent transition-colors"
    >
      <UserAvatar pubkey={pubkey} size="sm" />
      <div className="font-medium truncate">
        <UserName pubkey={pubkey} />
      </div>

      <time className="text-xs text-muted-foreground ms-auto">
        {formatTimeAgo(created_at)}
      </time>
    </Link>
  );
}

// Complicated observable for subscribing to the other users show are following
const recentFollows$ = user$.pipe(
  switchMap((user) =>
    user
      ? pool
          .subscription(
            combineLatest([user$.inboxes$, extraRelays$]).pipe(
              map((all) => relaySet(...all)),
            ),
            { kinds: [kinds.Contacts], "#p": [user.pubkey], limit: 10 },
          )
          .pipe(
            onlyEvents(),
            // Ignore duplicate events with the same pubkey
            distinct((e) => e.pubkey),
            mapEventsToTimeline(),
          )
      : EMPTY,
  ),
  share({
    // Save the last value
    connector: () => new ReplaySubject(1),
    // Reset after 60 seconds
    resetOnRefCountZero: () => timer(60 * 1000),
  }),
  // Hack to make react re-render
  map((arr) => [...arr]),
);

export default function ContactsIndexPage() {
  const recent = use$(recentFollows$);

  return (
    <>
      <PageHeader items={[{ label: "Home", to: "/" }, { label: "Contacts" }]} />
      <PageBody center>
        <section>
          <h2 className="text-xl font-semibold mb-4">Recent Followers</h2>
          {recent && recent.length > 0 ? (
            <div className="space-y-2">
              {recent.map((event) => (
                <FollowerItem
                  key={event.pubkey}
                  pubkey={event.pubkey}
                  created_at={event.created_at}
                />
              ))}
            </div>
          ) : (
            <div className="text-center text-muted-foreground py-4">
              {recent === undefined ? "Loading..." : "No recent followers"}
            </div>
          )}
        </section>
      </PageBody>
    </>
  );
}
