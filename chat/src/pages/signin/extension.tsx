import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ExtensionAccount } from "applesauce-accounts/accounts";
import { ExtensionSigner } from "applesauce-signers";
import { useState } from "react";
import accountManager from "../../lib/accounts";

interface ExtensionSignInProps {
  onSuccess?: () => void;
}

export default function ExtensionSignIn({ onSuccess }: ExtensionSignInProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignInWithExtension = async () => {
    setLoading(true);
    setError(null);

    try {
      // Create an ExtensionSigner
      const signer = new ExtensionSigner();

      // Get the public key from the extension
      const pubkey = await signer.getPublicKey();

      const existing = accountManager.getAccountForPubkey(pubkey);
      if (existing) {
        accountManager.setActive(existing.id);
        onSuccess?.();
        return;
      }

      // Create an ExtensionAccount with pubkey and a label
      const account = new ExtensionAccount(pubkey, signer);

      // Add the account to the account manager
      accountManager.addAccount(account);

      // Set it as the active account
      accountManager.setActive(account.id);

      // Call success callback
      onSuccess?.();
    } catch (err) {
      console.error("Sign in error:", err);
      setError(err instanceof Error ? err.message : "Failed to sign in");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h4 className="font-semibold mb-2">Connect with Browser Extension</h4>
        <p className="text-sm text-muted-foreground mb-4">
          Use a Nostr extension like Alby or nos2x
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Button
        className="w-full"
        onClick={handleSignInWithExtension}
        disabled={loading}
      >
        {loading ? "Connecting..." : "Sign in with Extension"}
      </Button>

      <p className="text-xs text-muted-foreground text-center">
        Don't have an extension?{" "}
        <a
          href="https://getalby.com/alby-extension"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline underline-offset-4 hover:no-underline"
        >
          Get Alby
        </a>
      </p>
    </div>
  );
}
