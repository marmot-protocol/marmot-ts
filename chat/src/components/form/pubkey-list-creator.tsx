import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { X } from "lucide-react";
import { normalizeToPubkey } from "applesauce-core/helpers";

interface PubkeyListCreatorProps {
  pubkeys: string[];
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  emptyMessage?: string;
  onPubkeysChange: (pubkeys: string[]) => void;
}

export function PubkeyListCreator({
  pubkeys,
  label = "Public Keys",
  placeholder = "Enter hex-encoded public key or npub",
  disabled = false,
  emptyMessage = "No public keys configured.",
  onPubkeysChange,
}: PubkeyListCreatorProps) {
  const [newPubkey, setNewPubkey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleAddPubkey = () => {
    const trimmed = newPubkey.trim();
    if (!trimmed) return;

    try {
      // Normalize to hex pubkey
      const normalizedPubkey = normalizeToPubkey(trimmed);

      if (!normalizedPubkey) {
        setError("Invalid pubkey or npub format");
        return;
      }

      if (pubkeys.includes(normalizedPubkey)) {
        setError("This pubkey is already in the list");
        return;
      }

      onPubkeysChange([...pubkeys, normalizedPubkey]);
      setNewPubkey("");
      setError(null);
    } catch (err) {
      setError("Invalid pubkey format");
    }
  };

  const handleRemovePubkey = (pubkeyToRemove: string) => {
    onPubkeysChange(pubkeys.filter((p) => p !== pubkeyToRemove));
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAddPubkey();
    }
  };

  return (
    <div className="w-full space-y-2">
      <Label>
        {label} ({pubkeys.length})
      </Label>

      {/* Current Pubkeys Display */}
      {pubkeys.length === 0 ? (
        <div className="text-muted-foreground text-sm text-center py-4 border border-dashed rounded">
          {emptyMessage}
        </div>
      ) : (
        <div className="space-y-2">
          {pubkeys.map((pubkey, index) => (
            <div
              key={index}
              className="flex items-center gap-2 p-2 bg-muted rounded"
            >
              <code className="flex-1 text-xs font-mono select-all truncate">
                {pubkey}
              </code>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => handleRemovePubkey(pubkey)}
                disabled={disabled}
                className="h-6 w-6 flex-shrink-0"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Add New Pubkey */}
      <div className="flex gap-2">
        <Input
          type="text"
          placeholder={placeholder}
          value={newPubkey}
          onChange={(e) => {
            setNewPubkey(e.target.value);
            setError(null);
          }}
          onKeyDown={handleKeyPress}
          disabled={disabled}
          className="flex-1"
        />
        <Button
          onClick={handleAddPubkey}
          disabled={disabled || !newPubkey.trim()}
        >
          Add
        </Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {!error && (
        <p className="text-xs text-muted-foreground">
          Press Enter or click Add to include the pubkey
        </p>
      )}
    </div>
  );
}
