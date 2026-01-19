import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { buildEvent } from "applesauce-core";
import { relaySet } from "applesauce-core/helpers";
import { setProfile } from "applesauce-core/operations/profile";
import { useCallback, useEffect, useState } from "react";
import {
  adjectives,
  animals,
  colors,
  uniqueNamesGenerator,
} from "unique-names-generator";
import { createKeyPackageRelayListEvent } from "../../../../src";
import { useObservable } from "../../hooks/use-observable";
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
  const lookupRelays = useObservable(lookupRelays$);
  const extraRelays = useObservable(extraRelays$);

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
  }, []);

  const robohashUrl = previewUser
    ? `https://robohash.org/${previewUser.pubkey}.png`
    : "";

  return (
    <div className="space-y-4">
      {/* Preview Section */}
      <div className="card">
        <div className="flex flex-col items-center gap-4">
          {previewUser && (
            <div className="avatar">
              <div className="w-24 rounded-full ring ring-primary ring-offset-base-100 ring-offset-2">
                <img src={robohashUrl} alt={previewUser.name} />
              </div>
            </div>
          )}
          <div className="text-center">
            <h4 className="font-bold text-lg">
              {previewUser?.name || "Generating..."}
            </h4>
            {previewUser && (
              <p className="text-xs text-base-content/60 font-mono mt-1">
                {previewUser.pubkey.slice(0, 16)}...
                {previewUser.pubkey.slice(-16)}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Regenerate Button */}
      <button
        className="btn btn-outline btn-secondary w-full"
        onClick={generateRandomUser}
        disabled={loading}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          className="w-5 h-5"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"
          />
        </svg>
        Generate New Random User
      </button>

      {/* Error Display */}
      {error && (
        <div className="alert alert-error">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="stroke-current shrink-0 h-6 w-6"
            fill="none"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <span>{error}</span>
        </div>
      )}

      {/* Create Account Button */}
      <button
        className="btn btn-primary w-full"
        onClick={handleCreateUser}
        disabled={loading || !previewUser}
      >
        {loading ? (
          <>
            <span className="loading loading-spinner"></span>
            Creating Account...
          </>
        ) : (
          "Create Account"
        )}
      </button>

      <div className="text-xs text-base-content/60 text-center">
        A new private key will be generated and stored locally in your browser
      </div>
    </div>
  );
}
