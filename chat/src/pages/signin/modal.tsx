import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useEffect, useState } from "react";
import SignerBunker from "./bunker";
import SignerConnectQR from "./connect-qr";
import ExtensionSignIn from "./extension";
import NewUser from "./new-user";

export default function SignInModal() {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<
    "extension" | "bunker" | "qr" | "newuser"
  >("newuser");

  const handleSuccess = () => {
    setOpen(false);
  };

  // Expose open function globally for programmatic access
  useEffect(() => {
    const handleOpenModal = () => {
      setOpen(true);
    };

    // Listen for custom event to open modal
    window.addEventListener("openSignInModal", handleOpenModal);

    // Also support the old id-based approach
    const checkForModalOpen = () => {
      const dialog = document.getElementById(
        "signin_modal",
      ) as HTMLDialogElement;
      if (dialog && dialog.open) {
        setOpen(true);
        dialog.close();
      }
    };
    const interval = setInterval(checkForModalOpen, 100);

    return () => {
      window.removeEventListener("openSignInModal", handleOpenModal);
      clearInterval(interval);
    };
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Sign In</DialogTitle>
        </DialogHeader>

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
      </DialogContent>
    </Dialog>
  );
}

// Helper function to open the modal programmatically
export function openSignInModal() {
  window.dispatchEvent(new Event("openSignInModal"));
  // Also support old approach
  const dialog = document.getElementById("signin_modal") as HTMLDialogElement;
  if (dialog) {
    dialog.showModal();
  }
}
