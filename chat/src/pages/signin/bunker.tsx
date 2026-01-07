import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NostrConnectAccount } from "applesauce-accounts/accounts";
import { NostrConnectSigner } from "applesauce-signers";
import { useState } from "react";
import accountManager from "../../lib/accounts";

interface SignerBunkerProps {
  onSuccess?: () => void;
}

export default function SignerBunker({ onSuccess }: SignerBunkerProps) {
  const [bunkerUrl, setBunkerUrl] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConnect = async () => {
    if (!bunkerUrl) return;

    try {
      setIsConnecting(true);
      setError(null);

      // Create signer from bunker URL
      const signer = await NostrConnectSigner.fromBunkerURI(bunkerUrl);

      // Get the public key
      const pubkey = await signer.getPublicKey();

      // Create a NostrConnectAccount
      const account = new NostrConnectAccount(pubkey, signer);

      // Add the account to the account manager
      accountManager.addAccount(account);

      // Set it as the active account
      accountManager.setActive(account.id);

      // Clear the form
      setBunkerUrl("");

      // Call success callback
      onSuccess?.();
    } catch (err) {
      console.error("Connection error:", err);
      setError(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setIsConnecting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold mb-2">Connect with Bunker URL</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Enter your bunker:// URL to connect
        </p>
      </div>

      <Input
        type="text"
        placeholder="bunker://..."
        value={bunkerUrl}
        onChange={(e) => setBunkerUrl(e.target.value)}
        disabled={isConnecting}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            handleConnect();
          }
        }}
      />

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Button
        className="w-full"
        onClick={handleConnect}
        disabled={!bunkerUrl || isConnecting}
      >
        {isConnecting ? "Connecting..." : "Connect"}
      </Button>
    </div>
  );
}
