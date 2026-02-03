import { relaySet } from "applesauce-core/helpers";
import { useState } from "react";
import { useObservable } from "../hooks/use-observable";
import { extraRelays$, lookupRelays$ } from "../lib/settings";

interface RelayConfigProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function RelayConfig({ isOpen, onClose }: RelayConfigProps) {
  const lookupRelays = useObservable(lookupRelays$);
  const extraRelays = useObservable(extraRelays$);
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
    lookupRelays$.next(["wss://purplepag.es/", "wss://index.hzrd149.com/"]);
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

  const handleKeyPress = (
    e: React.KeyboardEvent,
    type: "lookup" | "extra" | "manual",
  ) => {
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
    <dialog className={`modal ${isOpen ? "modal-open" : ""}`}>
      <div className="modal-box max-w-4xl max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-bold text-lg">Relay Configuration</h3>
          <button className="btn btn-sm btn-circle btn-ghost" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="space-y-6">
          {/* Lookup Relays Section */}
          <div className="card bg-base-200">
            <div className="card-body p-4">
              <div className="flex justify-between items-center mb-3">
                <h4 className="card-title text-sm">Lookup Relays</h4>
                <button
                  className="btn btn-xs btn-outline"
                  onClick={resetLookupRelays}
                  title="Reset to default lookup relays"
                >
                  Reset
                </button>
              </div>
              <p className="text-xs text-base-content/60 mb-3">
                Used for discovering user profiles and relay lists
              </p>

              <div className="space-y-2">
                {lookupRelays.map((relay, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <code className="flex-1 text-xs bg-base-100 p-2 rounded">
                      {relay}
                    </code>
                    <button
                      className="btn btn-xs btn-error"
                      onClick={() => handleRemoveLookupRelay(relay)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>

              <div className="join w-full mt-3">
                <input
                  type="text"
                  placeholder="wss://relay.example.com"
                  className="input input-bordered input-sm join-item flex-1"
                  value={newLookupRelay}
                  onChange={(e) => setNewLookupRelay(e.target.value)}
                  onKeyDown={(e) => handleKeyPress(e, "lookup")}
                />
                <button
                  className="btn btn-primary btn-sm join-item"
                  onClick={handleAddLookupRelay}
                  disabled={!newLookupRelay.trim()}
                >
                  Add
                </button>
              </div>
            </div>
          </div>

          {/* Extra Relays Section */}
          <div className="card bg-base-200">
            <div className="card-body p-4">
              <div className="flex justify-between items-center mb-3">
                <h4 className="card-title text-sm">Extra Relays</h4>
                <button
                  className="btn btn-xs btn-outline"
                  onClick={resetExtraRelays}
                  title="Reset to default extra relays"
                >
                  Reset
                </button>
              </div>
              <p className="text-xs text-base-content/60 mb-3">
                Always used when fetching events across the app
              </p>

              <div className="space-y-2">
                {extraRelays.map((relay, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <code className="flex-1 text-xs bg-base-100 p-2 rounded">
                      {relay}
                    </code>
                    <button
                      className="btn btn-xs btn-error"
                      onClick={() => handleRemoveExtraRelay(relay)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>

              <div className="join w-full mt-3">
                <input
                  type="text"
                  placeholder="wss://relay.example.com"
                  className="input input-bordered input-sm join-item flex-1"
                  value={newExtraRelay}
                  onChange={(e) => setNewExtraRelay(e.target.value)}
                  onKeyDown={(e) => handleKeyPress(e, "extra")}
                />
                <button
                  className="btn btn-primary btn-sm join-item"
                  onClick={handleAddExtraRelay}
                  disabled={!newExtraRelay.trim()}
                >
                  Add
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="modal-action">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button onClick={onClose}>close</button>
      </form>
    </dialog>
  );
}
