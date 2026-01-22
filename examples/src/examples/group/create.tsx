import { bytesToHex } from "@noble/hashes/utils.js";
import { useState } from "react";
import { map, switchMap } from "rxjs";
import type { CiphersuiteName, KeyPackage } from "ts-mls";
import {
  defaultCryptoProvider,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
} from "ts-mls";
import { CompleteKeyPackage } from "../../../../src";
import { getMemberCount } from "../../../../src/core/client-state";
import { createCredential } from "../../../../src/core/credential";
import { generateKeyPackage } from "../../../../src/core/key-package";
import { PubkeyListCreator } from "../../components/form/pubkey-list-creator";
import { RelayListCreator } from "../../components/form/relay-list-creator";
import JsonBlock from "../../components/json-block";
import { withSignIn } from "../../components/with-signIn";
import { useObservable, useObservableMemo } from "../../hooks/use-observable";
import accounts from "../../lib/accounts";
import { keyPackageStore$ } from "../../lib/key-package-store";
import { marmotClient$ } from "../../lib/marmot-client";

// ============================================================================
// Component: ErrorAlert
// ============================================================================

function ErrorAlert({ error }: { error: string | null }) {
  if (!error) return null;

  return (
    <div className="alert alert-error">
      <span>❌ Error: {error}</span>
    </div>
  );
}

// ============================================================================
// Component: ConfigurationForm
// ============================================================================

interface ConfigurationFormData {
  selectedKeyPackageId: string;
  selectedKeyPackage: CompleteKeyPackage | null;
  groupName: string;
  groupDescription: string;
  adminPubkeys: string[];
  relays: string[];
}

interface ConfigurationFormProps {
  keyPackages: KeyPackage[];
  keyPackageStore: any;
  isCreating: boolean;
  onSubmit: (data: ConfigurationFormData) => void;
}

