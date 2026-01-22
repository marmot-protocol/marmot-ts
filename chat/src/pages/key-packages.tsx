import { bytesToHex, relaySet, type NostrEvent } from "applesauce-core/helpers";
import { use$ } from "applesauce-react/hooks";
import { Plus } from "lucide-react";
import { getKeyPackageClient, ListedKeyPackage } from "marmot-ts";
import { useMemo } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { combineLatest, from, map, shareReplay } from "rxjs";

import { AppSidebar } from "@/components/app-sidebar";
import CipherSuiteBadge from "@/components/cipher-suite-badge";
import { SubscriptionStatusButton } from "@/components/subscription-status-button";
import { Button } from "@/components/ui/button";
import { SidebarInset } from "@/components/ui/sidebar";
import { withSignIn } from "@/components/with-signIn";
import { user$ } from "@/lib/accounts";
import { keyPackageRelays$, publishedKeyPackages$ } from "@/lib/lifecycle";
import { marmotClient$ } from "@/lib/marmot-client";
import { extraRelays$ } from "@/lib/settings";
import { formatTimeAgo } from "@/lib/time";

/** An observable of all relays to read key packages from */
const readRelays$ = combineLatest([
  user$.outboxes$,
  keyPackageRelays$,
  extraRelays$,
]).pipe(
  map((all) => relaySet(...all)),
  shareReplay(1),
);

function KeyPackageItem({
  keyPackage,
  event,
}: {
  keyPackage: ListedKeyPackage;
  event?: NostrEvent;
}) {
  const location = useLocation();

  const linkTo = useMemo(
    () => `/key-packages/${bytesToHex(keyPackage.keyPackageRef)}`,
    [keyPackage.keyPackageRef],
  );
  const isActive = location.pathname === linkTo;

  const client = event ? getKeyPackageClient(event) : undefined;
  const timeAgo = event ? formatTimeAgo(event.created_at) : "Unpublished";

  return (
    <Link
      to={linkTo}
      className={`hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex flex-col items-start gap-2 border-b p-4 text-sm leading-tight ${
        isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : ""
      }`}
    >
      <div className="flex w-full items-center gap-2">
        <span className="font-medium truncate">
          {client?.name || "Unknown Client"}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{timeAgo}</span>
        </span>
      </div>
      <div className="flex items-center gap-2">
        <CipherSuiteBadge cipherSuite={keyPackage.publicPackage.cipherSuite} />
      </div>
      {/* <span className="line-clamp-1 w-full text-xs text-muted-foreground font-mono">
        {matchedEvent?.id ||
          Array.from(keyPackage.publicPackage.initKey)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("")
            .slice(0, 16) + "..."}
      </span> */}
    </Link>
  );
}

function KeyPackagesPage() {
  const client = use$(marmotClient$);
  const keyPackages = use$(
    () => (client ? from(client.keyPackageStore.list()) : undefined),
    [client],
  );
  const published = use$(publishedKeyPackages$);

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
            keyPackages.map((keyPackage) => (
              <KeyPackageItem
                key={bytesToHex(keyPackage.keyPackageRef)}
                keyPackage={keyPackage}
                event={
                  published?.find(
                    (pkg) =>
                      bytesToHex(pkg.keyPackageRef) ===
                      bytesToHex(keyPackage.keyPackageRef),
                  )?.event
                }
              />
            ))
          ) : (
            <div className="p-4 text-sm text-muted-foreground text-center">
              {keyPackages === undefined ? "Loading..." : "No key packages yet"}
            </div>
          )}
        </div>

        <div className="p-4 text-sm text-muted-foreground text-center">
          Found {published?.length ?? 0} published key packages
        </div>
      </AppSidebar>
      <SidebarInset>
        <Outlet />
      </SidebarInset>
    </>
  );
}

export default withSignIn(KeyPackagesPage);
