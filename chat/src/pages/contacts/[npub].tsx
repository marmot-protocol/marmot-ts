import { castUser, User } from "applesauce-common/casts/user";
import { mapEventsToTimeline } from "applesauce-core";
import {
  bytesToHex,
  normalizeToProfilePointer,
  NostrEvent,
} from "applesauce-core/helpers";
import { use$ } from "applesauce-react/hooks";
import {
  getCredentialPubkey,
  getKeyPackage,
  getKeyPackageCipherSuiteId,
  getKeyPackageClient,
  getKeyPackageExtensions,
  getKeyPackageMLSVersion,
  getKeyPackageRelayList,
  getKeyPackageRelays,
  KEY_PACKAGE_KIND,
  KEY_PACKAGE_RELAY_LIST_KIND,
} from "marmot-ts";
import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { of, switchMap } from "rxjs";
import { map } from "rxjs/operators";
import { KeyPackage } from "ts-mls";

import FollowButton from "@/components/follow-button";
import { UserAvatar, UserName } from "@/components/nostr-user";
import { PageHeader } from "@/components/page-header";
import QRButton from "@/components/qr-button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { marmotClient$ } from "@/lib/marmot-client";
import { eventStore, pool } from "@/lib/nostr";

function KeyPackageCard({ event }: { event: NostrEvent }) {
  const [expanded, setExpanded] = useState(false);

  const mlsVersion = getKeyPackageMLSVersion(event);
  const cipherSuiteId = getKeyPackageCipherSuiteId(event);
  const extensions = getKeyPackageExtensions(event);
  const relays = getKeyPackageRelays(event);
  const client = getKeyPackageClient(event);

  // Parse the key package
  let keyPackage: KeyPackage | null = null;
  let keyPackageError: Error | null = null;
  try {
    keyPackage = getKeyPackage(event);
  } catch (error) {
    keyPackageError = error as Error;
  }

  const formatDate = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleString();
  };

  return (
    <div className="border rounded-lg p-4 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-xs text-muted-foreground font-mono truncate">
            {event.id}
          </div>
          <div className="text-xs text-muted-foreground/60 mt-1">
            {formatDate(event.created_at)}
          </div>
        </div>
        {keyPackage && !keyPackageError && (
          <span className="px-2 py-1 text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 rounded">
            Valid
          </span>
        )}
        {keyPackageError && (
          <span className="px-2 py-1 text-xs bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200 rounded">
            Parse Error
          </span>
        )}
      </div>

      {/* Quick Info Grid */}
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <div className="text-xs text-muted-foreground mb-1">MLS Version</div>
          <span className="px-2 py-1 text-xs border rounded">
            {mlsVersion || "Not specified"}
          </span>
        </div>

        <div>
          <div className="text-xs text-muted-foreground mb-1">Cipher Suite</div>
          {cipherSuiteId !== undefined ? (
            <span className="px-2 py-1 text-xs border rounded">
              {cipherSuiteId}
            </span>
          ) : (
            <span className="px-2 py-1 text-xs border border-red-500 text-red-600 rounded">
              Unknown
            </span>
          )}
        </div>

        {client && (
          <div className="col-span-2">
            <div className="text-xs text-muted-foreground mb-1">Client</div>
            <span className="px-2 py-1 text-xs border rounded">
              {client.name}
            </span>
          </div>
        )}

        {relays && relays.length > 0 && (
          <div className="col-span-2">
            <div className="text-xs text-muted-foreground mb-1">
              Relays ({relays.length})
            </div>
            <div className="flex flex-wrap gap-1">
              {relays.map((relay) => (
                <span key={relay} className="px-2 py-1 text-xs border rounded">
                  {relay}
                </span>
              ))}
            </div>
          </div>
        )}

        {extensions && extensions.length > 0 && (
          <div className="col-span-2">
            <div className="text-xs text-muted-foreground mb-1">
              Extensions ({extensions.length})
            </div>
            <div className="flex flex-wrap gap-1">
              {extensions.map((ext) => (
                <span key={ext} className="px-2 py-1 text-xs border rounded">
                  {ext}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Error Display */}
      {keyPackageError && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded">
          <strong>Parse Error:</strong> {keyPackageError.message}
        </div>
      )}

      {/* Expandable Details */}
      {keyPackage && (
        <button
          className="text-sm text-primary hover:underline"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Hide" : "Show"} Details
        </button>
      )}

      {expanded && keyPackage && (
        <div className="space-y-2 border-t pt-3">
          {/* Credential Info */}
          {keyPackage.leafNode.credential.credentialType === "basic" && (
            <div>
              <div className="text-xs text-muted-foreground mb-1">
                Credential Pubkey
              </div>
              <code className="text-xs break-all block bg-muted p-2 rounded">
                {getCredentialPubkey(keyPackage.leafNode.credential)}
              </code>
            </div>
          )}

          {/* Public Keys */}
          <div>
            <div className="text-xs text-muted-foreground mb-1">
              HPKE Public Key
            </div>
            <code className="text-xs break-all block bg-muted p-2 rounded">
              {bytesToHex(keyPackage.leafNode.hpkePublicKey)}
            </code>
          </div>

          <div>
            <div className="text-xs text-muted-foreground mb-1">
              Signature Public Key
            </div>
            <code className="text-xs break-all block bg-muted p-2 rounded">
              {bytesToHex(keyPackage.leafNode.signaturePublicKey)}
            </code>
          </div>
        </div>
      )}
    </div>
  );
}

function ContactKeyPackagesTab({
  keyPackages,
}: {
  keyPackages: NostrEvent[] | null | undefined;
}) {
  if (keyPackages && keyPackages.length > 0) {
    return (
      <div className="space-y-3">
        {keyPackages.map((event) => (
          <KeyPackageCard key={event.id} event={event as NostrEvent} />
        ))}
      </div>
    );
  }

  if (keyPackages && keyPackages.length === 0) {
    return (
      <div className="border rounded-lg p-8 text-center text-muted-foreground">
        No key packages found for this user.
      </div>
    );
  }

  return (
    <div className="flex justify-center p-8">
      <span className="text-muted-foreground">Loading...</span>
    </div>
  );
}

function ContactProfileTab({ user }: { user: User }) {
  const profile = use$(user.profile$);
  const displayName = profile?.displayName;
  const picture =
    profile?.picture ||
    `https://api.dicebear.com/7.x/identicon/svg?seed=${user.pubkey}`;

  return (
    <div className="border rounded-lg p-6 space-y-4">
      <div className="flex items-center gap-4">
        <div className="h-24 w-24 rounded-full overflow-hidden">
          <img
            src={picture}
            alt={displayName}
            className="h-full w-full object-cover"
          />
        </div>
        <div className="flex-1">
          <h3 className="text-xl font-semibold">{displayName}</h3>
          {profile?.about && (
            <p className="text-sm text-muted-foreground mt-2">
              {profile.about}
            </p>
          )}
        </div>
      </div>

      {profile?.website && (
        <div>
          <div className="text-xs text-muted-foreground mb-1">Website</div>
          <a
            href={profile.website}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary hover:underline"
          >
            {profile.website}
          </a>
        </div>
      )}

      <div>
        <div className="text-xs text-muted-foreground mb-1">Public Key</div>
        <code className="text-xs break-all block bg-muted p-2 rounded">
          {user.pubkey}
        </code>
      </div>
    </div>
  );
}

function ContactRelaysTab({
  keyPackageRelayList,
  keyPackageRelays,
}: {
  keyPackageRelayList: NostrEvent | null | undefined;
  keyPackageRelays: string[] | undefined;
}) {
  return (
    <div className="border rounded-lg p-6 space-y-4">
      <div>
        <h3 className="text-lg font-semibold mb-2">Key Package Relay List</h3>
        <p className="text-sm text-muted-foreground">
          This user publishes their key package relay list (kind 10051) to
          indicate where their key packages can be found.
        </p>
      </div>

      {keyPackageRelayList ? (
        <div className="space-y-3">
          <div>
            <div className="text-xs text-muted-foreground mb-1">
              Last Updated
            </div>
            <div className="text-sm">
              {new Date(keyPackageRelayList.created_at * 1000).toLocaleString()}
            </div>
          </div>

          {keyPackageRelays && keyPackageRelays.length > 0 ? (
            <div>
              <div className="text-xs text-muted-foreground mb-2">
                Relays ({keyPackageRelays.length})
              </div>
              <div className="space-y-2">
                {keyPackageRelays.map((relay) => (
                  <div
                    key={relay}
                    className="px-3 py-2 border rounded text-sm font-mono"
                  >
                    {relay}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded">
              Relay list event found but contains no valid relays.
            </div>
          )}
        </div>
      ) : (
        <div className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded">
          No relay list found for this user. They may not have configured their
          key package relays yet.
        </div>
      )}
    </div>
  );
}

function ContactDetailContent({ user }: { user: User }) {
  const profile = use$(user.profile$);
  const displayName = profile?.displayName;
  const outboxes = use$(user.outboxes$);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState<string>("");
  const [selectedKeyPackageEventId, setSelectedKeyPackageEventId] =
    useState<string>("");
  const [isInviting, setIsInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const keyPackageRelayList = use$(
    () => user.replaceable(KEY_PACKAGE_RELAY_LIST_KIND, undefined, outboxes),
    [user.pubkey, outboxes?.join(",")],
  );

  // Extract relays from the relay list event
  const keyPackageRelays = useMemo(() => {
    return keyPackageRelayList && getKeyPackageRelayList(keyPackageRelayList);
  }, [keyPackageRelayList]);

  // Fetch key packages
  const keyPackages = use$(() => {
    if (!keyPackageRelays) return;

    return pool
      .request(keyPackageRelays, {
        kinds: [KEY_PACKAGE_KIND],
        authors: [user.pubkey],
        limit: 50,
      })
      .pipe(
        mapEventsToTimeline(),
        map((arr) => [...arr]),
      );
  }, [user.pubkey, keyPackageRelays?.join(",")]);

  const groups = use$(
    () =>
      marmotClient$.pipe(
        switchMap((client) => client?.groupStateStore.list() ?? of([])),
      ),
    [],
  );

  const client = use$(marmotClient$);

  const handleInvite = async () => {
    setInviteError(null);
    if (!client) {
      setInviteError("Client not ready");
      return;
    }
    if (!selectedGroupId) {
      setInviteError("Select a group");
      return;
    }
    const selectedEvent =
      (keyPackages as NostrEvent[] | undefined)?.find(
        (e) => e.id === selectedKeyPackageEventId,
      ) ?? null;
    if (!selectedEvent) {
      setInviteError("Select a KeyPackage event");
      return;
    }

    try {
      setIsInviting(true);
      const group = await client.getGroup(selectedGroupId);
      await group.inviteByKeyPackageEvent(selectedEvent);
      setInviteOpen(false);
      setSelectedGroupId("");
      setSelectedKeyPackageEventId("");
    } catch (err) {
      console.error("Failed to invite:", err);
      setInviteError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsInviting(false);
    }
  };

  return (
    <>
      <PageHeader
        items={[
          { label: "Home", to: "/" },
          { label: "Contacts", to: "/contacts" },
          { label: displayName ?? "" },
        ]}
      />

      <div className="container mx-auto p-4 space-y-6">
        {/* User Header */}
        <div className="flex items-center gap-4 p-6 border rounded-lg">
          <UserAvatar pubkey={user.pubkey} size="xl" />
          <div className="flex-1">
            <h2 className="text-2xl font-semibold">
              <UserName pubkey={user.pubkey} />
            </h2>
            <code className="text-xs text-muted-foreground block mt-1">
              {user.pubkey}
            </code>
          </div>

          <div className="flex">
            <QRButton data={user.npub} size="lg" label="NPUB" />
            <FollowButton pubkey={user.pubkey} size="lg" />
            <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="lg">
                  Invite to group
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Invite to group</DialogTitle>
                  <DialogDescription>
                    Choose a group and one of this contact's KeyPackage events.
                  </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>Group</Label>
                    <Select
                      value={selectedGroupId}
                      onValueChange={setSelectedGroupId}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select a group" />
                      </SelectTrigger>
                      <SelectContent>
                        {(groups ?? []).map((groupId: Uint8Array) => {
                          const groupIdHex = bytesToHex(groupId);
                          return (
                            <SelectItem key={groupIdHex} value={groupIdHex}>
                              {groupIdHex.slice(0, 16)}...
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>KeyPackage event</Label>
                    <Select
                      value={selectedKeyPackageEventId}
                      onValueChange={setSelectedKeyPackageEventId}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select KeyPackage event" />
                      </SelectTrigger>
                      <SelectContent>
                        {(keyPackages ?? []).map((e) => (
                          <SelectItem key={e.id} value={e.id}>
                            {e.id.slice(0, 16)}...
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {inviteError && (
                    <Alert variant="destructive">
                      <AlertDescription>{inviteError}</AlertDescription>
                    </Alert>
                  )}
                </div>

                <DialogFooter>
                  <Button onClick={handleInvite} disabled={isInviting}>
                    {isInviting ? "Inviting..." : "Send invite"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        {/* Tabs */}
        <Tabs defaultValue="profile" className="w-full">
          <TabsList variant="line">
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="key-packages">
              Key Packages ({keyPackages?.length ?? 0})
            </TabsTrigger>
            <TabsTrigger value="relays">
              Key Package Relays ({keyPackageRelays?.length ?? 0})
            </TabsTrigger>
          </TabsList>

          {/* Profile Tab */}
          <TabsContent value="profile" className="space-y-4">
            <ContactProfileTab user={user} />
          </TabsContent>

          {/* Key Packages Tab */}
          <TabsContent value="key-packages" className="space-y-4">
            <ContactKeyPackagesTab keyPackages={keyPackages as NostrEvent[]} />
          </TabsContent>

          {/* Key Package Relays Tab */}
          <TabsContent value="relays" className="space-y-4">
            <ContactRelaysTab
              keyPackageRelayList={keyPackageRelayList}
              keyPackageRelays={keyPackageRelays}
            />
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}

export default function ContactDetailPage() {
  const { npub } = useParams<{ npub: string }>();

  if (!npub) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center text-muted-foreground">
          <p>Invalid contact identifier</p>
        </div>
      </div>
    );
  }

  let user: User;
  try {
    const pointer = normalizeToProfilePointer(npub);
    if (!pointer) throw new Error("Invalid user pointer");
    user = castUser(pointer, eventStore);
  } catch (error) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center text-muted-foreground">
          <p>Invalid contact identifier</p>
        </div>
      </div>
    );
  }

  return <ContactDetailContent user={user} />;
}
