import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { pool } from "@/lib/nostr";
import { ensureWebSocketURL } from "applesauce-core/helpers";
import { use$ } from "applesauce-react/hooks";
import { X } from "lucide-react";
import { useMemo, useState } from "react";

function RelayItem({
  relay,
  onRemove,
  disabled,
}: {
  relay: string;
  onRemove: () => void;
  disabled: boolean;
}) {
  const relayInstance = useMemo(() => pool.relay(relay), [relay]);
  const icon = use$(relayInstance.icon$);

  return (
    <div className="flex items-center gap-2 p-2 bg-muted rounded">
      <img src={icon} className="w-4 h-4" alt="" />
      <code className="flex-1 text-xs font-mono select-all">{relay}</code>
      <Button
        variant="ghost"
        size="icon"
        onClick={onRemove}
        disabled={disabled}
        className="h-6 w-6"
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

interface RelayListCreatorProps {
  relays: string[];
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  emptyMessage?: string;
  onRelaysChange: (relays: string[]) => void;
}

export function RelayListCreator({
  relays,
  label = "Relays",
  placeholder = "wss://relay.example.com",
  disabled = false,
  emptyMessage = "No relays configured. Add relays below to publish your key package.",
  onRelaysChange,
}: RelayListCreatorProps) {
  const [newRelay, setNewRelay] = useState("");

  const normalizeRelayUrl = (url: string): string => {
    const trimmed = url.trim();
    if (!trimmed) return trimmed;

    // Use ensureWebSocketURL to normalize the URL
    try {
      return ensureWebSocketURL(trimmed);
    } catch {
      // If it fails, try to prepend wss://
      if (!trimmed.startsWith("wss://") && !trimmed.startsWith("ws://"))
        return `wss://${trimmed}`;

      return trimmed;
    }
  };

  const handleAddRelay = () => {
    const normalized = normalizeRelayUrl(newRelay);
    if (normalized && !relays.includes(normalized)) {
      onRelaysChange([...relays, normalized]);
      setNewRelay("");
    }
  };

  const handleRemoveRelay = (relayToRemove: string) => {
    onRelaysChange(relays.filter((r) => r !== relayToRemove));
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAddRelay();
    }
  };

  return (
    <div className="w-full space-y-2">
      <Label>
        {label} ({relays.length})
      </Label>

      {/* Current Relays Display */}
      {relays.length === 0 ? (
        <div className="text-muted-foreground text-sm text-center py-4 border border-dashed rounded">
          {emptyMessage}
        </div>
      ) : (
        <div className="space-y-2">
          {relays.map((relay, index) => (
            <RelayItem
              key={index}
              relay={relay}
              onRemove={() => handleRemoveRelay(relay)}
              disabled={disabled}
            />
          ))}
        </div>
      )}

      {/* Add New Relay */}
      <div className="flex gap-2">
        <Input
          type="text"
          placeholder={placeholder}
          value={newRelay}
          onChange={(e) => setNewRelay(e.target.value)}
          onKeyDown={handleKeyPress}
          disabled={disabled}
          className="flex-1"
        />
        <Button
          onClick={handleAddRelay}
          disabled={disabled || !newRelay.trim()}
        >
          Add
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Press Enter or click Add to include the relay
      </p>
    </div>
  );
}
