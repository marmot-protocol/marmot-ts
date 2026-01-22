import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset } from "@/components/ui/sidebar";
import { groupStore$ } from "@/lib/group-store";
import { use$ } from "applesauce-react/hooks";
import { extractMarmotGroupData, getGroupIdHex } from "marmot-ts";
import { Link, Outlet, useLocation } from "react-router";
import { from, switchMap } from "rxjs";
import { ClientState } from "ts-mls/clientState.js";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { Button } from "../components/ui/button";

function GroupItem({
  groupId,
  clientState,
}: {
  groupId: string;
  clientState: ClientState;
}) {
  const location = useLocation();
  const isActive = location.pathname === `/groups/${groupId}`;
  const marmotData = extractMarmotGroupData(clientState);
  const name = marmotData?.name || "Unnamed Group";

  return (
    <Link
      to={`/groups/${groupId}`}
      className={`hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex items-center gap-3 border-b p-4 text-sm leading-tight last:border-b-0 ${
        isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : ""
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{name}</div>
        <div className="text-xs text-muted-foreground truncate font-mono">
          {groupId.slice(0, 16)}...
        </div>
      </div>
    </Link>
  );
}

export default function GroupsPage() {
  // Get groups list from store
  const groups = use$(
    () =>
      groupStore$.pipe(
        switchMap((store) =>
          store ? from(store.list()) : from(Promise.resolve([])),
        ),
      ),
    [],
  );

  return (
    <>
      <AppSidebar
        title="Groups"
        actions={
          <Label className="flex items-center gap-2 text-sm">
            <span>Unreads</span>
            <Switch className="shadow-none" />
          </Label>
        }
      >
        <div className="flex flex-col">
          <Button asChild className="m-2">
            <Link to="/groups/create">Create Group</Link>
          </Button>
          {groups && groups.length > 0 ? (
            groups.map((clientState) => {
              const groupId = getGroupIdHex(clientState);
              return (
                <GroupItem
                  key={groupId}
                  groupId={groupId}
                  clientState={clientState}
                />
              );
            })
          ) : (
            <div className="p-4 text-sm text-muted-foreground text-center">
              {groups === undefined ? "Loading..." : "No groups yet"}
            </div>
          )}
        </div>
      </AppSidebar>
      <SidebarInset>
        {/* Detail sub-pages */}
        <Outlet />
      </SidebarInset>
    </>
  );
}
