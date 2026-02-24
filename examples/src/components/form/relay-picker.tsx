import { useMemo, useState } from "react";
import { useObservable } from "../../hooks/use-observable";
import { relayConfig$ } from "../../lib/settings";

function RelayPickerModal(props: {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (relay: string) => void;
}) {
  const [customRelayUrl, setCustomRelayUrl] = useState("");

  const handleCustomRelaySubmit = () => {
    if (customRelayUrl) {
      props.onSelect(customRelayUrl);
      setCustomRelayUrl("");
    }
  };

  return (
    <dialog className={`modal ${props.isOpen ? "modal-open" : ""}`}>
      <div className="modal-box">
        <h3 className="font-bold text-lg mb-4">Custom Relay</h3>

        <div className="form-control">
          <label className="label">
            <span className="label-text">Custom Relay URL</span>
          </label>
          <div className="join w-full mb-4">
            <input
              type="text"
              placeholder="wss://your-relay.com"
              className="input input-bordered join-item flex-1"
              value={customRelayUrl}
              onInput={(e) => setCustomRelayUrl(e.currentTarget.value)}
            />
            <button
              className="btn btn-primary join-item"
              onClick={handleCustomRelaySubmit}
              disabled={customRelayUrl === ""}
            >
              Set
            </button>
          </div>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button onClick={props.onClose}>close</button>
      </form>
    </dialog>
  );
}

export default function RelayPicker(props: {
  value: string;
  onChange: (relay: string) => void;
  common?: string[];
}) {
  const [isModalOpen, setIsModalOpen] = useState(false);

  const relayConfig = useObservable(relayConfig$);

  const allRelayOptions = useMemo(() => {
    const extra = props.common || relayConfig?.lookupRelays || [];
    if (!props.value || extra.includes(props.value)) return extra;
    else return [props.value, ...extra];
  }, [props.value, props.common, relayConfig?.lookupRelays]);

  const handleSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    props.onChange(e.target.value);
  };

  const handleModalSelect = (relay: string) => {
    props.onChange(relay);
    setIsModalOpen(false);
  };

  return (
    <>
      <div className="join">
        <select
          className="select select-bordered join-item"
          value={props.value}
          onChange={handleSelectChange}
        >
          <option value="" disabled>
            Select a relay
          </option>
          {allRelayOptions.map((relay) => (
            <option key={relay} value={relay}>
              {relay}
            </option>
          ))}
        </select>
        <button className="btn join-item" onClick={() => setIsModalOpen(true)}>
          Custom
        </button>
      </div>

      <RelayPickerModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSelect={handleModalSelect}
      />
    </>
  );
}
