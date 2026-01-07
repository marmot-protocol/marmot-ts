import { AppSidebar } from "@/components/app-sidebar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import {
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Code, Key, Package } from "lucide-react";
import { Link, Outlet, useLocation } from "react-router";

const toolsNavItems = [
  {
    title: "Key Package Decoder",
    url: "/tools/key-package-decoder",
    icon: Package,
  },
  {
    title: "TLS Encoding Explorer",
    url: "/tools/tls-encoding",
    icon: Code,
  },
  {
    title: "Group Metadata Encoder/Decoder",
    url: "/tools/group-metadata-encoder-decoder",
    icon: Key,
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
        <header className="bg-background sticky top-0 flex shrink-0 items-center gap-2 border-b p-4">
          <SidebarTrigger className="-ml-1" />
          <Separator
            orientation="vertical"
            className="mr-2 data-[orientation=vertical]:h-4"
          />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink asChild>
                  <Link to="/">Home</Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem>
                <BreadcrumbPage>Tools</BreadcrumbPage>
              </BreadcrumbItem>
              {activeSubNavItem && (
                <>
                  <BreadcrumbSeparator className="hidden md:block" />
                  <BreadcrumbItem>
                    <BreadcrumbPage>{activeSubNavItem}</BreadcrumbPage>
                  </BreadcrumbItem>
                </>
              )}
            </BreadcrumbList>
          </Breadcrumb>
        </header>

        {/* Tools sub-pages */}
        <Outlet />
      </SidebarInset>
    </>
  );
}
