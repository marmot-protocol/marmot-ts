import NavUser from "@/components/nav-user";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { user$ } from "@/lib/accounts";
import { use$ } from "applesauce-react/hooks";
import {
  Command,
  KeyIcon,
  MessageSquareIcon,
  QrCodeIcon,
  Settings,
  ToolCaseIcon,
  UsersIcon,
} from "lucide-react";
import * as React from "react";
import { type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import QRModal from "./qr-modal";

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
  const user = use$(user$);
  const [qrOpen, setQrOpen] = React.useState(false);

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
            {user && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip={{
                    children: "Invite QR Code",
                    hidden: false,
                  }}
                  onClick={() => setQrOpen(true)}
                  className="px-2.5 md:px-2"
                >
                  <QrCodeIcon />
                  <span>Invite QR Code</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
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
          {user && (
            <QRModal data={user.npub} open={qrOpen} onOpenChange={setQrOpen} />
          )}
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
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup className="p-0">
            <SidebarGroupContent>{children}</SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
    </Sidebar>
  );
}
