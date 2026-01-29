import { Link, Outlet, useLocation, useNavigate } from "react-router";

import { use$ } from "applesauce-react/hooks";
import { GroupRumorHistory, MarmotGroup } from "marmot-ts";

import { AppSidebar } from "@/components/app-sidebar";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SidebarInset } from "@/components/ui/sidebar";
import { Switch } from "@/components/ui/switch";
import { getGroupSubscriptionManager } from "@/lib/runtime";
import { liveGroups$, marmotClient$ } from "../lib/marmot-client";

function GroupItem({
  group,
  onRemove,
}: {
  group: MarmotGroup<GroupRumorHistory>;
  onRemove: () => void;
}) {
  const location = useLocation();
  const isActive = location.pathname === `/groups/${group.idStr}`;
  const marmotData = group.groupData;
  const name = marmotData?.name || "Unnamed Group";

  const groupMgr = getGroupSubscriptionManager();
  const unreadGroups = use$(groupMgr?.unreadGroupIds$ ?? undefined);
  const hasUnread = Array.isArray(unreadGroups)
    ? unreadGroups.includes(group.idStr)
    : false;

  return (
    <div
      className={`hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex items-center gap-3 border-b text-sm leading-tight last:border-b-0 ${
        isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : ""
      }`}
    >
      <Link to={`/groups/${group.idStr}`} className="flex-1 min-w-0 p-4">
        <div className="font-medium truncate flex items-center gap-2">
          <span className="truncate">{name}</span>
          {hasUnread && (
            <span
              className="h-2 w-2 rounded-full bg-destructive shrink-0"
              aria-label="Unread messages"
              title="Unread messages"
            />
          )}
        </div>
        <div className="text-xs text-muted-foreground truncate font-mono">
          {group.idStr.slice(0, 16)}...
        </div>
      </Link>

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="mr-2"
            onClick={(e) => e.stopPropagation()}
          >
            Remove
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove group?</AlertDialogTitle>
            <AlertDialogDescription>
              This only removes the group and its messages from your local list.
              No protocol action will be published.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                onRemove();
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default function GroupsPage() {
  const client = use$(marmotClient$);
  const groups = use$(liveGroups$);
  const navigate = useNavigate();
  const location = useLocation();

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
            groups.map((group) => (
              <GroupItem
                key={group.idStr}
                group={group}
                onRemove={async () => {
                  if (!client) return;
                  await client.destroyGroup(group.id);

                  // Navigate back to groups page if not already there
                  if (location.pathname !== `/groups`)
                    navigate("/groups", { replace: true });
                }}
              />
            ))
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
