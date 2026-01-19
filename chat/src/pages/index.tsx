import { AppSidebar } from "@/components/app-sidebar";
import { PageHeader } from "@/components/page-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { ComponentExample } from "@/components/component-example";

export default function HomePage() {
  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "400px",
        } as React.CSSProperties
      }
    >
      <AppSidebar title="MarmoTS Chat" />
      <SidebarInset>
        <PageHeader items={[{ label: "Home" }]} />

        {/* Page */}
        <ComponentExample />
      </SidebarInset>
    </SidebarProvider>
  );
}
