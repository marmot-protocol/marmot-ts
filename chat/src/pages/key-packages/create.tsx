import { relaySet } from "applesauce-core/helpers";
import { use$ } from "applesauce-react/hooks";
import { Loader2, XCircle } from "lucide-react";
import {
  createCredential,
  createKeyPackageEvent,
  generateKeyPackage,
} from "marmot-ts";
import { useState } from "react";
import { useNavigate } from "react-router";
import {
  defaultCryptoProvider,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
} from "ts-mls";
import { type CiphersuiteName } from "ts-mls/crypto/ciphersuite.js";

import { CipherSuitePicker } from "@/components/form/cipher-suite-picker";
import { KeyPackageRelaysAlert } from "@/components/key-package-relays-alert";
import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { withSignIn } from "@/components/with-signIn";
import { accounts, user$ } from "@/lib/accounts";
import { keyPackageStore$ } from "@/lib/key-package-store";
import { eventStore, pool } from "@/lib/nostr";
import { keyPackageRelays$ } from "../../lib/lifecycle";

function CreateKeyPackagePage() {
  // Subscribe to the user's key package relays and mailboxes
  const keyPackageRelays = use$(keyPackageRelays$);
  const outboxes = use$(user$.outboxes$);
  const keyPackageStore = use$(keyPackageStore$);
  const navigate = useNavigate();

  const [cipherSuite, setCipherSuite] = useState<CiphersuiteName>(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
  );
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!keyPackageRelays || keyPackageRelays.length === 0) {
      return;
    }

    const publishRelays = relaySet(outboxes || [], keyPackageRelays);
    if (publishRelays.length === 0) {
      return;
    }

    try {
      setIsCreating(true);
      setError(null);

      const account = accounts.active;
      if (!account) throw new Error("No active account");

      const pubkey = account.pubkey;

      // Get cipher suite implementation
      const selectedCiphersuite = getCiphersuiteFromName(cipherSuite);
      const ciphersuiteImpl = await getCiphersuiteImpl(
        selectedCiphersuite,
        defaultCryptoProvider,
      );

      // Create credential and key package
      console.log("Creating credential for pubkey:", pubkey);
      const credential = createCredential(pubkey);

      console.log("Generating key package with cipher suite:", cipherSuite);
      const keyPackage = await generateKeyPackage({
        credential,
        ciphersuiteImpl,
      });

      // Create the unsigned event using the library function
      // Use key package relays in the event tags (for discovery)
      console.log("Creating key package event...");
      const unsignedEvent = createKeyPackageEvent({
        keyPackage: keyPackage.publicPackage,
        pubkey,
        relays: keyPackageRelays,
        client: "marmot-chat",
      });

      // Sign the event
      console.log("Signing event...");
      const signedEvent = await account.signEvent(unsignedEvent);
      console.log("Signed event:", signedEvent);

      // Publish to both key package relays and outboxes
      console.log("Publishing to relays:", publishRelays.join(", "));
      await pool.publish(publishRelays, signedEvent);
      console.log("Published to", publishRelays.join(", "));

      // Store the signed event in the event store
      eventStore.add(signedEvent);

      // Store the key package locally only after successful publication
      if (keyPackageStore) {
        console.log("Storing key package locally...");
        await keyPackageStore.add(keyPackage);
        console.log("Stored key package");
      }

      console.log("✅ Key package published successfully!");

      // Redirect to the detail page
      navigate(`/key-packages/${signedEvent.id}`);
    } catch (err) {
      console.error("Error creating key package:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsCreating(false);
    }
  };

  // Show alert if no key package relays are configured
  if (!keyPackageRelays || keyPackageRelays.length === 0) {
    return (
      <div className="container mx-auto p-6 max-w-4xl space-y-6">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold">Create Key Package</h1>
          <p className="text-muted-foreground">
            Generate and publish a new MLS key package to enable encrypted group
            messaging.
          </p>
        </div>
        <KeyPackageRelaysAlert />
      </div>
    );
  }

  return (
    <>
      {/* Header */}
      <PageHeader
        items={[
          { label: "Home", to: "/" },
          { label: "Key Packages", to: "/key-packages" },
          { label: "Create Key Package" },
        ]}
      />
      <PageBody>
        <Card>
          <CardHeader>
            <CardTitle>Configuration</CardTitle>
            <CardDescription>
              Configure the cipher suite for your key package. The key package
              will be published to your key package relays and outboxes.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <CipherSuitePicker
              value={cipherSuite}
              onChange={setCipherSuite}
              disabled={isCreating}
            />
          </CardContent>
          <CardFooter>
            <Button
              onClick={handleCreate}
              disabled={isCreating}
              className="w-full"
            >
              {isCreating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create Key Package"
              )}
            </Button>
          </CardFooter>
        </Card>

        {/* Error Display */}
        {error && (
          <Alert variant="destructive">
            <XCircle className="h-4 w-4" />
            <AlertDescription>Error: {error}</AlertDescription>
          </Alert>
        )}
      </PageBody>
    </>
  );
}

export default withSignIn(CreateKeyPackagePage);
