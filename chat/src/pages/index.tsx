import { AppSidebar } from "@/components/app-sidebar";
import { PageHeader } from "@/components/page-header";
import { SidebarInset } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  MessageSquareIcon,
  Settings,
  Server,
  KeyIcon,
  InboxIcon,
  UsersIcon,
  ArrowRight,
} from "lucide-react";
import { Link } from "react-router";

function QuickActionCard({
  title,
  description,
  icon: Icon,
  to,
  primary = false,
}: {
  title: string;
  description: string;
  icon: React.ElementType;
  to: string;
  primary?: boolean;
}) {
  return (
    <Card className={primary ? "border-primary/50" : undefined}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="h-5 w-5 text-muted-foreground" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          asChild
          variant={primary ? "default" : "outline"}
          className="w-full"
        >
          <Link to={to}>
            Go to {title}
            <ArrowRight className="ml-2 h-4 w-4" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

export default function HomePage() {
  return (
    <>
      <AppSidebar title="MarmoTS Chat" />
      <SidebarInset>
        <PageHeader items={[{ label: "Home" }]} />

        {/* Page Content */}
        <div className="container mx-auto p-4 space-y-6">
          {/* Intro Section */}
          <div className="space-y-2">
            <h1 className="text-3xl font-bold tracking-tight">
              Welcome to MarmoTS
            </h1>
            <p className="text-muted-foreground max-w-2xl">
              A secure, end-to-end encrypted group chat built on Nostr. Create
              groups, invite contacts, and communicate privately using the MLS
              (Messaging Layer Security) protocol.
            </p>
          </div>

          {/* Quick Actions Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <QuickActionCard
              title="Groups"
              description="View your groups or create a new encrypted group chat."
              icon={MessageSquareIcon}
              to="/groups"
              primary
            />
            <QuickActionCard
              title="Invites"
              description="Check pending group invitations and join new groups."
              icon={InboxIcon}
              to="/invites"
            />
            <QuickActionCard
              title="Contacts"
              description="Manage your contacts and view their key packages."
              icon={UsersIcon}
              to="/contacts"
            />
            <QuickActionCard
              title="Key Packages"
              description="Create and manage your key packages for secure messaging."
              icon={KeyIcon}
              to="/key-packages"
            />
            <QuickActionCard
              title="Relays"
              description="Configure Nostr relays for message delivery."
              icon={Server}
              to="/settings/relays"
            />
            <QuickActionCard
              title="Settings"
              description="Manage your accounts and application preferences."
              icon={Settings}
              to="/settings"
            />
          </div>

          {/* Getting Started Hint */}
          <Card className="bg-muted/50">
            <CardHeader>
              <CardTitle className="text-base">Getting Started</CardTitle>
              <CardDescription>
                New to MarmoTS? Here's how to begin:
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>1. Ensure you have a Nostr account configured in Settings</p>
              <p>2. Configure at least one relay in Settings → Relays</p>
              <p>3. Create a Key Package so others can invite you to groups</p>
              <p>4. Create a new group or wait for invitations from contacts</p>
            </CardContent>
          </Card>
        </div>
      </SidebarInset>
    </>
  );
}
