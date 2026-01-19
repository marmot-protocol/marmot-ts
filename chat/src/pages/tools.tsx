import { AppSidebar } from "@/components/app-sidebar";
import {
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Package, UsersIcon, Rss } from "lucide-react";
import { Link, Outlet, useLocation } from "react-router";

const toolsNavItems = [
  {
    title: "Key Package Encoding",
    url: "/tools/key-package-encoding",
    icon: Package,
  },
  {
    title: "Group Metadata Encoding",
    url: "/tools/group-metadata-encoding",
    icon: UsersIcon,
  },
  {
    title: "Key Package Feed",
    url: "/tools/key-package-feed",
    icon: Rss,
  },
];

export default function ToolsPage() {
  const location = useLocation();

  // Determine active nav item based on current pathname
  const activeSubNavItem = toolsNavItems.find(
    (item) => location.pathname === item.url,
  )?.title;

  return (
    <>
      <AppSidebar title="Tools">
        <SidebarMenu>
          {toolsNavItems.map((item) => {
            const isActive = activeSubNavItem === item.title;
            return (
              <SidebarMenuItem key={item.title}>
                <SidebarMenuButton
                  asChild
                  isActive={isActive}
                  className="px-2.5 md:px-2"
                >
                  <Link to={item.url}>
                    <item.icon />
                    <span>{item.title}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </AppSidebar>
      <SidebarInset>
        {/* Tools sub-pages */}
        <Outlet />
      </SidebarInset>
    </>
  );
}
