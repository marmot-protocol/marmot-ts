import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { extraRelays$, lookupRelays$ } from "@/lib/settings";
import { ensureHttpURL, relaySet } from "applesauce-core/helpers";
import { use$ } from "applesauce-react/hooks";
import { WifiIcon, WifiOffIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { pool } from "../../lib/nostr";

function RelayItem({
  relay,
  onRemove,
}: {
  relay: string;
  onRemove: () => void;
}) {
  const inst = useMemo(() => pool.relay(relay), [relay]);
  const icon = use$(inst.icon$);
  const connected = use$(inst.connected$);

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
      <Button variant="destructive" size="sm" onClick={onRemove}>
        Remove
      </Button>
    </div>
  );
}

export default function SettingsRelaysPage() {
  const lookupRelays = use$(lookupRelays$);
  const extraRelays = use$(extraRelays$);
  const [newLookupRelay, setNewLookupRelay] = useState("");
  const [newExtraRelay, setNewExtraRelay] = useState("");

  const handleAddLookupRelay = () => {
    if (newLookupRelay.trim()) {
      const newRelays = [...new Set([...lookupRelays, newLookupRelay.trim()])];
      lookupRelays$.next(newRelays);
      setNewLookupRelay("");
    }
  };

  const handleRemoveLookupRelay = (relay: string) => {
    const newRelays = lookupRelays.filter((r) => r !== relay);
    lookupRelays$.next(newRelays);
  };

  const handleAddExtraRelay = () => {
    if (newExtraRelay.trim()) {
      const newRelays = [...new Set([...extraRelays, newExtraRelay.trim()])];
      extraRelays$.next(newRelays);
      setNewExtraRelay("");
    }
  };

  const handleRemoveExtraRelay = (relay: string) => {
    const newRelays = extraRelays.filter((r) => r !== relay);
    extraRelays$.next(newRelays);
  };

  const resetLookupRelays = () => {
    lookupRelays$.next([
      "wss://purplepag.es/",
      "wss://index.hzrd149.com/",
      "wss://indexer.coracle.social/",
    ]);
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

  const handleKeyPress = (e: React.KeyboardEvent, type: "lookup" | "extra") => {
    if (e.key === "Enter") {
      e.preventDefault();
      switch (type) {
        case "lookup":
          handleAddLookupRelay();
          break;
        case "extra":
          handleAddExtraRelay();
          break;
      }
    }
  };

  return (
    <div className="w-full max-w-2xl space-y-8 p-4">
      {/* Lookup Relays Section */}
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

        <div className="flex gap-2 w-full">
          <Input
            type="text"
            placeholder="wss://relay.example.com"
            value={newLookupRelay}
            onChange={(e) => setNewLookupRelay(e.target.value)}
            onKeyDown={(e) => handleKeyPress(e, "lookup")}
            className="flex-1"
          />
          <Button
            onClick={handleAddLookupRelay}
            disabled={!newLookupRelay.trim()}
          >
            Add
          </Button>
        </div>
      </div>

      {/* Extra Relays Section */}
      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <div>
            <h2 className="text-2xl font-semibold">Extra Relays</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Always used when fetching events across the app
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

        <div className="flex gap-2 w-full">
          <Input
            type="text"
            placeholder="wss://relay.example.com"
            value={newExtraRelay}
            onChange={(e) => setNewExtraRelay(e.target.value)}
            onKeyDown={(e) => handleKeyPress(e, "extra")}
            className="flex-1"
          />
          <Button
            onClick={handleAddExtraRelay}
            disabled={!newExtraRelay.trim()}
          >
            Add
          </Button>
        </div>
      </div>
    </div>
  );
}
