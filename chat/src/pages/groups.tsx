import { AppSidebar } from "@/components/app-sidebar";
import { PageHeader } from "@/components/page-header";
import { SidebarInset } from "@/components/ui/sidebar";
import { ComponentExample } from "../components/component-example";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";

export default function GroupsPage() {
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
      />
      <SidebarInset>
        <PageHeader items={[{ label: "Home", to: "/" }, { label: "Groups" }]} />

        {/* Page */}
        <ComponentExample />
      </SidebarInset>
    </>
  );
}
