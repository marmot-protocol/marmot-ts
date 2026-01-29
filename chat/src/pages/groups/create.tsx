import { bytesToHex } from "@noble/hashes/utils.js";
import { use$ } from "applesauce-react/hooks";
import { Loader2, XCircle } from "lucide-react";
import {
  CompleteKeyPackage,
  createCredential,
  generateKeyPackage,
} from "marmot-ts";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import type { CiphersuiteName, KeyPackage } from "ts-mls";
import {
  defaultCryptoProvider,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
} from "ts-mls";

import { PubkeyListCreator } from "@/components/form/pubkey-list-creator";
import { RelayListCreator } from "@/components/form/relay-list-creator";
import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { withSignIn } from "@/components/with-signIn";
import accountManager from "@/lib/accounts";
import { marmotClient$ } from "@/lib/marmot-client";
import { extraRelays$ } from "@/lib/settings";
import { from, merge } from "rxjs";

// ============================================================================
// Types
// ============================================================================

interface ConfigurationFormData {
  selectedKeyPackageId: string;
  selectedKeyPackage: CompleteKeyPackage | null;
  groupName: string;
  groupDescription: string;
  adminPubkeys: string[];
  relays: string[];
}

// ============================================================================
// Component: ConfigurationForm
// ============================================================================

interface ConfigurationFormProps {
  keyPackages: KeyPackage[];
  keyPackageStore: any;
  isCreating: boolean;
  defaultRelays: string[];
  onSubmit: (data: ConfigurationFormData) => void;
}

function ConfigurationForm({
  keyPackages,
  keyPackageStore,
  isCreating,
  defaultRelays,
  onSubmit,
}: ConfigurationFormProps) {
  const [selectedKeyPackageId, setSelectedKeyPackageId] = useState("");
  const [selectedKeyPackage, setSelectedKeyPackage] =
    useState<CompleteKeyPackage | null>(null);
  const [groupName, setGroupName] = useState("My Group");
  const [groupDescription, setGroupDescription] = useState("");
  const [adminPubkeys, setAdminPubkeys] = useState<string[]>([]);
  const [relays, setRelays] = useState<string[]>(defaultRelays);

  // Keep relays populated with the user's default relays unless the user has
  // already made an explicit change.
  const [hasTouchedRelays, setHasTouchedRelays] = useState(false);

  // If default relays change (initial load / account switch), refresh the list
  // only if the user hasn't edited it.
  useEffect(() => {
    if (hasTouchedRelays) return;
    if (defaultRelays.length === 0) return;
    setRelays(defaultRelays);
  }, [defaultRelays.join(","), hasTouchedRelays]);

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
    // Default to the user's relay set if none selected.
    // The parent can still override, but this ensures the form is valid.
    const effectiveRelays = relays.length > 0 ? relays : defaultRelays;

    // If no key package is selected, generate a new one with defaults
    let keyPackageToUse = selectedKeyPackage;

    if (!keyPackageToUse) {
      try {
        const account = accountManager.active;
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
      relays: effectiveRelays,
    });
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold">Configuration</h2>
        <p className="text-sm text-muted-foreground">
          Configure your new MLS group with Marmot Group Data Extension
        </p>
      </div>

      <div className="space-y-6">
        {/* Key Package Selection */}
        <div className="space-y-2">
          <Label htmlFor="key-package">Select Key Package (Optional)</Label>
          {keyPackages.length === 0 ? (
            <Alert>
              <AlertDescription>
                No key packages available. A new one will be generated
                automatically with default settings.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <select
                id="key-package"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
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
              <p className="text-xs text-muted-foreground">
                Leave unselected to generate a new key package with default
                cipher suite
              </p>
            </>
          )}
        </div>

        {/* Group Name */}
        <div className="space-y-2">
          <Label htmlFor="group-name">Group Name</Label>
          <Input
            id="group-name"
            type="text"
            placeholder="Enter group name"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            disabled={isCreating}
          />
        </div>

        {/* Group Description */}
        <div className="space-y-2">
          <Label htmlFor="group-description">Description (Optional)</Label>
          <Textarea
            id="group-description"
            placeholder="Enter group description"
            value={groupDescription}
            onChange={(e) => setGroupDescription(e.target.value)}
            rows={2}
            disabled={isCreating}
          />
        </div>

        {/* Admin Pubkeys */}
        <PubkeyListCreator
          pubkeys={adminPubkeys}
          label="Admin Public Keys (Optional)"
          placeholder="Enter hex-encoded public key or npub"
          disabled={isCreating}
          emptyMessage="No admin keys configured. The group creator will be the only admin."
          onPubkeysChange={setAdminPubkeys}
        />

        {/* Relays */}
        <RelayListCreator
          relays={relays}
          label="Relays (Required)"
          placeholder="wss://relay.example.com"
          disabled={isCreating}
          emptyMessage="Leave this empty to use your default relay set."
          onRelaysChange={(next) => {
            setHasTouchedRelays(true);
            setRelays(next);
          }}
        />
      </div>

      <div>
        <Button
          className="w-full"
          onClick={handleSubmit}
          disabled={
            isCreating ||
            !groupName.trim() ||
            (relays.length === 0 && defaultRelays.length === 0)
          }
        >
          {isCreating ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Creating...
            </>
          ) : (
            "Create Group"
          )}
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

function CreateGroupPage() {
  const client = use$(marmotClient$);
  const extraRelays = use$(extraRelays$);
  const storedKeyPackages = use$(
    () => client && merge(from(client.keyPackageStore.list())),
    [client],
  );
  const keyPackages = useMemo(
    () => storedKeyPackages?.map((kp) => kp.publicPackage) ?? [],
    [storedKeyPackages],
  );

  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const navigate = useNavigate();

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

      // Get current user's pubkey as admin
      const account = accountManager.active;
      if (!account) {
        setError("No active account");
        return;
      }

      // Include current user as the first admin, then add any additional admins from the picker
      const currentUserPubkey = account.pubkey;
      const adminPubkeysList = [
        currentUserPubkey,
        ...data.adminPubkeys.filter((pubkey) => pubkey !== currentUserPubkey),
      ];
      const allRelays = [...data.relays];

      const group = await client.createGroup(data.groupName, {
        description: data.groupDescription,
        adminPubkeys: adminPubkeysList,
        relays: allRelays,
      });

      // Navigate directly to the group detail page
      navigate(`/groups/${bytesToHex(group.id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setIsCreating(false);
    }
  };

  return (
    <>
      <PageHeader
        items={[
          { label: "Home", to: "/" },
          { label: "Groups", to: "/groups" },
          { label: "Create Group" },
        ]}
      />
      <PageBody>
        {/* Configuration Form */}
        <ConfigurationForm
          keyPackages={keyPackages}
          keyPackageStore={client?.keyPackageStore}
          isCreating={isCreating}
          defaultRelays={extraRelays ?? []}
          onSubmit={(data) => {
            // Populate group relays from the user's relay config if none provided.
            // This keeps UX simple: in most cases the defaults are acceptable.
            const relays =
              data.relays.length > 0 ? data.relays : (extraRelays ?? []);
            return handleFormSubmit({ ...data, relays });
          }}
        />

        {/* Error Display */}
        {error && (
          <Alert variant="destructive" className="mt-4">
            <XCircle className="h-4 w-4" />
            <AlertDescription>Error: {error}</AlertDescription>
          </Alert>
        )}
      </PageBody>
    </>
  );
}

export default withSignIn(CreateGroupPage);