function ConfigurationForm({
  keyPackages,
  keyPackageStore,
  isCreating,
  onSubmit,
}: ConfigurationFormProps) {
  const [selectedKeyPackageId, setSelectedKeyPackageId] = useState("");
  const [selectedKeyPackage, setSelectedKeyPackage] =
    useState<CompleteKeyPackage | null>(null);
  const [groupName, setGroupName] = useState("My Group");
  const [groupDescription, setGroupDescription] = useState("");
  const [adminPubkeys, setAdminPubkeys] = useState<string[]>([]);
  const [relays, setRelays] = useState<string[]>([]);

  const handleKeyPackageSelect = async (keyPackageId: string) => {
    if (!keyPackageStore || !keyPackageId) {
      setSelectedKeyPackageId("");
      setSelectedKeyPackage(null);
      return;
    }

    try {
      setSelectedKeyPackageId(keyPackageId);

      const keyPackage = keyPackages.find(
        (kp) => bytesToHex(kp.initKey) === keyPackageId,
      );
      if (!keyPackage) {
        return;
      }

      const completePackage =
        await keyPackageStore.getCompletePackage(keyPackage);
      if (completePackage) {
        setSelectedKeyPackage(completePackage);
      }
    } catch (err) {
      // Silently handle key package loading errors
    }
  };

  const handleSubmit = async () => {
    // If no key package is selected, generate a new one with defaults
    let keyPackageToUse = selectedKeyPackage;

    if (!keyPackageToUse) {
      try {
        const account = accounts.active;
        if (!account) {
          return;
        }

        // Use default cipher suite
        const defaultCipherSuite: CiphersuiteName =
          "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";

        // Get cipher suite implementation
        const selectedCiphersuite = getCiphersuiteFromName(defaultCipherSuite);
        const ciphersuiteImpl = await getCiphersuiteImpl(
          selectedCiphersuite,
          defaultCryptoProvider,
        );

        // Create credential and key package
        const credential = createCredential(account.pubkey);
        keyPackageToUse = await generateKeyPackage({
          credential,
          ciphersuiteImpl,
        });
      } catch (err) {
        return;
      }
    }

    onSubmit({
      selectedKeyPackageId,
      selectedKeyPackage: keyPackageToUse,
      groupName,
      groupDescription,
      adminPubkeys,
      relays,
    });
  };
  return (
    <div className="card bg-base-100 border border-base-300">
      <div className="card-body">
        <h2 className="card-title">Configuration</h2>
        <p className="text-base-content/70 mb-4">
          Configure your new MLS group with Marmot Group Data Extension
        </p>

        <div className="space-y-4">
          {/* Key Package Selection */}
          <div className="form-control">
            <label className="label">
              <span className="label-text font-semibold">
                Select Key Package (Optional)
              </span>
            </label>
            {keyPackages.length === 0 ? (
              <div className="alert alert-info">
                <span>
                  ℹ️ No key packages available. A new one will be generated
                  automatically with default settings.
                </span>
              </div>
            ) : (
              <>
                <select
                  className="select select-bordered w-full"
                  value={selectedKeyPackageId}
                  onChange={(e) => handleKeyPackageSelect(e.target.value)}
                  disabled={isCreating}
                >
                  <option value="">Generate new key package (default)</option>
                  {keyPackages.map((kp) => (
                    <option
                      key={bytesToHex(kp.initKey)}
                      value={bytesToHex(kp.initKey)}
                    >
                      Key Package ({bytesToHex(kp.initKey).slice(0, 16)}...)
                    </option>
                  ))}
                </select>
                <label className="label">
                  <span className="label-text-alt text-base-content/60">
                    Leave unselected to generate a new key package with default
                    cipher suite
                  </span>
                </label>
              </>
            )}
          </div>

          {/* Group Name and Description */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="form-control">
              <label className="label">
                <span className="label-text font-semibold">Group Name</span>
              </label>
              <input
                type="text"
                placeholder="Enter group name"
                className="input input-bordered w-full"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                disabled={isCreating}
              />
            </div>

            <div className="form-control">
              <label className="label">
                <span className="label-text font-semibold">
                  Description (Optional)
                </span>
              </label>
              <textarea
                placeholder="Enter group description"
                className="textarea textarea-bordered w-full"
                value={groupDescription}
                onChange={(e) => setGroupDescription(e.target.value)}
                rows={2}
                disabled={isCreating}
              />
            </div>
          </div>

          {/* Admin Pubkeys and Relays */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="flex gap-2">
              <PubkeyListCreator
                pubkeys={adminPubkeys}
                label="Admin Public Keys (Optional)"
                placeholder="Enter hex-encoded public key"
                disabled={isCreating}
                emptyMessage="No admin keys configured. The group creator will be the only admin."
                onPubkeysChange={setAdminPubkeys}
              />
            </div>

            <div className="form-control">
              <RelayListCreator
                relays={relays}
                label="Relays (Required)"
                placeholder="wss://relay.example.com"
                disabled={isCreating}
                emptyMessage="At least one relay is required to publish group events."
                onRelaysChange={setRelays}
              />
            </div>
          </div>

          {/* Create Button */}
          <div className="card-actions justify-end mt-6">
            <button
              className="btn btn-primary btn-lg"
              onClick={handleSubmit}
              disabled={isCreating || !groupName.trim() || relays.length === 0}
            >
              {isCreating ? "⏳ Creating..." : "Show Group Details"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export default withSignIn(function GroupCreation() {
  const client = useObservable(marmotClient$);
  const keyPackageStore = useObservable(keyPackageStore$);
  const keyPackages =
    useObservableMemo(
      () =>
        keyPackageStore$.pipe(
          switchMap((store) => store.list()),
          map((packages) => packages.map((kp) => kp.publicPackage)),
        ),
      [],
    ) ?? [];

  const [isCreating, setIsCreating] = useState(false);
  const [result, setResult] = useState<{
    groupId: Uint8Array;
    clientState: any;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFormSubmit = async (data: ConfigurationFormData) => {
    if (!data.selectedKeyPackage) {
      return;
    }

    if (!client) {
      setError("Marmot client not available");
      return;
    }

    try {
      setIsCreating(true);
      setError(null);
      setResult(null);

      // Get current user's pubkey as admin
      const account = accounts.active;
      if (!account) {
        setError("No active account");
        return;
      }

      // Use only the admin pubkeys from the picker (creator is automatically added by MarmotClient)
      const adminPubkeysList = [...data.adminPubkeys];
      const allRelays = [...data.relays];

      const groupId = await client.createGroup(data.groupName, {
        description: data.groupDescription,
        adminPubkeys: adminPubkeysList,
        relays: allRelays,
      });

      // Retrieve the group to get the client state for display
      const group = await client.getGroup(groupId);
      setResult({ groupId, clientState: group.state });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsCreating(false);
    }
  };

  const reset = () => {
    setResult(null);
    setError(null);
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">Create Group</h1>
        <p className="text-base-content/70">
          Create a new MLS group with Marmot Group Data Extension
        </p>
      </div>

      {/* Configuration Form */}
      {!result && (
        <ConfigurationForm
          keyPackages={keyPackages}
          keyPackageStore={keyPackageStore}
          isCreating={isCreating}
          onSubmit={handleFormSubmit}
        />
      )}

      {/* Error Display */}
      <ErrorAlert error={error} />

      {/* Success Display */}
      {result && (
        <div className="space-y-4">
          <div className="alert alert-success">
            <div>
              <div className="font-bold">
                ✅ Group created and stored successfully!
              </div>
              <div className="text-sm">
                Group ID: {bytesToHex(result.groupId).slice(0, 16)}...
              </div>
            </div>
          </div>

          {/* Group Details */}
          <div className="card bg-base-200">
            <div className="card-body">
              <h2 className="card-title">Created Group</h2>
              <div className="divider my-1"></div>
              <JsonBlock
                value={{
                  groupId: bytesToHex(result.groupId),
                  epoch: Number(result.clientState.groupContext.epoch),
                  members: getMemberCount(result.clientState),
                  extensions: result.clientState.groupContext.extensions.length,
                }}
              />
            </div>
          </div>

          <div className="alert alert-info">
            <span>
              ℹ️ The private MLS Group ID is stored locally and should never be
              published to Nostr relays.
            </span>
          </div>

          <div className="flex justify-end">
            <button className="btn btn-outline" onClick={reset}>
              Create Another Group
            </button>
          </div>
        </div>
      )}
    </div>
  );
});
