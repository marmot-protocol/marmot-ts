import { AppSidebar } from "@/components/app-sidebar";
import { UserAvatar, UserName } from "@/components/nostr-user";
import { SidebarInput, SidebarInset } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { user$ } from "@/lib/accounts";
import { IconLock } from "@tabler/icons-react";
import { castUser, User } from "applesauce-common/casts/user";
import { use$ } from "applesauce-react/hooks";
import { KEY_PACKAGE_RELAY_LIST_KIND } from "marmot-ts";
import { createContext, useContext, useMemo, useState } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { useDebounce } from "../hooks/use-debounce";
import { eventLoader, eventStore } from "../lib/nostr";
import { profileSearch } from "../lib/search";

const FilterContext = createContext<{ hasKeyPackageRelays: boolean }>({
  hasKeyPackageRelays: false,
});

function ContactItem({ user }: { user: User }) {
  const location = useLocation();
  const isActive = location.pathname === `/contacts/${user.npub}`;
  const outboxes = use$(user$.outboxes$);
  const keyPackageRelayList = use$(
    () => user.replaceable(KEY_PACKAGE_RELAY_LIST_KIND, undefined, outboxes),
    [user.pubkey, outboxes?.join(",")],
  );
  const { hasKeyPackageRelays } = useContext(FilterContext);

  if (hasKeyPackageRelays && !keyPackageRelayList) return null;

  return (
    <Link
      to={`/contacts/${user.npub}`}
      className={`hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex items-center gap-3 border-b p-4 text-sm leading-tight last:border-b-0 relative ${
        isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : ""
      }`}
    >
      <UserAvatar pubkey={user.pubkey} />
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">
          <UserName pubkey={user.pubkey} />
        </div>
        <div className="text-xs text-muted-foreground truncate font-mono">
          {user.npub.slice(0, 8)}...{user.npub.slice(-8)}
        </div>
      </div>
      {keyPackageRelayList && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="absolute top-2 right-2">
              <IconLock className="size-4 text-green-600 dark:text-green-400" />
            </div>
          </TooltipTrigger>
          <TooltipContent>Can be messaged using MarmotTS</TooltipContent>
        </Tooltip>
      )}
    </Link>
  );
}

export default function ContactsPage() {
  const contacts = use$(user$.contacts$);
  const [query, setQuery] = useState("");
  const [hasKeyPackageRelays, setHasKeyPackageRelays] = useState(true);

  // always load the latest contacts
  const user = use$(user$);
  const outboxes = use$(user$.outboxes$);
  use$(
    () =>
      user &&
      eventLoader({
        kind: 3,
        pubkey: user.pubkey,
        // @ts-ignore
        cache: false,
        relays: outboxes,
      }),
    [user, outboxes],
  );

  const debouncedQuery = useDebounce(query, 500);

  const filteredContacts = useMemo(() => {
    if (!contacts) return [];
    if (!debouncedQuery.trim()) return contacts;

    return profileSearch
      .search(debouncedQuery.toLowerCase().trim())
      .map((r) => castUser(r.item.pubkey, eventStore));
  }, [contacts, debouncedQuery]);

  const filters = useMemo(
    () => ({ hasKeyPackageRelays }),
    [hasKeyPackageRelays],
  );

  return (
    <>
      <AppSidebar
        title="Contacts"
        actions={
          <Label className="flex items-center gap-2 text-sm">
            <span>Setup MLS</span>
            <Switch
              className="shadow-none"
              checked={hasKeyPackageRelays}
              onCheckedChange={setHasKeyPackageRelays}
            />
          </Label>
        }
      >
        <FilterContext.Provider value={filters}>
          <div className="flex flex-col">
            <div className="p-2 border-b">
              <SidebarInput
                placeholder="Search contacts..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            {filteredContacts && filteredContacts.length > 0 ? (
              filteredContacts.map((contact) => (
                <ContactItem key={contact.pubkey} user={contact} />
              ))
            ) : (
              <div className="p-4 text-sm text-muted-foreground text-center">
                {query.trim()
                  ? "No contacts found matching your search"
                  : "No contacts yet"}
              </div>
            )}
          </div>
        </FilterContext.Provider>
      </AppSidebar>
      <SidebarInset>
        <Outlet />
      </SidebarInset>
    </>
  );
}
