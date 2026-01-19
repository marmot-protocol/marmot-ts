import { getDisplayName, getProfilePicture } from "applesauce-core/helpers";
import { use$ } from "applesauce-react/hooks";
import { ChevronsUpDown, LogOutIcon, PlusIcon } from "lucide-react";
import { useNavigate } from "react-router";
import accountManager from "../lib/accounts";
import { eventStore } from "../lib/nostr";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "./ui/sidebar";

function AccountMenuItem({
  account,
  onClick,
}: {
  account: { id: string; pubkey: string };
  onClick: () => void;
}) {
  const profile = use$(
    () => eventStore.profile(account.pubkey),
    [account.pubkey],
  );
  const avatar = getProfilePicture(
    profile,
    `https://api.dicebear.com/7.x/identicon/svg?seed=${account.pubkey}`,
  );
  const name = getDisplayName(profile, account.pubkey.slice(0, 16));

  return (
    <DropdownMenuItem onClick={onClick}>
      <Avatar className="h-6 w-6 rounded-lg mr-2">
        <AvatarImage src={avatar} alt={name} />
        <AvatarFallback className="rounded-lg">
          {name.slice(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <div className="font-semibold truncate text-sm">{name}</div>
        <div className="text-xs text-muted-foreground truncate font-mono">
          {account.pubkey.slice(0, 8)}...{account.pubkey.slice(-8)}
        </div>
      </div>
    </DropdownMenuItem>
  );
}

export default function NavUser() {
  const navigate = useNavigate();
  const { isMobile } = useSidebar();
  const active = use$(accountManager.active$);
  const accounts = use$(accountManager.accounts$);

  // Get profile data for active account
  // Always call the hook to avoid "fewer hooks were rendered" error
  const activeProfile = use$(
    () => active && eventStore.profile(active.pubkey),
    [active?.pubkey],
  );
  const activeAvatar = active
    ? getProfilePicture(
        activeProfile ?? undefined,
        `https://api.dicebear.com/7.x/identicon/svg?seed=${active.pubkey}`,
      )
    : "";
  const activeName = active
    ? getDisplayName(activeProfile ?? undefined, active.pubkey.slice(0, 16))
    : "";

  const handleSignIn = () => {
    navigate("/signin");
  };

  const handleSwitchAccount = (accountId: string) => {
    accountManager.setActive(accountId);
  };

  const handleSignOut = () => {
    if (active) {
      accountManager.removeAccount(active.id);
    }
  };

  // If no accounts exist at all, show sign in button
  if (!accounts || accounts.length === 0) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton className="w-full" onClick={handleSignIn}>
            Sign In
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                size="lg"
                className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground md:h-8 md:p-0"
              >
                {active ? (
                  <>
                    <Avatar className="h-8 w-8 rounded-lg">
                      <AvatarImage src={activeAvatar} alt={activeName} />
                      <AvatarFallback className="rounded-lg">
                        {activeName.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="grid flex-1 text-left text-sm leading-tight">
                      <span className="truncate font-medium">{activeName}</span>
                      <span className="truncate text-xs font-mono">
                        {active.pubkey.slice(0, 8)}...
                        {active.pubkey.slice(-8)}
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <Avatar className="h-8 w-8 rounded-lg">
                      <AvatarFallback className="rounded-lg">?</AvatarFallback>
                    </Avatar>
                    <div className="grid flex-1 text-left text-sm leading-tight">
                      <span className="truncate font-medium">
                        Select Account
                      </span>
                      <span className="truncate text-xs">
                        Choose an account to continue
                      </span>
                    </div>
                  </>
                )}
                <ChevronsUpDown className="ml-auto size-4" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
              side={isMobile ? "bottom" : "right"}
              align="end"
              sideOffset={4}
            >
              {active && (
                <>
                  <DropdownMenuLabel className="p-0 font-normal">
                    <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                      <Avatar className="h-8 w-8 rounded-lg">
                        <AvatarImage src={activeAvatar} alt={activeName} />
                        <AvatarFallback className="rounded-lg">
                          {activeName.slice(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div className="grid flex-1 text-left text-sm leading-tight">
                        <span className="truncate font-medium">
                          {activeName}
                        </span>
                        <span className="truncate text-xs font-mono">
                          {active.pubkey.slice(0, 8)}...
                          {active.pubkey.slice(-8)}
                        </span>
                      </div>
                    </div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                </>
              )}
              {accounts.length > 1 && (
                <>
                  <DropdownMenuGroup>
                    {accounts
                      .filter((account) => !active || account.id !== active.id)
                      .map((account) => (
                        <AccountMenuItem
                          key={account.id}
                          account={account}
                          onClick={() => handleSwitchAccount(account.id)}
                        />
                      ))}
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={handleSignIn}>
                  <PlusIcon className="size-4" />
                  Add Account
                </DropdownMenuItem>
                {active && (
                  <DropdownMenuItem
                    onClick={handleSignOut}
                    className="text-destructive"
                  >
                    <LogOutIcon className="size-4" />
                    Sign Out
                  </DropdownMenuItem>
                )}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
    </>
  );
}
