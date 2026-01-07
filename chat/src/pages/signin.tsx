import { IconArrowLeft } from "@tabler/icons-react";
import { use$ } from "applesauce-react/hooks";
import { useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui/tabs";
import accountManager from "../lib/accounts";
import SignerBunker from "./signin/bunker";
import SignerConnectQR from "./signin/connect-qr";
import ExtensionSignIn from "./signin/extension";
import NewUser from "./signin/new-user";

export default function SignInPage() {
  const navigate = useNavigate();
  const activeAccount = use$(accountManager.active$);
  const [activeTab, setActiveTab] = useState<
    "extension" | "bunker" | "qr" | "newuser"
  >("newuser");

  const handleSuccess = () => {
    // Navigate back to home after successful sign-in
    navigate("/");
  };

  const handleBack = () => {
    navigate(-1);
  };

  return (
    <div className="flex items-center justify-center p-4 w-full">
      <Card className="w-full max-w-lg">
        <CardHeader className="relative">
          {activeAccount && (
            <Button
              variant="ghost"
              size="icon"
              onClick={handleBack}
              className="absolute left-0 top-1/2 -translate-y-1/2"
            >
              <IconArrowLeft />
            </Button>
          )}
          <CardTitle className="text-center">Sign In</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as typeof activeTab)}
          >
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="newuser">New User</TabsTrigger>
              <TabsTrigger value="extension">Extension</TabsTrigger>
              <TabsTrigger value="bunker">Bunker</TabsTrigger>
              <TabsTrigger value="qr">QR Code</TabsTrigger>
            </TabsList>

            <TabsContent value="newuser">
              <NewUser onSuccess={handleSuccess} />
            </TabsContent>
            <TabsContent value="extension">
              <ExtensionSignIn onSuccess={handleSuccess} />
            </TabsContent>
            <TabsContent value="bunker">
              <SignerBunker onSuccess={handleSuccess} />
            </TabsContent>
            <TabsContent value="qr">
              <SignerConnectQR onSuccess={handleSuccess} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
