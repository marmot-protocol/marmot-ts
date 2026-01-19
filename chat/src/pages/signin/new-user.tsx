import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { setProfile } from "applesauce-core/operations/profile";
import { useCallback, useEffect, useState } from "react";
import {
  adjectives,
  animals,
  colors,
  uniqueNamesGenerator,
} from "unique-names-generator";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { IconRefresh } from "@tabler/icons-react";
import { buildEvent } from "applesauce-core";
import { relaySet } from "applesauce-core/helpers";
import { use$ } from "applesauce-react/hooks";
import { createKeyPackageRelayListEvent } from "marmot-ts";
import accountManager from "../../lib/accounts";
import { eventStore, pool } from "../../lib/nostr";
import { extraRelays$, lookupRelays$ } from "../../lib/settings";

interface NewUserProps {
  onSuccess?: () => void;
}

interface PreviewUser {
  name: string;
  pubkey: string;
  account: PrivateKeyAccount<any>;
}

export default function NewUser({ onSuccess }: NewUserProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewUser, setPreviewUser] = useState<PreviewUser | null>(null);
  const lookupRelays = use$(lookupRelays$);
  const extraRelays = use$(extraRelays$);

  const generateRandomName = () => {
    return uniqueNamesGenerator({
      dictionaries: [adjectives, colors, animals],
      separator: " ",
      length: 3,
      style: "capital",
    });
  };

  const generateRandomUser = useCallback(() => {
    const name = generateRandomName();
    const account = PrivateKeyAccount.generateNew();
    const pubkey = account.pubkey;

    setPreviewUser({
      name,
      pubkey,
      account,
    });
  }, []);

  const handleCreateUser = async () => {
    if (!previewUser) {
      setError("Please generate a user first");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const { account, name } = previewUser;

      // Add the account to the account manager
      accountManager.addAccount(account);

      // Optionally publish a profile event with the name and robohash picture
      try {
        const profile = await account.signEvent(
          await buildEvent(
            { kind: 0 },
            {},
            setProfile({
              name: name,
              picture: `https://robohash.org/${account.pubkey}.png`,
            }),
          ),
        );
        await pool.publish(relaySet(lookupRelays, extraRelays), profile);

        // Create key package relay list event
        const keyPackageRelays = await account.signEvent(
          createKeyPackageRelayListEvent({
            relays: extraRelays ?? [],
            pubkey: account.pubkey,
          }),
        );
        await pool.publish(
          relaySet(lookupRelays, extraRelays),
          keyPackageRelays,
        );

        // Store locally in event store
        eventStore.add(profile);
      } catch (profileErr) {
        console.warn("Failed to publish profile:", profileErr);
        // Don't fail the whole operation if profile publish fails
      }

      // Set it as the active account
      accountManager.setActive(account.id);

      // Call success callback
      onSuccess?.();

      generateRandomUser();
    } catch (err) {
      console.error("Create user error:", err);
      setError(err instanceof Error ? err.message : "Failed to create user");
    } finally {
      setLoading(false);
    }
  };

  // Generate initial random user on component mount
  useEffect(() => {
    generateRandomUser();
  }, [generateRandomUser]);

  const robohashUrl = previewUser
    ? `https://robohash.org/${previewUser.pubkey}.png`
    : "";

  return (
    <div className="space-y-4">
      {/* Preview Section */}
      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-6">
          {previewUser && (
            <Avatar className="h-24 w-24">
              <AvatarImage src={robohashUrl} alt={previewUser.name} />
            </Avatar>
          )}
          <div className="text-center">
            <h4 className="font-bold text-lg">
              {previewUser?.name || "Generating..."}
            </h4>
            {previewUser && (
              <p className="text-xs text-muted-foreground font-mono mt-1">
                {previewUser.pubkey.slice(0, 16)}...
                {previewUser.pubkey.slice(-16)}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Regenerate Button */}
      <Button
        variant="outline"
        className="w-full"
        onClick={generateRandomUser}
        disabled={loading}
      >
        <IconRefresh className="size-4" />
        Generate New Random User
      </Button>

      {/* Error Display */}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Create Account Button */}
      <Button
        className="w-full"
        onClick={handleCreateUser}
        disabled={loading || !previewUser}
      >
        {loading ? "Creating Account..." : "Create Account"}
      </Button>

      <div className="text-xs text-muted-foreground text-center">
        A new private key will be generated and stored locally in your browser
      </div>
    </div>
  );
}
