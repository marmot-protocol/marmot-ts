import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { extraRelays$, lookupRelays$ } from "@/lib/settings";
import {
  AddInboxRelay,
  AddOutboxRelay,
  RemoveInboxRelay,
  RemoveOutboxRelay,
} from "applesauce-actions/actions/mailboxes";
import {
  ensureHttpURL,
  ensureWebSocketURL,
  relaySet,
} from "applesauce-core/helpers";
import { use$ } from "applesauce-react/hooks";
import { Loader2Icon, WifiIcon, WifiOffIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { PageBody } from "../../components/page-body";
import { PageHeader } from "../../components/page-header";
import { actions, user$ } from "../../lib/accounts";
import { pool } from "../../lib/nostr";

export function RelayItem({
  relay,
  onRemove,
}: {
  relay: string;
  onRemove: () => any | Promise<any>;
}) {
  const inst = useMemo(() => pool.relay(relay), [relay]);
  const icon = use$(inst.icon$);
  const connected = use$(inst.connected$);
  const [removing, setRemoving] = useState(false);

  const handleRemove = async () => {
    setRemoving(true);
    await onRemove();
    setRemoving(false);
  };

  return (
    <div className="flex items-center gap-2">
      <a href={ensureHttpURL(relay)} target="_blank" title="Open in new tab">
        <img src={icon} className="w-6 h-6" />
      </a>
      <code className="flex-1 text-xs bg-muted p-2 rounded font-mono select-all">
        {relay}
      </code>
      <span className="text-xs text-muted-foreground">
        {connected ? (
          <WifiIcon className="w-4 h-4 text-green-500" />
        ) : (
          <WifiOffIcon className="w-4 h-4 text-gray-500" />
        )}
      </span>
      <Button
        variant="destructive"
        size="sm"
        onClick={handleRemove}
        disabled={removing}
      >
        {removing ? <Loader2Icon className="w-4 h-4 animate-spin" /> : "Remove"}
      </Button>
    </div>
  );
}

export function NewRelayForm({
  onAdd,
}: {
  onAdd: (relay: string) => any | Promise<any>;
}) {
  const [newRelay, setNewRelay] = useState("");
  const [adding, setAdding] = useState(false);
  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAdd();
    }
  };

  const handleAdd = async (e?: React.FormEvent<HTMLFormElement>) => {
    e?.preventDefault();
    setAdding(true);
    await onAdd(ensureWebSocketURL(newRelay.trim()));
    setNewRelay("");
    setAdding(false);
  };

  return (
    <form className="flex gap-2 w-full" onSubmit={handleAdd}>
      <Input
        type="text"
        placeholder="wss://relay.example.com"
        value={newRelay}
        onChange={(e) => setNewRelay(e.target.value)}
        onKeyDown={handleKeyPress}
        className="flex-1"
        disabled={adding}
      />
      <Button type="submit" disabled={!newRelay.trim() || adding}>
        Add
      </Button>
    </form>
  );
}

function LookupRelaysSection() {
  const lookupRelays = use$(lookupRelays$);

  const handleAddLookupRelay = (relay: string) => {
    const newRelays = [...new Set([...lookupRelays, relay])];
    lookupRelays$.next(newRelays);
  };

  const handleRemoveLookupRelay = (relay: string) => {
    const newRelays = lookupRelays.filter((r) => r !== relay);
    lookupRelays$.next(newRelays);
  };

  const resetLookupRelays = () => {
    lookupRelays$.next([
      "wss://purplepag.es/",
      "wss://index.hzrd149.com/",
      "wss://indexer.coracle.social/",
    ]);
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-semibold">Lookup Relays</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Used for discovering user profiles and relay lists
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={resetLookupRelays}
          title="Reset to default lookup relays"
        >
          Reset
        </Button>
      </div>
      <div className="space-y-2">
        {lookupRelays.map((relay, index) => (
          <RelayItem
            key={index}
            relay={relay}
            onRemove={() => handleRemoveLookupRelay(relay)}
          />
        ))}
      </div>

      <NewRelayForm onAdd={handleAddLookupRelay} />
    </div>
  );
}

function OutboxRelaysSection() {
  const outboxes = use$(user$.outboxes$);

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-semibold">Outbox Relays</h2>
      <p className="text-sm text-muted-foreground mt-1">
        Relays where your events are published for others to find
      </p>

      <div className="space-y-2">
        {outboxes?.map((outbox, index) => (
          <RelayItem
            key={index}
            relay={outbox}
            onRemove={() => actions.run(RemoveOutboxRelay, outbox)}
          />
        ))}
      </div>

      <NewRelayForm onAdd={(relay) => actions.run(AddOutboxRelay, relay)} />
    </div>
  );
}

function InboxRelaysSection() {
  const inboxes = use$(user$.inboxes$);

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-semibold">Inbox Relays</h2>
      <p className="text-sm text-muted-foreground mt-1">
        Relays used by other users to send you events
      </p>

      <div className="space-y-2">
        {inboxes?.map((inbox, index) => (
          <RelayItem
            key={index}
            relay={inbox}
            onRemove={() => actions.run(RemoveInboxRelay, inbox)}
          />
        ))}
      </div>

      <NewRelayForm onAdd={(relay) => actions.run(AddInboxRelay, relay)} />
    </div>
  );
}

function ExtraRelaysSection() {
  const extraRelays = use$(extraRelays$);

  const handleAddExtraRelay = (relay: string) => {
    const newRelays = [...new Set([...extraRelays, relay])];
    extraRelays$.next(newRelays);
  };

  const handleRemoveExtraRelay = (relay: string) => {
    const newRelays = extraRelays.filter((r) => r !== relay);
    extraRelays$.next(newRelays);
  };

  const resetExtraRelays = () => {
    extraRelays$.next(
      relaySet([
        "wss://relay.damus.io",
        "wss://nos.lol",
        "wss://relay.primal.net",
        "wss://nostr.wine",
        "wss://relay.snort.social",
      ]),
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-semibold">Extra Relays</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Always used when fetching or publishing events across the app
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={resetExtraRelays}
          title="Reset to default extra relays"
        >
          Reset
        </Button>
      </div>
      <div className="space-y-2">
        {extraRelays.map((relay, index) => (
          <RelayItem
            key={index}
            relay={relay}
            onRemove={() => handleRemoveExtraRelay(relay)}
          />
        ))}
      </div>

      <NewRelayForm onAdd={handleAddExtraRelay} />
    </div>
  );
}

export default function SettingsRelaysPage() {
  return (
    <>
      <PageHeader
        items={[
          { label: "Home", to: "/" },
          { label: "Settings", to: "/settings" },
          { label: "Relays" },
        ]}
      />
      <PageBody>
        <LookupRelaysSection />
        <OutboxRelaysSection />
        <InboxRelaysSection />
        <ExtraRelaysSection />
      </PageBody>
    </>
  );
}
