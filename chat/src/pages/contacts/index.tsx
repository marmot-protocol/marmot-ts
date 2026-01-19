import { mapEventsToStore, mapEventsToTimeline } from "applesauce-core";
import { kinds, relaySet } from "applesauce-core/helpers";
import { npubEncode } from "applesauce-core/helpers/pointers";
import { use$ } from "applesauce-react/hooks";
import { onlyEvents } from "applesauce-relay";
import { useMemo } from "react";
import { Link } from "react-router";

import { UserAvatar, UserName } from "@/components/nostr-user";
import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
import { withSignIn } from "@/components/with-signIn";
import accounts, { user$ } from "@/lib/accounts";
import { eventStore, pool } from "@/lib/nostr";
import { extraRelays$ } from "@/lib/settings";
import { formatTimeAgo } from "@/lib/time";
import { SubscriptionStatusButton } from "../../components/subscription-status-button";

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

function ContactsIndexPage() {
  const extraRelays = use$(extraRelays$);
  const inboxes = use$(user$.inboxes$);
  const relays = useMemo(
    () => relaySet(inboxes, extraRelays),
    [inboxes, extraRelays],
  );

  const account = use$(accounts.active$);
  const recent = use$(
    () =>
      pool
        .subscription(relays, {
          kinds: [kinds.Contacts],
          "#p": [account!.pubkey],
          limit: 5,
        })
        .pipe(
          onlyEvents(),
          mapEventsToStore(eventStore),
          mapEventsToTimeline(),
        ),
    [relays, account!.pubkey],
  );

  return (
    <>
      <PageHeader items={[{ label: "Home", to: "/" }, { label: "Contacts" }]} />
      <PageBody center>
        <section>
          <div className="flex gap-2 items-start justify-between">
            <h2 className="text-xl font-semibold mb-4">Recent Followers</h2>
            <SubscriptionStatusButton relays={relays} events={recent} />
          </div>
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

export default withSignIn(ContactsIndexPage);
