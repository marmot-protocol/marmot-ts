import { type NostrEvent, relaySet } from "applesauce-core/helpers";
import { use$ } from "applesauce-react/hooks";
import { Plus } from "lucide-react";
import {
  getKeyPackageCipherSuiteId,
  getKeyPackageClient,
  KEY_PACKAGE_KIND,
} from "marmot-ts";
import { useMemo } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { combineLatest, map } from "rxjs";

import { AppSidebar } from "@/components/app-sidebar";
import CipherSuiteBadge from "@/components/cipher-suite-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { SidebarInset } from "@/components/ui/sidebar";
import { withSignIn } from "@/components/with-signIn";
import { default as accounts, keyPackageRelays$, user$ } from "@/lib/accounts";
import { eventStore, pool } from "@/lib/nostr";
import { extraRelays$ } from "@/lib/settings";
import { formatTimeAgo } from "@/lib/time";
import { SubscriptionStatusButton } from "@/components/subscription-status-button";

function KeyPackageItem({ event }: { event: NostrEvent }) {
  const location = useLocation();
  const isActive = location.pathname === `/key-packages/${event.id}`;

  const client = getKeyPackageClient(event);
  const cipherSuiteId = getKeyPackageCipherSuiteId(event);
  const timeAgo = formatTimeAgo(event.created_at);

  return (
    <Link
      to={`/key-packages/${event.id}`}
      className={`hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex flex-col items-start gap-2 border-b p-4 text-sm leading-tight last:border-b-0 ${
        isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : ""
      }`}
    >
      <div className="flex w-full items-center gap-2">
        <span className="font-medium truncate">
          {client?.name || "Unknown Client"}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">{timeAgo}</span>
      </div>
      <div className="flex items-center gap-2">
        {cipherSuiteId !== undefined ? (
          <CipherSuiteBadge cipherSuite={cipherSuiteId} />
        ) : (
          <Badge variant="destructive" className="outline text-xs">
            Unknown
          </Badge>
        )}
      </div>
      <span className="line-clamp-1 w-full text-xs text-muted-foreground font-mono">
        {event.id}
      </span>
    </Link>
  );
}

// Create an observable of relays to read key packages from
const readRelays$ = combineLatest([
  user$.outboxes$,
  keyPackageRelays$,
  extraRelays$,
]).pipe(map((all) => relaySet(...all)));

function KeyPackagesPage() {
  const account = use$(accounts.active$)!;

  // Fetch key packages from relays
  use$(
    () =>
      pool.subscription(readRelays$, {
        kinds: [KEY_PACKAGE_KIND],
        authors: [account.pubkey],
      }),
    [account.pubkey],
  );

  // Get timeline of key package events by the user
  const keyPackages = use$(
    () =>
      eventStore.timeline({
        kinds: [KEY_PACKAGE_KIND],
        authors: [account.pubkey],
      }),
    [account],
  );

  // Filter packages (for now, just show all)
  const filteredPackages = useMemo(() => {
    return keyPackages || [];
  }, [keyPackages]);

  return (
    <>
      <AppSidebar
        title="Key Packages"
        actions={
          <div className="flex items-center gap-2">
            <SubscriptionStatusButton relays={readRelays$} />
            <Button asChild size="sm" variant="default">
              <Link to="/key-packages/create">
                <Plus className="h-4 w-4 mr-1" />
                New
              </Link>
            </Button>
          </div>
        }
      >
        <div className="flex flex-col">
          {keyPackages && keyPackages.length > 0 ? (
            filteredPackages.map((event) => (
              <KeyPackageItem key={event.id} event={event as NostrEvent} />
            ))
          ) : (
            <div className="p-4 text-sm text-muted-foreground text-center">
              {keyPackages === undefined ? "Loading..." : "No key packages yet"}
            </div>
          )}
        </div>
      </AppSidebar>
      <SidebarInset>
        <PageHeader
          items={[{ label: "Home", to: "/" }, { label: "Key Packages" }]}
        />

        {/* Detail sub-pages */}
        <Outlet />
      </SidebarInset>
    </>
  );
}

export default withSignIn(KeyPackagesPage);
