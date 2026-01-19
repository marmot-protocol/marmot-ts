import NavUser from "@/components/nav-user";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Command,
  KeyIcon,
  MessageSquareIcon,
  Settings,
  ToolCaseIcon,
  UsersIcon,
} from "lucide-react";
import * as React from "react";
import { type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";

const topLevelNav = [
  {
    title: "Groups",
    url: "/groups",
    icon: MessageSquareIcon,
  },
  {
    title: "Contacts",
    url: "/contacts",
    icon: UsersIcon,
  },
  {
    title: "Key Packages",
    url: "/key-packages",
    icon: KeyIcon,
  },
  {
    title: "Tools",
    url: "/tools",
    icon: ToolCaseIcon,
  },
];

interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  children?: ReactNode;
  title?: string;
  actions?: ReactNode;
}

export function AppSidebar({
  children,
  title,
  actions,
  ...props
}: AppSidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();

  const { setOpen } = useSidebar();

  return (
    <Sidebar
      collapsible="icon"
      className="overflow-hidden *:data-[sidebar=sidebar]:flex-row"
      {...props}
    >
      {/* This is the first sidebar */}
      {/* We disable collapsible and adjust width to icon. */}
      {/* This will make the sidebar appear as icons. */}
      <Sidebar
        collapsible="none"
        className="w-[calc(var(--sidebar-width-icon)+1px)]! border-r"
      >
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" asChild className="md:h-8 md:p-0">
                <Link to="/">
                  <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                    <Command className="size-4" />
                  </div>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">Acme Inc</span>
                    <span className="truncate text-xs">Enterprise</span>
                  </div>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent className="px-1.5 md:px-0">
              <SidebarMenu>
                {topLevelNav.map((item) => (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      tooltip={{
                        children: item.title,
                        hidden: false,
                      }}
                      onClick={() => {
                        navigate(item.url);
                        setOpen(true);
                      }}
                      isActive={location.pathname.startsWith(item.url)}
                      className="px-2.5 md:px-2"
                    >
                      <item.icon />
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip={{
                  children: "Settings",
                  hidden: false,
                }}
                onClick={() => navigate("/settings")}
                className="px-2.5 md:px-2"
              >
                <Settings />
                <span>Settings</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <NavUser />
        </SidebarFooter>
      </Sidebar>

      {/* This is the second sidebar */}
      {/* We disable collapsible and let it fill remaining space */}
      <Sidebar
        collapsible="none"
        className="hidden flex-1 md:flex overflow-hidden"
      >
        <SidebarHeader className="gap-3.5 border-b p-4">
          <div className="flex w-full items-center justify-between gap-2">
            <div className="text-foreground text-base font-medium">{title}</div>
            {actions}
          </div>
          {!children && <SidebarInput placeholder="Type to search..." />}
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup className="px-0">
            <SidebarGroupContent>{children}</SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
    </Sidebar>
  );
}

// const coolGroupNavItem = (
//   <a
//     href="#"
//     key={title}
//     className="hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex flex-col items-start gap-2 border-b p-4 text-sm leading-tight whitespace-nowrap last:border-b-0"
//   >
//     <div className="flex w-full items-center gap-2">
//       <span>{mail.name}</span>{" "}
//       <span className="ml-auto text-xs">{mail.date}</span>
//     </div>
//     <span className="font-medium">{mail.subject}</span>
//     <span className="line-clamp-2 w-[260px] text-xs whitespace-break-spaces">
//       {mail.teaser}
//     </span>
//   </a>
// );
